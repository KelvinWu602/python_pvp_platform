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

VIDEO_OBJECT_KEY_FMT = 'output/{battle_id}.webm'

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
    from clients.s3Client import S3Client
    from clients.dbClient import DBClient
    s3_client = S3Client()
    db_client = DBClient()
    if s3_client is None:
        raise RuntimeError(f'failed to load s3Client')
    if db_client is None:
        raise RuntimeError(f'failed to load dbClient')
    return s3_client, db_client


def extract_payload(event):
    """Assuming SQS message batch size = 1"""
    records = event.get('Records') 
    if not isinstance(records, list):
        raise ValueError(f'expected event.records to be a list')
    if len(records) != 1:
        raise ValueError(f'expected len(event.records) == 1')
    return json.loads(records[0]['body'])


def lambda_handler(event, context):
    battle_id = None 
    worker_a = None 
    worker_b = None 
    db_client = None
    try:
        payload = extract_payload(event)

        battle_id = payload['battle_id']
        competition_id = payload['competition_id']
        a_snapshot_id = payload['a_snapshot_id']
        b_snapshot_id = payload['b_snapshot_id']
        a_user_id = payload['a_user_id']
        b_user_id = payload['b_user_id']

        print(f'battle_id       :{battle_id}')
        print(f'competition_id  :{competition_id}')
        print(f'a_snapshot_id   :{a_snapshot_id}')
        print(f'b_snapshot_id   :{b_snapshot_id}')
        print(f'a_user_id       :{a_user_id}')
        print(f'b_user_id       :{b_user_id}')
        
        lambda_request_id = getattr(context, 'log_stream_name', 'unknown')
        print(f'lambda_request_id: {lambda_request_id}')

        s3_client, db_client = setup_clients()

        # ─── ATTEMPT LOG ────────────────────────────────────────────
        db_client.log_attempt(battle_id, lambda_request_id)

        # ─── DETERMINISTIC RNG for consistent retries ───────────────
        seed = hash(battle_id)
        random.seed(seed)
        np.random.seed(seed % (2**32))

        worker_a = None
        worker_b = None

        # ─── SETUP PHASE ────────────────────────────────────────
        for d in (GAME_DIR, HELPER_DIR, OUTPUT_DIR):
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

        worker_a = PlayerWorker(a_code, helper_dir=HELPER_DIR)
        worker_b = PlayerWorker(b_code, helper_dir=HELPER_DIR)
        # ─── EXECUTION PHASE ─────────────────────────────────────
        game.init()
        try:
            result = game.simulate(worker_a, worker_b)
        except Exception:
            # game engines tend to catch all exceptions and re-wrap them,
            # which destroys the UserCodeError type. Check the workers
            # directly — if either recorded a strategy error, classify
            # this as a user code failure (input_ok=false).
            if (worker_a and worker_a.get_last_error()) or (worker_b and worker_b.get_last_error()):
                raise UserCodeError(worker_a.get_last_error() or worker_b.get_last_error())
            raise

        # Capture player output from the subprocess pipes before closing.
        a_stdout_log = worker_a.get_stdout_log()
        a_stderr_log = worker_a.get_stderr_log()
        b_stdout_log = worker_b.get_stdout_log()
        b_stderr_log = worker_b.get_stderr_log()

        # The game engine writes VP9/WebM directly (cv2.VideoWriter 'VP90'),
        # which browsers play natively — no transcode step needed.
        local_video_path = os.path.join(OUTPUT_DIR, f'{battle_id}.webm')
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
            video_reference=video_key,
            a_stdout_log=a_stdout_log,
            a_stderr_log=a_stderr_log,
            b_stdout_log=b_stdout_log,
            b_stderr_log=b_stderr_log,
        )

        print(f'battle {battle_id} completed')
        return {'statusCode': 200, 'battle_id': battle_id}

    except UserCodeError:
        a_stdout_log = worker_a.get_stdout_log() if worker_a else None
        a_stderr_log = worker_a.get_stderr_log() if worker_a else None
        b_stdout_log = worker_b.get_stdout_log() if worker_b else None
        b_stderr_log = worker_b.get_stderr_log() if worker_b else None
        db_client.callback_battle(
            battle_id=battle_id,
            infra_ok=True, input_ok=False,
            winner_user_id=None, loser_user_id=None,
            draw=None, video_reference=None,
            a_stdout_log=a_stdout_log,
            a_stderr_log=a_stderr_log,
            b_stdout_log=b_stdout_log,
            b_stderr_log=b_stderr_log,
        )
        return {'statusCode': 200, 'battle_id': battle_id}
    except Exception as e:
        print(f'battle {battle_id} infra failed, please check: {e}')
        raise
    finally:
        for w in (worker_a, worker_b):
            if w:
                w.close()
        close = getattr(db_client, 'close', None)
        if callable(close):
            close()
