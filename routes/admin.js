const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAdmin } = require('../middleware/authMiddleware');
const { saveArticleToDrive, deleteArticleFromDrive, syncFromDrive } = require('../services/driveService');

router.use(requireAdmin);

// ── Stats ─────────────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  const db = getDb();
  res.json({
    totalArticles: db.prepare('SELECT COUNT(*) as n FROM articles WHERE published=1').get().n,
    draftArticles: db.prepare('SELECT COUNT(*) as n FROM articles WHERE published=0').get().n,
    totalUsers: db.prepare('SELECT COUNT(*) as n FROM users WHERE active=1').get().n,
    categories: db.prepare("SELECT COUNT(DISTINCT category) as n FROM articles WHERE published=1 AND category!=''").get().n
  });
});

// ── Users ─────────────────────────────────────────────────────────
router.get('/users', (req, res) => {
  const users = getDb().prepare(`
    SELECT id, email, name, role, active, created_at, last_login FROM users ORDER BY created_at DESC
  `).all();
  res.json(users);
});

router.post('/users', async (req, res) => {
  const { email, name, password, role = 'user' } = req.body;
  if (!email || !name) return res.status(400).json({ error: 'Email and name are required' });
  if (!email.toLowerCase().endsWith('@rawtalent.com.au')) {
    return res.status(400).json({ error: 'Only @rawtalent.com.au email addresses are allowed' });
  }

  const db = getDb();
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase())) {
    return res.status(409).json({ error: 'A user with this email already exists' });
  }

  const hash = password ? await bcrypt.hash(password, 12) : null;
  db.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(email.toLowerCase(), name, hash, role);
  res.json({ success: true });
});

router.put('/users/:id', async (req, res) => {
  const { name, role, active, password } = req.body;
  const db = getDb();
  const target = db.prepare('SELECT email FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const adminEmail = (process.env.ADMIN_EMAIL || 'joy@rawtalent.com.au').toLowerCase();
  if (target.email.toLowerCase() === adminEmail && role && role !== 'admin') {
    return res.status(400).json({ error: 'Cannot change the primary admin role' });
  }

  if (password) {
    const hash = await bcrypt.hash(password, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
  }
  if (name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.params.id);
  if (role !== undefined) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  if (active !== undefined) db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);

  res.json({ success: true });
});

router.delete('/users/:id', (req, res) => {
  const db = getDb();
  const target = db.prepare('SELECT email FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.email.toLowerCase() === (process.env.ADMIN_EMAIL || 'joy@rawtalent.com.au').toLowerCase()) {
    return res.status(400).json({ error: 'Cannot delete the primary admin account' });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Articles ──────────────────────────────────────────────────────
router.get('/articles', (req, res) => {
  const articles = getDb().prepare(`
    SELECT id, title, summary, category, tags, published, created_at, updated_at, author_email
    FROM articles ORDER BY updated_at DESC
  `).all();
  res.json(articles.map(a => ({ ...a, tags: JSON.parse(a.tags || '[]') })));
});

router.get('/articles/:id', (req, res) => {
  const article = getDb().prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Not found' });
  article.tags = JSON.parse(article.tags || '[]');
  article.related_ids = JSON.parse(article.related_ids || '[]');
  res.json(article);
});

router.post('/articles', async (req, res) => {
  const { title, summary, content, category, tags, relatedIds, published = true } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Title and content are required' });

  const id = uuidv4();
  const now = new Date().toISOString();
  const db = getDb();

  const driveFileId = await saveArticleToDrive({
    id, title, summary, content, category,
    tags: tags || [], relatedArticleIds: relatedIds || [],
    author: req.user.email, published,
    createdAt: now, updatedAt: now
  });

  db.prepare(`
    INSERT INTO articles (id, title, summary, content, category, tags, related_ids, author_email, published, drive_file_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, title, summary || '', content, category || '', JSON.stringify(tags || []),
    JSON.stringify(relatedIds || []), req.user.email, published ? 1 : 0, driveFileId, now, now);

  res.json({ success: true, id });
});

router.put('/articles/:id', async (req, res) => {
  const { title, summary, content, category, tags, relatedIds, published } = req.body;
  const db = getDb();
  const existing = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Article not found' });

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE articles SET title=?, summary=?, content=?, category=?, tags=?, related_ids=?, published=?, updated_at=?
    WHERE id=?
  `).run(title, summary || '', content, category || '', JSON.stringify(tags || []),
    JSON.stringify(relatedIds || []), published ? 1 : 0, now, req.params.id);

  await saveArticleToDrive({
    id: req.params.id, title, summary, content, category,
    tags: tags || [], relatedArticleIds: relatedIds || [],
    author: existing.author_email, published,
    createdAt: existing.created_at, updatedAt: now,
    drive_file_id: existing.drive_file_id
  });

  res.json({ success: true });
});

router.delete('/articles/:id', async (req, res) => {
  const db = getDb();
  const article = db.prepare('SELECT drive_file_id FROM articles WHERE id = ?').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });
  await deleteArticleFromDrive(article.drive_file_id);
  db.prepare('DELETE FROM articles WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.post('/sync', async (req, res) => {
  try {
    await syncFromDrive();
    res.json({ success: true, message: 'Sync from Google Drive complete' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Glossary ──────────────────────────────────────────────────────
router.get('/glossary', (req, res) => {
  const terms = getDb().prepare('SELECT * FROM glossary ORDER BY term ASC').all();
  res.json(terms);
});

router.post('/glossary', (req, res) => {
  const { term, definition } = req.body;
  if (!term || !definition) return res.status(400).json({ error: 'Term and definition are required' });
  try {
    getDb().prepare('INSERT INTO glossary (term, definition) VALUES (?, ?)').run(term.trim(), definition.trim());
    res.json({ success: true });
  } catch {
    res.status(409).json({ error: 'That term already exists' });
  }
});

router.put('/glossary/:id', (req, res) => {
  const { term, definition } = req.body;
  if (!term || !definition) return res.status(400).json({ error: 'Term and definition are required' });
  const db = getDb();
  const existing = db.prepare('SELECT id FROM glossary WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Term not found' });
  db.prepare("UPDATE glossary SET term=?, definition=?, updated_at=datetime('now') WHERE id=?")
    .run(term.trim(), definition.trim(), req.params.id);
  res.json({ success: true });
});

router.delete('/glossary/:id', (req, res) => {
  getDb().prepare('DELETE FROM glossary WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
