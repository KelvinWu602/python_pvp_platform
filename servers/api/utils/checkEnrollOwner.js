const pool = require('./db');

module.exports = async (req, res, next) => {
  try {
    const user_id = req.user.user_id;
    const enroll_id = req.params.enroll_id;
    let result = await pool.query(
        `SELECT * FROM app.enroll WHERE id = $1 AND user_id = $2 LIMIT 1;`,
        [enroll_id, user_id]
    );
    if(result.rows.length < 1){
        return res.status(403).json({error: 'not owner of this enroll'});
    }
    next();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'API error' });
  }
};
