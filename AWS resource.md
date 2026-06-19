VPC: 
* python-pvp-vpc
subnet groups: 
* python-pvp-public
* python-pvp-private
* python-pvp-private-b
Internet gateway
* python-pvp-igw
Security groups
* python-pvp-db-sg (must allow inbound from vpc)
* python-pvp-jumpbox
RDS subnet group
* python-pvp-db-subnet-group
RDS 
* python-pvp-db
EC2 key pair
* python-pvp-ec2
EC2
* python-pvp-jumpbox 


Lambda
* python-pvp-simulator
  - NOT in a VPC. It used to run inside python-pvp-vpc only for direct RDS
    access. DB access now goes through the API server over HTTPS, so the
    Lambda runs in the AWS-managed (no-VPC) network and reaches S3, SQS and the
    API server over the public internet. This removes the need for VPC
    endpoints / NAT and improves cold-start time.
IAM Role
* python-pvp-simulator
IAM Policy
* python-pvp-store-rw-policy
S3 bucket
* python-pvp-store


SQS queue (battle jobs; API sends, Lambda consumes)
* python-pvp-battle-queue
  - Type: Standard (ordering not needed; simulation is idempotent so at-least-once delivery is fine)
  - Visibility timeout: >= Lambda timeout, recommended ~6x (e.g. Lambda 60s -> visibility 360s).
    Must exceed the function timeout or SQS will redeliver while a battle is still running.
  - Redrive policy: maxReceiveCount = 3, dead-letter target = python-pvp-battle-dlq
SQS dead-letter queue (failed battle jobs parked for inspection)
* python-pvp-battle-dlq
  - Type: Standard
  - Holds messages that failed maxReceiveCount times (e.g. player code that always crashes)

Lambda event source mapping (SQS -> simulator Lambda)
* python-pvp-battle-queue -> python-pvp-simulator
  - BatchSize: 1 (one battle per invocation; no partial-batch-failure handling needed)
  - On success the message is auto-deleted; on throw/timeout it is retried until maxReceiveCount, then DLQ'd



IAM Policy additions
* python-pvp-battle-queue-send-policy
  - Attached to the API server's principal (EC2 instance role / credentials it runs under)
  - Grants sqs:SendMessage on python-pvp-battle-queue (so POST /api/battle can enqueue a job)
* python-pvp-simulator role: attach AWSLambdaSQSQueueExecutionRole (AWS managed)
  - Grants sqs:ReceiveMessage / sqs:DeleteMessage / sqs:GetQueueAttributes on the queue,
    required for the event source mapping to poll and consume messages

API server EC2 instance role + policy
* EC2 instance role: python-pvp-api-server
  - Attach to the EC2 instance that runs the API server. Grants the minimum
    permissions needed: sqs:SendMessage + SSM Parameter Store read.
  - Trust policy: allows ec2.amazonaws.com to assume this role.
* Inline policy: python-pvp-api-server-policy  (see deploy/api-server-policy.json)
  - sqs:SendMessage on python-pvp-battle-queue
  - ssm:GetParameter + ssm:GetParameters on the /python_pvp/api/ SSM paths
  - Region and account are substituted at deploy time (see the ${AWS_REGION} /
    ${AWS_ACCOUNT_ID} placeholders in the policy JSON).

SSM Parameter Store setup (run once, or re-run to rotate secrets)
* Create the following parameters in the same region as the EC2 (ap-southeast-1).
  SecureString values are encrypted server-side; IAM controls access, not the
  encryption algorithm. Replace <value> with the actual secrets.
```
# Non-sensitive config (String)
aws ssm put-parameter --name /python_pvp/api/DB_USER \
    --value python_pvp_admin --type String
aws ssm put-parameter --name /python_pvp/api/DB_HOST \
    --value <rds-endpoint> --type String
aws ssm put-parameter --name /python_pvp/api/DB_PORT \
    --value 5432 --type String
aws ssm put-parameter --name /python_pvp/api/DB_NAME \
    --value python_pvp --type String
aws ssm put-parameter --name /python_pvp/api/BATTLE_QUEUE_URL \
    --value https://sqs.ap-southeast-1.amazonaws.com/<account>/python-pvp-battle-queue \
    --type String
aws ssm put-parameter --name /python_pvp/api/AWS_REGION \
    --value ap-southeast-1 --type String

# Sensitive secrets (SecureString — values not echoed to shell history)
aws ssm put-parameter --name /python_pvp/api/DB_PASSWORD \
    --value '<db-password>' --type SecureString
aws ssm put-parameter --name /python_pvp/api/MASTER_KEY \
    --value '<master-key>' --type SecureString
aws ssm put-parameter --name /python_pvp/api/SIM_API_TOKEN \
    --value '<simulator-service-session-id>' --type SecureString
```
  The simulator service token (SIM_API_TOKEN) is the user_session id from
  database/4. service-account.sql (default: 00000000-0000-0000-0000-000000000002).
* IAM requirement: the EC2 instance role (python-pvp-api-server) must have
  ssm:GetParameter + ssm:GetParameters on these paths (granted by the inline
  policy above).
* Rotation: update a parameter in place; on the next service restart the new
  value is fetched. For the SIM_API_TOKEN, also update the seeded row in the DB.

API server (DB access proxy for the Lambda)
* The simulator Lambda no longer connects to RDS. It calls the API's
  /api/internal endpoints (getCode, simulation-job/pending|complete|failed),
  which run the SQL through the shared pg.Pool. This bounds RDS connections to
  the pool size (utils/db.js, max 10) instead of scaling with Lambda concurrency.
* The API server MUST therefore be reachable from the Lambda over HTTPS, i.e.
  it needs a public endpoint (public ALB, or a public EC2 host with TLS). The
  /api/internal routes are root-only and authenticated with the service token,
  so exposing them publicly is acceptable, but keep them behind HTTPS.
* RDS security group (python-pvp-db-sg) no longer needs to allow the Lambda;
  it only needs to allow the API server (and the jumpbox tunnel for admin).

Simulator service account + auth (see database/4. service-account.sql)
* A long-lived 'root' user 'simulator-service' with a non-expiring
  user_session row. Login is disabled (no valid password hash); the only
  credential is the session token.
* Set on the Lambda as env vars:
  - SIM_API_BASE_URL : base URL of the API server (e.g. https://api.example.com)
  - SIM_API_TOKEN    : the user_session id from the seed (treat as a secret;
                       prefer storing via Lambda env encryption / Secrets Manager)
  - SIM_API_TIMEOUT  : optional per-request timeout seconds (default 10)
* Rotate the token by replacing the seeded user_session row.


jumpbox config
```
sudo apt update
sudo apt install postgresql-client
```

open ssh tunnel to db
```
ssh -i sensitive/python-pvp-ec2.pem -N -L 5433:python-pvp-db.cpwowc44igh2.ap-southeast-1.rds.amazonaws.com:5432 ubuntu@47.129.132.2
```