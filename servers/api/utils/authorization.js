module.exports = (acceptable_roles) => {
  return ((req, res, next) => {
    if (!req.user) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (acceptable_roles.includes(req.user.user_role) || req.user.user_role === 'root') {
      return next();
    }
    return res.status(403).json({ error: 'Forbidden' });
  });
};

