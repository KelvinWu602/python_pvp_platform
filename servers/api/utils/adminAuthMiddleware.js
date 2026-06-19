// Admin-only guard. Must run AFTER authMiddleware (which populates req.user).
// Rejects any caller whose role is not 'root'. Used by internal endpoints that
// only the simulator service account (a root user) should reach.
module.exports = (req, res, next) => {
  if (!req.user || req.user.user_role !== 'root') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};
