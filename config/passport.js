const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');

passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser((id, done) => {
  try {
    const user = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
    done(null, user || false);
  } catch (err) {
    done(err);
  }
});

passport.use(new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
  try {
    const user = getDb().prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email.toLowerCase().trim());
    if (!user || !user.password_hash) {
      return done(null, false, { message: 'Invalid email or password.' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return done(null, false, { message: 'Invalid email or password.' });
    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: (process.env.APP_URL || 'http://localhost:3000') + '/auth/google/callback'
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value?.toLowerCase();
      if (!email || !email.endsWith('@rawtalent.com.au')) {
        return done(null, false, { message: 'Only @rawtalent.com.au accounts are permitted.' });
      }

      const db = getDb();
      let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

      if (!user) {
        db.prepare(`INSERT INTO users (email, name, google_id, role, active) VALUES (?, ?, ?, 'user', 1)`)
          .run(email, profile.displayName || email.split('@')[0], profile.id);
        user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      } else if (!user.google_id) {
        db.prepare('UPDATE users SET google_id = ?, name = COALESCE(NULLIF(name,""), ?) WHERE email = ?')
          .run(profile.id, profile.displayName, email);
        user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      }

      if (!user.active) return done(null, false, { message: 'Your account has been disabled.' });
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }));
}
