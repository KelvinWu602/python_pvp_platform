import os
import sys
import json
import importlib.util


# AWS Lambda simulator entry point.
#
# Invoked directly (the event IS the payload dict, not an API Gateway
# envelope). Expected event (see simulator/design.md):
#   {
#     "battle_id":      "...",   # logical battle between a and b (stable across re-runs)
#     "simulation_id":  "...",   # this specific lambda invocation
#     "game_id":        "...",   # which game logic to run
#     "a_user_id":      "...",   # player a
#     "b_user_id":      "...",   # player b
#     "a_code_id":      "...",   # player a's strategy
#     "b_code_id":      "..."    # player b's strategy
#   }

# S3 bucket holding game definitions and rendered replay videos. Player
# strategy code is NOT in S3 - it lives in the app.code table in RDS and is
# fetched via db_client.getCode (see step 2 in run_simulation).
BUCKET_NAME = os.environ.get('S3_BUCKET', 'python-pvp-store')

# S3 key layout (design.md).
GAME_OBJECT_KEY_FMT = 'game/{game_id}/game.py'
VIDEO_OBJECT_KEY_FMT = 'output/{simulation_id}.mp4'

# Lambda only allows writes under /tmp, so anchor the working tree there.
WORK_DIR = os.environ.get('WORK_DIR', '/tmp')
GAME_DIR = os.path.join(WORK_DIR, 'game')
STRATEGIES_DIR = os.path.join(WORK_DIR, 'strategies')
OUTPUT_DIR = os.path.join(WORK_DIR, 'output')

# Directory holding this file, so client modules resolve regardless of cwd.
HERE = os.path.dirname(os.path.abspath(__file__))


def load_module(module_name, file_path):
    """Dynamically import a module from a file path. Returns None on failure."""
    spec = importlib.util.spec_from_file_location(module_name, file_path)
    if spec and spec.loader:
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        return module
    return None


def setup_clients():
    """Load the S3 and DB client modules and instantiate them. The module set
    depends on RUNNING_MODE so tests can swap in local fakes:
      - 'test'        -> ./testClients (local, no network)
      - 'production'  -> ./clients     (boto3 S3 + HTTP API db client)
    """
    running_mode = os.environ.get('RUNNING_MODE', 'production')
    base = os.path.join(HERE, 'testClients' if running_mode == 'test' else 'clients')

    s3_module = load_module('s3Client', os.path.join(base, 's3Client.py'))
    db_module = load_module('dbClient', os.path.join(base, 'dbClient.py'))
    if s3_module is None:
        raise RuntimeError(f'failed to load s3Client from {base}')
    if db_module is None:
        raise RuntimeError(f'failed to load dbClient from {base}')

    return s3_module.S3Client(), db_module.DBClient()


def run_simulation(event, s3_client, db_client):
    """Download the game + both strategies, run the match, export the replay
    video, upload it, and return (winner_user_id, loser_user_id, result,
    video_key).

    Mapping: the game reports a winner as 'a' / 'b' / None. We translate that
    into the player user ids carried on the event so the DB stores user-level
    results."""
    simulation_id = event['simulation_id']
    game_id = event['game_id']
    a_user_id = event['a_user_id']
    b_user_id = event['b_user_id']
    a_code_id = event['a_code_id']
    b_code_id = event['b_code_id']

    # Ensure the working directories exist before downloading into them.
    for d in (GAME_DIR, STRATEGIES_DIR, OUTPUT_DIR):
        os.makedirs(d, exist_ok=True)

    # 1. Fetch the game definition from S3 and import it.
    game_key = GAME_OBJECT_KEY_FMT.format(game_id=game_id)
    game_path = os.path.join(GAME_DIR, 'game.py')
    s3_client.download(BUCKET_NAME, game_key, game_path)
    game = load_module('game', game_path)
    if game is None:
        raise RuntimeError(f'failed to import game: {game_id}')

    # 2. Fetch both player strategies from the DB and import them. Dynamic
    #    load (not `from strategies.a import ...`) because the files don't
    #    exist until downloaded at runtime.
    a_path = os.path.join(STRATEGIES_DIR, 'a.py')
    b_path = os.path.join(STRATEGIES_DIR, 'b.py')
    db_client.getCode(a_code_id, a_path)
    db_client.getCode(b_code_id, b_path)

    a_module = load_module('strategy_a', a_path)
    b_module = load_module('strategy_b', b_path)
    if a_module is None or not hasattr(a_module, 'update'):
        raise RuntimeError(f'failed to import player a strategy: {a_code_id}')
    if b_module is None or not hasattr(b_module, 'update'):
        raise RuntimeError(f'failed to import player b strategy: {b_code_id}')

    player_a_strategy = a_module.update
    player_b_strategy = b_module.update

    # 3. Run the match. Module-level game interface:
    #      game.init()
    #      result = game.simulate(a, b)
    #      game.export_video(path)
    game.init()
    result = game.simulate(player_a_strategy, player_b_strategy)
    result = result or {}

    local_video_path = os.path.join(OUTPUT_DIR, f'{simulation_id}.mp4')
    game.export_video(local_video_path)

    # 4. Upload the replay to S3.
    video_key = VIDEO_OBJECT_KEY_FMT.format(simulation_id=simulation_id)
    s3_client.upload(BUCKET_NAME, video_key, local_video_path)

    # 5. Resolve winner/loser user ids from the reported winner tag.
    winner_tag = result.get('winner')  # 'a', 'b', or None
    if winner_tag == 'a':
        winner_user_id, loser_user_id = a_user_id, b_user_id
    elif winner_tag == 'b':
        winner_user_id, loser_user_id = b_user_id, a_user_id
    else:
        winner_user_id, loser_user_id = None, None  # draw / no winner

    return winner_user_id, loser_user_id, result, video_key


def extract_payload(event):
    """Return the battle payload dict from the Lambda event.

    Supports two invocation shapes:
      - SQS trigger (production): the event is an SQS batch. With the event
        source mapping configured BatchSize=1 there is exactly one record;
        the payload is JSON in record['body'].
      - Direct invoke (tests / manual): the event IS the payload dict (see
        simulator/test-guide.md), so it's returned as-is.
    """
    records = event.get('Records') if isinstance(event, dict) else None
    if records:
        # BatchSize=1, so there is a single record to process.
        return json.loads(records[0]['body'])
    return event


def lambda_handler(event, context):
    payload = extract_payload(event)

    # battle_id / simulation_id are read first so we can always report failure.
    battle_id = payload['battle_id']
    simulation_id = payload['simulation_id']

    s3_client, db_client = setup_clients()

    try:
        # Record the attempt before doing any heavy lifting so the job is never
        # invisible while it runs.
        db_client.markPending(battle_id, simulation_id)

        winner_user_id, loser_user_id, result, video_key = run_simulation(
            payload, s3_client, db_client
        )

        db_client.markComplete(
            battle_id,
            simulation_id,
            winner_user_id,
            loser_user_id,
            result,
            video_key,
        )
        return {'statusCode': 200, 'simulation_id': simulation_id}
    except Exception as e:
        # Record the failure so the job doesn't stay 'pending' forever.
        print(f'simulation {simulation_id} failed: {e}')
        try:
            db_client.markFailed(simulation_id, str(e))
        except Exception as inner:
            # Never mask the original error if the failure write also fails.
            print(f'failed to mark simulation {simulation_id} failed: {inner}')
        return {'statusCode': 500, 'simulation_id': simulation_id, 'error': str(e)}
    finally:
        close = getattr(db_client, 'close', None)
        if callable(close):
            close()
