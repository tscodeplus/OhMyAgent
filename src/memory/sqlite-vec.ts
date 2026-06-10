import type Database from 'better-sqlite3';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const loadedDbs = new WeakSet<Database.Database>();

export function loadSqliteVec(db: Database.Database, dimension: number): boolean {
  if (!loadedDbs.has(db)) {
    try {
      // sqlite-vec's npm package resolves the platform-specific extension path.
      // Dynamic require keeps tests/environments without the package from failing at import time.
      const sqliteVec = require('sqlite-vec') as { load: (db: Database.Database) => void };
      sqliteVec.load(db);
      loadedDbs.add(db);
    } catch {
      return false;
    }
  }

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory_embeddings USING vec0(
        memory_id TEXT PRIMARY KEY,
        embedding float[${dimension}]
      )
    `);
    return true;
  } catch {
    return false;
  }
}

export function sqliteVecAvailable(db: Database.Database): boolean {
  try {
    const row = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'vec_memory_embeddings'
    `).get() as { name: string } | undefined;
    return row?.name === 'vec_memory_embeddings';
  } catch {
    return false;
  }
}

/**
 * Insert embedding into vec0 table.
 */
export function vecInsert(
  db: Database.Database,
  memoryId: string,
  embedding: Float32Array,
): void {
  db.prepare('DELETE FROM vec_memory_embeddings WHERE memory_id = ?').run(memoryId);
  const stmt = db.prepare(
    'INSERT INTO vec_memory_embeddings (memory_id, embedding) VALUES (?, ?)'
  );
  stmt.run(memoryId, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength));
}

/**
 * Search vec0 table for similar embeddings.
 * Returns array of { memoryId, distance } sorted by distance ascending.
 */
export function vecSearch(
  db: Database.Database,
  queryEmbedding: Float32Array,
  limit: number = 10,
  candidateIds?: string[] | null,
): Array<{ memoryId: string; distance: number }> {
  if (candidateIds !== undefined && candidateIds !== null && candidateIds.length === 0) {
    return [];
  }
  const query = Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength);
  const rows = candidateIds && candidateIds.length > 0
    ? db.prepare(`
        SELECT memory_id, distance
        FROM vec_memory_embeddings
        WHERE embedding MATCH ? AND memory_id IN (${candidateIds.map(() => '?').join(',')})
        ORDER BY distance
        LIMIT ?
      `).all(query, ...candidateIds, limit)
    : db.prepare(`
        SELECT memory_id, distance
        FROM vec_memory_embeddings
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
      `).all(query, limit);
  return (rows as Array<{
    memory_id: string;
    distance: number;
  }>).map(r => ({ memoryId: r.memory_id, distance: r.distance }));
}

/**
 * Delete embedding from vec0 table.
 */
export function vecDelete(db: Database.Database, memoryId: string): void {
  db.prepare('DELETE FROM vec_memory_embeddings WHERE memory_id = ?').run(memoryId);
}
