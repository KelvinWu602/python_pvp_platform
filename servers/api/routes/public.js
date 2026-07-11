const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pool = require('../utils/db');

const router = express.Router();

// POST /user/session - Login (ALL)
router.post('/user/session', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'missing username or password' });
        }

        const userResult = await pool.query(
            `SELECT id, hash_password, urole FROM app.user WHERE username = $1;`,
            [username]
        );
        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = userResult.rows[0];
        const valid = bcrypt.compareSync(password, user.hash_password);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const sessionId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);

        await pool.query(
            `INSERT INTO app.user_session (id, user_id, expire_at_utc) VALUES ($1, $2, $3);`,
            [sessionId, user.id, expiresAt]
        );

        // Return urole so the frontend can conditionally show admin-only UI
        // (the header's 管理員 menu entry, the /admin route). The API remains
        // the source of truth for authorization — this is UI-only signal.
        return res.status(200).json({ auth_token: sessionId, urole: user.urole });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'API error' });
    }
});

module.exports = router;
