# API Server Deployment Guide (Ubuntu EC2)

How to deploy the Express API server (`servers/api/`) on an Ubuntu host. The
process: provision an EC2 instance with an IAM role, install Node + the app,
store secrets in SSM Parameter Store, run the app as a hardened systemd service,
and put nginx + TLS in front of it on port 443.

This guide uses the deploy artifacts already in this repo:

| File | Role |
|---|---|---|
| `deploy/python-pvp-api.service` | systemd unit (runs `node server.js` as `appuser`) |
| `deploy/load-ssm-secrets.sh` | `ExecStartPre` hook: pulls secrets from SSM → `/etc/python_pvp/api.env` |
| `deploy/api-server-policy.json` | IAM policy for the EC2 instance role (SQS send + SSM read) |
| `servers/python-pvp-api.nginx.conf` | nginx site config (TLS + internal HTTP proxy) |

> Region throughout: **ap-southeast-1**. Account id in `api-server-policy.json`
> is `097142190893` — change it to yours.

---

## Architecture recap

```
                          ┌── HTTPS:443 (internet) ──┐
                          │                          ▼
Internet/Browser ─────────┤                   ┌────────────┐
                          │                   │  nginx     │
                          │   HTTP:80  (VPC)  │ (TLS term) │
Lambda (VPC) ─────────────┘                   │            │
                                              └─────┬──────┘
                                                    │ proxy
                                                    ▼
                                          node server.js
                                          (127.0.0.1:3000)
                                                    │
                                                    ├─ pg.Pool ──► RDS
                                                    └─ SQS ──► Lambda
```

- Node binds `127.0.0.1:3000` only — never reachable from the network directly.
- nginx listens on `0.0.0.0:443` (TLS, internet) and `0.0.0.0:80` (VPC-internal).
  Both proxy to `http://127.0.0.1:3000`.
- The instance security group allows **443** from `0.0.0.0/0` (browsers) and
  **80** from the VPC CIDR only (Lambda inside VPC calls via HTTP on port 80).
- The frontend browser uses `https://api.coding-master.kelvin-test.xyz`.
  The simulator Lambda uses `http://<ec2-private-ip>:80` (no TLS within VPC).
- Secrets come from **SSM Parameter Store** at service start — nothing sensitive
  is written into the repo or the AMI.

---

## Prerequisites

- An AWS account with the VPC/subnets/RDS/SQS from `AWS resource.md` already created.
- The RDS database initialized (`database/readme.md`: migrations 1–4).
- A domain name you can point at the instance (for TLS), e.g. `api.coding-master.kelvin-test.xyz`.
- AWS CLI configured locally (`aws sts get-caller-identity` works).

---

## Step 1 — Create the IAM role for the instance

The instance needs to read its SSM secrets and send SQS messages. Create a role
that EC2 can assume, attach the repo's policy, and wrap it in an instance profile.

```bash
REGION=ap-southeast-1
ROLE=python-pvp-api-server

# Trust policy: EC2 can assume the role.
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

aws iam create-role \
  --role-name "$ROLE" \
  --assume-role-policy-document file:///tmp/ec2-trust.json

# Attach the app policy (edit the account id in the file first!).
aws iam put-role-policy \
  --role-name "$ROLE" \
  --policy-name python-pvp-api-server-policy \
  --policy-document file://deploy/api-server-policy.json

# Instance profile (EC2 attaches roles via instance profiles).
aws iam create-instance-profile --instance-profile-name "$ROLE"
aws iam add-role-to-instance-profile \
  --instance-profile-name "$ROLE" --role-name "$ROLE"

# Route53 permissions (certbot DNS-01 challenge — writes TXT records).
aws iam put-role-policy \
  --role-name "$ROLE" \
  --policy-name route53-certbot \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": [
        "route53:ListHostedZones",
        "route53:GetChange",
        "route53:ChangeResourceRecordSets"
      ],
      "Resource": "*"
    }]
  }'
```

> If you use CloudWatch Logs/SSM Session Manager, also attach the AWS-managed
> `CloudWatchAgentServerPolicy` and `AmazonSSMManagedInstanceCore`.

---

## Step 2 — Populate SSM Parameter Store

`load-ssm-secrets.sh` expects these exact parameter names. Create them once
(replace the placeholder values):

```bash
REGION=ap-southeast-1
put()      { aws ssm put-parameter --name "$1" --value "$2" --type String       --overwrite --region "$REGION"; }
put_secret(){ aws ssm put-parameter --name "$1" --value "$2" --type SecureString --overwrite --region "$REGION"; }

put        /python_pvp/api/DB_USER          python_pvp_admin
put        /python_pvp/api/DB_HOST          python-pvp-db.xxxxxxxx.ap-southeast-1.rds.amazonaws.com
put        /python_pvp/api/DB_PORT          5432
put        /python_pvp/api/DB_NAME          python_pvp
put        /python_pvp/api/AWS_REGION       ap-southeast-1
put        /python_pvp/api/BATTLE_QUEUE_URL https://sqs.ap-southeast-1.amazonaws.com/<account>/python-pvp-battle-queue
put        /python_pvp/api/CORS_ORIGIN      https://coding-master.kelvin-test.xyz
put_secret /python_pvp/api/DB_PASSWORD      '<your-db-password>'
put_secret /python_pvp/api/MASTER_KEY       '<long-random-string>'
put_secret /python_pvp/api/SIM_API_TOKEN    '00000000-0000-0000-0000-000000000002'
```

> `DB_HOST` is the **real RDS endpoint** (the instance is in the VPC and reaches
> RDS directly via `python-pvp-db-sg`). `SIM_API_TOKEN` is the service-account
> session id from `database/4. service-account.sql`.

---

## Step 3 — Launch the Ubuntu EC2 instance

- **AMI:** Ubuntu Server 22.04 or 24.04 LTS.
- **Type:** `t3.small` is comfortable for 200–300 users (`t3.micro` works for light load).
- **Subnet:** a **public** subnet (`python-pvp-public`) so it can serve 443 and
  obtain a TLS cert; assign a public IP (or attach an Elastic IP for a stable address).
- **IAM instance profile:** `python-pvp-api-server` (from Step 1).
- **Key pair:** `python-pvp-ec2` (or your own) for SSH.
- **Elastic IP** — allocate and associate one for a stable public endpoint.
- **Security group** (`python-pvp-api-sg`) — create/attach one allowing inbound:
  - `22/tcp` from your admin IP only,
  - `443/tcp` from `0.0.0.0/0` (HTTPS from the world),
  - `80/tcp` from the **VPC CIDR** (or Lambda security group) — Lambda callback
    via nginx HTTP.
- Ensure this instance's SG is allowed inbound on `5432` by **`python-pvp-db-sg`**
  so the app can reach RDS.

> Port 80 is **not** open to the internet — only within the VPC. TLS certificates
> are obtained via **DNS-01 challenge** (Route53 API), not HTTP-01.

Point your DNS `A` record (`api.coding-master.kelvin-test.xyz`) at the **Elastic IP**.

---

## Step 4 — Install dependencies on the host

SSH in (`ssh -i sensitive/python-pvp-ec2.pem ubuntu@<ip>`), then:

```bash
sudo apt update && sudo apt upgrade -y

# Node.js 22 LTS (Express 5 requires Node 18+).
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Tooling: git, nginx (TLS reverse proxy), AWS CLI (used by the SSM script),
# and the certbot Route53 plugin (DNS-01 challenge, no port 80 needed).
sudo apt install -y git nginx awscli certbot python3-certbot-dns-route53

node --version   # expect v20.x
aws --version
```

---

## Step 5 — Create the app user and deploy the code

The systemd unit runs the app as an unprivileged `appuser` from
`/opt/python_pvp_platform`.

```bash
# Unprivileged service account (no login shell, no home login).
sudo useradd --system --create-home --shell /usr/sbin/nologin appuser

# Deploy the repo to /opt (clone, or rsync/scp from your machine).
sudo git clone <your-repo-url> /opt/python_pvp_platform
# (or: sudo rsync -a ./ /opt/python_pvp_platform/ from a local checkout)

# Install production dependencies for the API.
cd /opt/python_pvp_platform/servers/api
sudo npm ci --omit=dev   # use `npm install --omit=dev` if there is no package-lock

# The service reads/writes nothing in the app dir at runtime, but make the
# secrets bootstrap script executable.
sudo chmod +x /opt/python_pvp_platform/deploy/load-ssm-secrets.sh
sudo chown -R appuser:appuser /opt/python_pvp_platform
```

> Re-deploys later: `git pull` (or rsync) → `npm ci --omit=dev` →
> `sudo systemctl restart python-pvp-api`.

---

## Step 6 — Install the systemd service

The unit (`deploy/python-pvp-api.service`) runs `load-ssm-secrets.sh` as
`ExecStartPre` (writing `/etc/python_pvp/api.env`), then starts `node server.js`.
If the SSM fetch fails, the service refuses to start — better than running with
an empty config.

```bash
sudo cp /opt/python_pvp_platform/deploy/python-pvp-api.service \
        /etc/systemd/system/python-pvp-api.service

sudo systemctl daemon-reload
sudo systemctl enable python-pvp-api
sudo systemctl start python-pvp-api

# Verify it came up.
sudo systemctl status python-pvp-api --no-pager
journalctl -u python-pvp-api -n 50 --no-pager
```

Expected log line: `Server running on http://localhost:3000`.

Smoke-test the app locally on the box (a public route, no auth needed):

```bash
curl -s http://127.0.0.1:3000/api/competition | head
```

> **Note on `load-ssm-secrets.sh`:** it reads the region/account from the EC2
> Instance Metadata Service (IMDS). On instances forced to IMDSv2-only, ensure
> the script's `curl` calls use a token, or temporarily set IMDS to
> `optional`. The shipped script uses IMDS; if your instance is IMDSv2-only and
> the fetch fails, that's the place to look.

---

## Step 7 — nginx reverse proxy + TLS

Terminate TLS at nginx and proxy to the Node process on localhost.

Port 80 is open only within the VPC — certbot cannot use HTTP-01 from the
internet. Use the **DNS-01 challenge** instead. The EC2 instance role already has
`route53:ChangeResourceRecordSets` (from Step 1), so certbot can create the
`_acme-challenge` TXT record via the Route53 API.

### 7.1 — Install the TLS certificate

```bash
# DNS must already point at the Elastic IP before running this.
sudo certbot certonly --dns-route53 \
  -d api.coding-master.kelvin-test.xyz \
  --non-interactive --agree-tos -m admin@coding-master.kelvin-test.xyz

# certbot installs a systemd timer for auto-renewal; confirm it:
sudo systemctl list-timers | grep certbot
```

### 7.2 — Configure nginx

nginx listens on both port 443 (TLS, internet) and port 80 (plain HTTP, VPC
internal only) and routes both to the Node process on localhost:3000.

The config file is checked in at `servers/python-pvp-api.nginx.conf`.
Copy it and enable the site:

```bash
sudo cp /opt/python_pvp_platform/servers/python-pvp-api.nginx.conf \
        /etc/nginx/sites-available/python-pvp-api

sudo ln -sf /etc/nginx/sites-available/python-pvp-api /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

> The config includes three server blocks:
> - `api.coding-master.kelvin-test.xyz:443` → `localhost:3000` (API)
> - `coding-master.kelvin-test.xyz:443` → `localhost:3001` (web frontend)
> - `_:80` (VPC internal) → `localhost:3000` (Lambda callback)
>
> Edit the `server_name` values if your domains differ. Port 80 is blocked
> from the internet at the SG level — only VPC-internal traffic (the Lambda)
> can reach it. The Lambda's `LAMBDA_CALLBACK_BASE_URL` is set to
> `http://<ec2-private-ip>:80`.

---

## Step 8 — Verify end to end

From your laptop (not the box), confirm public HTTPS works:

```bash
curl -i https://api.coding-master.kelvin-test.xyz/api/competition
```

Then exercise the full auth path:

```bash
# Create a user, log in, and confirm a token comes back.
curl -s -X POST https://api.coding-master.kelvin-test.xyz/api/user \
  -H 'Content-Type: application/json' \
  -d '{"username":"smoke","full_name":"Smoke Test","password":"pw123456"}'

curl -s -X POST https://api.coding-master.kelvin-test.xyz/api/user/session \
  -H 'Content-Type: application/json' \
  -d '{"username":"smoke","password":"pw123456"}'
# -> {"auth_token":"<uuid>"}
```

Confirm the service-account / internal path works (the Lambda relies on this):

```bash
# Should be 404 (auth passed, code id not found) — NOT 403/401.
curl -s -o /dev/null -w '%{http_code}\n' \
  https://api.coding-master.kelvin-test.xyz/api/internal/code/00000000-0000-0000-0000-000000000000 \
  -H "Authorization: Bearer 00000000-0000-0000-0000-000000000002"
```

A `403` here means the service account isn't seeded as `root`
(`database/4. service-account.sql`) or the token is wrong.

---

## Operations

| Task | Command |
|---|---|
| Tail logs | `journalctl -u python-pvp-api -f` |
| Restart (also re-pulls SSM secrets) | `sudo systemctl restart python-pvp-api` |
| Status | `sudo systemctl status python-pvp-api` |
| Rotate a secret | `aws ssm put-parameter --name /python_pvp/api/DB_PASSWORD --value '<new>' --type SecureString --overwrite` then restart |
| Deploy new code | `cd /opt/python_pvp_platform && sudo git pull && cd servers/api && sudo npm ci --omit=dev && sudo systemctl restart python-pvp-api` |
| Renew TLS (manual) | `sudo certbot renew` |

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Service fails on start, no `Server running` log | `load-ssm-secrets.sh` failed. Run it manually: `sudo bash /opt/python_pvp_platform/deploy/load-ssm-secrets.sh` and read the error. Check the instance role has the SSM permissions and all 9 params exist. |
| `EnvironmentFile=/etc/python_pvp/api.env` missing | Same as above — the `ExecStartPre` writes it; if SSM fetch fails the file is empty/absent. |
| App starts but DB calls 500 | RDS unreachable: confirm `python-pvp-db-sg` allows 5432 from this instance's SG, and `DB_HOST`/`DB_PORT` SSM values are correct. The app uses SSL with `rejectUnauthorized:false` (see `utils/db.js`). |
| `502 Bad Gateway` from nginx | Node process is down (`systemctl status python-pvp-api`) or not on 3000. |
| Lambda gets `403` on `/api/internal/*` | Service account not seeded as `root`, or `SIM_API_TOKEN` mismatch between DB, SSM, and the Lambda env var. |
| certbot fails | DNS not yet pointing at the host, or the instance role lacks `route53:ChangeResourceRecordSets`. |
| Secrets script can't read region/account | IMDSv2-only instance; see the IMDS note in Step 6. |

---

## Security notes

- `server.js` binds `127.0.0.1:3000` only. It is never reachable from the network
  directly — all traffic goes through nginx.
- The systemd unit is already hardened (`NoNewPrivileges`, `ProtectSystem=strict`,
  `PrivateTmp`, `ProtectHome`); keep those.
- CORS is restricted via the `CORS_ORIGIN` SSM parameter/env var
  (default `*` for development). Set it to the frontend domain
  (`https://coding-master.kelvin-test.xyz`) in production.
- See `docs/security.md` for the full secret-management and network model.
```
