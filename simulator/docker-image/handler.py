import os
import json
import random
import importlib.util
import sys

import numpy as np

from sandbox import PlayerWorker, UserCodeError


# AWS Lambda battle handler.
#
# Event-source mapped to the battle SQS queue (BatchSize=1). Expected event:
#   {
#     "battle_id":        "uuid",
#     "competition_id":   "uuid",
#     "is_test":          false,
#     "a_user_id":        "uuid",
#     "b_user_id":        "uuid",
#     "a_snapshot_id":    "uuid",
#     "b_snapshot_id":    "uuid"
#   }
#
# Flow:
#   1. Log attempt to execution_log (start_time, lambda_request_id → NULL end_time_utc).
#   2. Fetch both snapshots via API (player code).
#   3. Fetch competition via API (S3 keys for game engine + optional helper).
#   4. Download game definition and helper from S3.
#   5. Create sandboxed subprocess workers for both players.
#   6. Import game engine (trusted) and run simulation.
#   7. Upload replay video to S3.
#   8. PUT callback to API with result (infra_ok=true, input_ok=true).
#
# On any failure, the Lambda raises — the SQS message is NOT deleted, so it
# retries. After maxReceiveCount, the message goes to the DLQ, where the DLQ
# consumer writes infra_ok=false, input_ok=false. The main Lambda never writes
# failure records; it only records success.

BUCKET_NAME = os.environ.get('S3_BUCKET', 'python-pvp-store')

VIDEO_OBJECT_KEY_FMT = 'output/{battle_id}.mp4'

WORK_DIR = os.environ.get('WORK_DIR', '/tmp')
GAME_DIR = os.path.join(WORK_DIR, 'game')
HELPER_DIR = os.path.join(WORK_DIR, 'sandbox')
OUTPUT_DIR = os.path.join(WORK_DIR, 'output')

HERE = os.path.dirname(os.path.abspath(__file__))


def load_module(module_name, file_path):
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec and spec.loader:
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        return module
    return None


def setup_clients():
    base = os.path.join(HERE, 'clients')
    s3_module = load_module('s3Client', os.path.join(base, 's3Client.py'))
    db_module = load_module('dbClient', os.path.join(base, 'dbClient.py'))
    if s3_module is None:
        raise RuntimeError(f'failed to load s3Client from {base}')
    if db_module is None:
        raise RuntimeError(f'failed to load dbClient from {base}')

    return s3_module.S3Client(), db_module.DBClient()


def extract_payload(event):
    records = event.get('Records') if isinstance(event, dict) else None
    if records:
        return json.loads(records[0]['body'])
    return event


def lambda_handler(event, context):
    payload = extract_payload(event)

    battle_id = payload['battle_id']
    competition_id = payload['competition_id']
    a_snapshot_id = payload['a_snapshot_id']
    b_snapshot_id = payload['b_snapshot_id']
    a_user_id = payload['a_user_id']
    b_user_id = payload['b_user_id']

    s3_client, db_client = setup_clients()

    os.environ.pop('LAMBDA_CALLBACK_TOKEN', None)

    lambda_request_id = getattr(context, 'log_stream_name', 'unknown')

    # ─── ATTEMPT LOG ────────────────────────────────────────────
    db_client.log_attempt(battle_id, lambda_request_id)

    # ─── DETERMINISTIC RNG for consistent retries ───────────────
    seed = hash(battle_id)
    random.seed(seed)
    np.random.seed(seed % (2**32))

    worker_a = None
    worker_b = None

    # ─── SETUP PHASE ────────────────────────────────────────
    for d in (GAME_DIR, OUTPUT_DIR):
        os.makedirs(d, exist_ok=True)

    competition = db_client.fetch_competition(competition_id)
    a_code = db_client.fetch_snapshot(a_snapshot_id)
    b_code = db_client.fetch_snapshot(b_snapshot_id)

    game_path = os.path.join(GAME_DIR, 'game.py')
    s3_client.download(BUCKET_NAME, competition['game_reference'], game_path)

    helper_path = os.path.join(HELPER_DIR, 'helper.py')
    s3_client.download(BUCKET_NAME, competition['helper_reference'], helper_path)

    game = load_module('game', game_path)
    if game is None:
        raise RuntimeError('failed to import game')
    if not hasattr(game, 'init') or not hasattr(game, 'simulate') or not hasattr(game, 'export_video'):
        raise RuntimeError('game module missing required interface')
    
    try:
        worker_a = PlayerWorker(a_code, helper_dir=HELPER_DIR)
        worker_b = PlayerWorker(b_code, helper_dir=HELPER_DIR)
        # ─── EXECUTION PHASE ─────────────────────────────────────
        game.init()
        result = game.simulate(worker_a, worker_b)
        result = result or {}

        local_video_path = os.path.join(OUTPUT_DIR, f'{battle_id}.mp4')
        game.export_video(local_video_path)

        video_key = VIDEO_OBJECT_KEY_FMT.format(battle_id=battle_id)
        s3_client.upload(BUCKET_NAME, video_key, local_video_path)

        winner_tag = result.get('winner')
        if winner_tag == 'a':
            winner_user_id, loser_user_id = a_user_id, b_user_id
        elif winner_tag == 'b':
            winner_user_id, loser_user_id = b_user_id, a_user_id
        else:
            winner_user_id, loser_user_id = None, None

        db_client.callback_battle(
            battle_id=battle_id,
            infra_ok=True, input_ok=True,
            winner_user_id=winner_user_id,
            loser_user_id=loser_user_id,
            draw=(winner_user_id is None),
            video_reference=video_key
        )

        print(f'battle {battle_id} completed')
        return {'statusCode': 200, 'battle_id': battle_id}

    except UserCodeError:
        db_client.callback_battle(
            battle_id=battle_id,
            infra_ok=True, input_ok=False,
            winner_user_id=None, loser_user_id=None,
            draw=None, video_reference=None,
        )
        raise
    except Exception as e:
        print(f'battle {battle_id} failed: {e}')
        raise
    finally:
        for w in (worker_a, worker_b):
            if w:
                w.close()
        close = getattr(db_client, 'close', None)
        if callable(close):
            close()
