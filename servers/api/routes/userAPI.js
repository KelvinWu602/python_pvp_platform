const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../utils/db');

const router = express.Router();
router.use(express.json());

// POST /user - create a new user
router.post('/', async (req, res)=> {
  const { username, full_name, password } = req.body;
  if (!username || !full_name || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    const userResult = await pool.query(
      'SELECT id, hash_password FROM app.user WHERE username = $1',
      [username]
    );

    if (userResult.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hash_password = await bcrypt.hashSync(password);
    
    const insertResult = await pool.query(
      'INSERT INTO app.user (username, full_name, hash_password, urole) VALUES ($1, $2, $3, $4);',
      [username, full_name, hash_password, 'user']
    );

    return res.json(insertResult.rows[0]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// POST /user/session - create a new user session
// req.body = { username, password }
router.post('/session', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    const userResult = await pool.query(
      'SELECT id, hash_password FROM app.user WHERE username = $1',
      [username]
    );

    if (userResult.rows.length !== 1) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = userResult.rows[0];
    const isValidPassword = await bcrypt.compare(password, user.hash_password);

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours

    await pool.query(
      'INSERT INTO app.user_session (id, user_id, created_at_utc, expire_at_utc) VALUES ($1, $2, $3, $4)',
      [sessionId, user.id, new Date(), expiresAt]
    );

    res.json({ auth_token: sessionId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// DELETE /user/session - terminate a user session
// Authorization header: Bearer <sessionId>
router.delete('/session', async (req, res) => {
  const authHeader = req.headers.authorization;
  const sessionId = authHeader?.split(' ')[1];

  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID required in Authorization header' });
  }

  try {
    const result = await pool.query(
      'UPDATE app.user_session SET expire_at_utc = $1 WHERE id = $2 RETURNING id',
      [new Date(), sessionId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({ message: 'Session terminated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;