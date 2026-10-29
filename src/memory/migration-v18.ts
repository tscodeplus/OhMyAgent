/**
 * Migration v18: remember which memories the extraction model has already read.
 *
 * The LLM pass in `entity_backfill` picks candidates with "no typed link yet", so
 * a memory whose text states no relation stays a candidate forever and is paid
 * for again on every run. On the reference database that is 22 memories every six
 * hours, every day, for an answer that never changes — the same "backlog that
 * provably never drains" the provenance job's rotation was introduced to avoid.
 *
 * A null-result marker cannot live in `memory_links`: a row there is retrieval
 * evidence, and "the model looked and found nothing" is not a mention of anything.
 * So it gets its own table, keyed by memory and stamped with a content hash:
 *
 *   - same memory, same content  → skipped, the answer was already bought
 *   - same memory, edited content → re-examined automatically (hash differs)
 *   - `outcome = 'error'`         → never skipped; a failed call is not an answer
 *
 * Runs AFTER `applySchema()` like v17, and like v17 it is a pure data-layer add
 * that is safe to replay: `CREATE TABLE IF NOT EXISTS` is the whole migration.
 */

import type Database from 'better-sqlite3';

export interface MigrateV18Result {
  /** True when this call created the table (false on a re-run). */
  created: boolean;
}

export function migrateV18(db: Database.Database): MigrateV18Result {
  const existed = tableExists(db, 'entity_extraction_log');
  db.exec(`
    CREATE TABLE IF NOT EXISTS entity_extraction_log (
      memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
      -- sha256 of the exact text the model was shown. A match means the stored
      -- outcome still answers for this content; a mismatch means it does not.
      content_hash TEXT NOT NULL,
      -- 'triples' | 'none' | 'error'. 'error' is never used to skip.
      outcome TEXT NOT NULL,
      triples_written INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entity_extraction_log_hash
      ON entity_extraction_log(content_hash);
  `);
  return { created: !existed };
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
  return row !== undefined;
}
