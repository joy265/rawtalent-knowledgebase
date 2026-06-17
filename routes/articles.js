const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/authMiddleware');

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
      // Fallback to LIKE search if FTS query parsing fails
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

router.get('/categories', requireAuth, (req, res) => {
  const cats = getDb().prepare(`
    SELECT category, COUNT(*) as count
    FROM articles WHERE published = 1 AND category IS NOT NULL AND category != ''
    GROUP BY category ORDER BY count DESC
  `).all();
  res.json(cats);
});

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
  const relatedIds = JSON.parse(article.related_ids || '[]');

  if (relatedIds.length > 0) {
    const placeholders = relatedIds.map(() => '?').join(',');
    article.relatedArticles = db.prepare(`
      SELECT id, title, summary, category
      FROM articles WHERE id IN (${placeholders}) AND published = 1
    `).all(...relatedIds);
  } else {
    article.relatedArticles = [];
  }

  res.json(article);
});

module.exports = router;
