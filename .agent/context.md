# Project Context

## Project
Python PvP Coding Platform — users write Python code to compete in games. Each competition is associated with a game, users enroll, write code, and battle each other.

---

## Schema (source of truth: database/2. init-db.sql)

**app.user** — id, username, full_name, hash_password, urole(user/root), created_at_utc, updated_at_utc

**app.user_session** — id, user_id→user, created_at_utc, expire_at_utc

**app.competition** — id, npc_user_id→user(NOT NULL), display_name, description, start_time_utc, end_time_utc, game_reference, helper_reference, manifest_reference, created_at_utc, updated_at_utc

**app.enroll** — id, competition_id→competition, user_id→user, win_count, lose_count, tie_count, UNIQUE(competition_id, user_id)

**app.code** — id, user_id→user, name, created_at_utc — code belongs to user, not enrollment

**app.snapshot** — id, code_id→code, code(text), created_at_utc

**app.code_select** — enroll_id→enroll, code_id→code, user_id→user(denormalized), competition_id→competition(denormalized), PK(enroll_id, code_id). At most one code per enrollment (enforced by app).

**app.battle** — id, competition_id→competition, a_user_id→user, a_snapshot_id→snapshot, b_user_id→user, b_snapshot_id→snapshot, infra_ok, input_ok, draw, winner_user_id→user, loser_user_id→user, video_reference, created_at_utc, updated_at_utc. Status: infra_ok/input_ok both null = pending, both set = done.

**app.execution_log** — id, battle_id→battle, input(text=SQS msg), lambda_request_id, start_time_utc, end_time_utc

---

## Design Decisions

- **No separate game table** — game fields embedded in competition
- **Battle = unified job** — no separate test concept. Test = battle vs competition NPC
- **Status via null pattern** — infra_ok/input_ok both null = pending. SQS handles retries natively.
- **NPC lives on competition** — npc_user_id NOT NULL, set at creation. NPC's snapshot is found through enrollment + code_select (same as any user)
- **Code belongs to user** — not enroll. Users write code independently of competitions.
- **code_select links enroll → code** — at most one code per enrollment (DELETE old, INSERT new)
- **Root bypass** — root users pass all authorization checks, can access any route

## Creation Flows

### Admin creates competition + NPC enrollment (no NPC snapshot yet)
```
INSERT competition (npc_user_id, ...)
```

### Admin primes NPC code for testing
```
POST /admin/approve-code { user_id, competition_id }
  → finds NPC enrollment → latest snapshot → not yet tested?
  → inserts self-play battle (infra_ok, input_ok, draw = true)
  → inserts synthetic execution_log
  → increments enroll.tie_count
```

### User writes / updates code (snapshot is transparent)
```
POST /code { name, code }  → INSERT code + INSERT snapshot (one tx)
PUT /code/:id { code }     → INSERT snapshot (new version)
```

### Admin enrolls a user → user links code
```
POST /admin/enroll { competition_id, user_id }
(admin creates enrollment; user later links their code)
```

```
DELETE code_select WHERE enroll_id = ?
INSERT code_select (enroll_id, code_id, user_id, competition_id)
```

### Admin primes user/NPC code for testing
```
POST /admin/approve-code { user_id, competition_id }
  → self-play battle with infra_ok, input_ok, draw = true
  → marks latest snapshot as tested
```

### Create battle
- **Test vs NPC**: POST /enroll/:eid/test (auto-selects NPC from competition)
- **User battle**: POST /enroll/:eid/battle with { b_enroll_id }

```
INSERT battle (competition_id, a_user_id, a_snapshot_id, b_user_id, b_snapshot_id)
enqueue SQS → Lambda runs → PUT /admin/battle/:id → UPDATE battle + INSERT execution_log
```

---

## API Endpoints

### Public (mounted at /public)
| Method | Path | Description |
|--------|------|-------------|
| POST | /user/session | Login |

### User (mounted at /)
| Method | Path | Middleware | Description |
|--------|------|------------|-------------|
| GET | /competition | — | List all competitions |
| GET | /competition/:id | — | Get competition |
| DELETE | /user/session | — | Logout |
| POST | /code | — | Create code (with initial snapshot) |
| PUT | /code/:code_id | checkCodeOwner | Update code (creates new snapshot) |
| GET | /code | — | List my codes (latest code + tested status) |
| GET | /code/:code_id | checkCodeOwner | Get code details (latest code + tested status) |
| GET | /enroll | — | My enrollments |
| GET | /enroll/:enroll_id | checkEnrollOwner | Get enrollment |
| GET | /enroll/:enroll_id/code | checkEnrollOwner | Get linked code (latest code + tested status) |
| POST | /enroll/:enroll_id/code | checkEnrollOwner | Link/replace code |
| DELETE | /enroll/:enroll_id/code/:code_id | checkEnrollOwner | Unlink code |
| POST | /enroll/:enroll_id/test | checkEnrollOwner | Create test vs NPC |
| GET | /enroll/:enroll_id/test | checkEnrollOwner | List tests for this enrollment |
| GET | /test | — | List all my tests across competitions |
| GET | /test/:id | — | Get specific test result |
| POST | /enroll/:enroll_id/battle | checkEnrollOwner | Create battle vs opponent |
| GET | /enroll/:enroll_id/battle | checkEnrollOwner | List battles for this enrollment |
| GET | /battle | — | List all my battles across competitions |
| GET | /battle/:id | — | Get battle result |

### Root (mounted at /admin)
| Method | Path | Description |
|--------|------|-------------|
| POST | /user | Create user |
| POST | /competition | Create competition |
| POST | /enroll | Enroll a user in a competition |
| DELETE | /enroll/:enroll_id | Withdraw a user from a competition |
| GET | /snapshot/:id | Get snapshot code (Lambda-only, no user equivalent) |
| PUT | /battle-attempt/:id | Lambda attempt log (records start_time + lambda_request_id) |
| PUT | /battle/:id | Lambda callback (write result + execution_log + win/lose/tie count) |
| POST | /approve-code | Mark code as tested (self-play synthetic battle) |

### Middleware
- `checkEnrollOwner` — verifies req.user owns the enrollment
- `checkCodeOwner` — verifies code.user_id == req.user.user_id

---

## Lambda Execution Model

### Success-only recording

The main Lambda only records **success**. On any failure (infra or user code), it raises an exception — SQS redrives the message. After maxReceiveCount, the message goes to the DLQ, where the DLQ consumer writes `infra_ok=false, input_ok=false`.

```
SQS queue ──► Main Lambda (battle executor)
    │              │ success? → callback(infra_ok=true, input_ok=true) → done
    │              │ fail? → raise → SQS retries after visibility timeout
    │              │ maxReceiveCount (3) exceeded → moves to DLQ
    ▼
DLQ ──► DLQ Consumer Lambda (separate function)
            │
            └──► PUT /admin/battle/:id { infra_ok: false, input_ok: false }
```

### Sequence

1. **Attempt log**: `PUT /admin/battle-attempt/:id` — creates `execution_log` row with `lambda_request_id`, `start_time_utc`, and `end_time_utc=NULL`. If the Lambda crashes, this row is the breadcrumb for finding CloudWatch logs.
2. **Deterministic RNG**: `random.seed(hash(battle_id))` + `np.random.seed(...)` ensures retries produce the same simulation result.
3. **Setup**: Fetch competition + snapshots via API, download game from S3, import modules.
4. **Execute**: Init game → `simulate(a_update, b_update)` → export video → upload to S3.
5. **Callback**: `PUT /admin/battle/:id` with `infra_ok=true, input_ok=true` + winner/loser/video.
6. **Failure path**: Any exception is logged and re-raised. No callback attempt. SQS retries.

### API endpoints the Lambda calls

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| PUT | /admin/battle-attempt/:id | Root token | Log attempt (start_time + lambda_request_id) |
| GET | /competition/:id | Root token | Fetch competition (game_reference for S3) |
| GET | /admin/snapshot/:id | Root token | Fetch snapshot code text |
| PUT | /admin/battle/:id | Root token | Write result + INSERT execution_log |

### DLQ Consumer

Separate Lambda (`simulator/dlq_consumer/handler.py`), built from `Dockerfile.dlq`. Triggered by the DLQ SQS subscription. Reads the original SQS message and calls `PUT /admin/battle/:id` with `infra_ok=false, input_ok=false`. The API's `WHERE infra_ok IS NULL` guard ensures a late retry that succeeded won't be overwritten.

### Security

After `setup_clients()` captures the token into `db_client.token`, `LAMBDA_CALLBACK_TOKEN` is stripped from `os.environ` so user-submitted code running in the same process cannot read it.
