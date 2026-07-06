const pool = require('./db');

module.exports = async (req, res, next) => {
  try {
    const user_id = req.user.user_id;
    const code_id = req.params.code_id;
    const result = await pool.query(
      `SELECT id FROM app.code WHERE id = $1 AND user_id = $2 LIMIT 1;`,
      [code_id, user_id]
    );
    if (result.rows.length < 1) {
      return res.status(403).json({ error: 'not owner of this code' });
    }
    next();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'API error' });
  }
};
