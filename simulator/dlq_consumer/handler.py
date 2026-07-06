import json
import sys
import os


# DLQ consumer for the battle queue.
#
# Triggered by the DLQ SQS subscription (python-pvp-battle-queue-dlq).
# Reads the original SQS message and records infra_ok=false, input_ok=false
# so the battle is no longer stuck in pending state.
#
# The API's WHERE infra_ok IS NULL guard ensures this never overwrites a
# successful result — if a late retry happened to succeed before the DLQ
# consumer processed it, the PUT is a no-op.

HERE = os.path.dirname(os.path.abspath(__file__))
CLIENTS_DIR = os.path.join(os.path.dirname(HERE), 'docker-image', 'clients')

if CLIENTS_DIR not in sys.path:
    sys.path.insert(0, CLIENTS_DIR)

from dbClient import DBClient


def lambda_handler(event, context):
    db = DBClient()

    records = event.get('Records', [])
    for record in records:
        body = record.get('body', '')
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            print(f'DLQ: failed to parse message body as JSON: {body}')
            continue

        battle_id = payload.get('battle_id')
        if not battle_id:
            print(f'DLQ: missing battle_id in payload: {payload}')
            continue

        db.callback_battle(
            battle_id=battle_id,
            infra_ok=False,
            input_ok=None,
            winner_user_id=None,
            loser_user_id=None,
            draw=None,
            video_reference=None
        )

        print(f'DLQ: marked battle {battle_id} as failed')

    return {'statusCode': 200}
