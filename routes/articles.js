const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/authMiddleware');

// Search articles
router.get('/search', requireAuth, (req, res) => {
  const { q, category, limit = 20 } = req.query;
  const db = getDb();
  let articles;

  if (q && q.trim().length > 0) {
    const term = q.trim()
      .replace(/[^\w\s\-]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map(t => `"${t}"*`)
      .join(' OR ');

    try {
      articles = db.prepare(`
        SELECT a.id, a.title, a.summary, a.category, a.tags, a.created_at, a.updated_at
        FROM articles a
        JOIN articles_fts fts ON a.id = fts.id
        WHERE articles_fts MATCH ?
          AND a.published = 1
          ${category ? 'AND a.category = ?' : ''}
        ORDER BY rank
        LIMIT ?
      `).all(...[term, ...(category ? [category] : []), parseInt(limit)]);
    } catch {
      articles = db.prepare(`
        SELECT id, title, summary, category, tags, created_at, updated_at
        FROM articles
        WHERE published = 1
          AND (title LIKE ? OR summary LIKE ? OR content LIKE ?)
          ${category ? 'AND category = ?' : ''}
        ORDER BY updated_at DESC
        LIMIT ?
      `).all(...[`%${q}%`, `%${q}%`, `%${q}%`, ...(category ? [category] : []), parseInt(limit)]);
    }
  } else {
    articles = db.prepare(`
      SELECT id, title, summary, category, tags, created_at, updated_at
      FROM articles
      WHERE published = 1
        ${category ? 'AND category = ?' : ''}
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(...(category ? [category, parseInt(limit)] : [parseInt(limit)]));
  }

  res.json(articles.map(a => ({ ...a, tags: JSON.parse(a.tags || '[]') })));
});

// Get categories
router.get('/categories', requireAuth, (req, res) => {
  const cats = getDb().prepare(`
    SELECT category, COUNT(*) as count
    FROM articles WHERE published = 1 AND category IS NOT NULL AND category != ''
    GROUP BY category ORDER BY count DESC
  `).all();
  res.json(cats);
});

// Get all glossary terms (for frontend highlighting)
router.get('/glossary', requireAuth, (req, res) => {
  const terms = getDb().prepare('SELECT term, definition FROM glossary ORDER BY LENGTH(term) DESC').all();
  res.json(terms);
});

// Get single article + auto-related
router.get('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const article = db.prepare(`
    SELECT a.*, u.name as author_name
    FROM articles a
    LEFT JOIN users u ON a.author_email = u.email
    WHERE a.id = ? AND a.published = 1
  `).get(req.params.id);

  if (!article) return res.status(404).json({ error: 'Article not found' });

  article.tags = JSON.parse(article.tags || '[]');

  // Auto-related: find similar articles by category, tags, and title keywords
  article.relatedArticles = findRelatedArticles(db, article);

  res.json(article);
});

function findRelatedArticles(db, article) {
  const allArticles = db.prepare(`
    SELECT id, title, summary, category, tags
    FROM articles
    WHERE published = 1 AND id != ?
  `).all(article.id);

  if (allArticles.length === 0) return [];

  const currentTags = article.tags || [];
  const currentCategory = (article.category || '').toLowerCase();
  const currentWords = extractKeywords(article.title + ' ' + (article.summary || ''));

  const scored = allArticles.map(a => {
    const aTags = JSON.parse(a.tags || '[]');
    const aCategory = (a.category || '').toLowerCase();
    const aWords = extractKeywords(a.title + ' ' + (a.summary || ''));

    let score = 0;

    // Same category = strong signal
    if (currentCategory && aCategory === currentCategory) score += 4;

    // Shared tags
    const sharedTags = currentTags.filter(t =>
      aTags.map(x => x.toLowerCase()).includes(t.toLowerCase())
    );
    score += sharedTags.length * 3;

    // Shared title/summary keywords
    const sharedWords = currentWords.filter(w => aWords.includes(w));
    score += sharedWords.length;

    return { ...a, score };
  });

  return scored
    .filter(a => a.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(({ id, title, summary, category }) => ({ id, title, summary, category }));
}

// List file attachments for an article (metadata only, no binary data)
router.get('/:id/files', requireAuth, (req, res) => {
  const files = getDb().prepare(
    'SELECT id, filename, mimetype, filesize, display_mode, created_at FROM article_files WHERE article_id = ? ORDER BY created_at ASC'
  ).all(req.params.id);
  res.json(files);
});

// Serve/download a file attachment
router.get('/file/:fileId', requireAuth, (req, res) => {
  const file = getDb().prepare('SELECT * FROM article_files WHERE id = ?').get(req.params.fileId);
  if (!file) return res.status(404).json({ error: 'File not found' });
  const buffer = Buffer.from(file.data, 'base64');
  res.setHeader('Content-Type', file.mimetype);
  res.setHeader('Content-Length', buffer.length);
  if (file.display_mode === 'download') {
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`);
  } else {
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename)}"`);
  }
  res.send(buffer);
});

// Submit feedback on an article
router.post('/:id/feedback', requireAuth, (req, res) => {
  const { suggestedChanges } = req.body;
  if (!suggestedChanges?.trim()) return res.status(400).json({ error: 'Suggested changes are required' });

  const db = getDb();
  const article = db.prepare('SELECT title FROM articles WHERE id = ? AND published = 1').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Article not found' });

  db.prepare(`INSERT INTO feedback (article_id, article_title, suggested_changes, submitted_by) VALUES (?, ?, ?, ?)`)
    .run(req.params.id, article.title, suggestedChanges.trim(), req.user.email);

  res.json({ success: true });
});

function extractKeywords(text) {
  const stopWords = new Set([
    'the','a','an','and','or','but','in','on','at','to','for','of','with',
    'how','what','when','where','why','is','are','was','were','be','been',
    'has','have','had','do','does','did','will','would','could','should',
    'this','that','these','those','it','its','from','by','as','if','not'
  ]);
  return (text || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w));
}

module.exports = router;
