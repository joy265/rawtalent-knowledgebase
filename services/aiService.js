const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../db/database');

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

async function searchKnowledge(db, question, limit = 8) {
  const term = question
    .replace(/[^\w\s\-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .map(t => `"${t}"*`)
    .join(' OR ');

  const results = [];

  // Search published articles
  try {
    const r = await db.execute({
      sql: `SELECT a.id, a.title, a.content, a.category, 'article' as source_type, NULL as origin
            FROM articles a JOIN articles_fts fts ON a.id = fts.id
            WHERE articles_fts MATCH ? AND a.published = 1
            ORDER BY rank LIMIT ?`,
      args: [term, limit]
    });
    results.push(...r.rows);
  } catch {}

  // Search knowledge sources (documents + websites)
  try {
    const r = await db.execute({
      sql: `SELECT s.id, s.title, s.content, NULL as category, s.type as source_type, s.origin
            FROM knowledge_sources s JOIN knowledge_sources_fts fts ON s.id = fts.id
            WHERE knowledge_sources_fts MATCH ?
            ORDER BY rank LIMIT ?`,
      args: [term, limit]
    });
    results.push(...r.rows);
  } catch {}

  return results;
}

const SYSTEM_PROMPT = `You are an internal AI assistant for RawTalent, an Australian childcare staffing agency. Your job is to answer team members' questions accurately and concisely using only the provided source material.

Rules:
- Answer using ONLY information from the provided sources. Do not use outside knowledge.
- If the sources don't contain enough information, say clearly: "I don't have enough information in the knowledge base to answer this confidently."
- Cite sources by referencing [Source N] inline where you use them.
- Be practical and direct — team members need actionable answers fast.
- For compliance or regulatory questions, always note that requirements may change and link to the relevant source for verification.`;

async function askQuestion(question, askedBy) {
  const client = getClient();
  if (!client) throw new Error('AI is not configured. Please contact your administrator.');

  const db = getDb();
  const matches = await searchKnowledge(db, question);

  if (matches.length === 0) {
    return {
      answer: "I couldn't find any relevant information in the knowledge base to answer that question. Try rephrasing, or ask your administrator to add relevant documents or websites as sources.",
      sources: []
    };
  }

  const contextBlocks = matches.map((m, i) => {
    const label = m.source_type === 'article'
      ? `Article: ${m.title}${m.category ? ` (${m.category})` : ''}`
      : `${m.source_type === 'website' ? 'Website' : 'Document'}: ${m.title}${m.origin ? ` — ${m.origin}` : ''}`;
    const preview = (m.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000);
    return `[Source ${i + 1}: ${label}]\n${preview}`;
  }).join('\n\n---\n\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Sources:\n\n${contextBlocks}\n\n---\n\nQuestion: ${question}` }]
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
