# Security

## Secrets that must never be committed

| File | Contents | Gitignored? |
|---|---|---|
| `servers/api/.env` | DB password, master key | ✅ yes (`*.env`) |
| `servers/api/alpha.env` | Same as `.env` — should not exist | ✅ deleted |
| `sensitive/.env` | Alibaba Cloud access key + secret | ✅ yes (`sensitive/`) |
| `sensitive/python-pvp-ec2.pem` | SSH private key | ✅ yes (`sensitive/`) |
| Any `*.pem`, `*.key`, `*.crt` | Private keys / certificates | ✅ yes (`.gitignore` wildcard) |

The `.gitignore` covers: `*.env`, `sensitive/`, `*.pem`, `*.key`, `*.crt`, `node_modules/`, `__pycache__/`, `.DS_Store`, `.venv/`.

If you ever accidentally commit a secret:
1. Rotate the credential immediately (before the commit is pushed or as soon after as possible).
2. Remove the file from git history: `git filter-repo --path <file> --invert-paths` or ask GitHub/GitLab support to remove it from history.
3. Force-push to override history.

## Runtime secret management

### API server (EC2)

The API server on EC2 reads secrets from AWS SSM Parameter Store at startup (via `deploy/load-ssm-secrets.sh` as a `systemd ExecStartPre`). No secret files live on disk.

**SSM Parameter Store path convention:**
```
/python_pvp/api/DB_USER          — String
/python_pvp/api/DB_PASSWORD      — SecureString
/python_pvp/api/DB_HOST          — String
/python_pvp/api/DB_PORT          — String
/python_pvp/api/DB_NAME          — String
/python_pvp/api/MASTER_KEY       — SecureString
/python_pvp/api/BATTLE_QUEUE_URL — String
/python_pvp/api/AWS_REGION       — String
/python_pvp/api/SIM_API_TOKEN    — SecureString
```

The EC2 instance role (`python-pvp-api-server`) has an IAM policy (`deploy/api-server-policy.json`) that grants `ssm:GetParameter` and `ssm:GetParameters` only on these specific paths.

**To rotate a secret:**
```bash
# Update the SSM parameter
aws ssm put-parameter --name /python_pvp/api/DB_PASSWORD \
  --value '<new-password>' --type SecureString --overwrite --region ap-southeast-1

# Restart the API server so it picks up the new value
sudo systemctl restart python-pvp-api
```

### Simulator Lambda

The Lambda authenticates to the API server with a long-lived session token (`SIM_API_TOKEN`). It is set as a Lambda environment variable (or referenced from Secrets Manager via `{{resolve:secretsmanager:...}}`).

**The token** is the `id` column of the `user_session` row for `simulator-service` in `database/4. service-account.sql` (default: `00000000-0000-0000-0000-000000000002`).

**To rotate the token:**
1. In the database: `UPDATE app.user_session SET id = '<new-uuid>' WHERE user_id = '00000000-0000-0000-0000-000000000001';`
2. In SSM: `aws ssm put-parameter --name /python_pvp/api/SIM_API_TOKEN --value '<new-uuid>' --type SecureString --overwrite --region ap-southeast-1`
3. In Lambda env: update the `SIM_API_TOKEN` environment variable.

## Network security

### API server (public HTTPS)

The API server must be publicly reachable on HTTPS (port 443) because the Lambda calls it from outside the VPC over the internet. TLS is enforced via nginx + Let's Encrypt (certbot) or an ALB.

The `/api/internal/*` routes are:
- Only accessible with a valid `Authorization: Bearer <token>` header.
- The token must belong to a `urole = 'root'` user (`simulator-service`).
- The connection is encrypted (HTTPS).

### RDS security group

The RDS security group (`python-pvp-db-sg`) only needs to allow port 5432 from:
- The API server EC2's security group (application access).
- The jumpbox EC2 (admin tunnel access).

The Lambda has **no direct RDS access** — it goes through the API server, so no RDS SG rule for the Lambda is needed.

### Lambda network

The Lambda runs in the AWS-managed network (no VPC). It reaches:
- `api.yourdomain.com` — HTTPS, port 443
- `s3.amazonaws.com` — HTTPS, port 443
- `sqs.ap-southeast-1.amazonaws.com` — HTTPS, port 443

No VPC gateway endpoints or NAT gateways are needed.

## IAM least privilege

| Principal | Policy | Permissions |
|---|---|---|
| API server EC2 role | `deploy/api-server-policy.json` | `sqs:SendMessage` on `python-pvp-battle-queue`; `ssm:GetParameter` on `/python_pvp/api/*` |
| Lambda execution role | `AWSLambdaSQSQueueExecutionRole` (AWS managed) | `sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes` |
| Lambda execution role | `python-pvp-store-rw-policy` (custom) | `s3:GetObject`, `s3:PutObject` on `arn:aws:s3:::python-pvp-store/*` |
| Lambda execution role | `AWSLambdaBasicExecutionRole` (AWS managed) | CloudWatch logs |
| Simulator service account | Session auth via DB | Root role in the API; only usable via the session token |

## Dependency vulnerabilities

After any `npm install` or `pip install`, run the audit tool:

```bash
# Node.js
cd servers/api && npm audit

# Python (Lambda dependencies)
pip install safety || pip install pip-audit
```

The Lambda image has no OS-level dependency on the application VPC, so vulnerabilities in Lambda layers or base image are managed by AWS. Keep the base image updated by rebuilding and pushing new images periodically.