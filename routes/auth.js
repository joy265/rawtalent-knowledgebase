const express = require('express');
const passport = require('passport');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { getDb } = require('../db/database');

router.post('/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return res.status(500).json({ error: 'Server error' });
    if (!user) return res.status(401).json({ error: info?.message || 'Invalid credentials' });
    req.logIn(user, async (err) => {
      if (err) return res.status(500).json({ error: 'Login failed' });
      await getDb().execute({ sql: "UPDATE users SET last_login = datetime('now') WHERE id = ?", args: [user.id] });
      res.json({ success: true, user: { email: user.email, name: user.name, role: user.role } });
    });
  })(req, res, next);
});

if (process.env.GOOGLE_CLIENT_ID) {
  router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
  router.get('/google/callback',
    passport.authenticate('google', { failureRedirect: '/login.html?error=1' }),
    async (req, res) => {
      await getDb().execute({ sql: "UPDATE users SET last_login = datetime('now') WHERE id = ?", args: [req.user.id] });
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

router.put('/change-password', async (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both fields are required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });

  const db = getDb();
  const userRes = await db.execute({ sql: 'SELECT password_hash FROM users WHERE id = ?', args: [req.user.id] });
  const user = userRes.rows[0];
  if (!user || !user.password_hash) {
    return res.status(400).json({ error: 'Password change is not available for Google sign-in accounts' });
  }
  const match = await bcrypt.compare(currentPassword, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Current password is incorrect' });

  const hash = await bcrypt.hash(newPassword, 12);
  await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE id = ?', args: [hash, req.user.id] });
  res.json({ success: true });
});

module.exports = router;
