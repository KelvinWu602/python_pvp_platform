# AGENTS.md — Python PvP Platform

## Repo layout

| Path | What |
|------|------|
| `servers/api/` | Express 5 REST API (Node.js), `npm start` on port 3000 |
| `servers/web/index.html` | Debug HTML page (static, opened from file://) |
| `simulator/` | Python 3.12 Lambda (container image on ECR), entrypoint `docker-image/handler.py` |
| `database/` | SQL migrations, run order: `1. create-db.sql → 2. init-db.sql → 3. extension.sql → 4. triggers.sql` |
| `games/` | Game engine definitions (uploaded to S3, referenced by competition) |
| `deploy/` | EC2 deploy scripts, systemd unit, SSM bootstrap |
| `docs/` | Architecture + security docs (partially stale — see `./agent/context.md` for current design) |
| `.agent/context.md` | Current design: schema, endpoints, Lambda pattern, creation flows |

## Architecture

```
HTTP → Express API (Node, pg.Pool max 25) → PostgreSQL (RDS, app schema)
                                          → SQS enqueue
                                              → Lambda (Python, container)
                                                  → S3 download game, upload replay
                                                  → PUT /admin/battle/:id callback
```

Lambda never queries DB directly — calls API as root with `LAMBDA_CALLBACK_TOKEN`.

## Key patterns an agent will miss

- **Root bypass**: `authorization.js` lets `urole='root'` through ANY route, not just `/admin/*`. The Lambda's root token can call user-facing `GET /competition/:id`.
- **Status via null**: `battle.infra_ok` + `input_ok` both null = pending, both set = done. PUT callback uses `WHERE infra_ok IS NULL` so late DLQ retries don't overwrite success.
- **SQS enqueued in tx**: `enqueueBattle()` is called inside `BEGIN`/`COMMIT` blocks. If SQS send fails, the transaction rolls back.
- **Snapshot transparency**: No `snapshot_id` or snapshot timestamps in user-facing responses. Users create (`POST /code {name, code}`) and update (`PUT /code/:id {code}`) — snapshots are created internally. The `tested` field in code responses = "latest snapshot has a completed battle."
- **At most one code per enrollment**: `POST /enroll/:eid/code` does `DELETE old code_select` then `INSERT new` in one transaction.
- **Game fields embedded in competition**: No separate `app.game` table. `competition.game_reference` is the S3 key for the game `.py` file.
- **Enrollment admin-only**: `POST /admin/enroll` and `DELETE /admin/enroll/:eid`. Users cannot self-enroll or withdraw.

## Schema (source: `database/2. init-db.sql`)

All tables under `app` schema. UUID PKs with `gen_random_uuid()` default (added in `3. extension.sql`). Triggers on `user`, `competition`, `battle` auto-set `updated_at_utc` (`4. triggers.sql`).

**⚠️ KNOWN SCHEMA BUG**: `app.competition` in `2. init-db.sql` is MISSING `npc_snapshot_id uuid NOT NULL REFERENCES app.snapshot(id)`. The API code (`user.js`, `root.js`) and context.md assume it exists. The column must be added before tests/battles work — either add it to init-db.sql or run `ALTER TABLE app.competition ADD COLUMN npc_snapshot_id uuid REFERENCES app.snapshot(id);` and `UPDATE` to set it.

Tables: `user`, `user_session`, `code`, `snapshot`, `competition`, `enroll`, `code_select`, `battle`, `execution_log`.

## API routes (Express 5, mounted in `server.js`)

| Mount | Auth required | Role |
|-------|--------------|------|
| `/public` | None | Any |
| `/` | Bearer session token | `user` (or `root` via bypass) |
| `/admin` | Bearer session token | `root` |

Mount order matters: `/admin` and `/public` are declared before `/` in `server.js` to prevent `/admin/*` from matching user routes.

Full endpoint table in `.agent/context.md`.

## Development commands

```bash
# API server
cd servers/api && cp .env.example .env   # edit DB_*, LAMBDA_CALLBACK_TOKEN
npm install && npm start                  # port 3000

# DB tunnel (local dev)
ssh -i sensitive/python-pvp-ec2.pem -N -L 5433:<rds-endpoint>:5432 ubuntu@<jumpbox-ip>

# Lambda test locally (RIE)
cd simulator && docker build -t python-pvp-simulator .
docker run --rm -p 9000:8080 \
  -e RUNNING_MODE=production \
  -e LAMBDA_CALLBACK_BASE_URL=http://host.docker.internal:3000 \
  -e LAMBDA_CALLBACK_TOKEN=<uuid> \
  python-pvp-simulator

# Invoke Lambda locally
curl -s "http://localhost:9000/2015-03-31/functions/function/invocations" -d '@event.json'
```

**No test suite exists** — `npm test` is a stub in package.json. The Lambda test-guide (`simulator/test-guide.md`) describes manual e2e verification via seeded DB data + RIE.

## Lambda payload (SQS -> handler.py)

```json
{
  "battle_id": "uuid",
  "competition_id": "uuid",
  "is_test": false,
  "a_user_id": "uuid",
  "b_user_id": "uuid",
  "a_snapshot_id": "uuid",
  "b_snapshot_id": "uuid"
}
```

## DB tunnel quirk

Local dev connects to RDS through an SSH tunnel on port **5433** (not 5432). The pg Pool uses `ssl: { rejectUnauthorized: false }` because the tunnel makes the hostname mismatch the RDS certificate.

## Stale docs to ignore

`docs/architecture.md` describes the old schema (`app.game`, `app.simulation_job`, `api/internal/*` endpoints). `.agent/context.md` is the current source of truth for design and endpoints.
