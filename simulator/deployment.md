# Simulator Lambda Deployment Guide

This guide walks through deploying `python-pvp-simulator` — the AWS Lambda function that runs player-vs-player battles. Read the whole guide once before starting; some steps depend on earlier ones being completed first.

---

## Overview

The simulator Lambda is triggered by SQS messages representing battle jobs. It:

1. **Fetches both players' snapshot code** from the API (`GET /admin/snapshot/:id`).
2. **Fetches the competition** from the API (`GET /competition/:id`) to get the game S3 key.
3. **Downloads the game definition** from S3 (`game/<game_reference>/game.py`).
4. **Runs the match** by dynamically importing the game and both strategy modules.
5. **Uploads the replay video** to S3 (`output/<battle_id>.mp4`).
6. **Callbacks the result** via the API (`PUT /admin/battle/:id`) which sets `infra_ok`/`input_ok` and inserts an `execution_log` row in one transaction.

```
API server (POST /enroll/:eid/test or /battle)
    │
    ├─ INSERT app.battle (infra_ok=NULL, input_ok=NULL)
    └─ SendMessage → python-pvp-battle-queue (SQS)
                           │
                           ▼
                    python-pvp-simulator (Lambda, BatchSize=1)
                           │
                           ├─ GET /competition/:id  (game_reference for S3)
                           │
                           ├─ GET /admin/snapshot/:id  (player A code)
                           │
                           ├─ GET /admin/snapshot/:id  (player B code)
                           │
                           ├─ S3 download  game/<game_reference>/game.py
                           │
                           ├─ run match → S3 upload  output/<battle_id>.mp4
                           │
                           ├─ PUT /admin/battle/:id  (write result + execution_log)
                           │
                           ▼
                    GET /battle/:id  →  { infra_ok: true, input_ok: true, ... }
```

**Key design decisions to know before deployment:**
- The Lambda runs in the **AWS-managed network** (no VPC). It reaches the API server, S3, and SQS over the public internet.
- Player strategy code is **never stored in S3** — it's fetched from `app.code` in RDS via the API server. S3 only holds game definitions and replay videos.
- The Lambda has **no direct RDS connection**. All DB access goes through the API server's pooled connection, bounding RDS connection count to `pg.Pool` size.
- The Lambda uses **batch size 1** on the SQS trigger. Each invocation processes exactly one battle message.
- The SQS queue is **Standard** (not FIFO). Because simulations are idempotent, occasional duplicate delivery from the "at-least-once" guarantee is harmless.
- The API server must be **publicly reachable** over HTTPS so the Lambda can call it from the internet.

---

## Step 0 — Prerequisites

Before anything else, confirm the following pieces are in place:

| Requirement | How to check |
|---|---|
| Docker installed | `docker --version` |
| AWS CLI configured with sufficient permissions | `aws sts get-caller-identity` |
| API server deployed and publicly reachable | `curl https://<api-url>/api/competition` returns JSON (auth not required for some routes) |
| Root session token configured | A `user_session` row exists for the Lambda's root token (set via SSM or Lambda env) |
| Game definition uploaded to S3 | See [Step 4 — Upload the Game Definition](#step-4--upload-the-game-definition) |
| SSM Parameter Store secrets configured | The EC2 deploy guide covers this; the Lambda needs `SIM_API_BASE_URL` and `SIM_API_TOKEN` from SSM |

---

## Step 1 — Create the S3 Bucket

The bucket `python-pvp-store` holds **game definition files** (uploaded by admins) and **replay video files** (written by the Lambda). It is **not** used for player strategy code.

If the bucket already exists, skip this step.

```bash
aws s3 mb s3://python-pvp-store --region ap-southeast-1
```

### Bucket structure

```
s3://python-pvp-store/
├── game/
│   └── <game_id>/game.py      # game definition (uploaded before competition starts)
└── output/
    └── <simulation_id>.mp4    # replay video (written by Lambda after each run)
```

No lifecycle policies or versioning are required. The Lambda only needs:
- `s3:GetObject` on `game/*` (reading the game definition)
- `s3:PutObject` on `output/*` (writing the replay video)

---

## Step 2 — Create the SQS Queues

Two queues are required: one for battle jobs, one as a dead-letter queue for failed jobs.

### 2.1 Create the dead-letter queue (DLQ) first

```bash
aws sqs create-queue \
  --queue-name python-pvp-battle-dlq \
  --region ap-southeast-1 \
  --attributes '{
    "MessageRetentionPeriod": "1209600",
    "VisibilityTimeout": "60"
  }'
```

`MessageRetentionPeriod: 1209600` = 14 days. Battles that fail after 3 retries sit here for up to 14 days before being auto-deleted by SQS.

`VisibilityTimeout: 60` — the DLQ is consumed by the DLQ consumer Lambda (which calls `PUT /admin/battle/:id` with `infra_ok=false`), so a short visibility timeout is fine.

### 2.2 Create the main battle queue with redrive policy

```bash
# Get the DLQ ARN first (needed for the redrive policy)
DLQ_ARN=$(aws sqs get-queue-attributes \
  --queue-url https://sqs.ap-southeast-1.amazonaws.com/<account>/python-pvp-battle-dlq \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text \
  --region ap-southeast-1)

aws sqs create-queue \
  --queue-name python-pvp-battle-queue \
  --region ap-southeast-1 \
  --attributes '{
    "MessageRetentionPeriod": "86400",
    "VisibilityTimeout": "360",
    "RedrivePolicy": "{\"maxReceiveCount\": \"3\", \"deadLetterTargetArn\": \"<DLQ_ARN>\"}"
  }'
```

| Setting | Value | Why |
|---|---|---|
| `MessageRetentionPeriod: 86400` | 24 hours | If the queue is dead for less than a day, no messages are lost. |
| `VisibilityTimeout: 360` | 6 minutes | **Must exceed the Lambda timeout.** The Lambda is configured for 60s max. If it runs longer (e.g. a stuck match), SQS won't redeliver until 360s have passed, preventing mid-run duplicate delivery. |
| `maxReceiveCount: 3` | 3 retries | After 3 failed attempts, the message moves to the DLQ. This catches permanently crashing code (e.g. infinite loop in a strategy) without retrying forever. |
| `deadLetterTargetArn` | DLQ ARN | Routes failed messages to the DLQ. |

### 2.3 Record the queue URL

```bash
BATTLE_QUEUE_URL=$(aws sqs get-queue-url \
  --queue-name python-pvp-battle-queue \
  --query 'QueueUrl' \
  --output text \
  --region ap-southeast-1)
echo "Battle queue URL: ${BATTLE_QUEUE_URL}"
# Save this — you need it for:
#   1. The Lambda's BATTLE_QUEUE_URL env var (if it reads it)
#   2. The API server's SSM parameter (/python_pvp/api/BATTLE_QUEUE_URL)
```

---

## Step 3 — Create the IAM Role and Policy

The Lambda needs an execution role with permissions for S3 (game download + replay upload) and SQS (receive + delete messages). It also needs to call the API server, but that uses a Bearer token — no extra IAM needed for the HTTP call itself.

### 3.1 Create the trust policy (allow Lambda to assume this role)

```bash
cat > /tmp/lambda-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
EOF

aws iam create-role \
  --role-name python-pvp-simulator \
  --assume-role-policy-document file:///tmp/lambda-trust-policy.json \
  --region ap-southeast-1
```

### 3.2 Attach the managed policy for SQS

```bash
aws iam attach-role-policy \
  --role-name python-pvp-simulator \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole \
  --region ap-southeast-1
```

`AWSLambdaSQSQueueExecutionRole` grants:
- `sqs:ReceiveMessage` — consume messages from the queue
- `sqs:DeleteMessage` — remove a message after successful processing
- `sqs:GetQueueAttributes` — needed for the event source mapping

### 3.3 Attach the custom S3 policy

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

cat > /tmp/lambda-s3-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:GetObject", "s3:PutObject"],
    "Resource": "arn:aws:s3:::python-pvp-store/*"
  }]
}
EOF

aws iam put-role-policy \
  --role-name python-pvp-simulator \
  --policy-name python-pvp-store-rw-policy \
  --policy-document file:///tmp/lambda-s3-policy.json \
  --region ap-southeast-1
```

### 3.4 Attach the logging policy

```bash
aws iam attach-role-policy \
  --role-name python-pvp-simulator \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole \
  --region ap-southeast-1
```

This grants `logs:CreateLogGroup`, `logs:CreateLogStream`, and `logs:PutLogEvents`, which the Lambda needs to write to CloudWatch Logs.

---

## Step 4 — Upload the Game Definition

The game logic file must be uploaded to S3 **before** any battle can be run. The Lambda downloads it from `game/<game_id>/game.py` using the `game_id` from the SQS message payload.

Upload the game file from the repo:

```bash
# From the repo root
GAME_ID=$(python3 -c "import json; rows = json.load(open('database/seed-data.json')); print([r for r in rows if r['table']=='game'][0]['row']['id'])")
echo "Game ID: ${GAME_ID}"

aws s3 cp games/2526/game.py \
  s3://python-pvp-store/game/${GAME_ID}/game.py \
  --region ap-southeast-1

# Verify
aws s3 ls s3://python-pvp-store/game/
```

> **Note:** Replace `games/2526/game.py` with whichever game you are running. Each competition points at a `game_id` in `app.competition.game_id`; that ID must have a corresponding file at `game/<game_id>/game.py` in S3 before battles in that competition can execute.

---

## Step 5 — Build and Push the Docker Image to ECR

The Lambda runs as a container image. You build it locally, push to Amazon ECR, then create the Lambda function from that image.

### 5.1 Create the ECR repository (once)

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=ap-southeast-1
REPO=python-pvp-simulator

aws ecr create-repository \
  --repository-name ${REPO} \
  --region ${REGION} \
  --image-scanning-configuration scanOnPush=true \
  --encryption-configure encryptionType=AES256 \
  || true

# Make it publicly readable (Lambda needs to pull it)
aws ecr set-repository-policy \
  --repository-name ${REPO} \
  --policy-text '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":"*","Action":["ecr:GetDownloadUrlForLayer","ecr:BatchGetImage","ecr:DescribeImages"]}]}' \
  --region ${REGION}
```

### 5.2 Log in to ECR

```bash
aws ecr get-login-password --region ${REGION} \
  | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
```

### 5.3 Build the image

Build from the repo root, targeting `linux/amd64` (the architecture the Lambda runtime expects):

```bash
cd /Users/kelvinwhf/workspace/python_pvp_platform

docker build \
  --platform linux/amd64 \
  -t python-pvp-simulator \
  ./simulator

# Tag for ECR
docker tag python-pvp-simulator \
  "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${REPO}:latest"
```

### 5.4 Push to ECR

```bash
docker push "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${REPO}:latest"
echo "Image pushed: ${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${REPO}:latest"
```

---

## Step 6 — Create the Lambda Function

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=ap-southeast-1
REPO=python-pvp-simulator

aws lambda create-function \
  --function-name python-pvp-simulator \
  --description "Runs player-vs-player battles for python_pvp_platform" \
  --package-type Image \
  --code ImageUri="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${REPO}:latest" \
  --role "arn:aws:iam::${ACCOUNT_ID}:role/python-pvp-simulator" \
  --runtime python3.12 \
  --timeout 60 \
  --memory-size 512 \
  --architectures x86_64 \
  --region ${REGION}
```

| Setting | Value | Why |
|---|---|---|
| `timeout: 60` | 60 seconds | A battle should finish in well under 60s. If it hits this, something is wrong (e.g. infinite loop in a strategy), and SQS's visibility timeout (360s) gives plenty of headroom before redelivery. |
| `memory-size: 512` | 512 MB | The game uses numpy + opencv; 512 MB is comfortable. CPU scales with memory. |
| `architectures: x86_64` | x86_64 | Build used `--platform linux/amd64`. |
| `runtime: python3.12` | Python 3.12 | Matches the base image. |

---

## Step 7 — Configure the Lambda Environment Variables

The Lambda reads these at runtime. The simplest way to set them is via the Lambda's env block; for production use, store the secrets in SSM Parameter Store and inject them via the Lambda's configuration (Environment → Environment variables → Manage environment variables → choose from SSM parameters).

| Variable | Example value | Notes |
|---|---|---|---|
| `RUNNING_MODE` | `production` | Always `production` for deployed Lambda. `test` is only for local RIE testing. |
| `S3_BUCKET` | `python-pvp-store` | The bucket name; no S3 endpoint or region is needed — boto3 resolves from the execution role. |
| `LAMBDA_CALLBACK_BASE_URL` | `https://api.yourdomain.com` | The API server's public HTTPS URL. Must be reachable from Lambda over the internet. |
| `LAMBDA_CALLBACK_TOKEN` | `<root-session-uuid>` | Root Bearer token for API callback auth. Create a permanent `user_session` row or use a long-lived token. Treat as a secret. |
| `LAMBDA_CALLBACK_TIMEOUT` | `10` | Per-request timeout in seconds. The API server should respond in <1s; 10s is a generous buffer. |

```bash
aws lambda update-function-configuration \
  --function-name python-pvp-simulator \
  --environment 'Variables={
    "RUNNING_MODE=production",
    "S3_BUCKET=python-pvp-store",
    "LAMBDA_CALLBACK_BASE_URL=https://api.yourdomain.com",
    "LAMBDA_CALLBACK_TOKEN=<root-session-uuid>",
    "LAMBDA_CALLBACK_TIMEOUT=10"
  }' \
  --region ap-southeast-1
```

> **Security note on `LAMBDA_CALLBACK_TOKEN`:** This is a long-lived root credential. In production, store it in AWS Secrets Manager and grant the Lambda `secretsmanager:GetSecretValue` so you can reference it as `{{resolve:secretsmanager:LAMBDA_CALLBACK_TOKEN}}` instead of putting it in plain text in the environment variables. For SSM-based injection, the same principle applies — store as `SecureString` and reference via the SSM parameter ARN.

---

## Step 8 — Create the SQS Event Source Mapping

This connects the queue to the Lambda, so messages on the queue automatically trigger invocations.

```bash
# Get the queue ARN (needed for the event source mapping)
QUEUE_ARN=$(aws sqs get-queue-attributes \
  --queue-url https://sqs.ap-southeast-1.amazonaws.com/<account>/python-pvp-battle-queue \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text \
  --region ap-southeast-1)

aws lambda create-event-source-mapping \
  --function-name python-pvp-simulator \
  --event-source-arn "${QUEUE_ARN}" \
  --batch-size 1 \
  --maximum-batching-window-in-seconds 0 \
  --filter-criteria '{}' \
  --destination-config OnFailure={Destination=arn:aws:sqs:ap-southeast-1:<account>:python-pvp-battle-dlq} \
  --region ap-southeast-1
```

| Setting | Value | Why |
|---|---|---|
| `batch-size: 1` | 1 message per invocation | Each battle is a heavy, independent job. Batching more would complicate partial-failure handling. |
| `maximum-batching-window-in-seconds: 0` | No batching wait | SQS invokes the Lambda as soon as a message is available. Maximum responsiveness. |
| `filter-criteria: '{}'` | No message filtering | All messages in the queue are valid battle jobs. |
| `OnFailure: DLQ` | DLQ arn | Failed invocations after `maxReceiveCount` retries go to the DLQ; you can inspect or replay them. |

> **What happens when the Lambda is triggered:** The SQS event source mapping delivers the message body as the Lambda's `event` argument. The handler's `extract_payload()` function unwraps it (see `docker-image/handler.py`). The expected message body (the JSON payload) is:
> ```json
> {
>   "battle_id":       "<uuid>",
>   "competition_id":  "<uuid>",
>   "is_test":         true,
>   "a_user_id":       "<uuid>",
>   "b_user_id":       "<uuid>",
>   "a_snapshot_id":   "<uuid>",
>   "b_snapshot_id":   "<uuid>"
> }
> ```

Verify the event source mapping was created:

```bash
aws lambda list-event-source-mappings \
  --function-name python-pvp-simulator \
  --query 'EventSourceMappings[*].{UUID:UUID,State:State,BatchSize:BatchSize}' \
  --output table \
  --region ap-southeast-1
```

The state will be `Pending` initially, then move to `Active` (may take a minute or two).

---

## Step 9 — Verify the Deployment

### 9.1 Check the Lambda is active

```bash
aws lambda get-function-configuration \
  --function-name python-pvp-simulator \
  --query '{State:State,MemorySize:MemorySize,Timeout:Timeout}' \
  --output json \
  --region ap-southeast-1
```

State should be `Active`. If it shows `Pending`, wait ~30 seconds and retry.

### 9.2 Check the event source mapping

```bash
aws lambda list-event-source-mappings \
  --function-name python-pvp-simulator \
  --query 'EventSourceMappings[0].{UUID:UUID,State:State,BatchSize:BatchSize}' \
  --output json \
  --region ap-southeast-1
```

State should be `Enabled` and `Active`.

### 9.3 Send a test message to the queue (dry-run verification)

This verifies the end-to-end path without going through the API server:

```bash
BATTLE_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
SIMULATION_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
GAME_ID=$(python3 -c "import uuid; print(uuid.uuid4())")  # replace with real game_id from DB

TEST_PAYLOAD='{
  "battle_id": "'"${BATTLE_ID}"'",
  "simulation_id": "'"${SIMULATION_ID}"'",
  "game_id": "'"${GAME_ID}"'",
  "a_user_id": "00000000-0000-0000-0000-000000000001",
  "b_user_id": "00000000-0000-0000-0000-000000000002",
  "a_code_id": "00000000-0000-0000-0000-000000000010",
  "b_code_id": "00000000-0000-0000-0000-000000000011"
}'

aws sqs send-message \
  --queue-url https://sqs.ap-southeast-1.amazonaws.com/<account>/python-pvp-battle-queue \
  --message-body "${TEST_PAYLOAD}" \
  --region ap-southeast-1
```

Within a few seconds, the Lambda should be invoked. Check CloudWatch Logs:

```bash
# Find the latest log stream for the function
LOG_GROUP=$(aws lambda get-function-configuration \
  --function-name python-pvp-simulator \
  --query 'LogGroup' \
  --output text \
  --region ap-southeast-1)

STREAM=$(aws logs describe-log-streams \
  --log-group-name "${LOG_GROUP}" \
  --order-by LastEventTime \
  --descending \
  --limit 1 \
  --query 'logStreams[0].logStreamName' \
  --output text \
  --region ap-southeast-1)

aws logs get-log-events \
  --log-group-name "${LOG_GROUP}" \
  --log-stream-name "${STREAM}" \
  --limit 50 \
  --query 'events[*].message' \
  --output text \
  --region ap-southeast-1
```

Expected outcomes:

| Scenario | Log message | DB state |
|---|---|---|
| Success | `simulation <id> completed` | `app.simulation_job` has a `completed` row with winner/loser info |
| Game not in S3 | `failed to import game: <game_id>` → `markFailed` | `app.simulation_job` has a `failed` row with `execution_log` |
| Code ID not found | `code not found: <code_id>` → `markFailed` | `app.simulation_job` has a `failed` row |
| API server unreachable | `SIM_API_BASE_URL is not set` / connection error | `app.simulation_job` stays `pending`; check Lambda env vars |

The test message will write to the DLQ after 3 failed retries if the game or code IDs are fake — normal and expected when dry-running with made-up UUIDs.

---

## Runtime Environment Variable Reference

| Variable | Required | Default | Description |
|---|---|---|---|---|
| `RUNNING_MODE` | Yes | `production` | `production` → uses `clients/` (boto3 S3 + HTTP API dbClient). `test` → uses `testClients/` (local file doubles). Always `production` on Lambda. |
| `S3_BUCKET` | Yes | `python-pvp-store` | S3 bucket name. No path prefixes here — keys are constructed in `handler.py`. |
| `LAMBDA_CALLBACK_BASE_URL` | Yes | — | Full base URL of the API server, e.g. `https://api.yourdomain.com`. The Lambda calls this over HTTPS to access `/competition/*`, `/admin/snapshot/*`, `/admin/battle/*`. Must be reachable from Lambda. |
| `LAMBDA_CALLBACK_TOKEN` | Yes | — | Root Bearer token for API callback auth. Create a permanent `user_session` row with `urole=root`. |
| `LAMBDA_CALLBACK_TIMEOUT` | No | `10` | Per-request timeout in seconds for API calls. The API should respond in <1s; 10s is a generous safety margin. |
| `WORK_DIR` | No | `/tmp` | Working directory root. Lambda only allows writes to `/tmp`; do not change this. |

---

## SQS Message Payload Reference

The Lambda expects SQS message bodies to be valid JSON strings containing the battle event. This is the shape the API server sends when a battle is created:

```json
{
  "battle_id":       "e9d84a2b-...-uuid",
  "competition_id":  "a0c71a1c-...-uuid",
  "is_test":         false,
  "a_user_id":       "b1d82e3f-...-uuid",
  "b_user_id":       "c2e93f4a-...-uuid",
  "a_snapshot_id":   "d3f04a5b-...-uuid",
  "b_snapshot_id":   "e4a15b6c-...-uuid"
}
```

| Field | Source in API | Notes |
|---|---|---|
| `battle_id` | `app.battle.id` | Stable across re-runs; the logical match identity. |
| `competition_id` | `app.competition.id` | Used to fetch competition (game_reference for S3 download). |
| `is_test` | boolean | True = vs NPC, false = vs another user. |
| `a_user_id` | Caller's `user_id` from session | |
| `b_user_id` | Opponent's `user_id` from DB (or NPC's) | |
| `a_snapshot_id` | Latest `app.snapshot.id` for caller's linked code | Frozen at battle creation time. |
| `b_snapshot_id` | Latest `app.snapshot.id` for opponent's linked code (or NPC's) | Frozen at battle creation time. |

---

## S3 Key Reference

| Operation | S3 Key | Written by |
|---|---|---|---|
| Download (game definition) | `game/<game_reference>/game.py` | Admin (competition.game_reference) |
| Upload (replay video) | `output/<battle_id>.mp4` | Lambda (after each battle) |

`video_reference` stored in `app.battle` is the S3 key (`output/<battle_id>.mp4`), not a full URL. The frontend constructs the URL or uses a signed download.

---

## Updating and Redeploying

When you update `handler.py`, `clients/`, or any code under `docker-image/`:

```bash
# 1. Rebuild and push (from repo root)
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=ap-southeast-1
REPO=python-pvp-simulator

docker build --platform linux/amd64 -t python-pvp-simulator ./simulator
docker tag python-pvp-simulator:latest "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${REPO}:latest"
docker push "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${REPO}:latest"

# 2. Update the Lambda's image reference
aws lambda update-function-code \
  --function-name python-pvp-simulator \
  --image-uri "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${REPO}:latest" \
  --region ${REGION}

# The function enters "Pending" state while it pulls the new image.
# The event source mapping remains active throughout.
# First invocation after update may be slightly slower (cold start with new image).
```

**No environment variable changes are needed** for code-only updates unless you added a new env var.

**No SQS or IAM changes are needed** for code-only updates.

---

## Common Issues and Troubleshooting

### Lambda returns `statusCode: 500` immediately

Check the Lambda's CloudWatch Logs for the error message. Common causes:

```
# Symptom: "LAMBDA_CALLBACK_BASE_URL is not set"
# Fix: Set LAMBDA_CALLBACK_BASE_URL in Lambda environment variables (Step 7)

# Symptom: "LAMBDA_CALLBACK_TOKEN is not set"
# Fix: Set LAMBDA_CALLBACK_TOKEN in Lambda environment variables (Step 7)

# Symptom: "snapshot not found: <id>"
# Fix: The snapshot_id in the SQS message doesn't exist in app.snapshot.
#      Check that the battle was created correctly and both players have code snapshots.

# Symptom: "failed to import game"
# Fix: No file at the S3 key stored in competition.game_reference.
#      Upload the game definition (Step 4) or check the competition's game_reference.
```

### Lambda times out (statusCode: 500, `execution_log: ...TimeoutError`)

The match ran longer than 60 seconds. This usually means a strategy module's `update` function is blocking or looping. Check the execution log for the last printed game state. The DLQ receives the message after 3 such timeouts.

### Replay video not in S3 but job shows `completed`

Check the Lambda logs for the S3 upload error (e.g. permission denied). The IAM policy attached in Step 3 grants `s3:PutObject` on `python-pvp-store/*`. Verify the role is attached to the Lambda:

```bash
aws lambda get-function-configuration \
  --function-name python-pvp-simulator \
  --query 'Role' \
  --output text \
  --region ap-southeast-1
```

### Event source mapping state is `Disabled`

The mapping was disabled (possibly manually, or after too many failed invocations). Re-enable it:

```bash
UUID=$(aws lambda list-event-source-mappings \
  --function-name python-pvp-simulator \
  --query 'EventSourceMappings[0].UUID' \
  --output text \
  --region ap-southeast-1)

aws lambda update-event-source-mapping \
  --uuid "${UUID}" \
  --enabled \
  --region ap-southeast-1
```

### Messages pile up in the queue, Lambda is idle

Check the event source mapping state is `Enabled` and `Active`. If the Lambda is active but not consuming, check its concurrency limit:

```bash
aws lambda get-function-configuration \
  --function-name python-pvp-simulator \
  --query '{ReservedConcurrentExecutions:ReservedConcurrentExecutions,State:State}' \
  --output json \
  --region ap-southeast-1
```

If `ReservedConcurrentExecutions` is set to 0, the function is explicitly blocked. Remove the reservation:

```bash
aws lambda delete-function-concurrency \
  --function-name python-pvp-simulator \
  --region ap-southeast-1
```

### API server returns 403 on endpoints

The `LAMBDA_CALLBACK_TOKEN` may be wrong or expired. Verify:
1. The token matches a valid `user_session.id` for a root user in the DB.
2. The SSM Parameter Store value (`/python_pvp/api/LAMBDA_CALLBACK_TOKEN`) is up to date.
3. The Lambda's env var reflects the current value (update the env var after changing SSM).

### Lambda cannot reach the API server

The API server must be publicly accessible over HTTPS (port 443). Check:
1. The API server EC2 is running and nginx is up: `sudo systemctl status nginx` on the box.
2. Security group for the API EC2 allows inbound 443 from `0.0.0.0/0`.
3. DNS for the API domain resolves correctly.
4. TLS certificate is valid (`curl -v https://api.yourdomain.com` should succeed).

---

## Infrastructure Summary

```
AWS Account
├── S3: python-pvp-store
│   ├── game/<game_id>/game.py          (admin uploads)
│   └── output/<simulation_id>.mp4      (Lambda writes)
│
├── SQS
│   ├── python-pvp-battle-queue         (Lambda consumes, API enqueues)
│   │   └── RedrivePolicy: maxReceiveCount=3 → python-pvp-battle-dlq
│   └── python-pvp-battle-dlq           (Lambda on-failure destination)
│
├── Lambda: python-pvp-simulator
│   ├── Package: ECR image (python-pvp-simulator:latest)
│   ├── Role: python-pvp-simulator
│   │   ├── AWSLambdaSQSQueueExecutionRole  (SQS consume/delete)
│   │   ├── python-pvp-store-rw-policy      (S3 get/put)
│   │   └── AWSLambdaBasicExecutionRole     (CloudWatch logs)
│   ├── Event Source Mapping: python-pvp-battle-queue → BatchSize=1
│   └── Env: RUNNING_MODE, S3_BUCKET, LAMBDA_CALLBACK_BASE_URL, LAMBDA_CALLBACK_TOKEN, LAMBDA_CALLBACK_TIMEOUT
│
└── IAM
    ├── Role: python-pvp-simulator       (Lambda execution role)
    └── Policy: python-pvp-store-rw-policy (S3 get/put on python-pvp-store/*)
```