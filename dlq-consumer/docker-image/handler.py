import json


# DLQ consumer for the battle queue.
#
# Triggered by the DLQ SQS subscription (python-pvp-battle-queue-dlq).
# Reads the original SQS message and records infra_ok=false, input_ok=false
# so the battle is no longer stuck in pending state.
#
# The API's WHERE infra_ok IS NULL guard ensures this never overwrites a
# successful result — if a late retry happened to succeed before the DLQ
# consumer processed it, the PUT is a no-op.

from dbClient import DBClient

def lambda_handler(event, context):
    db = DBClient()
    records = event.get('Records', [])
    for record in records:
        try:
            body = record.get('body', '')
            payload = json.loads(body)
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
            print(f'marked battle {battle_id} as failed')
        except Exception as e:
            print(f'Exception on battle {battle_id}: {e}')
    return {'statusCode': 200}
