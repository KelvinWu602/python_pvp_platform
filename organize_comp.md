# Organize a competition from scratch

## Admin create users

1. POST /user

User
- username
- fullname
- password

2. Upload game file to S3

S3
- game.py
- helper.py
- manifest.json

3. Create competition

POST /competition

Competition
- display_name
- description
- start_time_utc
- end_time_utc
- game_reference
- helper_reference
- manifest_reference
- npc_user_id           can fill in himself

4. Set up npc test code

POST /enroll

Enroll
- user_id
- competition_id

POST /code

Code
- name, code

POST /enroll/:id/code

Code_Select
- enroll_id
- code_id

POST /approve-code

Battle
- is_test true


5. Some user run test

POST /enroll/:eid/test

Battle
- is_test true
- a_user_id = me
- a_snapshot_id = latest code snapshot
- b_user_id npc
- b_snapshot_id = latest tested code snapshot

SQS enqueue
{
    battle_id: battle.id,
    competition_id,
    is_test: true,
    a_user_id: user_id,
    b_user_id: npc_user_id,
    a_snapshot_id,
    b_snapshot_id,
};

6. Lambda Execution

- POST /admin/battle-attempt/:battle_id
    Log execution, if failed, lambda should fail and let SQS handles retry. ==> on error no catch

- GET /admin/snapshot/:snapshot_id
    Get player's code. if failed, lambda should fail and let SQS handles retry. ==> on error no catch

- S3 download game.py
    from game_reference to /tmp/game/game.py

- S3 download helper.py
    from helper_reference to /tmp/sandbox/helper.py

- Starts the subprocesses and simulation (TODO)

- Export video to /tmp/output/{battle_id}.mp4

- PUT /admin/battle/:bid
    Update battle result, only 2 possible results:
    infra_ok && input_ok
    infra_ok && !input_ok

7. DLQ

- PUT /admin/battle/:bid
    Update battle result, only 1 possible result:
    infra_ok == false


