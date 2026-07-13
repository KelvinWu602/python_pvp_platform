# API_elegant.md

The elegant, semantically consistent API surface for the Python PvP Platform.

Design principles this document abides by:

1. **Ownership tree in the URL** — every user-scoped resource lives under the
   ancestor it belongs to. No cross-competition flat lists on the user surface.
2. **One noun per path segment** — `/code`, `/snapshot`, `/test`, `/battle`,
   `/enroll`. Never a verb, never a mixed concern.
3. **Verbs derive from HTTP methods only** — no `POST /approve-code`; no
   `PUT /code {code}` that means "create snapshot."
4. **Consistent response envelopes** — lists are JSON arrays, single resources
   are JSON objects, creations return `201 { id }`, silent successes return
   `204`, errors are `{ error: string }` with a matching HTTP status.
5. **Server derives from context** — anything the server can compute (e.g.
   `result` in a battle list, `tested_at_utc`) is not the client's job.
6. **Denormalize hot paths** — every query that used to depend on `LATERAL` +
   correlated `EXISTS` on `app.battle` now reads persisted columns maintained
   by triggers.
7. **Payloads are the minimum the caller needs** — heavy fields (`a_stdout_log`,
   `a_stderr_log`, ...) are opt-in via query flags.
8. **URL params carry IDs, body carries data, query string carries options.**
9. **Auth boundary is unambiguous** — `/public/*` = anon; `/*` (default) = user
   (or root via bypass); `/admin/*` = root.

Notation used in this document:

* `:eid` = enrollment id, `:cid` = code id, `:sid` = snapshot id, `:tid` = test
  (battle) id, `:bid` = battle id.
* Auth column: `anon` = no session required; `user` = valid session
  (root allowed via the bypass in `authorization.js`); `root` = must be
  `urole='root'`.

---

## 1. Session

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| `POST` | `/public/session` | anon | `{ username, password }` | `201 { session_id, urole }` |
| `DELETE` | `/session` | user | — | `204` |

`session_id` is the bearer token the caller sends as `Authorization: Bearer <id>` on subsequent requests. Sessions expire 2 hours after issue.

Frontend callers:
* `POST /public/session` — `login.js` (via `api.login`).
* `DELETE /session` — `header.js` logout button (via `api.logout`).

---

## 2. Enrollments

An enrollment is the user's presence in a single competition. It is the root of all user-scoped competition activity.

### 2.1 List my enrollments

`GET /enroll` — auth: user

Response:
```json
[
  {
    "id": "uuid",
    "competition_id": "uuid",
    "competition_display_name": "string",
    "start_time_utc": "timestamp",
    "end_time_utc": "timestamp"
  }
]
```

* `competition_id` is included because the frontend correlates the current
  battle / code back to its enrollment by competition (see `battleResult.js`,
  `codeEditor.js`).
* `win/lose/tie` counts are intentionally **not** in the list; they're on the
  detail endpoint.

Order: `start_time_utc DESC`.

Frontend callers: `dashboard.js`, `codeEditor.js`, `battleResult.js`.

### 2.2 Get one enrollment (detail)

`GET /enroll/:eid` — auth: user (owner check via `checkEnrollOwner`)

Response:
```json
{
  "id": "uuid",
  "competition_id": "uuid",
  "competition_display_name": "string",
  "competition_description": "string",
  "start_time_utc": "timestamp",
  "end_time_utc": "timestamp",
  "win_count": 0,
  "lose_count": 0,
  "tie_count": 0
}
```

Frontend callers: `competition.js`, `battleResult.js` (for latest counters).

---

## 3. Codes

A code is a Python program authored by a user for a single competition. Codes are always scoped under an enrollment when created; they are looked up directly by id when viewed / edited.

### 3.1 List codes in an enrollment

`GET /enroll/:eid/code` — auth: user (owner check via `checkEnrollOwner`)

Response:
```json
[
  { "id": "uuid", "name": "string", "updated_at_utc": "timestamp" }
]
```

Order: `updated_at_utc DESC`.

`updated_at_utc` is read directly from `app.code.updated_at_utc` (denormalized; bumped on snapshot insert). No LATERAL join.

Frontend callers: `dashboard.js` (loaded when the user selects an enrollment).

### 3.2 Create a code

`POST /enroll/:eid/code` — auth: user (owner check via `checkEnrollOwner`)

Body:
```json
{ "name": "string" }
```

Response: `201 { "id": "uuid" }`

* Creates only the code row. **No initial snapshot is created.**
* `GET /code/:cid/text` returns `{ "text": null }` until the user makes the first save.
* `GET /code/:cid/snapshot` returns `[]` until the first save.

Frontend callers: `dashboard.js` (create-code modal).

### 3.3 Get code metadata

`GET /code/:cid` — auth: user (owner check via `checkCodeOwner`)

Response:
```json
{
  "id": "uuid",
  "name": "string",
  "competition_id": "uuid",
  "enroll_id": "uuid",
  "updated_at_utc": "timestamp"
}
```

* `enroll_id` is the caller's enrollment in the code's competition, resolved
  server-side. This saves the frontend from a separate `GET /enroll` lookup
  to enable the "測試" button.

Frontend callers: `codeEditor.js`.

### 3.4 Get latest snapshot text

`GET /code/:cid/text` — auth: user (owner check via `checkCodeOwner`)

Response:
```json
{ "text": "string | null" }
```

* `null` when the code has no snapshots yet (fresh from `POST /enroll/:eid/code`).
* Split from `GET /code/:cid` so the snapshot polling loop and metadata cache
  can operate independently, and so future callers that only need the header
  don't pay for the (possibly tens-of-KB) source text.

Frontend callers: `codeEditor.js`.

---

## 4. Selected code (singleton subresource)

Each enrollment has at most one "selected" code — the entry that represents
this user in real battles. This is a singleton subresource of the enrollment.

### 4.1 Get the selected code

`GET /enroll/:eid/code/selected` — auth: user (owner check via `checkEnrollOwner`)

Response:
```json
{ "id": "uuid", "name": "string", "tested_at_utc": "timestamp | null" }
```
or `null` (JSON literal) when nothing is selected.

`tested_at_utc` reflects when the selected code's latest snapshot first
achieved `latest_test_status='success'`. It's `null` if the latest snapshot has
not been successfully tested.

Frontend callers: `dashboard.js`, `competition.js`.

### 4.2 Set the selected code

`PUT /enroll/:eid/code/selected` — auth: user (owner check via `checkEnrollOwner`)

Body:
```json
{ "code_id": "uuid" }
```

Response: `204`

Semantics:
* Idempotent — the URL identifies a singleton, so `PUT` is the correct method.
* Server verifies `code_id` belongs to the caller and matches the enrollment's
  competition; otherwise `400`.

Frontend callers: `dashboard.js` (click a code card).

### 4.3 Clear the selected code

`DELETE /enroll/:eid/code/selected` — auth: user (owner check via `checkEnrollOwner`)

Response: `204`

Frontend callers: none currently. Available for symmetry.

---

## 5. Snapshots

A snapshot is an immutable point-in-time capture of a code's source text. Snapshots are the unit that Lambda executes.

### 5.1 List snapshots of a code

`GET /code/:cid/snapshot` — auth: user (owner check via `checkCodeOwner`)

Response:
```json
[
  {
    "id": "uuid",
    "created_at_utc": "timestamp",
    "test_id": "uuid | null",
    "test_status": "'pending' | 'success' | 'user_error' | 'infra_error' | null"
  }
]
```

Order: `created_at_utc DESC` (latest first).

* `test_id` and `test_status` are read directly from
  `app.snapshot.latest_test_battle_id` and `app.snapshot.latest_test_status`
  (denormalized). No LATERAL join, no `EXISTS` correlated subquery.
* `retestable` is derived on the client:
  `test_status === null || test_status === 'infra_error'`.

Frontend callers: `codeEditor.js` (initial page load).

### 5.2 Get one snapshot

`GET /code/:cid/snapshot/:sid` — auth: user (owner check via `checkCodeOwner`)

Response: same shape as one list element above (`{ id, created_at_utc, test_id, test_status }`).

Used by `codeEditor.js` polling: when at least one snapshot in the list has
`test_status='pending'`, poll only those snapshots by id (in parallel)
instead of re-fetching the full list. Stop polling when none remain pending.

### 5.3 Create a snapshot

`POST /code/:cid/snapshot` — auth: user (owner check via `checkCodeOwner`)

Body:
```json
{ "text": "string" }
```

Response: `201 { "id": "uuid" }`

Side effect (via trigger): bumps `app.code.updated_at_utc` to
`NEW.created_at_utc`.

Frontend callers: `codeEditor.js` (save button).

---

## 6. Tests

A test is a battle with `is_test=true`, always vs. the competition's NPC. Users create tests directly on a code — the server derives the enrollment and NPC snapshot.

### 6.1 Create a test

`POST /code/:cid/test` — auth: user (owner check via `checkCodeOwner`)

Request body: none.

Response: `201 { "id": "uuid" }`

Server behavior:
1. Look up the code's competition and the NPC's latest tested snapshot.
2. Pick the code's newest snapshot as `a_snapshot_id`.
3. `SELECT ... FOR UPDATE` the snapshot row; refuse (`409`) if its
   `latest_test_status IN ('pending','success','user_error')` — only `null` or
   `'infra_error'` are retestable.
4. Insert the battle, enqueue on SQS, commit.

Errors:
* `400` — code has no snapshot; NPC not enrolled; NPC has no tested snapshot.
* `409` — snapshot already tested / test in progress.
* `500` — SQS enqueue failure (transaction rolls back).

Frontend callers: `codeEditor.js` (測試 button on the latest snapshot).

### 6.2 Get a test result

`GET /test/:tid` — auth: user (must be `a_user_id` of the battle)

Query flags:
* `?log=true` — include `a_stdout_log` and `b_stdout_log` fields.
* `?error=true` — include `a_stderr_log` and `b_stderr_log` fields.

Response: full battle object (see §8) with `is_test=true`.

Frontend callers: `testResult.js`.

---

## 7. Battles

A battle is a real match between two enrolled players (`is_test=false`). Matchmaking is server-controlled: users cannot pick their opponent.

### 7.1 Create a battle

`POST /enroll/:eid/battle` — auth: user (owner check via `checkEnrollOwner`)

Request body: none.

Response: `201 { "id": "uuid" }`

Server behavior:
1. Verify caller has a tested snapshot linked (via `enroll.selected_code_id`).
2. Randomly pick an eligible opponent enrollment in the same competition
   (excluding self and NPC) that has a `selected_code_id` and whose latest
   snapshot has `latest_test_status='success'`.
3. Insert the battle, enqueue, commit.

Errors:
* `400` — caller has no tested selected code; no eligible opponent.

Frontend callers: `competition.js` (battle button), `battleResult.js`
(rematch button).

### 7.2 List battles in an enrollment

`GET /enroll/:eid/battle` — auth: user (owner check via `checkEnrollOwner`)

Query flags:
* `?include_pending=true` — include battles with `infra_ok IS NULL`.
* `?include_failed=true` — include battles with `infra_ok=false` or `input_ok=false`.

Default (no flags): only completed successful battles (`infra_ok=true AND input_ok=true`).

Response:
```json
[
  {
    "id": "uuid",
    "opponent_display_name": "string",
    "result": "'win' | 'lose' | 'draw' | 'pending' | 'failed'",
    "created_at_utc": "timestamp"
  }
]
```

Server derives `opponent_display_name` from `app.user.full_name` (falling back to `username`) and `result` from the caller's perspective:
* `pending` — `infra_ok IS NULL`.
* `failed`  — `infra_ok=false OR input_ok=false`.
* `draw`    — `draw=true`.
* `win`     — `winner_user_id = caller_user_id`.
* `lose`    — otherwise.

Order: `created_at_utc DESC`.

Frontend callers: `competition.js` (battle history panel).

### 7.3 Get a battle

`GET /battle/:bid` — auth: user (must be `a_user_id` or `b_user_id`)

Query flags: same `?log=true` / `?error=true` as `GET /test/:tid`.

Response: full battle object (see §8) with `is_test=false`.

Frontend callers: `battleResult.js`.

---

## 8. Full battle object

Returned by `GET /test/:tid` and `GET /battle/:bid`:

```json
{
  "id": "uuid",
  "competition_id": "uuid",
  "is_test": true,
  "a_user_id": "uuid",
  "a_snapshot_id": "uuid",
  "b_user_id": "uuid",
  "b_snapshot_id": "uuid",
  "infra_ok": true,
  "input_ok": true,
  "draw": false,
  "winner_user_id": "uuid | null",
  "loser_user_id": "uuid | null",
  "video_reference": "string | null",
  "created_at_utc": "timestamp",
  "updated_at_utc": "timestamp",

  "a_stdout_log": "...",
  "a_stderr_log": "...",
  "b_stdout_log": "...",
  "b_stderr_log": "..."
}
```

* `a_stdout_log` / `b_stdout_log` present only when `?log=true`.
* `a_stderr_log` / `b_stderr_log` present only when `?error=true`.
* When still running: `infra_ok`, `input_ok`, `draw`, `winner_user_id`,
  `loser_user_id`, `video_reference` are all `null`.

---

## 9. Competition

Only the fields the user-facing frontend actually consumes are exposed.

### 9.1 Get manifest reference

`GET /competition/:cid/manifest` — auth: user

Response:
```json
{ "reference": "string" }
```

This is the S3 key of the competition's `manifest.json`, which drives autocomplete in the code editor.

Frontend callers: `codeEditor.js`.

There is intentionally **no** `GET /competition/:cid` on the user surface.
Competition display name is available on every enrollment via `GET /enroll`, and every user who has any state in a competition (codes, battles, tests) is enrolled in it by construction.

### 9.2 Score histogram

`GET /competition/:cid/histogram` — auth: user

Response:
```json
[
  { "score": 0, "count": 0 }
]
```

`score = win_count * 2 + tie_count`; the NPC is excluded. Order: `score ASC`.

`my_score` is not returned — the caller already has `win_count` and `tie_count` from `GET /enroll/:eid`.

Frontend callers: `competition.js`.

---

## 10. Admin routes

Unchanged in this pass. Admin routes continue to live under `/admin/*` and require `urole='root'`. See `servers/api/routes/root.js`.

Two admin routes are worth noting because they mutate state that the user
surface reads:
* `POST /admin/enroll` — creates an enrollment (nullable
  `selected_code_id` starts `NULL`).
* `PUT /admin/battle/:battle_id` — Lambda callback. Its `UPDATE` on
  `app.battle` fires the `trg_battle_maintains_snapshot_test_state` trigger,
  which is what drives snapshot denormalization.

---

## 11. Endpoints removed in this redesign

| Removed | Replacement |
|---|---|
| `POST /public/user/session` | `POST /public/session` |
| `DELETE /user/session` | `DELETE /session` |
| `GET /code` | `GET /enroll/:eid/code` |
| `POST /code` | `POST /enroll/:eid/code` |
| `PUT /code/:cid` | `POST /code/:cid/snapshot` |
| `GET /enroll/:eid/code` (linked-code lookup) | `GET /enroll/:eid/code/selected` |
| `POST /enroll/:eid/code` (link) | `PUT /enroll/:eid/code/selected` |
| `DELETE /enroll/:eid/code/:cid` | `DELETE /enroll/:eid/code/selected` |
| `POST /enroll/:eid/test` | `POST /code/:cid/test` |
| `GET /enroll/:eid/test` | Derivable from `GET /code/:cid/snapshot` |
| `GET /test` | — (cross-competition list dropped) |
| `GET /battle` | — (cross-competition list dropped) |
| `GET /competition` | — (list dropped) |
| `GET /competition/:cid` | `GET /competition/:cid/manifest`; display name from `GET /enroll` |
| `GET /competition/:cid/score-histogram` | `GET /competition/:cid/histogram` |

---

## 12. Frontend caller impact table

| View file | Method(s) it uses | Notes |
|---|---|---|
| `login.js` | `POST /public/session` | Field name `session_id` (was `auth_token`) |
| `header.js` | `DELETE /session` | Path change |
| `dashboard.js` | `GET /enroll`, `GET /enroll/:eid/code`, `GET /enroll/:eid/code/selected`, `PUT /enroll/:eid/code/selected`, `POST /enroll/:eid/code` | Code list now per-enroll (loaded on selection). Create code no longer sends `text` or `competition_id`. |
| `codeEditor.js` | `GET /code/:cid`, `GET /code/:cid/text`, `GET /code/:cid/snapshot`, `GET /code/:cid/snapshot/:sid`, `POST /code/:cid/snapshot`, `POST /code/:cid/test`, `GET /enroll`, `GET /competition/:cid/manifest` | Handle `text: null` on first load. Save uses `POST /code/:cid/snapshot`. Test uses `POST /code/:cid/test`. Polling switches to per-snapshot fetches for pending rows. |
| `competition.js` | `GET /enroll/:eid`, `GET /competition/:cid/histogram`, `GET /enroll/:eid/code/selected`, `GET /enroll/:eid/battle`, `POST /enroll/:eid/battle` | Server ships `result` and `opponent_display_name`; client-side derivation removed. |
| `battleResult.js` | `GET /battle/:bid`, `GET /enroll` | Drop `GET /competition/:cid`; look up display name from the enroll list. |
| `testResult.js` | `GET /test/:tid?log=true&error=true` | No change. |

---

## 13. Server-derived fields at a glance

| Field | Where computed | Source |
|---|---|---|
| `enroll_id` on `GET /code/:cid` | route handler | `enroll` where `user_id=caller AND competition_id=code.competition_id` |
| `updated_at_utc` on `GET /enroll/:eid/code` | trigger `trg_snapshot_bumps_code_updated` | `app.code.updated_at_utc` |
| `tested_at_utc` on `GET /enroll/:eid/code/selected` | trigger `trg_battle_maintains_snapshot_test_state` | `app.snapshot.tested_at_utc` |
| `test_id`, `test_status` on snapshot list | trigger `trg_battle_maintains_snapshot_test_state` | `app.snapshot.latest_test_battle_id`, `app.snapshot.latest_test_status` |
| `opponent_display_name`, `result` on battle list | route handler (SQL) | JOIN `app.user` + CASE from caller perspective |
