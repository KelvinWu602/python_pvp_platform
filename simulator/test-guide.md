# Simulator Lambda — Testing Guide

End-to-end steps to test `python-pvp-simulator`: seed the database, stage S3
objects, build & push the container image, wire up the Lambda + IAM role, and
invoke it. There are two paths:

- **Path A — Local container test** (fast loop, uses your `localhost:5433` tunnel)
- **Path B — Deployed Lambda test** (Lambda in AWS-managed network, DB access via API server)

Reference the actual AWS resource names in `../AWS resource.md`.

---

## 0. What the handler expects

Event payload (direct invoke — the event **is** the dict, no API Gateway
envelope). See `docker-image/handler.py`:

```json
{
  "battle_id":     "<uuid of app.battle row>",
  "simulation_id": "<uuid for this run; becomes app.simulation_job.id>",
  "game_id":       "<uuid of app.game row>",
  "a_user_id":     "<uuid of player A user>",
  "b_user_id":     "<uuid of player B user>",
  "a_code_id":     "<uuid of app.code row for A>",
  "b_code_id":     "<uuid of app.code row for B>"
}
```

Flow the handler runs:
1. `markPending(battle_id, simulation_id)` → **INSERTs** a new `app.simulation_job` row.
2. Download `game/<game_id>/game.py` from S3 (`python-pvp-store`).
3. `getCode(a_code_id)` / `getCode(b_code_id)` → read `app.code.code`, write `a.py` / `b.py`.
4. Run `init()` → `simulate(a, b)` → `export_video()`.
5. Upload replay to `output/<simulation_id>.mp4`.
6. `markComplete(...)` (or `markFailed(...)` on error).

Required env vars (see `docker-image/clients/`):

| Var               | Purpose                                | Local value                       | Deployed Lambda value            |
|-------------------|----------------------------------------|-----------------------------------|----------------------------------|
| `RUNNING_MODE`    | `production` or `test`                 | `production`                      | `production`                     |
| `S3_BUCKET`       | S3 bucket name                         | `python-pvp-store`                | `python-pvp-store`               |
| `SIM_API_BASE_URL`| API server base URL (no trailing /)    | `http://localhost:3000`           | `https://api.yourdomain.com`     |
| `SIM_API_TOKEN`   | Service account session token          | (from database/4. service-account.sql) | (set via SSM or Lambda env) |
| `SIM_API_TIMEOUT` | Per-request timeout in seconds         | `10`                              | `10`                             |

---

## 1. Seed the database (via your `localhost:5433` tunnel)

The handler needs an `app.battle` row (FK target for the simulation job) and two
`app.code` rows. The schema/IDs come from `../database/2. init-db.sql` and
`3. extension.sql` (UUIDs auto-generate via `gen_random_uuid()`).

Assuming the schema is already created (see `../database/readme.md`). Connect:

```bash
psql "host=localhost port=5433 dbname=python_pvp user=python_pvp_admin sslmode=require"
```

Run this seed script. It creates a game, a competition, two users, two enrolls,
two code rows, and a battle — then prints the IDs you'll put in the event.

```sql
-- Wrap in a transaction so a mistake is easy to roll back.
BEGIN;

-- 1. Game. simulation_reference is the game_id segment used in the S3 key
--    game/<game_id>/game.py. We reuse the game's own uuid as that segment.
INSERT INTO app.game (display_name, simulation_reference)
VALUES ('maze-2526', 'placeholder')
RETURNING id AS game_id \gset
UPDATE app.game SET simulation_reference = :'game_id'::text WHERE id = :'game_id';

-- 2. Competition for the game.
INSERT INTO app.competition (game_id, display_name, start_time_utc, end_time_utc, enabled)
VALUES (:'game_id', 'test-comp', now() - interval '1 day', now() + interval '7 days', true)
RETURNING id AS competition_id \gset

-- 3. Two users.
INSERT INTO app.user (username, full_name, hash_password)
VALUES ('alice', 'Alice A', 'x') RETURNING id AS a_user_id \gset
INSERT INTO app.user (username, full_name, hash_password)
VALUES ('bob', 'Bob B', 'x') RETURNING id AS b_user_id \gset

-- 4. Enrollments (one per user in the competition).
INSERT INTO app.enroll (competition_id, user_id)
VALUES (:'competition_id', :'a_user_id') RETURNING id AS a_enroll_id \gset
INSERT INTO app.enroll (competition_id, user_id)
VALUES (:'competition_id', :'b_user_id') RETURNING id AS b_enroll_id \gset

-- 5. Player strategies stored as text in app.code.
--    Player A: a simple forward driver. Player B: idle (does nothing).
INSERT INTO app.code (enroll_id, name, code) VALUES (
  :'a_enroll_id', 'forward',
$PYCODE$
def update(sensors, telemetry):
    # Accelerate both wheels toward a forward cruise speed.
    target = 9.0
    a1 = (target - telemetry['spin1']) * 6.0
    a2 = (target - telemetry['spin2']) * 6.0
    return (a1, a2)
$PYCODE$
) RETURNING id AS a_code_id \gset

INSERT INTO app.code (enroll_id, name, code) VALUES (
  :'b_enroll_id', 'idle',
$PYCODE$
def update(sensors, telemetry):
    return (0.0, 0.0)
$PYCODE$
) RETURNING id AS b_code_id \gset

-- 6. The battle (FK target for the simulation_job the handler inserts).
INSERT INTO app.battle (a_enroll_id, b_enroll_id, a_code_id, b_code_id)
VALUES (:'a_enroll_id', :'b_enroll_id', :'a_code_id', :'b_code_id')
RETURNING id AS battle_id \gset

COMMIT;

-- Print everything you need for the event payload.
SELECT
  :'battle_id'   AS battle_id,
  :'game_id'     AS game_id,
  :'a_user_id'   AS a_user_id,
  :'b_user_id'   AS b_user_id,
  :'a_code_id'   AS a_code_id,
  :'b_code_id'   AS b_code_id;
```

Copy the printed IDs. Generate a fresh `simulation_id` yourself (it must be a
new UUID each run, and must NOT already exist in `app.simulation_job`):

```bash
python3 -c "import uuid; print(uuid.uuid4())"
```

> Re-running a battle: keep the same `battle_id`, just use a new `simulation_id`.

---

## 2. Stage the game definition in S3

The handler downloads `game/<game_id>/game.py`. Upload the simulator game using
the **same `game_id`** you got above:

```bash
aws s3 cp simulator/games/2526/game.py \
  "s3://python-pvp-store/game/<game_id>/game.py"
```

Verify:

```bash
aws s3 ls "s3://python-pvp-store/game/<game_id>/game.py"
```

> Player strategies are NOT in S3 — they come from `app.code` (seeded in step 1).
> The handler will write the replay to `output/<simulation_id>.mp4` itself.

---

## Path A — Local container test (recommended first)

Fastest loop. Runs the exact image locally against the RDS tunnel.

### A1. Build the image

Build context is `simulator/` (the Dockerfile copies from `docker-image/`):

```bash
docker build -t python-pvp-simulator simulator
```

> Apple Silicon: Lambda runs x86_64. For a *local* functional test the native
> arm64 build is fine. For an image you'll deploy, build for the Lambda arch —
> see B1.

### A2. Run with the Lambda Runtime Interface Emulator

The `public.ecr.aws/lambda/python` base image ships the RIE, exposing the
function on `localhost:9000`.

```bash
docker run --rm -p 9000:8080 \
  -e RUNNING_MODE=production \
  -e S3_BUCKET=python-pvp-store \
  -e SIM_API_BASE_URL=http://localhost:3000 \
  -e SIM_API_TOKEN='00000000-0000-0000-0000-000000000002' \
  -e SIM_API_TIMEOUT=10 \
  -e AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  -e AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  -e AWS_SESSION_TOKEN="$AWS_SESSION_TOKEN" \
  -e AWS_DEFAULT_REGION=ap-southeast-1 \
  python-pvp-simulator
```

> The AWS_* vars give the container creds to reach S3 (locally there's no
> execution role). Use credentials that can GetObject/PutObject on
> `python-pvp-store`.

### A3. Invoke it

In another terminal, POST the event to the RIE:

```bash
curl -s "http://localhost:9000/2015-03-31/functions/function/invocations" \
  -d '{
    "battle_id":     "<battle_id>",
    "simulation_id": "<fresh-uuid>",
    "game_id":       "<game_id>",
    "a_user_id":     "<a_user_id>",
    "b_user_id":     "<b_user_id>",
    "a_code_id":     "<a_code_id>",
    "b_code_id":     "<b_code_id>"
  }' | jq
```

Expected success: `{"statusCode": 200, "simulation_id": "..."}`.

Then go to step 5 (verify results).

---

## Path B — Deployed Lambda test

### B1. Build for the Lambda architecture and push to ECR

Pick the architecture you'll configure the function with (`x86_64` or `arm64`).

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=ap-southeast-1
REPO=python-pvp-simulator

# Create the ECR repo once.
aws ecr create-repository --repository-name "$REPO" --region "$REGION" || true

# Log in to ECR.
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

# Build for the target arch (use --platform so it matches the Lambda config).
docker build --platform linux/amd64 -t "$REPO" simulator

# Tag & push.
docker tag "$REPO:latest" "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$REPO:latest"
docker push "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$REPO:latest"
```

> If you build `linux/amd64`, set the Lambda architecture to `x86_64` in B3.
> For `arm64`, use `--platform linux/arm64` and set architecture `arm64`.

### B2. Create the IAM execution role

The function needs: basic CloudWatch logging and S3 read/write on the bucket.
(It runs in the AWS-managed network, not the application VPC — DB access goes
through the API server via HTTPS.)

```bash
# Trust policy: Lambda can assume the role.
cat > /tmp/trust.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
JSON

aws iam create-role \
  --role-name python-pvp-simulator-role \
  --assume-role-policy-document file:///tmp/trust.json

# CloudWatch logging permissions.
aws iam attach-role-policy --role-name python-pvp-simulator-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# S3 read/write scoped to the bucket.
cat > /tmp/s3.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:PutObject"],
    "Resource": "arn:aws:s3:::python-pvp-store/*"
  }]
}
JSON

aws iam put-role-policy --role-name python-pvp-simulator-role \
  --policy-name python-pvp-simulator-s3 \
  --policy-document file:///tmp/s3.json
```

### B3. Create (or update) the Lambda function

You'll need the VPC subnet IDs (`python-pvp-private`, `python-pvp-private-b`)
and the DB security group (`python-pvp-db-sg`). Look up the actual IDs:

```bash
aws ec2 describe-subnets \
  --filters "Name=tag:Name,Values=python-pvp-private,python-pvp-private-b" \
  --query "Subnets[].SubnetId" --output text

aws ec2 describe-security-groups \
  --filters "Name=group-name,Values=python-pvp-db-sg" \
  --query "SecurityGroups[].GroupId" --output text
```

Create the function (container image). Replace placeholders:

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=ap-southeast-1

aws lambda create-function \
  --function-name python-pvp-simulator \
  --package-type Image \
  --code ImageUri="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/python-pvp-simulator:latest" \
  --role "arn:aws:iam::$ACCOUNT_ID:role/python-pvp-simulator-role" \
  --architectures x86_64 \
  --timeout 60 \
  --memory-size 512 \
  --ephemeral-storage Size=1024 \
  --environment "Variables={RUNNING_MODE=production,S3_BUCKET=python-pvp-store,SIM_API_BASE_URL=https://api.yourdomain.com,SIM_API_TOKEN=<from-database/4. service-account.sql>,SIM_API_TIMEOUT=10}"
```

> - `SIM_API_BASE_URL` must be the **public HTTPS URL** of the API server.
>   The Lambda runs in the AWS-managed network and reaches it over the internet.
> - `SIM_API_TOKEN` is the `user_session` id for `simulator-service` from
>   `database/4. service-account.sql`. Store it in SSM Parameter Store and
>   reference it via `{{resolve:ssm:...}}` or set it directly in the env var.
> - The Lambda does NOT need a VPC — it reaches S3 and SQS over the public
>   internet. The application VPC's RDS is not accessed directly by the Lambda.
> - Tune `--memory-size` if rendering the mp4 is slow; opencv + 1800 frames
>   can be CPU heavy at 512 MB. 512 MB is adequate for the 2526 game.

To update after a new image push:

```bash
aws lambda update-function-code \
  --function-name python-pvp-simulator \
  --image-uri "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/python-pvp-simulator:latest"
```

### B4. Invoke it

```bash
cat > /tmp/event.json <<'JSON'
{
  "battle_id":     "<battle_id>",
  "simulation_id": "<fresh-uuid>",
  "game_id":       "<game_id>",
  "a_user_id":     "<a_user_id>",
  "b_user_id":     "<b_user_id>",
  "a_code_id":     "<a_code_id>",
  "b_code_id":     "<b_code_id>"
}
JSON

aws lambda invoke \
  --function-name python-pvp-simulator \
  --payload fileb:///tmp/event.json \
  /tmp/response.json

cat /tmp/response.json
```

View logs:

```bash
aws logs tail /aws/lambda/python-pvp-simulator --follow
```

---

## 5. Verify the results

### 5a. Database — the simulation job

Through the tunnel:

```bash
psql "host=localhost port=5433 dbname=python_pvp user=python_pvp_admin sslmode=require" -c \
"SELECT id, battle_id, status, winner_user_id, loser_user_id,
        winner_score_gain, loser_score_loss, battle_video_reference, execution_log
   FROM app.simulation_job
  WHERE id = '<simulation_id>';"
```

Expect `status = completed`, the winner/loser user ids set (or NULL on a draw),
scores populated, and `battle_video_reference = output/<simulation_id>.mp4`.
On failure: `status = failed` and the error in `execution_log`.

### 5b. S3 — the replay video

```bash
aws s3 cp "s3://python-pvp-store/output/<simulation_id>.mp4" /tmp/replay.mp4
open /tmp/replay.mp4   # macOS
```

---

## Test mode (no S3 needed)

To exercise the orchestration without S3, set `RUNNING_MODE=test`. The test S3
client treats local files as the "bucket": `download` is a no-op if the file is
already staged on disk at the expected path, else it raises the same 404 a real
missing key would. The DB client is unchanged, so a reachable Postgres is still
required (the `localhost:5433` tunnel works). This is mainly for the failure-path
and wiring checks, not a full render against real S3 assets.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `markPending` fails with FK violation | `battle_id` doesn't exist in `app.battle`. |
| `duplicate key` on `simulation_job` | `simulation_id` was reused — generate a fresh UUID. |
| `code not found: <id>` | wrong `a_code_id`/`b_code_id`, or rows not seeded. |
| S3 404 on game download | game not uploaded to `game/<game_id>/game.py`, or wrong `game_id`. |
| Local container can't reach API | `SIM_API_BASE_URL=http://localhost:3000` is correct when the tunnel is active; confirm `npm start` is running on the API server and the tunnel (`localhost:5433`) is up. |
| Lambda can't reach API server | The API server must be publicly reachable on HTTPS (port 443). Check the API EC2 security group allows 443 inbound, and the Lambda has internet egress. `SIM_API_BASE_URL` must be `https://` not `http://`. |
| Lambda can't reach S3 | Lambda runs in AWS-managed network and reaches S3 publicly; no VPC gateway endpoint needed. If this fails, check the execution role's S3 policy (`python-pvp-store-rw-policy`). |
| `cannot import cv2` / libGL error | rebuild image; the Dockerfile installs `mesa-libGL`/`glib2` for headless opencv. |
| Strategy error in `execution_log` | the player code in `app.code` raised; check it defines `update(sensors, telemetry)`. |
