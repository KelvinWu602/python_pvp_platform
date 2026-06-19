Lambda Handler File structure:

/app
    - /handler.py
    - /clients
        - /s3Client.py
        - /rdsClient.py
    - /testClients
        - /s3Client.py
        - /rdsClient.py
    - /game
        - /game.py
    - /strategies
        - /a.py
        - /b.py
    - /output
        - /battle_id_time.mp4

s3 bucket name: python-pvp-store

under the bucket
/game
    - /{game_id}/game.py
    - /{game_id}/game.py
    - /{game_id}/game.py
/output
    - /{simulation_id}.mp4

Note: player strategy code is NOT stored in S3. It is stored in the app.code
table in RDS (code text column) and fetched via dbClient.getCode. S3 only
holds game definitions and rendered replay videos.

Execution Flow:

get event object
- battle_id (represent the logical battle between player a and b, same battle id will be used even if it is re-run multiple times)
- simulation_id (represent this lambda invocation)
- game_id (represent the game logic)
- a_user_id (represent player a)
- b_user_id (represent player b)
- a_code_id (represent player a's code_id)
- b_code_id (represent player b's code_id)

set up clients depending on running mode:
if running mode is test:
- set up the local testing clients
if running mode is production
- set up the production clients

s3Client should support:
- constructor (Please let me know what auth is needed for lambda to access s3 bucket)
- download(bucket_name, object_key, file_path)
- upload(bucket_name, object_key, file_path)

s3Client (TEST) should support:
- constructor
- download(bucket_name (ignored), object_key (ignored), file_path) : it will check whether a file specified at file_path already exists, otherwise, raise the same error as if s3 download has a wrong object_key

dbClient should support:
- constructor (Set up db connection using env vars)
- getCode(code_id, file_path): use a select query to get the code string, then store it at file_path
- markPending(battle_id, simulation_id)
- markComplete(battle_id, simulation_id, winner_user_id, loser_user_id, result, battle_video_reference)
- markFailed (execution_log) : put the error message into db.

dbClient (TEST) is the same as the normal dbClient

then markPending first, this will add a new record in the db simulation table

then start download the game code from s3 bucket using game_id, place it under /game folder. 

then download the player strategies from db using code_ids, place them under /strategis folder. Name player_a's code as a.py, and b as b.py.

then initialize the game object.
then run the simulation
then get the result 

if everything goes fine, markComplete
if anything goes wrong, markFailed