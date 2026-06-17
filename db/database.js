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

const ECEC_GLOSSARY = [
  { term: 'ASQA', definition: 'Australian Skills Quality Authority — the national regulator for vocational education and training (VET) in Australia.' },
  { term: 'WWCC', definition: 'Working With Children Check — mandatory government clearance required for anyone working with children in Australia.' },
  { term: 'DNU', definition: 'Do Not Use — an internal status flag marking an educator as ineligible for placement.' },
  { term: 'ECEC', definition: 'Early Childhood Education and Care — the regulated sector covering childcare centres and preschools.' },
  { term: 'RTO', definition: 'Registered Training Organisation — a government-accredited provider of vocational education and training qualifications.' },
  { term: 'SPES', definition: 'SPES Education — a former RTO whose qualifications have been cancelled by ASQA.' },
  { term: 'RFC', definition: 'Reason for Calling — the purpose/reason field logged when making a call note.' },
  { term: 'ROTC', definition: 'Result of the Call — the outcome field logged after completing a call.' },
  { term: 'EOD', definition: 'End of Day — used in handover notes and shift summaries.' },
  { term: 'CXL', definition: 'Cancellation — shorthand used internally for a cancelled booking or shift.' },
  { term: 'Fill Rate', definition: 'The percentage of requested shifts that were successfully staffed with an educator.' },
  { term: 'Room Leader', definition: 'The senior qualified educator responsible for a specific room within a childcare centre.' },
  { term: 'Induction', definition: 'A mandatory orientation conducted by the childcare centre before an educator begins their first shift there.' },
  { term: 'Account Freeze', definition: 'A temporary restriction placed on an educator\'s account, preventing new bookings until resolved.' },
  { term: 'Red Zone', definition: 'An account restriction status indicating serious non-compliance — one step below DNU.' },
  { term: 'Workforce Registry', definition: 'A government registry for tracking qualified Early Childhood Education and Care educators.' },
  { term: 'Handover', definition: 'Shift-to-shift notes passed between the morning and afternoon teams to ensure continuity.' },
  { term: 'Admin Portal', definition: 'The internal platform used by the RawTalent team for managing bookings, timesheets, and educator profiles.' },
  { term: 'Booking ID', definition: 'A unique identifier assigned to each shift booking record in the Admin Portal.' },
  { term: 'Candidate ID', definition: 'A unique identifier for each educator profile used when searching or assigning in the system.' },
  { term: 'Unfilled Booking', definition: 'A shift request from a centre that has not yet been assigned an educator.' },
  { term: 'No-Show', definition: 'When an educator fails to attend a confirmed shift without prior notice.' },
  { term: 'VIC', definition: 'Victoria — one of the Australian states where RawTalent operates educator placements.' },
  { term: 'SA', definition: 'South Australia — one of the Australian states where RawTalent operates educator placements.' },
  { term: 'QLD', definition: 'Queensland — one of the Australian states where RawTalent operates educator placements.' },
  { term: 'ACT', definition: 'Australian Capital Territory — one of the regions where RawTalent operates educator placements.' },
  { term: 'Cert III', definition: 'Certificate III in Early Childhood Education and Care — the minimum qualification required for most casual educator roles.' },
  { term: 'Diploma', definition: 'Diploma of Early Childhood Education and Care — a higher qualification required for Room Leader and senior roles.' },
  { term: 'NQF', definition: 'National Quality Framework — the regulatory framework governing the quality of early childhood education and care services in Australia.' },
  { term: 'NQS', definition: 'National Quality Standard — the benchmark for quality in early childhood education and care services under the NQF.' },
  { term: 'ACECQA', definition: 'Australian Children\'s Education and Care Quality Authority — the national body overseeing the NQF and quality standards.' },
  { term: 'Centre', definition: 'A childcare service or client site where RawTalent places casual educators.' },
  { term: 'Educator', definition: 'A casual worker placed by RawTalent into childcare centres — must hold appropriate qualifications and clearances.' },
  { term: 'Booking', definition: 'A confirmed shift placement — the core transaction matching an educator to a centre for a specific date and time.' },
];

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

    CREATE TABLE IF NOT EXISTS glossary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      term TEXT UNIQUE NOT NULL,
      definition TEXT NOT NULL,
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

  // Seed glossary terms if empty
  const glossaryCount = db.prepare('SELECT COUNT(*) as n FROM glossary').get().n;
  if (glossaryCount === 0) {
    const insertTerm = db.prepare('INSERT OR IGNORE INTO glossary (term, definition) VALUES (?, ?)');
    const seedAll = db.transaction(() => {
      ECEC_GLOSSARY.forEach(({ term, definition }) => insertTerm.run(term, definition));
    });
    seedAll();
    console.log(`✓ Glossary seeded with ${ECEC_GLOSSARY.length} ECEC terms`);
  }

  const adminEmail = process.env.ADMIN_EMAIL || 'joy@rawtalent.com.au';
  const adminPassword = process.env.ADMIN_PASSWORD || 'RawTalent2024!';
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);

  if (!existing) {
    const hash = await bcrypt.hash(adminPassword, 12);
    db.prepare(`INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, 'Joy — Administrator', 'admin')`)
      .run(adminEmail, hash);
    console.log(`✓ Admin account created: ${adminEmail}`);
  }

  console.log('✓ Database ready');
}

module.exports = { getDb, initDatabase };
