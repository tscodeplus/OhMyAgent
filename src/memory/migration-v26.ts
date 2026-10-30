/**
 * Migration v26: the index `memory_links.subject_entity` was never given.
 *
 * `memory_links` grew a subject in v15 (`subject_entity`) and only `target_entity`
 * ever got an index. Anything that asks "which memories name X" — the overview's
 * seed ranking, the entity roster's mention count, the mention tier — is written as
 * `target_entity = X OR subject_entity = X`, and an OR is only optimised when *both*
 * branches are indexable. With half of it unindexed SQLite falls back to a full
 * table scan, per entity: measured on the device (`EXPLAIN QUERY PLAN` → `SCAN ml`)
 * as 43 ms of a 55 ms graph request at 378 entities × 885 rows, i.e. O(N × L).
 *
 * The column order is `(subject_entity, relation_type)` to mirror
 * `idx_memory_links_entity(target_entity, relation_type)`: the second column costs
 * nothing to carry and lets the same index answer a future "subject + predicate"
 * filter without a second copy of these rows on a phone.
 *
 * Runs AFTER `applySchema` like v20–v25 — it only adds an index to a table that
 * `schema.ts` declares, and every statement is `IF NOT EXISTS`, because these
 * migrations replay on every open rather than running once per version.
 */

import type Database from 'better-sqlite3';

export interface MigrateV26Result {
  /** Indexes this call created (empty on a re-run). */
  createdIndexes: string[];
}

const LINKS_TABLE = 'memory_links';
const SUBJECT_INDEX = 'idx_memory_links_subject';

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?')
    .get('table', table) as { name: string } | undefined;
  return row !== undefined;
}

export function migrateV26(db: Database.Database): MigrateV26Result {
  const createdIndexes: string[] = [];
  // A pre-v10 database has no link table at all; nothing to index, and no error.
  if (!tableExists(db, LINKS_TABLE)) return { createdIndexes };

  db.exec(
    `CREATE INDEX IF NOT EXISTS ${SUBJECT_INDEX} ON ${LINKS_TABLE}(subject_entity, relation_type)`,
  );
  createdIndexes.push(SUBJECT_INDEX);

  return { createdIndexes };
}
