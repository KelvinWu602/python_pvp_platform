# AWS Deployment Guide

End-to-end deployment from a fresh AWS account to a fully working Python PvP
platform. **Region: `ap-southeast-1`**, **AWS account: `097142190893`**.

## Architecture

```
Internet ──HTTPS:443──► nginx (EC2) ──proxy──► node server.js (127.0.0.1:3000)
                         │
                         ├── pg.Pool ─── SSH tunnel ──► RDS (python-pvp-db)
                         │                               app schema (9 tables)
                         └── SQS SendMessage ──► python-pvp-battle-queue
                                                     │
                                                     ▼
                                             python-pvp-simulator (Lambda)
                                                     │
                                                     ├── GET /admin/snapshot/:id
                                                     ├── GET /competition/:id
                                                     ├── S3 download game/*/game.py
                                                     ├── run match → S3 upload output/*.mp4
                                                     └── PUT /admin/battle/:id
                                                     
                                                     On failure (3 retries):
                                                     
                                             python-pvp-battle-dlq
                                                     │
                                                     ▼
                                             python-pvp-simulator-dlq (Lambda)
                                                     └── PUT /admin/battle/:id (infra_ok=false)
```

**Key principles:**
- Lambda has **no direct DB access** — all data goes through the API server via HTTPS.
- Secrets are **scp'd as a .env file** on first deploy (no SSM Parameter Store).
- The API server is **publicly reachable** so the Lambda can call it from the AWS-managed network.

---

## Section 1: Database Migration (RDS)

Assumes RDS is already created. Connect via SSH tunnel through the EC2 jumpbox.

### 1.1 — Install psql client (macOS)

```bash
brew install libpq
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
```

### 1.2 — Create SSH tunnel

```bash
ssh -i sensitive/python-pvp-ec2.pem -N \
  -L 5433:python-pvp-db.cpwowc44igh2.ap-southeast-1.rds.amazonaws.com:5432 \
  ubuntu@13.212.111.107
```

Keep this terminal open. In another terminal, run the migrations.

### 1.3 — Run migrations in order

```bash
# Migration 1: create role + database (run once, against default db)
psql --host localhost --port 5433 --username postgres -W \
  -f database/1.\ create-db.sql

# Migration 2: create schema + tables
psql --host localhost --port 5433 --dbname python_pvp \
  --username python_pvp_admin -W \
  -f database/2.\ init-db.sql

# Migration 3: UUID extensions + auto-generate defaults
psql --host localhost --port 5433 --dbname python_pvp \
  --username python_pvp_admin -W \
  -f database/3.\ extension.sql

# Migration 4: triggers (auto-update updated_at_utc)
psql --host localhost --port 5433 --dbname python_pvp \
  --username python_pvp_admin -W \
  -f database/4.\ triggers.sql

# Migration 5: indexes
psql --host localhost --port 5433 --dbname python_pvp \
  --username python_pvp_admin -W \
  -f database/5.\ indexes.sql
```

### 1.4 — Create a root user for the Lambda callback token

The Lambda authenticates to the API with a root `user_session` token. Create a
dedicated service-account root user and a permanent session for it.

```bash
psql "host=localhost port=5433 dbname=python_pvp user=python_pvp_admin sslmode=require"
```

```sql
INSERT INTO app.user (username, full_name, hash_password, urole)
VALUES ('lambda-callback', 'Lambda Callback Service', 'x', 'root');

-- Create a permanent session token for the Lambda.
-- Save this UUID — you'll use it as LAMBDA_CALLBACK_TOKEN later.
INSERT INTO app.user_session (user_id, expire_at_utc)
SELECT id, '2099-12-31' FROM app.user WHERE username = 'lambda-callback'
RETURNING id;
```

Keep this terminal for seeding test data later (Section 5).

---

## Section 2: API Server (EC2)

Provision an EC2 instance to run the Express API behind nginx.

### 2.1 — Create IAM role for the EC2 instance

The instance only needs `sqs:SendMessage` (to enqueue battle jobs). No SSM
permissions needed since we're scp-ing the .env file directly.

```bash
REGION=ap-southeast-1
ACCOUNT=097142190893

# Trust policy
cat > /tmp/ec2-trust.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "ec2.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
JSON

aws iam create-role --role-name python-pvp-api-server \
  --assume-role-policy-document file:///tmp/ec2-trust.json

# SQS send permission (enqueue battles)
aws iam put-role-policy --role-name python-pvp-api-server \
  --policy-name sqs-send \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["sqs:SendMessage"],
      "Resource": "arn:aws:sqs:ap-southeast-1:'$ACCOUNT':python-pvp-battle-queue"
    }]
  }'

aws iam create-instance-profile --instance-profile-name python-pvp-api-server
aws iam add-role-to-instance-profile \
  --instance-profile-name python-pvp-api-server \
  --role-name python-pvp-api-server
```

### 2.2 — Launch EC2 instance

From the AWS Console or CLI:

- **AMI:** Ubuntu Server 24.04 LTS
- **Type:** `t3.small` (or `t3.micro` for light load)
- **Subnet:** `python-pvp-public` (needs public IP for internet access)
- **IAM instance profile:** `python-pvp-api-server`
- **Security group** (create `python-pvp-api-sg`):
  - `22/tcp` from your IP only
  - `443/tcp` from `0.0.0.0/0`
  - `3000/tcp` from `0.0.0.0/0` (for now — remove after nginx is set up)
- **Key pair:** `python-pvp-ec2`

Also ensure the RDS security group (`python-pvp-db-sg`) allows inbound on port
`5432` from the EC2 security group.

Note the public IP (e.g. `13.212.111.107`) for the next steps.

### 2.3 — SSH in and install dependencies

```bash
IP=13.212.111.107
ssh -i sensitive/python-pvp-ec2.pem ubuntu@$IP
```

```bash
sudo apt update && sudo apt upgrade -y

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git nginx

node --version   # expect v22.x
```

### 2.4 — Deploy the code

```bash
sudo mkdir -p /opt
sudo chown ubuntu:ubuntu /opt

cd /opt
git clone <your-repo-url> python_pvp_platform

cd /opt/python_pvp_platform/servers/api
npm ci --omit=dev
```

### 2.5 — Create the .env file

On your **local machine**, create `servers/api/.env.production`:

```bash
cat > servers/api/.env.production <<'ENV'
DB_USER=python_pvp_admin
DB_PASSWORD=<your-rds-password>
DB_HOST=python-pvp-db.cpwowc44igh2.ap-southeast-1.rds.amazonaws.com
DB_PORT=5432
DB_NAME=python_pvp
DB_MAX_CONN=25
DB_NO_SSL=true
AWS_REGION=ap-southeast-1
BATTLE_QUEUE_URL=https://sqs.ap-southeast-1.amazonaws.com/097142190893/python-pvp-battle-queue
PORT=3000
ENV
```

> **`DB_NO_SSL=true`**: The pg driver connects without SSL. If you want SSL
> (recommended for production), set it to `false` or omit the env var, and
> uncomment the `ssl` config in `utils/db.js`.

**scp it to the EC2:**

```bash
scp -i sensitive/python-pvp-ec2.pem \
  servers/api/.env.production \
  ubuntu@13.212.111.107:/tmp/api.env

# On the EC2:
ssh -i sensitive/python-pvp-ec2.pem ubuntu@13.212.111.107
sudo mkdir -p /etc/python_pvp
sudo mv /tmp/api.env /etc/python_pvp/api.env
sudo chmod 600 /etc/python_pvp/api.env
sudo chown appuser:appuser /etc/python_pvp/api.env  # user created next
```

### 2.6 — Create appuser and install systemd service

```bash
# Create unprivileged service account
sudo useradd --system --create-home --shell /usr/sbin/nologin appuser
sudo chown -R appuser:appuser /opt/python_pvp_platform

# Install the systemd unit (the version WITHOUT ExecStartPre SSM script)
sudo cp /opt/python_pvp_platform/deploy/python-pvp-api.service \
        /etc/systemd/system/python-pvp-api.service

# Need to add appuser read access to the env file (if not done above)
sudo chown appuser:appuser /etc/python_pvp/api.env

sudo systemctl daemon-reload
sudo systemctl enable --now python-pvp-api

# Verify
sudo systemctl status python-pvp-api --no-pager
journalctl -u python-pvp-api -n 20 --no-pager
```

Expected: `Server running on http://localhost:3000`.

### 2.7 — nginx reverse proxy (with TLS)

```bash
sudo tee /etc/nginx/sites-available/python-pvp-api >/dev/null <<'NGINX'
server {
    listen 80;
    server_name api.yourdomain.com;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        client_max_body_size 5m;
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/python-pvp-api /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

**TLS (optional but recommended for production):**

```bash
sudo certbot --nginx -d api.yourdomain.com \
  --non-interactive --agree-tos -m you@yourdomain.com
```

> Without TLS, set `LAMBDA_CALLBACK_BASE_URL=http://13.212.111.107:3000` later.
> The Lambda will call the API over the public internet without encryption.

### 2.8 — Smoke test the API

```bash
# From your local machine:
curl http://13.212.111.107:3000/competition
# Expect: 401 {"error":"Authorization header required"}

curl -X POST http://13.212.111.107:3000/public/user/session \
  -H 'Content-Type: application/json' \
  -d '{"username":"nobody","password":"x"}'
# Expect: 401 {"error":"Invalid credentials"}
```

These mean the server is running and the DB is connected.

---

## Section 3: Supporting Infrastructure

### 3.1 — S3 bucket

```bash
aws s3 mb s3://python-pvp-store --region ap-southeast-1

# Bucket layout:
#   s3://python-pvp-store/
#   ├── game/<game_reference>/game.py   (admin uploads)
#   └── output/<battle_id>.mp4          (Lambda writes)
```

### 3.2 — SQS queues

```bash
REGION=ap-southeast-1
ACCOUNT=097142190893

# Create DLQ first
aws sqs create-queue \
  --queue-name python-pvp-battle-dlq \
  --region $REGION \
  --attributes '{
    "MessageRetentionPeriod": "1209600",
    "VisibilityTimeout": "60"
  }'

DLQ_ARN=$(aws sqs get-queue-attributes \
  --queue-url https://sqs.$REGION.amazonaws.com/$ACCOUNT/python-pvp-battle-dlq \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text --region $REGION)

# Create main queue with redrive to DLQ
aws sqs create-queue \
  --queue-name python-pvp-battle-queue \
  --region $REGION \
  --attributes '{
    "MessageRetentionPeriod": "86400",
    "VisibilityTimeout": "360",
    "RedrivePolicy": "{\"maxReceiveCount\": 3, \"deadLetterTargetArn\": \"'"$DLQ_ARN"'\"}"
  }'

# Save the queue URL for the API server's .env
BATTLE_QUEUE_URL=$(aws sqs get-queue-url \
  --queue-name python-pvp-battle-queue \
  --query 'QueueUrl' --output text --region $REGION)
echo "BATTLE_QUEUE_URL=$BATTLE_QUEUE_URL"
```

### 3.3 — IAM roles for Lambdas

```bash
REGION=ap-southeast-1
ACCOUNT=097142190893
```

**Main simulator role:**

```bash
cat > /tmp/lambda-trust.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
JSON

aws iam create-role --role-name python-pvp-simulator \
  --assume-role-policy-document file:///tmp/lambda-trust.json

# SQS consume/delete
aws iam attach-role-policy --role-name python-pvp-simulator \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole

# CloudWatch logs
aws iam attach-role-policy --role-name python-pvp-simulator \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# S3 read/write
aws iam put-role-policy --role-name python-pvp-simulator \
  --policy-name python-pvp-store-rw \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::python-pvp-store/*"
    }]
  }'
```

**DLQ consumer role:**

```bash
aws iam create-role --role-name python-pvp-simulator-dlq \
  --assume-role-policy-document file:///tmp/lambda-trust.json

aws iam attach-role-policy --role-name python-pvp-simulator-dlq \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole

aws iam attach-role-policy --role-name python-pvp-simulator-dlq \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
```

### 3.4 — ECR repositories

```bash
aws ecr create-repository \
  --repository-name python-pvp-simulator \
  --region $REGION \
  --image-scanning-configuration scanOnPush=true || true

aws ecr create-repository \
  --repository-name python-pvp-simulator-dlq \
  --region $REGION \
  --image-scanning-configuration scanOnPush=true || true
```

---

## Section 4: Lambda Deployment

### 4.1 — Upload the game definition to S3

```bash
aws s3 cp games/2526_game/game.py \
  s3://python-pvp-store/games/2526/game.py \
  --region ap-southeast-1

aws s3 ls s3://python-pvp-store/games/2526/game.py
```

### 4.2 — Build & push the main simulator image

```bash
ACCOUNT=097142190893
REGION=ap-southeast-1
REPO=python-pvp-simulator

aws ecr get-login-password --region $REGION \
  | docker login --username AWS --password-stdin \
    "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"

docker build --platform linux/amd64 \
  -t $REPO simulator

docker tag $REPO:latest \
  "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$REPO:latest"

docker push "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$REPO:latest"
```

### 4.3 — Build & push the DLQ consumer image

```bash
ACCOUNT=097142190893
REGION=ap-southeast-1
REPO=python-pvp-simulator-dlq

docker build --platform linux/amd64 \
  -t $REPO -f dlq-consumer/Dockerfile dlq-consumer

docker tag $REPO:latest \
  "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$REPO:latest"

docker push "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$REPO:latest"
```

### 4.4 — Create the main simulator Lambda

```bash
ACCOUNT=097142190893
REGION=ap-southeast-1

aws lambda create-function \
  --function-name python-pvp-simulator \
  --package-type Image \
  --code ImageUri="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/python-pvp-simulator:latest" \
  --role "arn:aws:iam::$ACCOUNT:role/python-pvp-simulator" \
  --timeout 60 \
  --memory-size 512 \
  --architectures x86_64 \
  --region $REGION

# Set environment variables
aws lambda update-function-configuration \
  --function-name python-pvp-simulator \
  --region $REGION \
  --environment 'Variables={
    "RUNNING_MODE": "production",
    "S3_BUCKET": "python-pvp-store",
    "LAMBDA_CALLBACK_BASE_URL": "http://13.212.111.107:3000",
    "LAMBDA_CALLBACK_TOKEN": "<the-root-session-uuid-from-1.4>",
    "LAMBDA_CALLBACK_TIMEOUT": "10"
  }'
```

### 4.5 — Create the DLQ consumer Lambda

```bash
aws lambda create-function \
  --function-name python-pvp-simulator-dlq \
  --package-type Image \
  --code ImageUri="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/python-pvp-simulator-dlq:latest" \
  --role "arn:aws:iam::$ACCOUNT:role/python-pvp-simulator-dlq" \
  --timeout 30 \
  --memory-size 128 \
  --architectures x86_64 \
  --region $REGION

aws lambda update-function-configuration \
  --function-name python-pvp-simulator-dlq \
  --region $REGION \
  --environment 'Variables={
    "LAMBDA_CALLBACK_BASE_URL": "http://13.212.111.107:3000",
    "LAMBDA_CALLBACK_TOKEN": "<the-root-session-uuid-from-1.4>",
    "LAMBDA_CALLBACK_TIMEOUT": "10"
  }'
```

### 4.6 — Create SQS event source mappings

```bash
ACCOUNT=097142190893
REGION=ap-southeast-1

# Main queue → simulator
QUEUE_ARN=$(aws sqs get-queue-attributes \
  --queue-url https://sqs.$REGION.amazonaws.com/$ACCOUNT/python-pvp-battle-queue \
  --attribute-names QueueArn --query 'Attributes.QueueArn' \
  --output text --region $REGION)

aws lambda create-event-source-mapping \
  --function-name python-pvp-simulator \
  --event-source-arn "$QUEUE_ARN" \
  --batch-size 1 \
  --maximum-batching-window-in-seconds 0 \
  --region $REGION

# DLQ → DLQ consumer
DLQ_ARN=$(aws sqs get-queue-attributes \
  --queue-url https://sqs.$REGION.amazonaws.com/$ACCOUNT/python-pvp-battle-dlq \
  --attribute-names QueueArn --query 'Attributes.QueueArn' \
  --output text --region $REGION)

aws lambda create-event-source-mapping \
  --function-name python-pvp-simulator-dlq \
  --event-source-arn "$DLQ_ARN" \
  --batch-size 1 \
  --region $REGION
```

---

## Section 5: Verification

### 5.1 — Seed test data

Through the SSH tunnel (from Section 1.2), connect to the DB:

```bash
psql "host=localhost port=5433 dbname=python_pvp user=python_pvp_admin sslmode=require"
```

Run this seed script to create users, a competition, enrollments, and a battle:

```sql
BEGIN;

-- Need the root user ID (from section 1.4)
SELECT id AS root_user_id FROM app.user WHERE username = 'lambda-callback' \gset

-- Player users
INSERT INTO app.user (username, full_name, hash_password)
VALUES ('alice', 'Alice', 'x') RETURNING id AS a_user_id \gset
INSERT INTO app.user (username, full_name, hash_password)
VALUES ('bob', 'Bob', 'x') RETURNING id AS b_user_id \gset

-- NPC code + snapshot
INSERT INTO app.code (user_id, name) VALUES (:'root_user_id', '_npc_')
RETURNING id AS npc_code_id \gset
INSERT INTO app.snapshot (code_id, code) VALUES (:'npc_code_id',
$$def update(sensors, telemetry):
    return (0.0, 0.0)$$
) RETURNING id AS npc_snapshot_id \gset

-- Competition (game_reference matches the S3 key from 4.1)
INSERT INTO app.competition (
  npc_user_id, display_name, description,
  start_time_utc, end_time_utc,
  game_reference, helper_reference, manifest_reference
) VALUES (
  :'root_user_id', 'Test Comp', '',
  now() - interval '1 day', now() + interval '7 days',
  'games/2526/game.py', '', ''
) RETURNING id AS competition_id \gset

-- Enroll NPC (so test battles vs NPC work)
INSERT INTO app.enroll (competition_id, user_id)
VALUES (:'competition_id', :'root_user_id') RETURNING id AS npc_enroll_id \gset

-- Player enrollments
INSERT INTO app.enroll (competition_id, user_id)
VALUES (:'competition_id', :'a_user_id') RETURNING id AS a_enroll_id \gset
INSERT INTO app.enroll (competition_id, user_id)
VALUES (:'competition_id', :'b_user_id') RETURNING id AS b_enroll_id \gset

-- Player code + snapshots
INSERT INTO app.code (user_id, name) VALUES (:'a_user_id', 'aggressive')
RETURNING id AS a_code_id \gset
INSERT INTO app.snapshot (code_id, code) VALUES (:'a_code_id',
$$def update(sensors, telemetry):
    target = 9.0
    a1 = (target - telemetry['spin1']) * 6.0
    a2 = (target - telemetry['spin2']) * 6.0
    return (a1, a2)$$
) RETURNING id AS a_snapshot_id \gset

INSERT INTO app.code (user_id, name) VALUES (:'b_user_id', 'idle')
RETURNING id AS b_code_id \gset
INSERT INTO app.snapshot (code_id, code) VALUES (:'b_code_id',
$$def update(sensors, telemetry):
    return (0.0, 0.0)$$
) RETURNING id AS b_snapshot_id \gset

-- Link codes to enrollments
INSERT INTO app.code_select (enroll_id, code_id, user_id, competition_id)
VALUES (:'a_enroll_id', :'a_code_id', :'a_user_id', :'competition_id');
INSERT INTO app.code_select (enroll_id, code_id, user_id, competition_id)
VALUES (:'b_enroll_id', :'b_code_id', :'b_user_id', :'competition_id');

-- Link NPC code to NPC enrollment
INSERT INTO app.code_select (enroll_id, code_id, user_id, competition_id)
VALUES (:'npc_enroll_id', :'npc_code_id', :'root_user_id', :'competition_id');

COMMIT;

-- Print IDs for the test
SELECT
  :'a_user_id'       AS a_user_id,
  :'b_user_id'       AS b_user_id,
  :'competition_id'  AS competition_id,
  :'a_enroll_id'     AS a_enroll_id,
  :'b_enroll_id'     AS b_enroll_id;
```

### 5.2 — Authenticate and create a test battle

```bash
IP=13.212.111.107

# Login as Alice
AUTH_TOKEN=$(curl -s -X POST http://$IP:3000/public/user/session \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"x"}' | python3 -c \
  "import sys,json; print(json.load(sys.stdin).get('auth_token',''))")
echo "AUTH_TOKEN=$AUTH_TOKEN"
```

```bash
# Get Alice's enrollment ID
curl -s http://$IP:3000/enroll \
  -H "Authorization: Bearer $AUTH_TOKEN" | jq .
```

```bash
# Create a test battle vs NPC
A_ENROLL_ID="<paste-enroll-id-from-above>"

curl -s -X POST "http://$IP:3000/enroll/$A_ENROLL_ID/test" \
  -H "Authorization: Bearer $AUTH_TOKEN" | jq .
```

### 5.3 — Watch the Lambda execute

```bash
REGION=ap-southeast-1

# Tail CloudWatch logs
aws logs tail /aws/lambda/python-pvp-simulator --follow --region $REGION
```

Expected output includes:
```
battle_id       :<uuid>
competition_id  :<uuid>
...
battle <uuid> completed
```

### 5.4 — Verify the result

**Check the battle row in the DB:**

```bash
psql "host=localhost port=5433 dbname=python_pvp user=python_pvp_admin sslmode=require" -c "
SELECT id, infra_ok, input_ok, draw, winner_user_id, video_reference
FROM app.battle
WHERE a_user_id = (SELECT id FROM app.user WHERE username = 'alice')
ORDER BY created_at_utc DESC LIMIT 1;"
```

Expected: `infra_ok = true`, `input_ok = true`, `video_reference` set.

**Check the replay video in S3:**

```bash
BATTLE_ID=$(psql "host=localhost port=5433 dbname=python_pvp user=python_pvp_admin sslmode=require" -t -A -c "
SELECT video_reference FROM app.battle
WHERE a_user_id = (SELECT id FROM app.user WHERE username = 'alice')
  AND infra_ok = true
ORDER BY created_at_utc DESC LIMIT 1;")

aws s3 cp "s3://python-pvp-store/$BATTLE_ID" /tmp/replay.mp4 --region ap-southeast-1
open /tmp/replay.mp4
```

---

## Updating

### API server

```bash
ssh -i sensitive/python-pvp-ec2.pem ubuntu@13.212.111.107
cd /opt/python_pvp_platform
sudo git pull
cd servers/api
sudo npm ci --omit=dev
sudo systemctl restart python-pvp-api
```

### Lambda (code changes)

```bash
ACCOUNT=097142190893
REGION=ap-southeast-1

# Rebuild & push
docker build --platform linux/amd64 -t python-pvp-simulator simulator
docker tag python-pvp-simulator:latest \
  $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/python-pvp-simulator:latest
docker push $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/python-pvp-simulator:latest

# Update Lambda image
aws lambda update-function-code \
  --function-name python-pvp-simulator \
  --image-uri $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/python-pvp-simulator:latest \
  --region $REGION
```

Same process for the DLQ consumer (swap `python-pvp-simulator` → `python-pvp-simulator-dlq`).

### Database schema changes

Apply new migration files through the SSH tunnel:

```bash
psql "host=localhost port=5433 dbname=python_pvp user=python_pvp_admin sslmode=require" \
  -f database/<new-migration>.sql
```

---

## Operations Cheatsheet

| Task | Command |
|---|---|
| Tail API logs | `ssh ubuntu@$IP sudo journalctl -u python-pvp-api -f` |
| Restart API | `ssh ubuntu@$IP sudo systemctl restart python-pvp-api` |
| Tail Lambda logs | `aws logs tail /aws/lambda/python-pvp-simulator --follow` |
| Check DLQ messages | `aws sqs get-queue-attributes --queue-url <dlq-url> --attribute-names ApproximateNumberOfMessages` |
| Invoke Lambda directly | `aws lambda invoke --function-name python-pvp-simulator --payload fileb://event.json /tmp/out.json` |
| SSH tunnel for DB | `ssh -i sensitive/python-pvp-ec2.pem -N -L 5433:<rds-endpoint>:5432 ubuntu@$IP` |
| DB query | `psql "host=localhost port=5433 dbname=python_pvp user=python_pvp_admin sslmode=require" -c "SELECT ..."` |

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| API returns 500 on login | DB connection: check `.env` values, RDS security group allows EC2 |
| Lambda fails with API 403 | `LAMBDA_CALLBACK_TOKEN` doesn't match a valid root session in the DB |
| Lambda fails with "snapshot not found" | `a_snapshot_id`/`b_snapshot_id` in the SQS message don't exist in `app.snapshot` |
| Lambda fails with "failed to import game" | Game file not found at the S3 key from `competition.game_reference` |
| Lambda times out (60s) | Strategy `update()` is too slow or looping; check execution log |
| Messages pile up in queue | Event source mapping disabled, or Lambda concurrency set to 0 |
| Battle stays pending | Main Lambda crashed without calling callback → DLQ consumer should fire after 3 retries |
