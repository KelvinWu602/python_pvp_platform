const pool = require('./db');

module.exports = (location = 'body') => {
  return async (req, res, next) => {
    const { user_id } = req.user;
    let enroll_id;

    if (location === 'body') {
      enroll_id = req.body.enroll_id;
    } else if (location === 'query') {
      enroll_id = req.query.enroll_id;
    }

    if (!enroll_id) {
      return res.status(400).json({ error: 'enroll_id is required' });
    }

    try {
      const result = await pool.query(
        'SELECT id FROM app.enroll WHERE id = $1 AND user_id = $2',
        [enroll_id, user_id]
      );

      if (result.rows.length === 0) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      next();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Database error' });
    }
  };
};
