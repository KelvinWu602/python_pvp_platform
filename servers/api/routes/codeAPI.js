// Support the following user actions
// List all the code written for the current competition
// Get the code content for the current competition
// Create a new piece of code for the current competition
// Update the code
const express = require('express');
const pool = require('../utils/db');
const authMiddleware = require('../utils/authMiddleware');
const enrollOwnershipMiddleware = require('../utils/enrollOwnershipMiddleware');
const router = express.Router();

router.use(authMiddleware);

// POST /code - upload a piece of code
// req.body = { enroll_id, name, code }
router.post('/', enrollOwnershipMiddleware('body'), async (req, res) => {
    const { enroll_id, name, code } = req.body;

    if (!name || !code) {
      return res.status(400).json({ error: 'name and code are required' });
    }

    try {
        const insertResult = await pool.query(
          'INSERT INTO app.code (enroll_id, name, code) VALUES ($1, $2, $3) RETURNING id',
          [enroll_id, name, code]
        );

        return res.status(200).json({ code_id: insertResult.rows[0].id });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: 'Database error' });
    }
});

// GET /code - get all code info under a specific enrollment
// query params: enroll_id
router.get('/', enrollOwnershipMiddleware('query'), async (req, res) => {
    const { enroll_id } = req.query;

    try {
        const codeResult = await pool.query(
          'SELECT id, enroll_id, name, code FROM app.code WHERE enroll_id = $1',
          [enroll_id]
        );

        res.status(200).json({ codes: codeResult.rows });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Database error' });
    }
});

// GET /code/:id - get specific code info by giving the code id
router.get('/:id', async (req, res) => {
    const { user_id } = req.user;
    const { id } = req.params;

    try {
        // get code and verify user owns the enrollment
        const codeResult = await pool.query(
          `SELECT c.id, c.enroll_id, c.name, c.code
           FROM app.code c
           JOIN app.enroll e ON c.enroll_id = e.id
           WHERE c.id = $1 AND e.user_id = $2`,
          [id, user_id]
        );

        if (codeResult.rows.length === 0) {
          return res.status(404).json({ error: 'Code not found' });
        }

        res.status(200).json(codeResult.rows[0]);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Database error' });
    }
});

// PUT /code/:id - update an existing piece of code (name and/or code body)
// req.body = { name?, code? }
// Ownership is enforced by joining app.enroll and matching the session user.
router.put('/:id', async (req, res) => {
    const { user_id } = req.user;
    const { id } = req.params;
    const { name, code } = req.body;

    if (name === undefined && code === undefined) {
      return res.status(400).json({ error: 'at least one of name or code is required' });
    }

    try {
        // Update only the columns provided, but only if the requesting user
        // owns the enrollment the code belongs to. COALESCE keeps the existing
        // value when a field is omitted.
        const updateResult = await pool.query(
          `UPDATE app.code c
              SET name = COALESCE($1, c.name),
                  code = COALESCE($2, c.code)
             FROM app.enroll e
            WHERE c.id = $3
              AND c.enroll_id = e.id
              AND e.user_id = $4
          RETURNING c.id, c.enroll_id, c.name, c.code`,
          [name ?? null, code ?? null, id, user_id]
        );

        if (updateResult.rows.length === 0) {
          return res.status(404).json({ error: 'Code not found' });
        }

        res.status(200).json(updateResult.rows[0]);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Database error' });
    }
});

module.exports = router;