const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'knowledgebase.db');
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

async function initDatabase() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT,
      name TEXT,
      role TEXT DEFAULT 'user',
      google_id TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      last_login TEXT
    );

    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT,
      content TEXT,
      category TEXT,
      tags TEXT DEFAULT '[]',
      related_ids TEXT DEFAULT '[]',
      author_email TEXT,
      published INTEGER DEFAULT 1,
      drive_file_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(
      id UNINDEXED,
      title,
      summary,
      content,
      category,
      tags,
      content=articles,
      content_rowid=rowid
    );

    CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
      INSERT INTO articles_fts(rowid, id, title, summary, content, category, tags)
      VALUES (new.rowid, new.id, new.title, new.summary, new.content, new.category, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE ON articles BEGIN
      INSERT INTO articles_fts(articles_fts, rowid, id, title, summary, content, category, tags)
      VALUES('delete', old.rowid, old.id, old.title, old.summary, old.content, old.category, old.tags);
      INSERT INTO articles_fts(rowid, id, title, summary, content, category, tags)
      VALUES (new.rowid, new.id, new.title, new.summary, new.content, new.category, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS articles_ad AFTER DELETE ON articles BEGIN
      INSERT INTO articles_fts(articles_fts, rowid, id, title, summary, content, category, tags)
      VALUES('delete', old.rowid, old.id, old.title, old.summary, old.content, old.category, old.tags);
    END;
  `);

  const adminEmail = process.env.ADMIN_EMAIL || 'joy@rawtalent.com.au';
  const adminPassword = process.env.ADMIN_PASSWORD || 'RawTalent2024!';
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);

  if (!existing) {
    const hash = await bcrypt.hash(adminPassword, 12);
    db.prepare(`
      INSERT INTO users (email, password_hash, name, role)
      VALUES (?, ?, 'Joy — Administrator', 'admin')
    `).run(adminEmail, hash);
    console.log(`✓ Admin account created: ${adminEmail}`);
  }

  console.log('✓ Database ready');
}

module.exports = { getDb, initDatabase };
