// Internal endpoints used by the simulator Lambda instead of connecting to
// RDS directly. The Lambda authenticates with the long-lived service-account
// session token (see database/4. service-account.sql) and these endpoints run
// the exact SQL the old simulator dbClient ran. Routing through the API means
// all DB access goes through the shared pg.Pool, bounding RDS connections to
// the pool size rather than scaling with Lambda concurrency.
//
// Every route here is root-only (adminAuthMiddleware). Mounted at
// /api/internal in server.js.
const express = require('express');
const pool = require('../utils/db');
const authMiddleware = require('../utils/authMiddleware');
const adminAuthMiddleware = require('../utils/adminAuthMiddleware');

const router = express.Router();
router.use(express.json());
router.use(authMiddleware);
router.use(adminAuthMiddleware);

// GET /internal/code/:id - fetch a strategy's source.
// Replaces dbClient.getCode (SELECT code FROM app.code WHERE id = ...).
// Returns { id, code }. 404 if the code id does not exist.
router.get('/code/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query(
            'SELECT id, code FROM app.code WHERE id = $1',
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'code not found' });
        }
        return res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Database error' });
    }
});

// POST /internal/simulation-job/pending - mark a job pending.
// Replaces dbClient.markPending: INSERT a fresh simulation_job row.
// body = { battle_id }
router.post('/simulation-job/pending', async (req, res) => {
    const { battle_id } = req.body;
    if (!battle_id) {
        return res.status(400).json({ error: 'battle_id is required' });
    }
    try {
        const insertResult = await pool.query(
            `INSERT INTO app.simulation_job (battle_id, status)
             VALUES ($1, 'pending') RETURNING *`,
            [battle_id]
        );
        return res.status(201).json(insertResult.rows[0]);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Database error' });
    }
});

// POST /internal/simulation-job/complete - finish a job 'completed'.
// Replaces dbClient.markComplete.
// body = { battle_id, simulation_id, winner_user_id, loser_user_id,
//          winner_score_gain, loser_score_loss, battle_video_reference,
//          execution_log }
// winner/loser ids may be null (draw). Score fields default to 0, log to null.
router.post('/simulation-job/complete', async (req, res) => {
    const {
        battle_id,
        simulation_id,
        winner_user_id = null,
        loser_user_id = null,
        winner_score_gain = 0,
        loser_score_loss = 0,
        battle_video_reference = null,
        execution_log = null,
    } = req.body;

    if (!battle_id || !simulation_id) {
        return res.status(400).json({ error: 'battle_id and simulation_id are required' });
    }

    try {
        const result = await pool.query(
            `UPDATE app.simulation_job
                SET status = 'completed',
                    winner_user_id = $1,
                    loser_user_id = $2,
                    winner_score_gain = $3,
                    loser_score_loss = $4,
                    battle_video_reference = $5,
                    execution_log = $6,
                    updated_at_utc = now()
              WHERE id = $7 AND battle_id = $8
          RETURNING id`,
            [
                winner_user_id,
                loser_user_id,
                winner_score_gain,
                loser_score_loss,
                battle_video_reference,
                execution_log,
                simulation_id,
                battle_id,
            ]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'simulation_job not found for battle' });
        }
        return res.status(200).json({ simulation_id });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Database error' });
    }
});

// POST /internal/simulation-job/failed - finish a job 'failed'.
// Replaces dbClient.markFailed.
// body = { simulation_id, execution_log }
router.post('/simulation-job/failed', async (req, res) => {
    const { simulation_id, execution_log = null } = req.body;
    if (!simulation_id) {
        return res.status(400).json({ error: 'simulation_id is required' });
    }
    try {
        const result = await pool.query(
            `UPDATE app.simulation_job
                SET status = 'failed',
                    execution_log = $1,
                    updated_at_utc = now()
              WHERE id = $2
          RETURNING id`,
            [execution_log, simulation_id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'simulation_job not found' });
        }
        return res.status(200).json({ simulation_id });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Database error' });
    }
});

module.exports = router;
