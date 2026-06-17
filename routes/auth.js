const express = require('express');
const passport = require('passport');
const router = express.Router();
const { getDb } = require('../db/database');

router.post('/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return res.status(500).json({ error: 'Server error' });
    if (!user) return res.status(401).json({ error: info?.message || 'Invalid credentials' });
    req.logIn(user, (err) => {
      if (err) return res.status(500).json({ error: 'Login failed' });
      getDb().prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);
      res.json({ success: true, user: { email: user.email, name: user.name, role: user.role } });
    });
  })(req, res, next);
});

if (process.env.GOOGLE_CLIENT_ID) {
  router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
  router.get('/google/callback',
    passport.authenticate('google', { failureRedirect: '/login.html?error=1' }),
    (req, res) => {
      getDb().prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(req.user.id);
      res.redirect('/');
    }
  );
}

router.post('/logout', (req, res) => {
  req.logout((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.json({ success: true });
  });
});

router.get('/me', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ email: req.user.email, name: req.user.name, role: req.user.role });
});

module.exports = router;
