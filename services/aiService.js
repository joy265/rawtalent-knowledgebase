const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/database');

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function buildFtsTerm(text) {
  return text
    .replace(/[^\w\s\-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .map(t => `"${t}"*`)
    .join(' OR ');
}

async function searchKnowledge(db, question, limit = 5) {
  const term = buildFtsTerm(question);
  const results = [];
  const seen = new Set();

  async function runSearch(ftsQuery) {
    try {
      const r1 = await db.execute({
        sql: `SELECT a.id, a.title, a.content, a.category, 'article' as source_type, NULL as origin
              FROM articles a JOIN articles_fts fts ON a.id = fts.id
              WHERE articles_fts MATCH ? AND a.published = 1
              ORDER BY rank LIMIT ?`,
        args: [ftsQuery, limit]
      });
      for (const row of r1.rows) {
        if (!seen.has(row.id)) { seen.add(row.id); results.push(row); }
      }
    } catch {}

    try {
      const r2 = await db.execute({
        sql: `SELECT s.id, s.title, s.content, NULL as category, s.type as source_type, s.origin
              FROM knowledge_sources s JOIN knowledge_sources_fts fts ON s.id = fts.id
              WHERE knowledge_sources_fts MATCH ?
              ORDER BY rank LIMIT ?`,
        args: [ftsQuery, limit]
      });
      for (const row of r2.rows) {
        if (!seen.has(row.id)) { seen.add(row.id); results.push(row); }
      }
    } catch {}
  }

  await runSearch(term);

  // Fallback: if fewer than 3 results, try searching individual keywords separately
  if (results.length < 3) {
    const words = question
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3);
    for (const word of words) {
      if (results.length >= limit) break;
      await runSearch(`"${word}"*`);
    }
  }

  return results.slice(0, limit);
}

const SYSTEM_PROMPT = `You are an internal AI assistant for RawTalent, an Australian ECEC (early childhood education and care) staffing agency. Your job is to answer team members' questions accurately and concisely.

Rules:
1. **Typos and near-matches**: If a question contains an obvious typo or misspelling of a known ECEC term or acronym (e.g. "ACEQA" → ACECQA, "certifcate" → Certificate III), silently correct it and answer for the intended term. Briefly note the correction at the start of your answer so the team member knows what you understood.
2. **Prefer provided sources**: When the sources contain relevant information, use them and cite inline as [Source N].
3. **Use ECEC domain knowledge as a fallback**: If the provided sources don't fully cover the question, you may use your general knowledge of Australian ECEC, NQF, ACECQA, state regulations, childcare compliance, and staffing — but clearly begin that section with "Based on general ECEC knowledge (not in your knowledge base):" so the team member knows to verify it.
4. **Internal processes**: For questions about RawTalent-specific internal processes, procedures, or policies — if not covered by the sources, say so rather than guessing.
5. Be practical and direct — team members need actionable answers fast.
6. For compliance or regulatory questions, always recommend verifying with the official source (ACECQA, state regulator, etc.) as requirements can change.`;

async function askQuestion(question, askedBy) {
  const client = getClient();
  if (!client) throw new Error('AI is not configured. Please contact your administrator.');

  const db = getDb();
  const matches = await searchKnowledge(db, question);

  const contextBlocks = matches.map((m, i) => {
    const label = m.source_type === 'article'
      ? `Article: ${m.title}${m.category ? ` (${m.category})` : ''}`
      : `${m.source_type === 'website' ? 'Website' : 'Document'}: ${m.title}${m.origin ? ` — ${m.origin}` : ''}`;
    const preview = (m.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
    return `[Source ${i + 1}: ${label}]\n${preview}`;
  }).join('\n\n---\n\n');

  const userContent = matches.length > 0
    ? `Sources:\n\n${contextBlocks}\n\n---\n\nQuestion: ${question}`
    : `No matching documents were found in the knowledge base for this question.\n\nQuestion: ${question}\n\nIf you can answer this from your general ECEC/Australian childcare knowledge, please do so and clearly label it as general knowledge. If it is an internal RawTalent-specific question that you cannot answer without sources, say so.`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }]
  });

  const answer = response.content[0]?.text || '';

  const sourcesUsed = matches.map((m, i) => ({
    index: i + 1,
    title: m.title,
    type: m.source_type,
    id: m.id,
    origin: m.origin || null
  }));

  await db.execute({
    sql: 'INSERT INTO ai_query_log (question, answer, sources_used, asked_by) VALUES (?, ?, ?, ?)',
    args: [question, answer, JSON.stringify(sourcesUsed), askedBy]
  });

  return { answer, sources: sourcesUsed };
}

module.exports = { askQuestion };
