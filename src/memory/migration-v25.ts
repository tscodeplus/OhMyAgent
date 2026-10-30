/**
 * Migration v25: `knowledge_log.note` — the reviewer's own words.
 *
 * Rejecting a shadow draft is now a decision *with a cause*: the queue offers a
 * closed set of reasons (`REJECTION_REASONS` in `knowledge/types.ts`) and lets the
 * reviewer add free text. The code goes in `reason` so it stays groupable, and the
 * sentence goes here because a sentence in a code column destroys the grouping it
 * was put there to give — `reject:thin` counting 9 and `reject:thin because the
 * only source is one 62-character summary` counting 1 is a bug in a tally, not a
 * nuance.
 *
 * Runs AFTER `applySchema` like v20/v21/v22/v24: `knowledge_log` is migration-v14's
 * table, so `schema.ts` does not declare it and there is no column here for
 * `applySchema` to trip over on an upgraded database — but the table does not exist
 * until v14 has run either. Every statement is guarded (`PRAGMA table_info`,
 * `IF NOT EXISTS`), because these migrations replay on every open.
 *
 * The index is on `reason` alone rather than `(action, reason)`: the tally reads
 * `WHERE reason LIKE 'reject:%'`, and the retention prune deletes whole rows by
 * age, so one narrow index serves both and the wide one would only be a second
 * copy of the same rows on a phone.
 */

import type Database from 'better-sqlite3';

export interface MigrateV25Result {
  /** Columns this call added (empty on a re-run). */
  added: string[];
  /** Indexes this call created (empty on a re-run). */
  createdIndexes: string[];
}

const LOG_TABLE = 'knowledge_log';
const NOTE_COLUMN = 'note';
const REASON_INDEX = 'idx_knowledge_log_reason';

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

export function migrateV25(db: Database.Database): MigrateV25Result {
  const added: string[] = [];
  const createdIndexes: string[] = [];

  // A database that has not reached v14 has no log table at all, and one that has
  // is the only case where this migration has work to do.
  if (!tableExists(db, LOG_TABLE)) return { added, createdIndexes };

  if (!hasColumn(db, LOG_TABLE, NOTE_COLUMN)) {
    db.exec(`ALTER TABLE ${LOG_TABLE} ADD COLUMN ${NOTE_COLUMN} TEXT`);
    added.push(`${LOG_TABLE}.${NOTE_COLUMN}`);
  }

  db.exec(`CREATE INDEX IF NOT EXISTS ${REASON_INDEX} ON ${LOG_TABLE}(reason)`);
  createdIndexes.push(REASON_INDEX);

  return { added, createdIndexes };
}
