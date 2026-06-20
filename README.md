# python_pvp_platform

A competitive programming platform where players write strategy code (Python functions) that controls a vehicle, and their strategies are pitted against each other in real-time simulations. Winners score points for their enrollment in competitions.

---

## Architecture

```
Player (web browser)
  │
  ├─ POST /api/battle ──────────────────────────┐
  │                                              │
  │  Express API server (Node.js)               │
  │  ├─ writes app.battle row (DB)             │
  │  └─ SendMessage → SQS python-pvp-battle-queue
  │                                              │
  ▼                                              │
Simulator Lambda (Python)                         │
  ├─ markPending (API → DB)                     │
  ├─ download game definition (S3: game/<id>/game.py)
  ├─ getCode (API → DB) — player strategies     │
  ├─ run match (numpy + opencv)                 │
  ├─ upload replay (S3: output/<simulation_id>.mp4)
  └─ markComplete / markFailed (API → DB)       │
                                              │
SQS python-pvp-battle-queue (Lambda trigger)  ◄─┘
```

**The three main components:**

| Component | Location | Role |
|---|---|---|
| API server | `servers/api/` | Express.js REST API — battle CRUD, code management, user auth |
| Simulator | `simulator/` | Python Lambda — runs the match, writes replay to S3 |
| Games | `games/2526_game/` | Reference game implementation (Python) |

**Battle flow:**
1. Player selects a competition and their code in the web UI.
2. Client calls `POST /api/battle` with `competition_id`.
3. API resolves both enrollments, freezes both `code_id`s in `app.battle`, and enqueues a job to SQS.
4. Lambda is triggered by SQS (event source mapping, batch size 1).
5. Lambda marks the job `pending` via the API server.
6. Lambda downloads the game definition from S3 and fetches both player codes from the DB via the API.
7. Lambda runs the simulation, exports the replay, and uploads it to S3.
8. Lambda marks the job `completed` (or `failed`) via the API.
9. Client polls `GET /api/battle/:id` until `simulation_job.status === 'completed'`.

---

## Project structure

```
python_pvp_platform/
├── servers/
│   └── api/              # Express.js API server
│       ├── routes/       # Route handlers (battleAPI, codeAPI, competitionAPI, userAPI, internalAPI)
│       └── utils/        # Middleware (auth, admin, enroll), DB pool, SQS client
│
├── simulator/            # AWS Lambda (Python, container image)
│   ├── deployment.md     # Step-by-step Lambda deployment guide
│   ├── design.md         # Architecture design notes
│   ├── test-guide.md     # End-to-end local test guide (RIE / deployed Lambda)
│   └── docker-image/
│       ├── handler.py    # Lambda entry point
│       ├── clients/      # Production clients (S3, API-over-HTTP db client)
│       └── testClients/  # Local test doubles
│
├── games/
│   └── 2526_game/        # The 2526 maze-racing game (Python, numpy + opencv)
│       ├── game.py       # Entry points: init(), simulate(a_strat, b_strat), export_video()
│       ├── strategies/   # Seed strategies (spinner.py, wall_follower.py)
│       └── physics.md    # Physics design notes
│
├── database/             # PostgreSQL schema and seed data
│   ├── 1. create-db.sql  # Create DB + role (run once against postgres)
│   ├── 2. init-db.sql    # Create all app.* tables
│   ├── 3. extension.sql  # UUID defaults + uuid-ossp extension
│   ├── 4. service-account.sql  # Long-lived service account for Lambda auth
│   └── readme.md         # Local DB setup instructions (ports, tunnels)
│
├── deploy/               # Deployment helpers for the API server (EC2)
│   ├── api-server-policy.json   # IAM policy (SQS send + SSM read)
│   ├── load-ssm-secrets.sh      # Bootstrap: fetch secrets from SSM → EnvironmentFile
│   └── python-pvp-api.service   # systemd unit file
│
├── sensitive/            # Private credentials — NEVER commit
│   ├── .env              # Dev credential overrides
│   └── python-pvp-ec2.pem  # SSH key for jumpbox tunnel
│
└── AWS resource.md       # AWS resource inventory (VPC, RDS, S3, SQS, IAM, Lambda)
```

---

## Quick start

### 1. Database

```bash
# Open SSH tunnel to RDS (from AWS resource.md)
ssh -i sensitive/python-pvp-ec2.pem -N -L 5433:<rds-endpoint>:5432 ubuntu@<jumpbox-ip>

# Run migrations (from repo root, with tunnel on localhost:5433)
psql --host localhost --port 5433 --username postgres -f database/1.\ create-db.sql
psql --host localhost --port 5433 --username python_pvp_admin -d python_pvp -f database/2.\ init-db.sql
psql --host localhost --port 5433 --username python_pvp_admin -d python_pvp -f database/3.\ extension.sql
```

### 2. API server

```bash
cd servers/api
npm install
cp .env .env.local   # edit .env.local with your DB credentials
npm start            # runs on http://localhost:3000
```

### 3. Simulator (local test with RIE)

```bash
# From repo root
docker build -t python-pvp-simulator ./simulator
docker run -p 9000:8080 python-pvp-simulator

# In another terminal — invoke with the test payload (from simulator/test-guide.md)
curl -s "http://localhost:9000/2015-03-31/functions/function/invocations" \
  -d '{"Records":[{"body":"{\"battle_id\":\"...\",\"simulation_id\":\"...\",...}"}]}' | jq
```

### 4. Web debug UI

Open `servers/web/index.html` directly in a browser. It is a standalone auth-debug tool for manually testing all API endpoints.

---

## Key documentation

| Document | What it covers |
|---|---|
| `simulator/deployment.md` | Full Lambda deployment: SQS, IAM, ECR, event source mapping |
| `simulator/test-guide.md` | End-to-end test: seeding DB, uploading game to S3, invoking Lambda |
| `simulator/design.md` | Simulator architecture, S3 key layout, execution flow |
| `database/readme.md` | Local DB setup (ports, tunnels, migration order) |
| `deploy/` | API server EC2 deployment: IAM policy, systemd unit, SSM bootstrap |
| `AWS resource.md` | Full AWS resource inventory (VPC, RDS, Lambda, S3, SQS, IAM) |

---

## Database schema

```
app.game                — game definitions (display_name, simulation_reference)
app.competition         — competition instances (game_id, time window, enabled)
app.user                — registered players (username, hash_password, urole)
app.user_session        — session tokens for auth
app.enroll              — player's enrollment in a competition (UNIQUE competition_id+user_id)
app.code                — strategy source code (enroll_id → app.enroll, code text column)
app.battle              — frozen record of a battle (a_enroll_id, b_enroll_id, a_code_id, b_code_id)
app.simulation_job      — result of one Lambda invocation (battle_id → app.battle, status, scores, video ref)
```

For the full CREATE TABLE statements, see `database/2. init-db.sql`.

---

## Monthly cost estimate (200–300 users)

Rough estimate for running **one** environment in **ap-southeast-1 (Singapore)**, on-demand pricing, USD/month. The architecture is deliberately cost-lean: the Lambda runs **outside the VPC**, so there is **no NAT Gateway and no VPC endpoints** (the items that usually dominate small AWS bills). The only always-on resources are one API EC2 instance, one jumpbox EC2 instance, and one RDS instance; everything else is usage-based.

### Workload assumptions

| Parameter | Value | Basis |
|---|---|---|
| Active users | ~250 | midpoint of 200–300 |
| Battles per user / month | ~40 | engaged competition usage |
| **Battles / month** | **~10,000** | 250 × 40 |
| Lambda memory / timeout | 512 MB / 60 s | `simulator/deployment.md` |
| Avg Lambda duration / battle | ~15 s | up to 30 s sim @ 60 fps + opencv render at 1080×720 |
| Replay size | ~10–16 MB | sample `match.mp4` ≈ 16.5 MB |

### Expected case (~$50–65 / month)

| Service | Config | Monthly |
|---|---|---|
| EC2 — API server | `t3.small` (2 vCPU, 2 GB) | ~$19 |
| EC2 — jumpbox | `t3.micro` (start only when needed) | ~$3–8 |
| EBS | ~30 GB gp3 (2 root volumes) | ~$3 |
| RDS PostgreSQL | `db.t4g.micro` Single-AZ + 20 GB gp3 | ~$15 |
| Lambda | 10k × 15 s × 512 MB ≈ 76,800 GB-s | ~$1–3 |
| SQS | battle queue + DLQ (≈ free tier) | ~$0 |
| S3 | ~120 GB replays/mo + requests | ~$3 |
| ECR | 1 image repo (~1–2 GB) | ~$0.20 |
| CloudWatch Logs | Lambda + app logs | ~$1–3 |
| Data transfer out | API JSON + replay downloads (~50–150 GB) | ~$5–15 |
| SSM Parameter Store / IAM / VPC / IGW | — | $0 |
| **Total** | | **≈ $50–65** |

### Scenario range

| Scenario | Setup | Monthly |
|---|---|---|
| **Low** | `t3.micro` API, `db.t4g.micro`, S3 lifecycle expiry, jumpbox off | ~$35–45 |
| **Expected** | `t3.small` API, `db.t4g.micro`, replays retained | ~$50–65 |
| **High** | `t3.medium` API, `db.t4g.small` Multi-AZ, ~20k battles, replays kept forever | ~$110–160 |

### Cost notes & optimizations

- **S3 grows unbounded.** `deployment.md` sets no lifecycle policy; at ~12 MB × 10k battles that is **~120 GB added every month** (compounding). Add an S3 lifecycle rule (e.g. expire replays after 30–90 days) to keep S3 flat at ~$3–5/mo.
- **Lambda is nearly free** here (~$1–3/mo). The no-VPC design avoids the costs that usually make Lambda expensive; doubling battles barely moves the bill.
- **EC2 + RDS are the real baseline (~$35–40/mo)** since they run 24/7. A 1-year Savings Plan / Reserved Instance (~30–40% off) plus stopping the jumpbox when idle can bring steady-state cost down to **~$25–30/mo**.
- **Data transfer is the largest variable.** Serving 16 MB replay videos drives egress; if replay viewing is heavy, CloudFront in front of S3 can lower egress cost at scale.
- **Assumptions not in the repo:** instance classes (none specified), battles/user/month, and replay retention. Adjust the workload table above to re-scope.

> **Bottom line:** roughly **$50–65/month** for one environment at 200–300 users, or as low as **~$35/month** with a Savings Plan + S3 lifecycle policy.

---

## Security notes

**Secrets must never be committed.** The following are already gitignored — do not bypass these:

- `servers/api/.env` / `alpha.env` — DB password, master key. Use AWS SSM Parameter Store (see `deploy/`).
- `sensitive/` — contains `.env` (Alibaba Cloud keys) and `.pem` (SSH key). Never commit.
- `*.env` — any file ending in `.env` is gitignored as a precaution.

**Runtime secret management:**
- API server on EC2: reads secrets from SSM Parameter Store via `deploy/load-ssm-secrets.sh`. See `deploy/api-server-policy.json` for the IAM policy.
- Simulator Lambda: `SIM_API_TOKEN` and `SIM_API_BASE_URL` set via Lambda environment variables (or Secrets Manager reference). Never embed long-lived credentials in code.

**API server must be publicly reachable** (HTTPS, port 443) so the Lambda can call `/api/internal/*` endpoints. The Lambda runs in the AWS-managed network, not inside the application VPC.

**The simulator service account** (`database/4. service-account.sql`) has role `root` and a non-expiring session token. Treat its session ID (`SIM_API_TOKEN`) like a password. Rotate by replacing the `user_session` row and updating the SSM parameter.