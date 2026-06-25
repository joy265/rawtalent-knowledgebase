const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const multer = require('multer');
const mammoth = require('mammoth');
const { getDb } = require('../db/database');
const { requireAdmin } = require('../middleware/authMiddleware');
const { saveArticleToDrive, deleteArticleFromDrive, syncFromDrive } = require('../services/driveService');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

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
  try {
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

    db.prepare(`INSERT INTO article_logs (article_id, article_title, action, changes_summary, changed_by) VALUES (?, ?, ?, ?, ?)`)
      .run(id, title, 'created', 'Article created', req.user.email);

    res.json({ success: true, id });
  } catch (err) {
    console.error('Create article error:', err);
    res.status(500).json({ error: err.message || 'Failed to save article' });
  }
});

router.put('/articles/:id', async (req, res) => {
  try {
    const { title, summary, content, category, tags, relatedIds, published } = req.body;
    const db = getDb();
    const existing = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Article not found' });

    const changes = [];
    if (title !== existing.title) changes.push(`Title: "${existing.title}" → "${title}"`);
    if ((summary || '') !== (existing.summary || '')) changes.push('Summary updated');
    if (content !== existing.content) changes.push('Content updated');
    if ((category || '') !== (existing.category || '')) changes.push(`Category: "${existing.category || 'none'}" → "${category || 'none'}"`);
    if (JSON.stringify(tags || []) !== existing.tags) changes.push('Tags updated');
    if (Boolean(published) !== Boolean(existing.published)) changes.push(`Status: ${existing.published ? 'Published' : 'Draft'} → ${published ? 'Published' : 'Draft'}`);

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE articles SET title=?, summary=?, content=?, category=?, tags=?, related_ids=?, published=?, updated_at=?
      WHERE id=?
    `).run(title, summary || '', content, category || '', JSON.stringify(tags || []),
      JSON.stringify(relatedIds || []), published ? 1 : 0, now, req.params.id);

    db.prepare(`INSERT INTO article_logs (article_id, article_title, action, changes_summary, changed_by) VALUES (?, ?, ?, ?, ?)`)
      .run(req.params.id, title, 'updated', changes.length ? changes.join(' | ') : 'Minor edits', req.user.email);

    await saveArticleToDrive({
      id: req.params.id, title, summary, content, category,
      tags: tags || [], relatedArticleIds: relatedIds || [],
      author: existing.author_email, published,
      createdAt: existing.created_at, updatedAt: now,
      drive_file_id: existing.drive_file_id
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Update article error:', err);
    res.status(500).json({ error: err.message || 'Failed to update article' });
  }
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

router.get('/drive-status', async (req, res) => {
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!key || !folderId) {
    return res.json({ connected: false, reason: 'Environment variables not set' });
  }
  try {
    const credentials = JSON.parse(Buffer.from(key, 'base64').toString());
    const serviceAccountEmail = credentials.client_email || 'unknown';
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive'] });
    const drive = google.drive({ version: 'v3', auth });
    const result = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'files(id)',
      pageSize: 1
    });
    res.json({ connected: true, serviceAccountEmail, fileCount: result.data.files.length });
  } catch (err) {
    let credentials = {};
    try { credentials = JSON.parse(Buffer.from(key, 'base64').toString()); } catch {}
    res.json({ connected: false, serviceAccountEmail: credentials.client_email, reason: err.message });
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

// ── Feedback ──────────────────────────────────────────────────────
router.get('/feedback', (req, res) => {
  const feedback = getDb().prepare('SELECT * FROM feedback ORDER BY created_at DESC').all();
  res.json(feedback);
});

router.put('/feedback/:id', (req, res) => {
  const { status, adminComments } = req.body;
  getDb().prepare("UPDATE feedback SET status=?, admin_comments=?, updated_at=datetime('now') WHERE id=?")
    .run(status || 'pending', adminComments ?? '', req.params.id);
  res.json({ success: true });
});

router.delete('/feedback/:id', (req, res) => {
  getDb().prepare('DELETE FROM feedback WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Article Logs ──────────────────────────────────────────────────
router.get('/article-logs', (req, res) => {
  const { articleId } = req.query;
  const logs = articleId
    ? getDb().prepare('SELECT * FROM article_logs WHERE article_id = ? ORDER BY created_at DESC').all(articleId)
    : getDb().prepare('SELECT * FROM article_logs ORDER BY created_at DESC LIMIT 200').all();
  res.json(logs);
});

router.delete('/article-logs/:id', (req, res) => {
  getDb().prepare('DELETE FROM article_logs WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Document Import ───────────────────────────────────────────────
router.post('/parse-document', upload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const ext = path.extname(req.file.originalname).toLowerCase();
  const baseName = path.basename(req.file.originalname, ext)
    .replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();

  try {
    let html = '';
    let title = baseName;

    if (ext === '.docx') {
      const result = await mammoth.convertToHtml(
        { buffer: req.file.buffer },
        {
          styleMap: [
            "p[style-name='Heading 1'] => h1:fresh",
            "p[style-name='Heading 2'] => h2:fresh",
            "p[style-name='Heading 3'] => h3:fresh",
            "p[style-name='Title'] => h1:fresh",
            "b => strong",
            "i => em"
          ]
        }
      );
      html = result.value;

      // Pull the first heading out as the article title
      const headingMatch = html.match(/<h[123][^>]*>([\s\S]*?)<\/h[123]>/i);
      if (headingMatch) {
        const headingText = headingMatch[1].replace(/<[^>]+>/g, '').trim();
        if (headingText) {
          title = headingText;
          html = html.slice(html.indexOf(headingMatch[0]) + headingMatch[0].length).trim();
        }
      }

      // Clean up empty paragraphs at the start
      html = html.replace(/^(<p>\s*<\/p>\s*)+/, '').trim();

    } else if (ext === '.txt') {
      const text = req.file.buffer.toString('utf8');
      const lines = text.split(/\r?\n/);

      // First non-empty line → title
      const firstNonEmpty = lines.findIndex(l => l.trim());
      if (firstNonEmpty >= 0) title = lines[firstNonEmpty].trim();

      // Rest → paragraphs (blank lines = paragraph break)
      const body = lines.slice(firstNonEmpty + 1);
      let paragraph = [];
      const paragraphs = [];
      for (const line of body) {
        if (line.trim()) {
          paragraph.push(line.trim().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'));
        } else if (paragraph.length) {
          paragraphs.push(`<p>${paragraph.join(' ')}</p>`);
          paragraph = [];
        }
      }
      if (paragraph.length) paragraphs.push(`<p>${paragraph.join(' ')}</p>`);
      html = paragraphs.join('\n');

    } else {
      return res.status(400).json({ error: 'Unsupported file type. Please upload a .docx or .txt file.' });
    }

    // Extract plain-text summary from first meaningful paragraph
    const summaryMatch = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const summary = summaryMatch
      ? summaryMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 280)
      : '';

    res.json({ title, content: html, summary, warnings: [] });
  } catch (err) {
    console.error('Document parse error:', err);
    res.status(500).json({ error: 'Failed to parse document: ' + err.message });
  }
});

// ── Article File Attachments ──────────────────────────────────────
const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

router.post('/articles/:id/files', fileUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { displayMode = 'download' } = req.body;
  const db = getDb();
  const article = db.prepare('SELECT id FROM articles WHERE id = ?').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  const base64 = req.file.buffer.toString('base64');
  const result = db.prepare(`
    INSERT INTO article_files (article_id, filename, mimetype, filesize, data, display_mode)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.params.id, req.file.originalname, req.file.mimetype, req.file.size, base64, displayMode);

  res.json({ success: true, id: result.lastInsertRowid, filename: req.file.originalname, displayMode });
});

router.get('/articles/:id/files', (req, res) => {
  const files = getDb().prepare(
    'SELECT id, filename, mimetype, filesize, display_mode, created_at FROM article_files WHERE article_id = ? ORDER BY created_at ASC'
  ).all(req.params.id);
  res.json(files);
});

router.delete('/files/:id', (req, res) => {
  getDb().prepare('DELETE FROM article_files WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
