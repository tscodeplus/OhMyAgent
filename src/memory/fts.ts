import type Database from 'better-sqlite3';

export interface FtsSearchResult {
  memoryId: string;
  content: string;
  bm25Score: number;      // raw BM25 score (lower = more relevant)
  normalizedScore: number;  // normalized to [0, 1] (higher = more relevant)
}

/**
 * Execute FTS5 BM25 search on memories.
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
