# Simulator Lambda Design

## Handler file structure

```
/app
    - /handler.py            (orchestrator: fetch, run, callback)
    - /sandbox.py            (PlayerWorker — sandboxed subprocess manager)
    - /_worker.py            (child process entry — reads stdin, execs user code, writes stdout)
    - /clients
        - /s3Client.py       (boto3 S3 — game download + replay upload)
        - /dbClient.py       (HTTP API client — snapshot + competition + callback)
    - /testClients
        - /s3Client.py       (local file-system stub)
        - /dbClient.py       (inherits from production dbClient)
    - /game                  (downloaded game.py placed here at runtime)
    - /output                (replay .mp4 written here at runtime)
```

## S3 bucket layout

`s3://python-pvp-store/`
- `/game/<key>/game.py`        — game engine (key stored in competition.game_reference)
- `/helper/<key>/helper.py`    — optional helper module (competition.helper_reference)
- `/output/<battle_id>.mp4`    — rendered replay video

Player strategy code is NOT stored in S3. It lives in `app.snapshot` table
in the DB and is fetched via the API's `GET /admin/snapshot/:id` endpoint.

## SQS event payload

```json
{
  "battle_id":       "uuid (app.battle.id)",
  "competition_id":  "uuid (app.competition.id)",
  "is_test":         true/false,
  "a_user_id":       "uuid",
  "b_user_id":       "uuid",
  "a_snapshot_id":   "uuid (app.snapshot.id for player A)",
  "b_snapshot_id":   "uuid (app.snapshot.id for player B)"
}
```

No `simulation_id` — the battle_id itself is the stable identity across retries.

## Execution flow (main Lambda)

1. Parse SQS event → extract battle payload.
2. `setup_clients()` — instantiate S3 + API clients; `LAMBDA_CALLBACK_TOKEN` captured in `db_client.token`, then stripped from `os.environ`.
3. `log_attempt(battle_id, lambda_request_id, start_time)` → API `POST /admin/battle-attempt/:id`
   → INSERTs execution_log row with NULL end_time_utc (breadcrumb for finding CloudWatch logs).
4. Seed RNG with `hash(battle_id)` — deterministic retries produce the same result.
5. `fetch_competition(competition_id)` → API `GET /admin/competition/:id`
   → get game_reference, helper_reference, manifest_reference (S3 keys).
6. `fetch_snapshot(a_snapshot_id)` / `fetch_snapshot(b_snapshot_id)` → API GET /admin/snapshot/:id
   → get code text for both players.
7. Download game engine + helper from S3 using competition keys → /tmp/game/game.py, /tmp/sandbox/helper.py.
8. Create sandboxed `PlayerWorker` subprocesses for each player (pass user code + helper path via stdin).
9. Import game module (trusted, runs in main process — not sandboxed).
10. `game.init()` → `game.simulate(worker_a, worker_b)` → result dict.
    Each frame: game calls worker_a(sensors, telemetry) → IPC to child → update() → result back.
10. `game.export_video(path)` → local .mp4 file.
11. Upload replay to s3://python-pvp-store/output/<battle_id>.mp4.
12. `callback_battle(battle_id, ...)` → API `PUT /admin/battle/:id`
    → sets infra_ok/input_ok + INSERTs execution_log (one tx in the API).
13. On **any** failure, the Lambda re-raises and returns an error. SQS redrives the message.
    The main Lambda never writes failure records — it only records success.

## Sandbox (PlayerWorker)

Each player strategy runs in a separate child process with kernel-enforced limits:

| Limit | Value | Blocks |
|-------|-------|--------|
| `RLIMIT_CPU` | 1 second | Infinite loops (kernel sends SIGXCPU) |
| `RLIMIT_NPROC` | 0 | `fork()`, `os.system()`, `subprocess` |
| `RLIMIT_FSIZE` | 0 | File writes (`open()`, `tempfile`) |
| `RLIMIT_AS` | 64 MB | Memory exhaustion attacks |

The parent sends JSON messages via stdin; the child responds on stdout:

```
Parent → Child (startup): {"user_code": "...", "helper_dir": "/tmp/sandbox"}
Child  → Parent:           {"ok": true}

Parent → Child (per frame): {"sensors": [...], "telemetry": {...}}
Child  → Parent:            {"ok": true, "a1": ..., "a2": ...}
                            {"ok": false, "error": "..."}
```

If the child crashes or times out, `PlayerWorker` respawns it and returns `(0.0, 0.0)` for that frame. After 3 consecutive failures per worker, the exception propagates and the whole battle fails.

The helper module (admin-provided) is written to `/tmp/sandbox/helper.py` by the parent before spawning workers. The child inserts `/tmp/sandbox` into `sys.path`, so user code can `import helper` and call its functions. The helper runs inside the same sandboxed child with the same rlimits.

The game engine itself is NOT sandboxed — it runs in the main Lambda process as a trusted Python module loaded via `importlib`. Only player strategies run in subprocesses.

## Error handling

| Failure source          | What happens | Eventually |
|-------------------------|-------------|------------|
| API/S3 unavailable (setup failed) | Exception raised → SQS retries | DLQ consumer writes infra_ok=false after maxReceiveCount |
| User code crash | Exception raised → SQS retries | DLQ consumer writes infra_ok=false |
| Lambda timeout | No handler code fires → SQS retries after visibility timeout | DLQ consumer writes infra_ok=false |
| Callback PUT fails | Exception raised → SQS retries | Re-executes simulation (deterministic RNG → same result) → callback retries |

The API's `PUT /admin/battle/:id` uses `WHERE infra_ok IS NULL` so a late retry cannot overwrite success.

## SQS topology

```
POST /code/:cid/test (or POST /enroll/:eid/battle) → enqueueBattle → python-pvp-battle-queue
                                                        ├─ maxReceiveCount (3)
                                                        ├─ visibility timeout (6 min)
                                                        └─ DLQ: python-pvp-battle-queue-dlq
                                                                └─ DLQ Consumer Lambda
                                                                (simulator/dlq_consumer/handler.py)
```

The DLQ consumer calls `PUT /admin/battle/:id` with `infra_ok=false, input_ok=false`.
The API handler uses `WHERE infra_ok IS NULL` so a late retry won't overwrite success.

## Env vars

| Variable                | Required | Default            | Description |
|-------------------------|----------|--------------------|-------------|
| RUNNING_MODE            | Yes      | production         | production → clients/ (boto3 + HTTP API), test → testClients/ |
| S3_BUCKET               | Yes      | python-pvp-store   | S3 bucket for game files + replay videos |
| LAMBDA_CALLBACK_BASE_URL| Yes      | —                  | API server base URL (e.g. https://api.example.com) |
| LAMBDA_CALLBACK_TOKEN   | Yes      | —                  | Root Bearer token for API auth |
| LAMBDA_CALLBACK_TIMEOUT | No       | 10                 | Per-request timeout in seconds |
| WORK_DIR                | No       | /tmp               | Working directory root (Lambda only allows writes to /tmp) |

## API endpoints the Lambda calls

| Method | Path                       | Auth       | Purpose |
|--------|----------------------------|------------|---------|
| GET    | /admin/competition/:id     | Root token | Fetch competition (game_reference, helper_reference, manifest_reference for S3) |
| GET    | /admin/snapshot/:id        | Root token | Fetch snapshot code text |
| POST   | /admin/battle-attempt/:id  | Root token | INSERT execution_log row (attempt breadcrumb) |
| PUT    | /admin/battle/:id          | Root token | Write result on app.battle (triggers denorm updates) |

All authenticated with `Authorization: Bearer <LAMBDA_CALLBACK_TOKEN>`.
