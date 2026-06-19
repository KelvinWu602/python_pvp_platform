const pool = require('./db');

module.exports = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const sessionId = authHeader?.split(' ')[1];

  if (!sessionId) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  try {
    const result = await pool.query(
      `SELECT us.id, us.user_id, us.expire_at_utc, u.username, u.urole
       FROM app.user_session us
       JOIN app."user" u ON us.user_id = u.id
       WHERE us.id = $1`,
      [sessionId]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    const session = result.rows[0];
    if (new Date(session.expire_at_utc) < new Date()) {
      return res.status(401).json({ error: 'Session expired' });
    }

    req.user = {
      user_id: session.user_id,
      username: session.username,
      session_id: sessionId,
      user_role: session.urole
    };

    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
};
