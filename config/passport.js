const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');

passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  try {
    const result = await getDb().execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [id] });
    done(null, result.rows[0] || false);
  } catch (err) {
    done(err);
  }
});

passport.use(new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
  try {
    const result = await getDb().execute({
      sql: 'SELECT * FROM users WHERE email = ? AND active = 1',
      args: [email.toLowerCase().trim()]
    });
    const user = result.rows[0];
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
      let userRes = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] });
      let user = userRes.rows[0];

      if (!user) {
        await db.execute({
          sql: `INSERT INTO users (email, name, google_id, role, active) VALUES (?, ?, ?, 'user', 1)`,
          args: [email, profile.displayName || email.split('@')[0], profile.id]
        });
        userRes = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] });
        user = userRes.rows[0];
      } else if (!user.google_id) {
        await db.execute({
          sql: 'UPDATE users SET google_id = ?, name = COALESCE(NULLIF(name,""), ?) WHERE email = ?',
          args: [profile.id, profile.displayName, email]
        });
        userRes = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] });
        user = userRes.rows[0];
      }

      if (!user.active) return done(null, false, { message: 'Your account has been disabled.' });
      return done(null, user);
    } catch (err) {
      return done(err);
    }
  }));
}
