import type Database from 'better-sqlite3';
import { buildFtsQuery, tokenizeForIndex, isJiebaAvailable } from './fts-tokenizer.js';

export interface FtsSearchResult {
  memoryId: string;
  content: string;
  bm25Score: number;      // raw BM25 score (lower = more relevant)
  normalizedScore: number;  // normalized to [0, 1] (higher = more relevant)
}

/**
 * Execute FTS5 BM25 search on memories (original external-content table).
 *
 * @param db       SQLite database instance
 * @param ftsQuery FTS5-compatible query string (from query-expansion module)
 * @param limit    Max number of results
 * @param scope    Optional scope filter (matches memories.scope)
 * @param scopeKey Optional scope_key filter (matches memories.scope_key)
 */
export function ftsSearch(
  db: Database.Database,
  ftsQuery: string,
  limit: number,
  scope?: string,
  scopeKey?: string,
): FtsSearchResult[] {
  // Safety: reject empty or whitespace-only queries
  if (!ftsQuery || !ftsQuery.trim()) return [];

  let sql = `
    SELECT m.id, m.content, bm25(memories_fts) as rank
    FROM memories_fts fts
    JOIN memories m ON m.rowid = fts.rowid
    WHERE memories_fts MATCH ?
      AND m.status = 'active'
  `;
  const params: unknown[] = [ftsQuery];

  if (scope) {
    sql += ` AND m.scope = ?`;
    params.push(scope);
  }
  if (scopeKey) {
    sql += ` AND m.scope_key = ?`;
    params.push(scopeKey);
  }

  sql += ` ORDER BY rank LIMIT ?`;
  params.push(limit);

  let rows: Array<{ id: string; content: string; rank: number }>;
  try {
    rows = db.prepare(sql).all(...params) as Array<{ id: string; content: string; rank: number }>;
  } catch {
    // FTS5 query parse error (e.g., invalid syntax) — return empty
    return [];
  }

  if (rows.length === 0) return [];

  // Normalize BM25 scores to [0, 1]
  // BM25 raw values are negative; smaller = better match
  const ranks = rows.map(r => r.rank);
  const minRank = Math.min(...ranks);
  const maxRank = Math.max(...ranks);

  return rows.map(r => ({
    memoryId: r.id,
    content: r.content,
    bm25Score: r.rank,
    normalizedScore: maxRank === minRank
      ? 0.8  // all results equally relevant → reasonable default
      : 1 - (r.rank - minRank) / (maxRank - minRank),  // linear normalization
  }));
}

// ── Jieba-enhanced FTS5 search ──────────────────────────────────────────

/**
 * Execute FTS5 BM25 search using the jieba-segmented FTS5 table.
 *
 * The query text is tokenized with jieba before building the FTS5 MATCH
 * expression, providing much better Chinese text recall than the default
 * unicode61 tokenizer.
 *
 * Falls back to the original ftsSearch() when jieba is unavailable.
 */
export function ftsSearchJieba(
  db: Database.Database,
  queryText: string,
  limit: number,
  scope?: string,
  scopeKey?: string,
): FtsSearchResult[] {
  if (!isJiebaAvailable()) {
    // Fall back to original FTS — pass query through to unicode61 tokenizer
    const sanitized = queryText.replace(/[^\w\s一-鿿]/g, ' ').trim();
    if (!sanitized) return [];
    return ftsSearch(db, sanitized, limit, scope, scopeKey);
  }

  const ftsQuery = buildFtsQuery(queryText);
  if (!ftsQuery) return [];

  let sql = `
    SELECT fts.memory_id, fts.content_original as content, bm25(memories_fts_jieba) as rank
    FROM memories_fts_jieba fts
    JOIN memories m ON m.id = fts.memory_id
    WHERE memories_fts_jieba MATCH ?
      AND m.status = 'active'
  `;
  const params: unknown[] = [ftsQuery];

  if (scope) {
    sql += ` AND fts.scope = ?`;
    params.push(scope);
  }
  if (scopeKey) {
    sql += ` AND fts.scope_key = ?`;
    params.push(scopeKey);
  }

  sql += ` ORDER BY rank LIMIT ?`;
  params.push(limit);

  let rows: Array<{ memory_id: string; content: string; rank: number }>;
  try {
    rows = db.prepare(sql).all(...params) as Array<{ memory_id: string; content: string; rank: number }>;
  } catch {
    // FTS5 query parse error → fall back to original FTS
    return ftsSearch(db, queryText.replace(/[^\w\s一-鿿]/g, ' ').trim(), limit, scope, scopeKey);
  }

  if (rows.length === 0) return [];

  return rows.map(r => {
    // BM25 rank: more negative = more relevant
    const relevance = -r.rank;
    return {
      memoryId: r.memory_id,
      content: r.content,
      bm25Score: r.rank,
      normalizedScore: relevance / (1 + relevance),
    };
  });
}

/**
 * Sync a memory record to the jieba FTS5 index.
 * Called after insert/update/delete on the memories table.
 */
export function syncJiebaFts(
  db: Database.Database,
  action: 'insert' | 'update' | 'delete',
  memory: {
    id: string;
    content: string;
    kind: string;
    scope: string;
    scope_key: string;
    created_at: string;
  },
): void {
  if (!isJiebaAvailable()) return;

  try {
    // Delete old entry first (for update case)
    const delStmt = db.prepare('DELETE FROM memories_fts_jieba WHERE memory_id = ?');
    delStmt.run(memory.id);

    if (action !== 'delete') {
      // Insert segmented content
      const segmented = tokenizeForIndex(memory.content);
      const insertStmt = db.prepare(`
        INSERT INTO memories_fts_jieba (content, content_original, memory_id, kind, scope, scope_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      insertStmt.run(
        segmented,
        memory.content,
        memory.id,
        memory.kind,
        memory.scope,
        memory.scope_key,
        memory.created_at,
      );
    }
  } catch {
    // FTS sync failure is non-fatal — main write already succeeded
  }
}

/**
 * Whether jieba-enhanced FTS search is available.
 */
export function ftsJiebaAvailable(): boolean {
  return isJiebaAvailable();
}

/**
 * Backfill the jieba FTS index for all active memories.
 * Called at startup to populate the jieba FTS table for memories
 * that were created before jieba support was added.
 *
 * Runs in a single transaction. Existing jieba entries are preserved.
 *
 * @returns Number of memories indexed.
 */
export function rebuildJiebaFts(db: Database.Database): number {
  if (!isJiebaAvailable()) return 0;

  try {
    // Only backfill memories that don't already have a jieba entry
    const rows = db.prepare(`
      SELECT m.id, m.content, m.kind, m.scope, m.scope_key, m.created_at
      FROM memories m
      LEFT JOIN memories_fts_jieba j ON j.memory_id = m.id
      WHERE m.status = 'active' AND j.memory_id IS NULL
    `).all() as Array<{
      id: string; content: string; kind: string;
      scope: string; scope_key: string; created_at: string;
    }>;

    if (rows.length === 0) return 0;

    const delStmt = db.prepare('DELETE FROM memories_fts_jieba WHERE memory_id = ?');
    const insertStmt = db.prepare(`
      INSERT INTO memories_fts_jieba (content, content_original, memory_id, kind, scope, scope_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      let indexed = 0;
      for (const row of rows) {
        try {
          delStmt.run(row.id);
          insertStmt.run(
            tokenizeForIndex(row.content),
            row.content,
            row.id,
            row.kind,
            row.scope,
            row.scope_key,
            row.created_at,
          );
          indexed++;
        } catch {
          // Skip individual failures
        }
      }
      return indexed;
    });

    return tx();
  } catch {
    return 0;
  }
}
