import type Database from 'better-sqlite3';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const dbsWithExtension = new WeakSet<Database.Database>();

/**
 * Load the sqlite-vec native extension into the given database.
 * Safe to call multiple times — subsequent calls are no-ops.
 * Returns true on success, false with a console.warn on failure.
 */
export function loadSqliteVecExtension(db: Database.Database): boolean {
  if (dbsWithExtension.has(db)) return true;

  try {
    const sqliteVec = require('sqlite-vec') as { load: (db: Database.Database) => void };
    sqliteVec.load(db);
    dbsWithExtension.add(db);
    return true;
  } catch (err: any) {
    console.warn('[sqlite-vec] Failed to load extension:', err?.message ?? err);
    return false;
  }
}

/**
 * Load the extension (if needed) and create the vec0 virtual table.
 * The virtual table is created with the given embedding dimension.
 * Dimension only matters on first call — subsequent calls with a different
 * dimension are ignored because the table already exists (IF NOT EXISTS).
 */
export function loadSqliteVec(db: Database.Database, dimension: number): boolean {
  if (!loadSqliteVecExtension(db)) return false;

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory_embeddings USING vec0(
        memory_id TEXT PRIMARY KEY,
        embedding float[${dimension}]
      )
    `);
    return true;
  } catch (err: any) {
    console.warn('[sqlite-vec] Failed to create virtual table:', err?.message ?? err);
    return false;
  }
}

/**
 * Probe whether sqlite-vec can be loaded into the given database.
 * Actually loads the extension (so any DLL/platform issues surface
 * immediately) but does NOT create the virtual table — that happens
 * lazily on first embedding write with the real dimension.
 *
 * Throws with a diagnostic message on failure.
 */
export function probeSqliteVec(db: Database.Database): void {
  if (!loadSqliteVecExtension(db)) {
    throw new Error('sqlite-vec extension failed to load; check earlier [sqlite-vec] log line for details');
  }
}

/**
 * Returns true if the sqlite-vec extension has been loaded into this
 * database AND the vec0 virtual table exists.
 */
export function sqliteVecAvailable(db: Database.Database): boolean {
  if (!dbsWithExtension.has(db)) return false;
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
