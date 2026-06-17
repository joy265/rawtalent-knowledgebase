const { google } = require('googleapis');
const { getDb } = require('../db/database');

function getDriveClient() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) return null;
  try {
    const credentials = JSON.parse(
      Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY, 'base64').toString()
    );
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/drive']
    });
    return google.drive({ version: 'v3', auth });
  } catch {
    console.warn('Drive: invalid service account key');
    return null;
  }
}

const FOLDER_ID = () => process.env.DRIVE_FOLDER_ID;

async function saveArticleToDrive(article) {
  const drive = getDriveClient();
  if (!drive || !FOLDER_ID()) return null;

  const content = JSON.stringify(article, null, 2);

  try {
    if (article.drive_file_id) {
      await drive.files.update({
        fileId: article.drive_file_id,
        media: { mimeType: 'application/json', body: content }
      });
      return article.drive_file_id;
    } else {
      const res = await drive.files.create({
        requestBody: {
          name: `${article.id}.json`,
          parents: [FOLDER_ID()],
          mimeType: 'application/json'
        },
        media: { mimeType: 'application/json', body: content }
      });
      return res.data.id;
    }
  } catch (err) {
    console.error('Drive save error:', err.message);
    return null;
  }
}

async function deleteArticleFromDrive(driveFileId) {
  const drive = getDriveClient();
  if (!drive || !driveFileId) return;
  try {
    await drive.files.delete({ fileId: driveFileId });
  } catch (err) {
    console.error('Drive delete error:', err.message);
  }
}

async function syncFromDrive() {
  const drive = getDriveClient();
  if (!drive || !FOLDER_ID()) {
    console.log('Drive sync skipped — not configured');
    return;
  }

  const res = await drive.files.list({
    q: `'${FOLDER_ID()}' in parents and mimeType='application/json' and trashed=false`,
    fields: 'files(id,name)',
    pageSize: 1000
  });

  const db = getDb();
  let synced = 0;

  for (const file of res.data.files || []) {
    try {
      const resp = await drive.files.get({ fileId: file.id, alt: 'media' });
      const article = resp.data;
      if (!article.id || !article.title) continue;

      const existing = db.prepare('SELECT id FROM articles WHERE id = ?').get(article.id);
      if (!existing) {
        db.prepare(`
          INSERT INTO articles (id, title, summary, content, category, tags, related_ids, author_email, published, drive_file_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          article.id, article.title, article.summary || '', article.content || '',
          article.category || '', JSON.stringify(article.tags || []),
          JSON.stringify(article.relatedArticleIds || []),
          article.author || '', article.published !== false ? 1 : 0,
          file.id, article.createdAt || new Date().toISOString(), article.updatedAt || new Date().toISOString()
        );
        synced++;
      }
    } catch (e) {
      console.error('Drive sync file error:', file.name, e.message);
    }
  }

  console.log(`✓ Drive sync complete — ${synced} new articles imported`);
}

module.exports = { saveArticleToDrive, deleteArticleFromDrive, syncFromDrive };
