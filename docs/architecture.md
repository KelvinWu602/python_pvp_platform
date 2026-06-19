# Architecture

## System overview

```
Internet ──► Express API server (Node.js, EC2)
               │                │
               │  writes        │  sends job
               ▼                ▼
         PostgreSQL (RDS)    SQS queue
                                   │
              ◄── marks job complete/failed ──│
               │                │
               │                ▼
               │         Simulator Lambda (Python, container)
               │                │
               │  getCode()     │  S3 download game
               │  markPending() │  run match
               │  markComplete()│  S3 upload replay
               ▼                ▼
            PostgreSQL        S3 (game + replay)
```

## Components

### 1. Express API server (`servers/api/`)

Node.js + Express REST API. All persistence goes through a shared `pg.Pool` (max 10 connections) so RDS connections are bounded regardless of Lambda concurrency.

**Routes:**
- `POST /api/battle` → insert `app.battle` row + enqueue SQS job
- `GET /api/battle/:id` → battle + latest `completed` simulation_job
- `POST/GET/PUT /api/code` → strategy code CRUD
- `POST /api/competition/:id/enroll` → enroll in competition
- `POST/GET/PUT/DELETE /api/competition` → competition management (admin)
- `POST/DELETE /api/user/session` → login/logout
- `GET /api/internal/code/:id` → simulator-only code fetch
- `POST /api/internal/simulation-job/pending|complete|failed` → simulator-only job writes

**Auth:** Session tokens stored in `app.user_session`. Admin routes (`competition/game`, `competition` write ops) require `urole = 'root'`. Internal routes (`/api/internal/*`) require `urole = 'root'` (service account).

### 2. Simulator Lambda (`simulator/`)

Python 3.12 Lambda, deployed as a container image on ECR. Triggered by SQS event source mapping (BatchSize=1).

**Execution flow:**
1. Unwrap SQS record (or accept direct invocation for testing)
2. Call API `POST /api/internal/simulation-job/pending` → marks job as `pending`
3. Download `game/<game_id>/game.py` from S3
4. Call API `GET /api/internal/code/:id` for both players' code → write to `/tmp/strategies/a.py` and `b.py`
5. Import game + both strategy modules via `importlib.util.spec_from_file_location`
6. Call `game.init()` → `game.simulate(a_strat, b_strat)` → `game.export_video()`
7. Upload replay to `s3://python-pvp-store/output/<simulation_id>.mp4`
8. Call API `POST /api/internal/simulation-job/complete` (or `failed`) with results

**Client modes:**
- `RUNNING_MODE=production` → `clients/` (boto3 S3 + urllib API client)
- `RUNNING_MODE=test` → `testClients/` (local file doubles for S3; API client still calls the API server)

### 3. Games (`games/2526_game/`)

The reference implementation of the 2526 maze-racing game. This is the file uploaded to S3 at `game/<game_id>/game.py`.

**Module-level interface (called by handler.py):**
```python
init()                                    # build arena, reset state
simulate(player_a_update_fn, player_b_update_fn)  # run race, return result dict
export_video(path)                        # render frames to mp4 at path
```

**Strategy interface (player code must define):**
```python
def update(sensors, telemetry) -> (alpha1, alpha2)
# sensors: list[8] of distances [F, FR, R, BR, B, BL, L, FL] (max 250px each)
# telemetry: dict {'spin1', 'spin2', 'theta', 'omega', 'vx', 'vy'}
# returns: (left_wheel_accel, right_wheel_accel)
```

**Result dict:**
```python
{'winner': 'a' | 'b' | None,
 'winner_score_gain': float,
 'loser_score_loss': float,
 'log': str}
```

### 4. SQS queue (`python-pvp-battle-queue`)

Standard queue (not FIFO). At-least-once delivery is safe because simulation is idempotent — re-running produces equivalent results.

**Redrive policy:** after 3 failed attempts, message goes to `python-pvp-battle-dlq`. 14-day retention on the DLQ.

**Visibility timeout:** 360s (6 min). Must exceed Lambda timeout (60s) to prevent mid-run redelivery.

### 5. S3 bucket (`python-pvp-store`)

| Key pattern | Content | Who writes |
|---|---|---|
| `game/<game_id>/game.py` | Game definition (Python source) | Admin (pre-competition) |
| `output/<simulation_id>.mp4` | Replay video | Simulator Lambda |

Strategy code is **not** in S3 — it lives in `app.code.code` in RDS and is fetched via the API server.

## Data model

```
app.user (id, username, full_name, hash_password, urole)
  └── app.user_session (id, user_id, expire_at_utc)

app.game (id, display_name, simulation_reference)
  └── app.competition (id, game_id, display_name, start/end, enabled)
        └── app.enroll (id, competition_id, user_id, selected_code_id)
              ├── app.code (id, enroll_id, name, code)
              └── app.battle (id, a_enroll_id, b_enroll_id, a_code_id, b_code_id)
                    └── app.simulation_job (id, battle_id, status, winner/loser_user_id, scores, battle_video_reference, execution_log)
```

**Enrollment uniqueness:** `UNIQUE (competition_id, user_id)` on `app.enroll` — a user can only enroll once per competition.

**Battle code freeze:** `a_code_id` and `b_code_id` are frozen at battle creation (`NOT NULL`) so replay is stable even if a player edits their code later.

**Simulation idempotency:** multiple `simulation_job` rows can exist for one `battle_id` (re-runs). `GET /api/battle/:id` returns the latest `completed` job — all completed jobs for the same battle yield equivalent results by design.

## Key design decisions

### Why the Lambda calls the API for DB access instead of connecting directly to RDS?

A Lambda invocation opens one `psycopg2` connection. With high concurrency (many simultaneous battles), this exhausts RDS's `max_connections`. By routing all DB writes through the API server's `pg.Pool` (max 10), the real RDS connection count is bounded to the pool size regardless of Lambda concurrency.

### Why SQS instead of direct Lambda invocation?

The API server only needs to write the battle row and enqueue a job — one `SendMessage` call. SQS provides built-in retry (visibility timeout), dead-lettering (DLQ), and at-least-once delivery. The alternative (Lambda invoke API) would couple the API to the Lambda's IAM and require managing concurrent invocation limits.

### Why batch size 1?

Each battle is a heavy, independent job. Batching more messages per invocation would complicate partial-failure handling (if one message fails, you need to report which specific message IDs failed back to SQS). Batch size 1 makes the retry contract trivial: one message per invocation, throw on any failure.

### Why does the Lambda run outside the VPC?

The only reason the Lambda was in `python-pvp-vpc` was direct RDS access. Once DB access moved to the API server, the Lambda's dependencies (API server, S3, SQS) are all reachable over the public internet from the AWS-managed Lambda network. This removes the need for a VPC gateway endpoint for S3, an SQS interface endpoint, or a NAT gateway.