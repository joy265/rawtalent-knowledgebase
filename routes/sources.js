const express = require('express');
const router = express.Router();
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { requireAuth, requireSuperAdmin } = require('../middleware/authMiddleware');
const { askQuestion } = require('../services/aiService');
const { load: cheerioLoad } = require('cheerio');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ── Ask AI — available to all authenticated users ─────────────────
router.post('/ask', requireAuth, async (req, res) => {
  const { question } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'Question is required' });
  try {
    const result = await askQuestion(question.trim(), req.user.email);
    res.json(result);
  } catch (err) {
    console.error('AI ask error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Everything below is super_admin only ─────────────────────────
router.use(requireSuperAdmin);

// List all sources
router.get('/', async (req, res) => {
  try {
    const result = await getDb().execute(
      'SELECT id, type, title, origin, added_by, created_at, updated_at FROM knowledge_sources ORDER BY updated_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload a document (PDF, DOCX, TXT)
router.post('/document', upload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  try {
    let text = '';
    if (ext === '.docx') {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      text = result.value;
    } else if (ext === '.pdf') {
      const data = await pdfParse(req.file.buffer);
      text = data.text;
    } else if (ext === '.txt') {
      text = req.file.buffer.toString('utf8');
    } else {
      return res.status(400).json({ error: 'Supported types: .pdf, .docx, .txt' });
    }

    if (!text.trim()) return res.status(400).json({ error: 'No text could be extracted from this file' });

    const id = uuidv4();
    const title = req.body.title?.trim() || path.basename(req.file.originalname, ext);
    await getDb().execute({
      sql: 'INSERT INTO knowledge_sources (id, type, title, origin, content, added_by) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, 'document', title, req.file.originalname, text.trim(), req.user.email]
    });
    res.json({ success: true, id, title });
  } catch (err) {
    console.error('Document ingest error:', err.message);
    res.status(500).json({ error: 'Failed to process document: ' + err.message });
  }
});

// Add a website URL
router.post('/website', async (req, res) => {
  const { url, title: customTitle } = req.body;
  if (!url?.trim()) return res.status(400).json({ error: 'URL is required' });
  try {
    const { title, text } = await fetchWebText(url.trim());
    if (!text.trim()) return res.status(400).json({ error: 'No readable content found at that URL' });
    const id = uuidv4();
    await getDb().execute({
      sql: 'INSERT INTO knowledge_sources (id, type, title, origin, content, added_by) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, 'website', customTitle?.trim() || title, url.trim(), text.trim(), req.user.email]
    });
    res.json({ success: true, id, title: customTitle?.trim() || title });
  } catch (err) {
    console.error('Website ingest error:', err.message);
    res.status(500).json({ error: 'Failed to fetch website: ' + err.message });
  }
});

// Refresh a website source (re-fetch its content)
router.post('/:id/refresh', async (req, res) => {
  const db = getDb();
  const result = await db.execute({ sql: 'SELECT origin FROM knowledge_sources WHERE id = ? AND type = "website"', args: [req.params.id] });
  const src = result.rows[0];
  if (!src) return res.status(404).json({ error: 'Website source not found' });
  try {
    const { title, text } = await fetchWebText(src.origin);
    await db.execute({
      sql: "UPDATE knowledge_sources SET title=?, content=?, updated_at=datetime('now') WHERE id=?",
      args: [title, text.trim(), req.params.id]
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to refresh: ' + err.message });
  }
});

// Paste content manually (for sites that block scraping)
router.post('/paste', async (req, res) => {
  const { title, content, origin } = req.body;
  if (!title?.trim() || !content?.trim()) return res.status(400).json({ error: 'Title and content are required' });
  try {
    const id = uuidv4();
    await getDb().execute({
      sql: 'INSERT INTO knowledge_sources (id, type, title, origin, content, added_by) VALUES (?, ?, ?, ?, ?, ?)',
      args: [id, 'website', title.trim(), origin?.trim() || '', content.trim(), req.user.email]
    });
    res.json({ success: true, id, title: title.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a source
router.delete('/:id', async (req, res) => {
  try {
    await getDb().execute({ sql: 'DELETE FROM knowledge_sources WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Web fetch helper — uses Jina Reader to bypass bot protection ──
async function fetchWebText(url) {
  // Jina Reader renders the full page (including JS) and bypasses most bot protection
  const jinaUrl = `https://r.jina.ai/${url}`;
  const response = await fetch(jinaUrl, {
    headers: {
      'Accept': 'text/plain',
      'X-Return-Format': 'text',
      'X-Timeout': '25'
    },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Could not retrieve content from ${url} (status ${response.status})`);
  const raw = await response.text();

  // Jina returns lines like "Title: ..." and "URL Source: ..." at the top
  const titleMatch = raw.match(/^Title:\s*(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : url;

  // Strip the metadata header lines, keep the actual content
  const contentStart = raw.indexOf('\n\n');
  const text = (contentStart > -1 ? raw.slice(contentStart) : raw).trim();

  return { title, text };
}

module.exports = router;
