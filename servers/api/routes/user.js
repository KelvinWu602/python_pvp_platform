// User-scoped API surface. See API_elegant.md for the full spec.
//
// Auth: every route requires a valid session. authorization(['user']) also
// admits root (see authorization.js — root passes through any role check).
//
// Ownership checks are per-route via checkEnrollOwner / checkCodeOwner.

const express = require('express');
const pool = require('../utils/db');
const authentication = require('../utils/authentication');
const authorization = require('../utils/authorization');
const checkEnrollOwner = require('../utils/checkEnrollOwner');
const checkCodeOwner = require('../utils/checkCodeOwner');
const { enqueueBattle } = require('../utils/sqs');

const router = express.Router();

router.use(authentication);
router.use(authorization(['user']));


// ─── 1. Session ──────────────────────────────────────────────────────

// DELETE /session — logout the caller's session
router.delete('/session', async (req, res) => {
    try {
        await pool.query(
            `UPDATE app.user_session SET expire_at_utc = now() WHERE id = $1;`,
            [req.user.session_id]
        );
        return res.status(204).send();
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});


// ─── 2. Enrollments ──────────────────────────────────────────────────

// GET /enroll — list my enrollments
router.get('/enroll', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT
               e.id,
               e.competition_id,
               e.user_id,
               c.display_name AS competition_display_name,
               c.start_time_utc,
               c.end_time_utc
             FROM app.enroll e
             JOIN app.competition c ON c.id = e.competition_id
             WHERE e.user_id = $1
             ORDER BY c.start_time_utc DESC;`,
            [req.user.user_id]
        );
        return res.status(200).json(result.rows);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// GET /enroll/:enroll_id — one enrollment with detail
router.get('/enroll/:enroll_id', checkEnrollOwner, async (req, res) => {
    try {
        const { enroll_id } = req.params;
        const result = await pool.query(
            `SELECT
               e.id,
               e.competition_id,
               e.user_id,
               c.display_name AS competition_display_name,
               c.description  AS competition_description,
               c.start_time_utc,
               c.end_time_utc,
               e.win_count, e.lose_count, e.tie_count
             FROM app.enroll e
             JOIN app.competition c ON c.id = e.competition_id
             WHERE e.id = $1;`,
            [enroll_id]
        );
        return res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});


// ─── 3. Codes ────────────────────────────────────────────────────────

// GET /enroll/:enroll_id/code — codes I authored for this competition
router.get('/enroll/:enroll_id/code', checkEnrollOwner, async (req, res) => {
    try {
        const { enroll_id } = req.params;
        const result = await pool.query(
            `SELECT c.id, c.name, c.updated_at_utc
             FROM app.code c
             JOIN app.enroll e ON e.competition_id = c.competition_id
             WHERE e.id = $1
               AND c.user_id = $2
             ORDER BY c.updated_at_utc DESC;`,
            [enroll_id, req.user.user_id]
        );
        return res.status(200).json(result.rows);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// POST /enroll/:enroll_id/code — create a code (no initial snapshot)
router.post('/enroll/:enroll_id/code', checkEnrollOwner, async (req, res) => {
    try {
        const { enroll_id } = req.params;
        const { name } = req.body || {};
        if (!name || typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ error: 'missing name' });
        }

        // Look up the enrollment's competition_id — cheap because enroll is
        // small and the row is already fresh in cache from checkEnrollOwner.
        const enrollResult = await pool.query(
            `SELECT competition_id FROM app.enroll WHERE id = $1;`,
            [enroll_id]
        );
        const { competition_id } = enrollResult.rows[0];

        const result = await pool.query(
            `INSERT INTO app.code (user_id, name, competition_id)
             VALUES ($1, $2, $3)
             RETURNING id;`,
            [req.user.user_id, name.trim(), competition_id]
        );
        return res.status(201).json({ id: result.rows[0].id });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// GET /code/:code_id — code metadata (no source text)
//
// enroll_id is the caller's enrollment in this code's competition, resolved
// server-side so the frontend can enable the 測試 button without another
// round-trip. If the caller isn't enrolled, enroll_id is null.
router.get('/code/:code_id', checkCodeOwner, async (req, res) => {
    try {
        const { code_id } = req.params;
        const result = await pool.query(
            `SELECT
               c.id,
               c.name,
               c.competition_id,
               e.id AS enroll_id,
               c.updated_at_utc
             FROM app.code c
             LEFT JOIN app.enroll e
               ON e.competition_id = c.competition_id
              AND e.user_id = c.user_id
             WHERE c.id = $1;`,
            [code_id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Code not found' });
        }
        return res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// GET /code/:code_id/text — latest snapshot's source text (null if none)
router.get('/code/:code_id/text', checkCodeOwner, async (req, res) => {
    try {
        const { code_id } = req.params;
        const result = await pool.query(
            `SELECT code
             FROM app.snapshot
             WHERE code_id = $1
             ORDER BY created_at_utc DESC
             LIMIT 1;`,
            [code_id]
        );
        const text = result.rows.length > 0 ? result.rows[0].code : null;
        return res.status(200).json({ text });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});


// ─── 4. Selected code (singleton subresource) ────────────────────────

// GET /enroll/:enroll_id/code/selected — the code linked to this enrollment
router.get('/enroll/:enroll_id/code/selected', checkEnrollOwner, async (req, res) => {
    try {
        const { enroll_id } = req.params;
        const result = await pool.query(
            `SELECT
               c.id,
               c.name,
               (
                   SELECT s.tested_at_utc
                   FROM app.snapshot s
                   WHERE s.code_id = c.id
                   ORDER BY s.created_at_utc DESC
                   LIMIT 1
               ) AS tested_at_utc
             FROM app.enroll e
             JOIN app.code c ON c.id = e.selected_code_id
             WHERE e.id = $1;`,
            [enroll_id]
        );
        if (result.rows.length === 0) {
            return res.status(200).json(null);
        }
        return res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// PUT /enroll/:enroll_id/code/selected — set the enrollment's selected code
//
// Idempotent. Body: { code_id }. The code must belong to the caller and be
// for the same competition as the enrollment.
router.put('/enroll/:enroll_id/code/selected', checkEnrollOwner, async (req, res) => {
    try {
        const { enroll_id } = req.params;
        const { code_id } = req.body || {};
        if (!code_id) {
            return res.status(400).json({ error: 'missing code_id' });
        }

        // Single query validates both ownership and competition match.
        const validation = await pool.query(
            `SELECT 1
             FROM app.code c
             JOIN app.enroll e ON e.competition_id = c.competition_id
             WHERE c.id = $1
               AND c.user_id = $2
               AND e.id = $3;`,
            [code_id, req.user.user_id, enroll_id]
        );
        if (validation.rows.length === 0) {
            return res.status(400).json({ error: 'code not found, not owned by you, or wrong competition' });
        }

        await pool.query(
            `UPDATE app.enroll SET selected_code_id = $1 WHERE id = $2;`,
            [code_id, enroll_id]
        );
        return res.status(204).send();
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// DELETE /enroll/:enroll_id/code/selected — clear the selected code
router.delete('/enroll/:enroll_id/code/selected', checkEnrollOwner, async (req, res) => {
    try {
        const { enroll_id } = req.params;
        await pool.query(
            `UPDATE app.enroll SET selected_code_id = NULL WHERE id = $1;`,
            [enroll_id]
        );
        return res.status(204).send();
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});


// ─── 5. Snapshots ────────────────────────────────────────────────────

// GET /code/:code_id/snapshot — list snapshots (newest first)
//
// test_id and test_status come straight from the denormalized columns on
// app.snapshot. retestable is derived on the client from test_status.
router.get('/code/:code_id/snapshot', checkCodeOwner, async (req, res) => {
    try {
        const { code_id } = req.params;
        const result = await pool.query(
            `SELECT
               id,
               created_at_utc,
               latest_test_battle_id AS test_id,
               latest_test_status    AS test_status
             FROM app.snapshot
             WHERE code_id = $1
             ORDER BY created_at_utc DESC;`,
            [code_id]
        );
        return res.status(200).json(result.rows);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// GET /code/:code_id/snapshot/:snapshot_id — one snapshot's metadata
//
// Used by codeEditor.js polling: while a snapshot is 'pending', poll just
// that snapshot instead of re-fetching the whole list.
router.get('/code/:code_id/snapshot/:snapshot_id', checkCodeOwner, async (req, res) => {
    try {
        const { code_id, snapshot_id } = req.params;
        const result = await pool.query(
            `SELECT
               id,
               created_at_utc,
               latest_test_battle_id AS test_id,
               latest_test_status    AS test_status
             FROM app.snapshot
             WHERE id = $1 AND code_id = $2;`,
            [snapshot_id, code_id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Snapshot not found' });
        }
        return res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// POST /code/:code_id/snapshot — create a snapshot (aka "save")
//
// The trigger trg_snapshot_bumps_code_updated bumps app.code.updated_at_utc.
router.post('/code/:code_id/snapshot', checkCodeOwner, async (req, res) => {
    try {
        const { code_id } = req.params;
        const { text } = req.body || {};
        if (text === undefined || text === null) {
            return res.status(400).json({ error: 'missing text' });
        }
        const result = await pool.query(
            `INSERT INTO app.snapshot (code_id, code)
             VALUES ($1, $2)
             RETURNING id;`,
            [code_id, text]
        );
        return res.status(201).json({ id: result.rows[0].id });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});


// ─── 6. Tests ────────────────────────────────────────────────────────

// POST /code/:code_id/test — create a test battle vs NPC
//
// Enrollment and NPC snapshot are resolved server-side.
// The guard against duplicate tests uses app.snapshot.latest_test_status
// under FOR UPDATE — see triggers.sql for how the column is maintained.
router.post('/code/:code_id/test', checkCodeOwner, async (req, res) => {
    let client;
    try {
        const { code_id } = req.params;
        const user_id = req.user.user_id;

        // Resolve competition, NPC, caller's latest snapshot, NPC's latest
        // tested snapshot — all in one query where possible.
        const ctxResult = await pool.query(
            `SELECT
               c.competition_id,
               comp.npc_user_id,
               (
                   SELECT s.id FROM app.snapshot s
                   WHERE s.code_id = c.id
                   ORDER BY s.created_at_utc DESC LIMIT 1
               ) AS a_snapshot_id
             FROM app.code c
             JOIN app.competition comp ON comp.id = c.competition_id
             WHERE c.id = $1;`,
            [code_id]
        );
        if (ctxResult.rows.length === 0) {
            return res.status(404).json({ error: 'Code not found' });
        }
        const { competition_id, npc_user_id, a_snapshot_id } = ctxResult.rows[0];
        if (!a_snapshot_id) {
            return res.status(400).json({ error: 'code has no snapshot' });
        }

        // NPC's latest tested snapshot. The NPC's enrollment holds a
        // selected_code_id pointing at their competition code; we want the
        // newest snapshot on that code with latest_test_status='success'.
        const npcSnapResult = await pool.query(
            `SELECT s.id
             FROM app.snapshot s
             JOIN app.code c ON c.id = s.code_id
             JOIN app.enroll e ON e.selected_code_id = c.id
             WHERE e.competition_id = $1
               AND e.user_id = $2
               AND s.latest_test_status = 'success'
             ORDER BY s.created_at_utc DESC
             LIMIT 1;`,
            [competition_id, npc_user_id]
        );
        if (npcSnapResult.rows.length === 0) {
            return res.status(400).json({ error: 'NPC has no tested snapshot' });
        }
        const b_snapshot_id = npcSnapResult.rows[0].id;

        client = await pool.connect();
        await client.query('BEGIN;');

        // Lock the snapshot row so concurrent POST /code/:cid/test calls for
        // the same snapshot serialize. The second observes the first's
        // pending state and returns 409.
        const lockResult = await client.query(
            `SELECT latest_test_status
             FROM app.snapshot
             WHERE id = $1
             FOR UPDATE;`,
            [a_snapshot_id]
        );
        if (lockResult.rowCount === 0) {
            await client.query('ROLLBACK;');
            return res.status(404).json({ error: 'snapshot not found' });
        }
        const status = lockResult.rows[0].latest_test_status;
        // Retestable only when the snapshot has never been tested OR the last
        // test failed on infra (platform side). success / pending / user_error
        // all block retesting.
        if (status !== null && status !== 'infra_error') {
            await client.query('ROLLBACK;');
            return res.status(409).json({ error: 'snapshot already tested or a test is in progress' });
        }

        const battleResult = await client.query(
            `INSERT INTO app.battle
               (competition_id, is_test, a_user_id, a_snapshot_id, b_user_id, b_snapshot_id)
             VALUES ($1, true, $2, $3, $4, $5)
             RETURNING id;`,
            [competition_id, user_id, a_snapshot_id, npc_user_id, b_snapshot_id]
        );
        const battle_id = battleResult.rows[0].id;

        // The trigger trg_battle_insert_sets_snapshot_pending has already
        // moved the snapshot to latest_test_status='pending'. If SQS enqueue
        // fails, the transaction rolls back and the pending state is
        // undone with it.
        await enqueueBattle({
            battle_id,
            competition_id,
            a_user_id: user_id,
            b_user_id: npc_user_id,
            a_snapshot_id,
            b_snapshot_id,
        });

        await client.query('COMMIT;');
        return res.status(201).json({ id: battle_id });
    } catch (err) {
        if (client) await client.query('ROLLBACK;').catch(() => {});
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    } finally {
        if (client) client.release();
    }
});

// GET /test/:test_id — full battle object for a test
router.get('/test/:test_id', async (req, res) => {
    try {
        const log = req.query.log || false;
        const error = req.query.error || false;
        const { test_id } = req.params;
        const result = await pool.query(
            `SELECT
               id, competition_id, is_test,
               a_user_id, a_snapshot_id, b_user_id, b_snapshot_id,
               infra_ok, input_ok, draw, winner_user_id, loser_user_id,
               video_reference,
               created_at_utc, updated_at_utc
               ${ log   ? `, a_stdout_log, b_stdout_log` : `` }
               ${ error ? `, a_stderr_log, b_stderr_log` : `` }
             FROM app.battle
             WHERE id = $1 AND is_test = true AND a_user_id = $2;`,
            [test_id, req.user.user_id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Test not found' });
        }
        return res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});


// ─── 7. Battles ──────────────────────────────────────────────────────

// POST /enroll/:enroll_id/battle — create a battle vs a random opponent
//
// Server-side random matchmaking. No opponent selection: users cannot pick
// their opponent (that would let them farm the weakest player).
router.post('/enroll/:enroll_id/battle', checkEnrollOwner, async (req, res) => {
    let client;
    try {
        const { enroll_id } = req.params;
        const user_id = req.user.user_id;

        // Fetch competition context + window flags in one query. The
        // (now() < start) / (now() > end) comparisons happen inside Postgres
        // so we avoid any timezone/parsing pitfalls in Node's Date.
        const enrollResult = await pool.query(
            `SELECT e.competition_id, c.npc_user_id,
                    (now() < c.start_time_utc) AS not_started,
                    (now() > c.end_time_utc)   AS ended
             FROM app.enroll e
             JOIN app.competition c ON c.id = e.competition_id
             WHERE e.id = $1;`,
            [enroll_id]
        );
        const {
            competition_id, npc_user_id, not_started, ended,
        } = enrollResult.rows[0];

        // Time-window gate: real battles only during the competition. Tests
        // remain freely available (users may prepare / debug outside the
        // window). Fail fast before any snapshot lookups.
        if (not_started) {
            return res.status(403).json({ error: 'Competition has not started' });
        }
        if (ended) {
            return res.status(403).json({ error: 'Competition has ended' });
        }

        // Caller's tested snapshot: the newest snapshot of their selected
        // code with latest_test_status='success'.
        const mySnapResult = await pool.query(
            `SELECT s.id
             FROM app.snapshot s
             JOIN app.enroll e ON e.selected_code_id = s.code_id
             WHERE e.id = $1
               AND s.latest_test_status = 'success'
             ORDER BY s.created_at_utc DESC
             LIMIT 1;`,
            [enroll_id]
        );
        if (mySnapResult.rows.length === 0) {
            return res.status(400).json({ error: 'You have no tested code' });
        }
        const a_snapshot_id = mySnapResult.rows[0].id;

        // Random eligible opponent enrollment in this competition, excluding
        // self and NPC, whose selected code has a tested snapshot.
        //
        // The CTE computes "latest successful snapshot per code" in a single
        // scan of the idx_snapshot_success_by_code partial index, instead of
        // running a correlated subquery per candidate enrollment. It also
        // makes the query's intent explicit: "one row per code, its latest
        // successful snapshot." DISTINCT ON (code_id) is Postgres's idiom
        // for that pattern — picks the first row per group given the
        // matching ORDER BY.
        const oppResult = await pool.query(
            `WITH latest_success AS (
                 SELECT DISTINCT ON (code_id)
                        code_id,
                        id AS snapshot_id
                   FROM app.snapshot
                  WHERE latest_test_status = 'success'
                  ORDER BY code_id, created_at_utc DESC
             )
             SELECT e.id AS enroll_id, e.user_id, ls.snapshot_id
               FROM app.enroll e
               JOIN latest_success ls ON ls.code_id = e.selected_code_id
              WHERE e.competition_id = $1
                AND e.id      <> $2
                AND e.user_id <> $3
              ORDER BY random()
              LIMIT 1;`,
            [competition_id, enroll_id, npc_user_id]
        );
        if (oppResult.rows.length === 0) {
            return res.status(400).json({ error: 'No eligible opponent available' });
        }
        const b_user_id = oppResult.rows[0].user_id;
        const b_snapshot_id = oppResult.rows[0].snapshot_id;

        client = await pool.connect();
        await client.query('BEGIN;');

        const battleResult = await client.query(
            `INSERT INTO app.battle
               (competition_id, is_test, a_user_id, a_snapshot_id, b_user_id, b_snapshot_id)
             VALUES ($1, false, $2, $3, $4, $5)
             RETURNING id;`,
            [competition_id, user_id, a_snapshot_id, b_user_id, b_snapshot_id]
        );
        const battle_id = battleResult.rows[0].id;

        await enqueueBattle({
            battle_id,
            competition_id,
            a_user_id: user_id,
            b_user_id,
            a_snapshot_id,
            b_snapshot_id,
        });

        await client.query('COMMIT;');
        return res.status(201).json({ id: battle_id });
    } catch (err) {
        if (client) await client.query('ROLLBACK;').catch(() => {});
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    } finally {
        if (client) client.release();
    }
});

// GET /enroll/:enroll_id/battle — battle history for this enrollment
//
// Query flags:
//   ?include_pending=true — include battles with infra_ok IS NULL
//   ?include_failed=true  — include battles that infra_errored / user_errored
//
// Default: only completed, successful battles. Server derives
// opponent_display_name and result (from the caller's perspective) so the
// frontend doesn't have to.
router.get('/enroll/:enroll_id/battle', checkEnrollOwner, async (req, res) => {
    try {
        const { enroll_id } = req.params;
        const includePending = req.query.include_pending === 'true';
        const includeFailed  = req.query.include_failed  === 'true';

        // Build the status filter. Default: only completed successful.
        const conditions = [];
        conditions.push(`(b.infra_ok = true AND b.input_ok = true)`);
        if (includePending) conditions.push(`b.infra_ok IS NULL`);
        if (includeFailed)  conditions.push(`(b.infra_ok = false OR b.input_ok = false)`);
        const statusFilter = conditions.join(' OR ');

        const enrollResult = await pool.query(
            `SELECT competition_id, user_id FROM app.enroll WHERE id = $1;`,
            [enroll_id]
        );
        const { competition_id, user_id: me } = enrollResult.rows[0];

        const result = await pool.query(
            `SELECT
               b.id,
               COALESCE(opp.full_name, opp.username) AS opponent_display_name,
               CASE
                 WHEN b.infra_ok IS NULL                              THEN 'pending'
                 WHEN b.infra_ok = false OR b.input_ok = false        THEN 'failed'
                 WHEN b.draw = true                                   THEN 'draw'
                 WHEN b.winner_user_id = $2                           THEN 'win'
                 ELSE                                                     'lose'
               END AS result,
               b.created_at_utc
             FROM app.battle b
             JOIN app.user opp
               ON opp.id = CASE WHEN b.a_user_id = $2 THEN b.b_user_id ELSE b.a_user_id END
             WHERE b.competition_id = $1
               AND b.is_test = false
               AND (b.a_user_id = $2 OR b.b_user_id = $2)
               AND (${statusFilter})
             ORDER BY b.created_at_utc DESC;`,
            [competition_id, me]
        );
        return res.status(200).json(result.rows);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// GET /battle/:battle_id — full battle object
router.get('/battle/:battle_id', async (req, res) => {
    try {
        const log = req.query.log || false;
        const error = req.query.error || false;
        const { battle_id } = req.params;
        const result = await pool.query(
            `SELECT
               id, competition_id, is_test,
               a_user_id, a_snapshot_id, b_user_id, b_snapshot_id,
               infra_ok, input_ok, draw, winner_user_id, loser_user_id,
               video_reference,
               created_at_utc, updated_at_utc
               ${ log   ? `, a_stdout_log, b_stdout_log` : `` }
               ${ error ? `, a_stderr_log, b_stderr_log` : `` }
             FROM app.battle
             WHERE id = $1
               AND (a_user_id = $2 OR b_user_id = $2);`,
            [battle_id, req.user.user_id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Battle not found' });
        }
        return res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});


// ─── 8. Competition ──────────────────────────────────────────────────

// GET /competition/:competition_id/manifest — manifest.json S3 reference
//
// This is the only competition field the user-facing frontend needs on the
// competition itself. Display name is on every enrollment; there is no
// user-facing endpoint returning the full competition row.
router.get('/competition/:competition_id/manifest', async (req, res) => {
    try {
        const { competition_id } = req.params;
        const result = await pool.query(
            `SELECT manifest_reference FROM app.competition WHERE id = $1;`,
            [competition_id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Competition not found' });
        }
        return res.status(200).json({ reference: result.rows[0].manifest_reference });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// GET /competition/:competition_id/histogram — score distribution
//
// score = win_count * 2 + tie_count. NPC excluded. my_score is not returned:
// the caller already has win_count / tie_count from GET /enroll/:eid.
router.get('/competition/:competition_id/histogram', async (req, res) => {
    try {
        const { competition_id } = req.params;

        const compResult = await pool.query(
            `SELECT npc_user_id FROM app.competition WHERE id = $1;`,
            [competition_id]
        );
        if (compResult.rows.length === 0) {
            return res.status(404).json({ error: 'Competition not found' });
        }
        const { npc_user_id } = compResult.rows[0];

        const histResult = await pool.query(
            `SELECT (win_count * 2 + tie_count) AS score, COUNT(*)::int AS count
             FROM app.enroll
             WHERE competition_id = $1 AND user_id <> $2
             GROUP BY score
             ORDER BY score ASC;`,
            [competition_id, npc_user_id]
        );

        return res.status(200).json(
            histResult.rows.map(r => ({ score: Number(r.score), count: r.count }))
        );
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});


module.exports = router;
