Here's my bug review. I found a mix of correctness, security, and reliability issues. I have not changed any code — let me know which you want fixed.
Critical
1. app.user.username has no UNIQUE constraint → duplicate users / broken login
database/2. init-db.sql:26-34 — username is just varchar(20) NOT NULL. The create-user check (userAPI.js:17-24) does a SELECT-then-INSERT, which is a TOCTOU race: two concurrent requests can both pass the check and insert the same username. Then login (userAPI.js:55 if (userResult.rows.length !== 1)) fails for that user forever — every login attempt returns 401 because the query returns 2 rows. Fix: add UNIQUE (username) to the schema.
2. database/4. service-account.sql is missing
Referenced by internalAPI.js:3, deployment.md, docs/security.md, and .env.example, but the file does not exist (database/ only has 1–3 + readme + test-db.sh). Without the seeded root service account + session token 00000000-...-002, every /api/internal/* call from the Lambda gets 403, so markPending/getCode/markComplete/markFailed all fail and battles never complete. Fix: create the migration that seeds the service account user (role root) and a non-expiring user_session row.
3. Create-user returns undefined
userAPI.js:28-33 — the INSERT has no RETURNING, so insertResult.rows[0] is undefined and the endpoint responds 200 with body undefined. Fix: add RETURNING id, username, full_name, urole (and never return hash_password).
High
4. Orphaned pending simulation_job on any failure
internalAPI.js / handler.py:171 — markPending INSERTs the row. If getCode, S3 download, or the sim then throws, the handler calls markFailed (handler.py:190), which is fine — but if markPending itself succeeds and the Lambda is then killed (timeout/OOM) before markFailed, the row is stuck pending. More importantly: SQS redelivers the same message (up to 3×), and each retry calls markPending again with the same simulation_id → the second INSERT fails with a duplicate-PK error, the handler catches it and calls markFailed... but the row is already pending from attempt 1, so it flips to failed even though a retry might have succeeded. The retry path is effectively broken because simulation_id is fixed per message. Fix: make markPending idempotent (INSERT ... ON CONFLICT (id) DO NOTHING) and/or generate simulation_id inside the Lambda per-attempt.
5. competition POST/PUT don't validate inputs → 500s and bad data
competitionAPI.js:81-98, 101-130 — no null checks on game_id, display_name, start_time_utc, end_time_utc. Missing required fields hit a NOT NULL violation and return a generic 500. The PUT also requires all five fields (full replace), so a partial update wipes columns to null/undefined. display_name is varchar(20) — a longer name throws a 500 rather than a 400. Same unvalidated-input pattern in game POST (:14).
6. Enroll endpoint conflates create vs. update and ignores failures
competitionAPI.js:180-206 — if selected_code_id is provided, it does an UPDATE; if the user isn't enrolled yet, the UPDATE matches 0 rows and returns 200 with body undefined (silent no-op). If not provided, it INSERTs — a second enroll attempt hits the UNIQUE(competition_id,user_id) constraint and returns 500 instead of a clean 409. There's also no check that selected_code_id actually belongs to that enrollment, so a user could point their enrollment at someone else's code id.
Medium
7. updated_at_utc is never updated automatically
database/2. init-db.sql — comments say "auto gen" but there are no triggers; columns only default to now() on insert. Code manually sets it in some UPDATEs (competitionAPI game PUT, internalAPI) but not others (e.g. codeAPI PUT :96-106, competition PUT). Inconsistent timestamps. Fix: add a BEFORE UPDATE trigger, or set it in every UPDATE.
8. Game can hang near the Lambda timeout
simulator/games/2526/game.py — simulate() runs up to max_time=30s of sim plus opencv rendering of ~1800 frames at 1080×720. That render is CPU-bound and, on a 512 MB Lambda (low CPU allotment), can plausibly approach or exceed the 60s timeout, producing intermittent failures → DLQ. Also, a malicious/buggy strategy doing heavy work in update() is called ~3600 times with no per-call guard. Fix: bump Lambda memory (more CPU) and/or add a wall-clock guard.
9. bcrypt.hashSync(password) called with await and no cost factor
userAPI.js:26 — await bcrypt.hashSync(...) awaits a non-promise (harmless but misleading), and omitting the salt-rounds arg relies on bcryptjs's default (10). Works, but should be the async bcrypt.hash(password, 12) to avoid blocking the event loop under load.
10. CORS is fully open
server.js:16 — app.use(cors()) allows any origin. Fine for the debug page, but should be restricted before production.
Low / Notes
- s3Client.upload return value is unused (handler.py:128) — harmless; the key is rebuilt locally. Fine.
- enrollOwnershipMiddleware runs before express.json() in codeAPI — actually OK, since authMiddleware/route still parse, but codeAPI.js never calls router.use(express.json()) (unlike other routers). It works only because server.js:19 mounts express.json() globally. Relying on that is fragile; the per-router express.json() in other files is then redundant.
- DB_PORT/DB_MAX_CONN are strings (db.js:7,9) — pg tolerates string port, and max: "25" coerces, but max as a string is technically not the documented type.
- GET /competition/:id returns 200 with undefined body for a non-existent id (competitionAPI.js:144-156) instead of 404.
- GET /battle/:id is unauthenticated-for-any-battle — any logged-in user can read any battle's result by id. May be intended.