const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../utils/db');
const authentication = require('../utils/authentication');
const authorization = require('../utils/authorization');

const router = express.Router();

router.use(authentication);
router.use(authorization(['root']));

// POST /user - Create user
router.post('/user', async (req, res) => {
    try {
        const { username, full_name, password } = req.body;
        if (!username || !full_name || !password) {
            return res.status(400).json({ error: 'missing required fields' });
        }
        const existing = await pool.query(
            `SELECT id FROM app.user WHERE username = $1;`,
            [username]
        );
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'User already exists' });
        }
        const hash = bcrypt.hashSync(password);
        const result = await pool.query(
            `INSERT INTO app.user (username, full_name, hash_password) VALUES ($1, $2, $3) RETURNING id, username, full_name, urole;`,
            [username, full_name, hash]
        );
        return res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// POST /competition - Create competition with NPC code + admin enrollment
router.post('/competition', async (req, res) => {
    try {
        const {
            npc_user_id, display_name, description,
            start_time_utc, end_time_utc,
            game_reference, helper_reference, manifest_reference
        } = req.body;

        if (!npc_user_id || !display_name || !start_time_utc || !end_time_utc || !game_reference || !helper_reference || !manifest_reference) {
            return res.status(400).json({ error: 'missing required fields' });
        }

        const compResult = await pool.query(
            `INSERT INTO app.competition (npc_user_id, display_name, description, start_time_utc, end_time_utc, game_reference, helper_reference, manifest_reference)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *;`,
            [npc_user_id, display_name, description, start_time_utc, end_time_utc, game_reference, helper_reference, manifest_reference]
        );
        const competition_id = compResult.rows[0].id;
        return res.status(201).json(compResult.rows[0]);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// POST /enroll - Admin enrolls a user in a competition
router.post('/enroll', async (req, res) => {
    try {
        const { competition_id, user_id } = req.body;
        if (!competition_id || !user_id) {
            return res.status(400).json({ error: 'missing competition_id or user_id' });
        }
        const result = await pool.query(
            `INSERT INTO app.enroll (competition_id, user_id)
             VALUES ($1, $2)
             ON CONFLICT (competition_id, user_id) DO NOTHING
             RETURNING *;`,
            [competition_id, user_id]
        );
        if (result.rows.length === 0) {
            return res.status(200).json({ message: 'Already enrolled' });
        }
        return res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// DELETE /enroll/:enroll_id - Admin withdraws a user from a competition
router.delete('/enroll/:enroll_id', async (req, res) => {
    let client;
    try {
        client = await pool.connect();
        const { enroll_id } = req.params;

        await client.query('BEGIN;');

        await client.query(
            `DELETE FROM app.code_select WHERE enroll_id = $1;`,
            [enroll_id]
        );

        const result = await client.query(
            `DELETE FROM app.enroll WHERE id = $1 RETURNING *;`,
            [enroll_id]
        );

        await client.query('COMMIT;');

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Enrollment not found' });
        }
        return res.status(200).json({ message: 'Enrollment withdrawn' });
    } catch (err) {
        if (client) await client.query('ROLLBACK;').catch(() => {});
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    } finally {
        if (client) client.release();
    }
});

// POST /approve-code - Admin marks code as tested (self-play synthetic battle)
router.post('/approve-code', async (req, res) => {
    try {
        const { user_id, competition_id } = req.body;
        if (!user_id || !competition_id) {
            return res.status(400).json({ error: 'missing user_id or competition_id' });
        }

        const enrollResult = await pool.query(
            `SELECT e.id AS enroll_id, cs.code_id
             FROM app.enroll e
             LEFT JOIN app.code_select cs ON cs.enroll_id = e.id
             WHERE e.competition_id = $1 AND e.user_id = $2;`,
            [competition_id, user_id]
        );
        if (enrollResult.rows.length === 0) {
            return res.status(400).json({ error: 'User not enrolled in this competition' });
        }
        const { enroll_id, code_id } = enrollResult.rows[0];
        if (!code_id) {
            return res.status(400).json({ error: 'User has no code linked' });
        }

        const snapResult = await pool.query(
            `SELECT id FROM app.snapshot
             WHERE code_id = $1
             ORDER BY created_at_utc DESC LIMIT 1;`,
            [code_id]
        );
        if (snapResult.rows.length === 0) {
            return res.status(400).json({ error: 'No snapshot found' });
        }
        const snapshot_id = snapResult.rows[0].id;

        const testedResult = await pool.query(
            `SELECT 1 FROM app.battle
             WHERE (a_snapshot_id = $1 OR b_snapshot_id = $1)
               AND infra_ok = true AND input_ok = true
             LIMIT 1;`,
            [snapshot_id]
        );
        if (testedResult.rows.length > 0) {
            return res.status(200).json({ message: 'Already tested' });
        }

        const battleResult = await pool.query(
            `INSERT INTO app.battle (competition_id, is_test, a_user_id, a_snapshot_id, b_user_id, b_snapshot_id,
                                     infra_ok, input_ok, draw, winner_user_id, loser_user_id)
             VALUES ($1, true, $2, $3, $2, $3,
                     true, true, true, $2, $2)
             RETURNING *;`,
            [competition_id, user_id, snapshot_id]
        );

        return res.status(201).json({ message: 'Code approved', battle_id: battleResult.rows[0].id });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    } 
});

// POST /battle-attempt/:id - Lambda attempt log: record that Lambda started processing
router.post('/battle-attempt/:battle_id', async (req, res) => {
    try {
        const { battle_id } = req.params;
        const { lambda_request_id } = req.body;

        const result = await pool.query(
            `INSERT INTO app.execution_log (battle_id, lambda_request_id, start_time_utc)
             VALUES ($1, $2, now())
             RETURNING *;`,
            [battle_id, lambda_request_id]
        );

        return res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// PUT /battle/:battle_id - Lambda callback: record result 
router.put('/battle/:battle_id', async (req, res) => {
    // either call by main or dlq consumer
    let client;
    try {
        client = await pool.connect();
        const { battle_id } = req.params;
        const {
            infra_ok, input_ok, draw,
            winner_user_id, loser_user_id,
            a_user_id, b_user_id,
            video_reference,
            a_stdout_log, a_stderr_log,
            b_stdout_log, b_stderr_log
        } = req.body;

        if (infra_ok === undefined) {
            return res.status(400).json({ error: 'infra_ok is required' });
        }

        await client.query('BEGIN;');

        const battleResult = await client.query(
            `UPDATE app.battle
             SET infra_ok = $1,
                 input_ok = $2,
                 draw = $3,
                 winner_user_id = $4,
                 loser_user_id = $5,
                 video_reference = $6,
                 updated_at_utc = now(),
                 a_stdout_log = $7,
                 a_stderr_log = $8,
                 b_stdout_log = $9,
                 b_stderr_log = $10
              WHERE id = $11 AND infra_ok IS NULL
              RETURNING *;`,
            [infra_ok, input_ok ?? null, draw ?? null, winner_user_id ?? null, loser_user_id ?? null, video_reference ?? null, a_stdout_log ?? null, a_stderr_log ?? null, b_stdout_log ?? null, b_stderr_log ?? null, battle_id]
        );

        // Just a safe guard, normally this cannot happen.
        // since this endpoint ok only if the tx is committed
        // and the handler ok only if this endpoint ok
        if (battleResult.rows.length === 0) {
            await client.query('ROLLBACK;');
            // Row not found or already resolved — either way, nothing to do
            return res.status(200).json({ message: 'No update needed' });
        }

        const battle = battleResult.rows[0];
        if (battle.infra_ok && battle.input_ok) {
            if (battle.draw) {
                await client.query(
                    `UPDATE app.enroll SET tie_count = tie_count + 1
                        WHERE competition_id = $1 AND user_id = $2;`,
                    [battle.competition_id, battle.a_user_id]
                );
                await client.query(
                    `UPDATE app.enroll SET tie_count = tie_count + 1
                        WHERE competition_id = $1 AND user_id = $2;`,
                    [battle.competition_id, battle.b_user_id]
                );
            } else if (battle.winner_user_id && battle.loser_user_id) {
                await client.query(
                    `UPDATE app.enroll SET win_count = win_count + 1
                     WHERE competition_id = $1 AND user_id = $2;`,
                    [battle.competition_id, battle.winner_user_id]
                );
                await client.query(
                    `UPDATE app.enroll SET lose_count = lose_count + 1
                     WHERE competition_id = $1 AND user_id = $2;`,
                    [battle.competition_id, battle.loser_user_id]
                );
            }
        }

        await client.query('COMMIT;');

        return res.status(200).json(battleResult.rows[0]);
    } catch (err) {
        if (client) await client.query('ROLLBACK;').catch(() => {});
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    } finally {
        if (client) client.release();
    }
});

// GET /snapshot/:id - Get snapshot code (Lambda fetches code to run)
router.get('/snapshot/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `SELECT * FROM app.snapshot WHERE id = $1;`,
            [id]
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

module.exports = router;
