function requireAuth(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Login required' });
  if (!req.user.active) return res.status(403).json({ error: 'Account disabled' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Login required' });
  if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Login required' });
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requireSuperAdmin };
