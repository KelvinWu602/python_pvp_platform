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

// DELETE /user/session - Logout
router.delete('/user/session', async (req, res) => {
    try {
        await pool.query(
            `UPDATE app.user_session SET expire_at_utc = now() WHERE id = $1;`,
            [req.user.session_id]
        );
        return res.status(200).json({ message: 'Session terminated' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// GET /competition - List all competitions
router.get('/competition', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM app.competition;`);
        return res.status(200).json(result.rows);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// GET /competition/:id - Get competition
router.get('/competition/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `SELECT * FROM app.competition WHERE id = $1;`,
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Competition not found' });
        }
        return res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// POST /code - Create code with initial snapshot
router.post('/code', async (req, res) => {
    let client;
    try {
        const { name, code } = req.body;
        if (!name) {
            return res.status(400).json({ error: 'missing name' });
        }
        client = await pool.connect();
        await client.query('BEGIN;');
        const codeResult = await client.query(
            `INSERT INTO app.code (user_id, name) VALUES ($1, $2) RETURNING *;`,
            [req.user.user_id, name]
        );
        const newCode = codeResult.rows[0];
        if (code) {
            await client.query(
                `INSERT INTO app.snapshot (code_id, code) VALUES ($1, $2);`,
                [newCode.id, code]
            );
        }
        await client.query('COMMIT;');
        return res.status(201).json({ id: newCode.id, name: newCode.name, created_at_utc: newCode.created_at_utc });
    } catch (err) {
        if (client) await client.query('ROLLBACK;').catch(() => {});
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    } finally {
        if (client) client.release();
    }
});

// PUT /code/:code_id - Update code (creates new snapshot)
router.put('/code/:code_id', checkCodeOwner, async (req, res) => {
    try {
        const { code_id } = req.params;
        const { code } = req.body;
        if (!code) {
            return res.status(400).json({ error: 'missing code' });
        }
        await pool.query(
            `INSERT INTO app.snapshot (code_id, code) VALUES ($1, $2);`,
            [code_id, code]
        );
        return res.status(200).json({ message: 'Code updated' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// GET /code - List my codes with latest code and tested status
router.get('/code', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT c.id, c.name, c.created_at_utc,
                    s.code AS code,
                    EXISTS (
                      SELECT 1 FROM app.battle b
                      WHERE (b.a_snapshot_id = s.id OR b.b_snapshot_id = s.id)
                        AND b.infra_ok = true AND b.input_ok = true
                    ) AS tested
             FROM app.code c
             LEFT JOIN app.snapshot s ON c.id = s.code_id
             WHERE c.user_id = $1
               AND (s.id IS NULL OR s.id = (SELECT s2.id FROM app.snapshot s2 WHERE s2.code_id = c.id ORDER BY s2.created_at_utc DESC LIMIT 1))
             ORDER BY c.created_at_utc DESC;`,
            [req.user.user_id]
        );
        return res.status(200).json(result.rows);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// GET /code/:code_id - Get code details with latest code and tested status
router.get('/code/:code_id', checkCodeOwner, async (req, res) => {
    try {
        const { code_id } = req.params;
        const result = await pool.query(
            `SELECT c.id, c.name, c.created_at_utc,
                    s.code,
                    EXISTS (
                      SELECT 1 FROM app.battle b
                      WHERE (b.a_snapshot_id = s.id OR b.b_snapshot_id = s.id)
                        AND b.infra_ok = true AND b.input_ok = true
                    ) AS tested
             FROM app.code c
             LEFT JOIN app.snapshot s ON c.id = s.code_id
             WHERE c.id = $1
             ORDER BY s.created_at_utc DESC
             LIMIT 1;`,
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

// GET /enroll - List my enrollments
router.get('/enroll', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT * FROM app.enroll WHERE user_id = $1;`,
            [req.user.user_id]
        );
        return res.status(200).json(result.rows);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// GET /enroll/:enroll_id - Get enrollment
router.get('/enroll/:enroll_id', checkEnrollOwner, async (req, res) => {
    try {
        const { enroll_id } = req.params;
        const result = await pool.query(
            `SELECT * FROM app.enroll WHERE id = $1;`,
            [enroll_id]
        );
        return res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// GET /enroll/:eid/code - Get linked code with latest code and tested status
router.get('/enroll/:enroll_id/code', checkEnrollOwner, async (req, res) => {
    try {
        const { enroll_id } = req.params;
        const result = await pool.query(
            `SELECT c.id, c.name, c.created_at_utc,
                    s.code,
                    EXISTS (
                      SELECT 1 FROM app.battle b
                      WHERE (b.a_snapshot_id = s.id OR b.b_snapshot_id = s.id)
                        AND b.infra_ok = true AND b.input_ok = true
                    ) AS tested
             FROM app.code c
             JOIN app.code_select cs ON cs.code_id = c.id
             LEFT JOIN app.snapshot s ON c.id = s.code_id
             WHERE cs.enroll_id = $1
             ORDER BY s.created_at_utc DESC
             LIMIT 1;`,
            [enroll_id]
        );
        return res.status(200).json(result.rows[0] || null);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// POST /enroll/:eid/code - Link code to enrollment (replaces any existing link)
router.post('/enroll/:enroll_id/code', checkEnrollOwner, async (req, res) => {
    try {
        const { enroll_id } = req.params;
        const { code_id } = req.body;

        if (!code_id) {
            return res.status(400).json({ error: 'missing code_id' });
        }

        const codeResult = await pool.query(
            `SELECT id FROM app.code WHERE id = $1 AND user_id = $2;`,
            [code_id, req.user.user_id]
        );
        if (codeResult.rows.length === 0) {
            return res.status(400).json({ error: 'code not found or not owned by you' });
        }

        const enrollResult = await pool.query(
            `SELECT competition_id FROM app.enroll WHERE id = $1;`,
            [enroll_id]
        );
        const competition_id = enrollResult.rows[0].competition_id;

        const client = await pool.connect();
        try {
            await client.query('BEGIN;');

            await client.query(
                `DELETE FROM app.code_select WHERE enroll_id = $1;`,
                [enroll_id]
            );

            await client.query(
                `INSERT INTO app.code_select (enroll_id, code_id, user_id, competition_id)
                 VALUES ($1, $2, $3, $4);`,
                [enroll_id, code_id, req.user.user_id, competition_id]
            );

            await client.query('COMMIT;');

            return res.status(200).json({ message: 'Code linked to enrollment' });
        } catch (err) {
            await client.query('ROLLBACK;').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// DELETE /enroll/:eid/code/:cid - Unlink code from enrollment
router.delete('/enroll/:enroll_id/code/:code_id', checkEnrollOwner, async (req, res) => {
    try {
        const { enroll_id, code_id } = req.params;
        const result = await pool.query(
            `DELETE FROM app.code_select WHERE enroll_id = $1 AND code_id = $2 RETURNING *;`,
            [enroll_id, code_id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Link not found' });
        }
        return res.status(200).json({ message: 'Code unlinked' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// ─── Test endpoints (is_test = true) ──────────────────────────

// POST /enroll/:eid/test - Create test vs NPC
router.post('/enroll/:enroll_id/test', checkEnrollOwner, async (req, res) => {
    try {
        const user_id = req.user.user_id;
        const enroll_id = req.params.enroll_id;

        const enrollResult = await pool.query(
            `SELECT e.competition_id, c.npc_user_id
             FROM app.enroll e
             JOIN app.competition c ON e.competition_id = c.id
             WHERE e.id = $1;`,
            [enroll_id]
        );
        const { competition_id, npc_user_id } = enrollResult.rows[0];

        const snapResult = await pool.query(
            `SELECT s.id FROM app.snapshot s
             JOIN app.code_select cs ON cs.code_id = s.code_id
             WHERE cs.enroll_id = $1
             ORDER BY s.created_at_utc DESC LIMIT 1;`,
            [enroll_id]
        );
        if (snapResult.rows.length === 0) {
            return res.status(400).json({ error: 'No code linked to this enrollment' });
        }
        const a_snapshot_id = snapResult.rows[0].id;

        // Find NPC's enrollment in this competition
        const npcEnrollResult = await pool.query(
            `SELECT id FROM app.enroll
             WHERE competition_id = $1 AND user_id = $2;`,
            [competition_id, npc_user_id]
        );
        if (npcEnrollResult.rows.length === 0) {
            return res.status(400).json({ error: 'NPC not enrolled in this competition' });
        }
        const npcEnrollId = npcEnrollResult.rows[0].id;

        const npcSnapResult = await pool.query(
            `SELECT s.id FROM app.snapshot s
             JOIN app.code_select cs ON cs.code_id = s.code_id
             WHERE cs.enroll_id = $1
               AND EXISTS (
                 SELECT 1 FROM app.battle b
                 WHERE (b.a_snapshot_id = s.id OR b.b_snapshot_id = s.id)
                   AND b.infra_ok = true AND b.input_ok = true
               )
             ORDER BY s.created_at_utc DESC LIMIT 1;`,
            [npcEnrollId]
        );
        if (npcSnapResult.rows.length === 0) {
            return res.status(400).json({ error: 'NPC code not tested yet' });
        }
        const b_snapshot_id = npcSnapResult.rows[0].id;

        const client = await pool.connect();
        try {
            await client.query('BEGIN;');

            const battleResult = await client.query(
                `INSERT INTO app.battle (competition_id, is_test, a_user_id, a_snapshot_id, b_user_id, b_snapshot_id)
                 VALUES ($1, true, $2, $3, $4, $5) RETURNING *;`,
                [competition_id, user_id, a_snapshot_id, npc_user_id, b_snapshot_id]
            );
            const battle = battleResult.rows[0];

            const payload = {
                battle_id: battle.id,
                competition_id,
                a_user_id: user_id,
                b_user_id: npc_user_id,
                a_snapshot_id,
                b_snapshot_id,
            };

            await enqueueBattle(payload);
            await client.query('COMMIT;');

            return res.status(201).json({ id: battle.id });
        } catch (err) {
            await client.query('ROLLBACK;').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// GET /enroll/:eid/test - List tests for this enrollment
router.get('/enroll/:enroll_id/test', checkEnrollOwner, async (req, res) => {
    try {
        const enroll_id = req.params.enroll_id;
        const enrollResult = await pool.query(
            `SELECT competition_id FROM app.enroll WHERE id = $1;`,
            [enroll_id]
        );
        const { competition_id } = enrollResult.rows[0];

        const result = await pool.query(
            `SELECT id, competition_id, is_test, a_user_id, b_user_id,
                    infra_ok, input_ok, draw, winner_user_id, loser_user_id,
                    video_reference, created_at_utc, updated_at_utc
             FROM app.battle
             WHERE competition_id = $1 AND is_test = true AND a_user_id = $2
             ORDER BY created_at_utc DESC;`,
            [competition_id, req.user.user_id]
        );
        return res.status(200).json(result.rows);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// GET /test - List all my tests across all competitions
router.get('/test', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, competition_id, is_test, a_user_id, b_user_id,
                    infra_ok, input_ok, draw, winner_user_id, loser_user_id,
                    video_reference, created_at_utc, updated_at_utc
             FROM app.battle
             WHERE is_test = true AND a_user_id = $1
             ORDER BY created_at_utc DESC;`,
            [req.user.user_id]
        );
        return res.status(200).json(result.rows);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// ─── Battle endpoints (is_test = false) ───────────────────────

// POST /enroll/:eid/battle - Create battle vs opponent
router.post('/enroll/:enroll_id/battle', checkEnrollOwner, async (req, res) => {
    try {
        const user_id = req.user.user_id;
        const enroll_id = req.params.enroll_id;
        const { b_enroll_id } = req.body;

        if (!b_enroll_id) {
            return res.status(400).json({ error: 'missing b_enroll_id' });
        }

        if (b_enroll_id === enroll_id) {
            return res.status(400).json({ error: 'Cannot battle yourself' });
        }

        const enrollResult = await pool.query(
            `SELECT e.competition_id, e.user_id AS a_uid
             FROM app.enroll e WHERE e.id = $1;`,
            [enroll_id]
        );
        const { competition_id } = enrollResult.rows[0];

        const oppResult = await pool.query(
            `SELECT e.id, e.user_id, cs.code_id
             FROM app.enroll e
             JOIN app.code_select cs ON cs.enroll_id = e.id
             WHERE e.id = $1 AND e.competition_id = $2;`,
            [b_enroll_id, competition_id]
        );
        if (oppResult.rows.length === 0) {
            return res.status(400).json({ error: 'Opponent not found or has no code linked' });
        }
        const { user_id: b_user_id, code_id: b_code_id } = oppResult.rows[0];

        const mySnapResult = await pool.query(
            `SELECT s.id FROM app.snapshot s
             JOIN app.code_select cs ON cs.code_id = s.code_id
             WHERE cs.enroll_id = $1
               AND EXISTS (
                 SELECT 1 FROM app.battle b
                 WHERE (b.a_snapshot_id = s.id OR b.b_snapshot_id = s.id)
                   AND b.infra_ok = true AND b.input_ok = true
               )
             ORDER BY s.created_at_utc DESC LIMIT 1;`,
            [enroll_id]
        );
        if (mySnapResult.rows.length === 0) {
            return res.status(400).json({ error: 'You have no tested code' });
        }
        const a_snapshot_id = mySnapResult.rows[0].id;

        const oppSnapResult = await pool.query(
            `SELECT s.id FROM app.snapshot s
             WHERE s.code_id = $1
               AND EXISTS (
                 SELECT 1 FROM app.battle b
                 WHERE (b.a_snapshot_id = s.id OR b.b_snapshot_id = s.id)
                   AND b.infra_ok = true AND b.input_ok = true
               )
             ORDER BY s.created_at_utc DESC LIMIT 1;`,
            [b_code_id]
        );
        if (oppSnapResult.rows.length === 0) {
            return res.status(400).json({ error: 'Opponent has no tested code' });
        }
        const b_snapshot_id = oppSnapResult.rows[0].id;

        const client = await pool.connect();
        try {
            await client.query('BEGIN;');

            const battleResult = await client.query(
                `INSERT INTO app.battle (competition_id, is_test, a_user_id, a_snapshot_id, b_user_id, b_snapshot_id)
                 VALUES ($1, false, $2, $3, $4, $5) RETURNING *;`,
                [competition_id, user_id, a_snapshot_id, b_user_id, b_snapshot_id]
            );
            const battle = battleResult.rows[0];

            const payload = {
                battle_id: battle.id,
                competition_id,
                a_user_id: user_id,
                b_user_id,
                a_snapshot_id,
                b_snapshot_id,
            };

            await enqueueBattle(payload);
            await client.query('COMMIT;');

            return res.status(201).json({ id: battle.id });
        } catch (err) {
            await client.query('ROLLBACK;').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// GET /enroll/:eid/battle - List battles for this enrollment
router.get('/enroll/:enroll_id/battle', checkEnrollOwner, async (req, res) => {
    try {
        const enroll_id = req.params.enroll_id;
        const enrollResult = await pool.query(
            `SELECT competition_id FROM app.enroll WHERE id = $1;`,
            [enroll_id]
        );
        const { competition_id } = enrollResult.rows[0];

        const result = await pool.query(
            `SELECT id, competition_id, is_test, a_user_id, b_user_id,
                    infra_ok, input_ok, draw, winner_user_id, loser_user_id,
                    video_reference, created_at_utc, updated_at_utc
             FROM app.battle
             WHERE competition_id = $1 AND is_test = false
               AND (a_user_id = $2 OR b_user_id = $2)
             ORDER BY created_at_utc DESC;`,
            [competition_id, req.user.user_id]
        );
        return res.status(200).json(result.rows);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// GET /battle - List all my battles across all competitions
router.get('/battle', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT id, competition_id, is_test, a_user_id, b_user_id,
                    infra_ok, input_ok, draw, winner_user_id, loser_user_id,
                    video_reference, created_at_utc, updated_at_utc
             FROM app.battle
             WHERE is_test = false
               AND (a_user_id = $1 OR b_user_id = $1)
             ORDER BY created_at_utc DESC;`,
            [req.user.user_id]
        );
        return res.status(200).json(result.rows);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

// ─── Shared result endpoints ──────────────────────────────────

// GET /test/:id - Get test result
router.get('/test/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `SELECT id, competition_id, is_test, a_user_id, b_user_id,
                    infra_ok, input_ok, draw, winner_user_id, loser_user_id,
                    video_reference, created_at_utc, updated_at_utc
             FROM app.battle WHERE id = $1 AND is_test = true AND a_user_id = $2;`,
            [id, req.user.user_id]
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

// GET /battle/:id - Get battle result
router.get('/battle/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `SELECT id, competition_id, is_test, a_user_id, b_user_id,
                    infra_ok, input_ok, draw, winner_user_id, loser_user_id,
                    video_reference, created_at_utc, updated_at_utc
             FROM app.battle WHERE id = $1 AND (a_user_id = $2 OR b_user_id = $2);`,
            [id, req.user.user_id]
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

module.exports = router;
