const pool = require('../utils/db');
const authMiddleware = require('../utils/authMiddleware');
const express = require('express');
const router = express.Router();
router.use(express.json());
router.use(authMiddleware);

// POST /game - Create a game
router.post('/game', async (req, res) => {
    // ADMIN only
    if (req.user.user_role !== 'root') {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const { display_name, simulation_reference } = req.body
    try{
        const insertResult = await pool.query(
            'INSERT INTO app.game (display_name, simulation_reference) VALUES ($1, $2) RETURNING *;',
            [display_name, simulation_reference]
        );

        return res.json(insertResult.rows[0]);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Something went wrong' });
    }
});

// PUT /game/:id - Edit a game
router.put('/game/:id', async (req, res) => {
    // ADMIN only
    if (req.user.user_role !== 'root') {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const game_id = req.params.id;
    const { simulation_reference } = req.body
    if (!game_id || !simulation_reference) {
        return res.status(400).json({ error: 'Must provide game_id and simulation_reference'});
    }
    try{
        const updateResult = await pool.query(
            `UPDATE app.game SET updated_at_utc = now(), simulation_reference = $1 WHERE id = $2 RETURNING *;`,
            [simulation_reference, game_id]
        );

        if (updateResult.rows.length === 0) {
            return res.status(404).json({error: 'Game not found'});
        }

        return res.json(updateResult.rows[0]);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Database error' });
    }
});

// GET /game/:id - Get a game
router.get('/game/:id', async (req, res) => {
    // ALL
    const game_id = req.params.id;
    if (!game_id) {
        return res.status(400).json({ error: 'Must provide game_id'});
    }
    try{
        const result = await pool.query(
            `SELECT * FROM app.game WHERE id = $1;`,
            [game_id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({error: 'Game not found'});
        }

        return res.json(result.rows[0]);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Database error' });
    }
});

// POST  - Create a competition
router.post('', async (req, res) => {
    // ADMIN only
    if (req.user.user_role !== 'root') {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const { game_id, display_name, start_time_utc, end_time_utc, enabled } = req.body;
    try{
        const insertResult = await pool.query(
            'INSERT INTO app.competition (game_id, display_name, start_time_utc, end_time_utc, enabled) VALUES ($1, $2, $3, $4, $5) RETURNING *;',
            [game_id, display_name, start_time_utc, end_time_utc, enabled]
        );

        return res.json(insertResult.rows[0]);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Something went wrong' });
    }
});

// PUT  - Edit a competition
router.put('/:id', async (req, res) => {
    // ADMIN only
    if (req.user.user_role !== 'root') {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const competition_id = req.params.id;
    const { game_id, display_name, start_time_utc, end_time_utc, enabled } = req.body;
    try{
        const updateResult = await pool.query(
            `UPDATE app.competition
                SET game_id = $1,
                    display_name = $2,
                    start_time_utc = $3,
                    end_time_utc = $4,
                    enabled = $5
              WHERE id = $6
          RETURNING *;`,
            [game_id, display_name, start_time_utc, end_time_utc, enabled, competition_id]
        );

        if (updateResult.rows.length === 0) {
            return res.status(404).json({ error: 'Competition not found' });
        }

        return res.json(updateResult.rows[0]);
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Something went wrong' });
    }
});

// GET  - list competition
router.get('', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM app.competition');
        return res.status(200).json(result.rows);
    }catch(err){
        console.error(err);
        return res.status(500).json({error: 'Something went wrong'});
    }
});

// GET /:id - get a competition
router.get('/:id', async (req, res) => {
    const competition_id = req.params.id;
    try {
        const result = await pool.query(
            'SELECT * FROM app.competition WHERE id = $1',
            [competition_id]
        );
        return res.status(200).json(result.rows[0]);
    }catch(err){
        console.error(err);
        return res.status(500).json({error: 'Something went wrong'});
    }
});

// DELETE  - delete competition
router.delete('/:id', async (req, res)=>{
    // ADMIN only
    if (req.user.user_role !== 'root') {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const competition_id = req.params.id;
    try {
        const updateResult = await pool.query(
            'UPDATE app.competition SET enabled = false WHERE id = $1 RETURNING *',
            [competition_id]
        );
        return res.status(200).json(updateResult.rows[0]);
    }catch(err){
        console.error(err);
        return res.status(500).json({error: 'Something went wrong'});
    }
});

// POST /:id/enroll - enroll into competition
// user do not provide selected_code_id as they should not have code at this point
// user will later call this endpoint again after calling the post code endpoint
router.post('/:id/enroll', async (req, res)=>{
    const user_id = req.user.user_id;
    const competition_id = req.params.id;
    const { selected_code_id } = req.body;
    if (!user_id || !competition_id) {
        return res.status(400).json({ error: 'Must provide user_id and competition_id' });
    }
    try{
        let result;
        if(selected_code_id){
            result = await pool.query(
                'UPDATE app.enroll SET selected_code_id = $1 WHERE competition_id = $2 AND user_id = $3 RETURNING *;',
                [selected_code_id, competition_id, user_id]
            );
        }else{
            // without selected_code_id, cannot be update request
            result = await pool.query(
                'INSERT INTO app.enroll (competition_id, user_id) VALUES ($1, $2) RETURNING *;',
                [competition_id, user_id]
            );
        }
        return res.status(200).json(result.rows[0]);
    }catch(err){
        console.error(err);
        return res.status(500).json({error: 'Something went wrong'});
    }
});

// DELETE /:id/enroll - withdraw from competition
router.delete('/:id/enroll', async (req, res)=>{
    const user_id = req.user.user_id;
    const competition_id = req.params.id;
    if (!user_id || !competition_id) {
        return res.status(400).json({ error: 'Must provide user_id and competition_id' });
    }
    try{
        const deleteResult = await pool.query(
            'DELETE FROM app.enroll WHERE competition_id = $1 AND user_id = $2;',
            [competition_id, user_id]
        );

        return res.status(200).json({message: 'enroll deleted'});
    }catch(err){
        console.error(err);
        return res.status(500).json({error: 'Something went wrong'});
    }
});

module.exports = router;