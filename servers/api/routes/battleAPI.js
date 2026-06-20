// Battle endpoints.
//
// Starting a battle: POST inserts an app.battle row (with both players' code
// ids frozen on it), then enqueues one job on python-pvp-battle-queue (SQS).
// The simulator Lambda consumes the queue (event source mapping, BatchSize=1)
// and writes the result to app.simulation_job. The API never invokes compute
// directly, which keeps it decoupled; SQS owns retries (visibility timeout)
// and dead-lettering.
//
// Dual-write note: the battle INSERT and the SQS send are two separate writes.
// If the process dies between them, a battle row exists with no job enqueued.
// Because the simulation is idempotent and the message carries a fresh
// simulation_id, a later sweeper/retry can safely re-enqueue such orphans.
const express = require('express');
const crypto = require('crypto');
const pool = require('../utils/db');
const authMiddleware = require('../utils/authMiddleware');
const { enqueueBattle } = require('../utils/sqs');

const router = express.Router();
router.use(express.json());
router.use(authMiddleware);

// POST /battle - Start a battle in a competition.
//
// Auth token identifies the calling user (player a). Body carries the
// competition. The server:
//   1. finds the caller's enrollment in that competition (400 if none),
//   2. reads that enrollment's selected_code_id (400 if none selected),
//   3. finds another enrollment in the same competition that has a
//      selected_code_id (400 if no opponent is ready),
//   4. inserts an app.battle row with both code ids frozen, caller as a.
// req.body = { competition_id }
router.post('/', async (req, res) => {
    const { user_id } = req.user;
    const { competition_id } = req.body;

    if (!competition_id) {
        return res.status(400).json({ error: 'competition_id is required' });
    }

    try {
        // 1. Caller's enrollment in this competition.
        const myEnrollResult = await pool.query(
            'SELECT id, selected_code_id FROM app.enroll WHERE competition_id = $1 AND user_id = $2',
            [competition_id, user_id]
        );
        if (myEnrollResult.rows.length === 0) {
            return res.status(400).json({ error: 'You are not enrolled in this competition' });
        }
        const myEnroll = myEnrollResult.rows[0];

        // 2. Caller must have a selected code.
        if (!myEnroll.selected_code_id) {
            return res.status(400).json({ error: 'You have not selected a code for this competition' });
        }

        // 3. Find an opponent: any other enrollment in this competition that has
        //    a selected code. Pick one at random so repeated calls vary the
        //    matchup rather than always hitting the same opponent. Also grab the
        //    opponent's user_id (needed in the simulator event payload).
        const opponentResult = await pool.query(
            `SELECT id, user_id, selected_code_id
               FROM app.enroll
              WHERE competition_id = $1
                AND user_id <> $2
                AND selected_code_id IS NOT NULL
              ORDER BY random()
              LIMIT 1`,
            [competition_id, user_id]
        );
        if (opponentResult.rows.length === 0) {
            return res.status(400).json({ error: 'No opponent with a selected code is available in this competition' });
        }
        const opponentEnroll = opponentResult.rows[0];

        // 4. Resolve which game this competition runs - the simulator event
        //    needs game_id to fetch the game definition from S3.
        const gameResult = await pool.query(
            'SELECT game_id FROM app.competition WHERE id = $1',
            [competition_id]
        );
        if (gameResult.rows.length === 0 || !gameResult.rows[0].game_id) {
            return res.status(400).json({ error: 'Competition has no game configured' });
        }
        const game_id = gameResult.rows[0].game_id;

        // 5. Insert the battle, freezing both code ids (schema requires them
        //    NOT NULL so the match stays replayable even if a code is edited).
        const insertResult = await pool.query(
            `INSERT INTO app.battle (a_enroll_id, b_enroll_id, a_code_id, b_code_id)
             VALUES ($1, $2, $3, $4)
             RETURNING id, a_enroll_id, b_enroll_id, a_code_id, b_code_id, created_at_utc`,
            [myEnroll.id, opponentEnroll.id, myEnroll.selected_code_id, opponentEnroll.selected_code_id]
        );
        const battle = insertResult.rows[0];

        // 6. Enqueue the simulation job. simulation_id is generated here so the
        //    message is unique per run and matches the app.simulation_job row
        //    the Lambda will INSERT (markPending). The payload shape matches
        //    what handler.py expects.
        const payload = {
            battle_id: battle.id,
            game_id,
            a_user_id: user_id,
            b_user_id: opponentEnroll.user_id,
            a_code_id: battle.a_code_id,
            b_code_id: battle.b_code_id,
        };

        try {
            await enqueueBattle(payload);
        } catch (enqueueErr) {
            // The battle row is committed but enqueue failed. Surface a 502 so
            // the client knows the simulation wasn't triggered; a sweeper/retry
            // can re-enqueue orphaned battles later (see dual-write note above).
            console.error('failed to enqueue battle', battle.id, enqueueErr);
            return res.status(502).json({
                error: 'Battle created but failed to enqueue simulation',
                battle_id: battle.id,
            });
        }

        return res.status(201).json({ ...battle });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Database error' });
    }
});

// GET /battle/:id - Get a battle and its result.
//
// Returns the battle row plus the latest COMPLETED app.simulation_job for it
// (status, winner/loser, scores, video reference, log). A battle may be run
// multiple times (re-runs / retries), producing several simulation_job rows.
// Because the simulation is idempotent, all completed jobs yield equivalent
// results, so we return the most recent completed one. We deliberately ignore
// pending/failed jobs here, and do NOT just take the newest row: a newer job
// may still be pending/failed while an older job already completed.
// simulation_job is null if no run has completed yet.
router.get('/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const battleResult = await pool.query(
            `SELECT id, a_enroll_id, b_enroll_id, a_code_id, b_code_id,
                    created_at_utc, updated_at_utc
               FROM app.battle
              WHERE id = $1`,
            [id]
        );
        if (battleResult.rows.length === 0) {
            return res.status(404).json({ error: 'Battle not found' });
        }

        // Latest COMPLETED job for this battle. Results are idempotent across
        // runs, so any completed job is authoritative; we return the most
        // recent completed one and skip pending/failed jobs entirely.
        const jobResult = await pool.query(
            `SELECT id, status, winner_user_id, loser_user_id,
                    winner_score_gain, loser_score_loss,
                    battle_video_reference, execution_log,
                    created_at_utc, updated_at_utc
               FROM app.simulation_job
              WHERE battle_id = $1
                AND status = 'completed'
              ORDER BY created_at_utc DESC
              LIMIT 1`,
            [id]
        );

        return res.status(200).json({
            battle: battleResult.rows[0],
            simulation_job: jobResult.rows[0] || null,
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Database error' });
    }
});

module.exports = router;
