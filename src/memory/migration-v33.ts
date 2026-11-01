/**
 * Migration v33: `note_relations` gets a `basis` column, by rebuilding the table.
 *
 * v31 created this table for a feature that was never wired up, so **it cannot
 * contain a row** — nothing in the codebase ever inserted into it, which is
 * verifiable with `SELECT COUNT(*) FROM note_relations` on any install. Rebuilding
 * is therefore lossless, and it is the only honest way to get the column name right:
 * v31 called it `origin`, which everywhere else in this database means *authorship*
 * (`user` / `agent`). Reusing that name for `session|title|tags` would be a reading
 * trap of exactly the kind AGENTS.md warns about (two same-named columns, two
 * meanings), and `ALTER TABLE ... ADD COLUMN basis` would leave the misleading column
 * in place forever since SQLite cannot drop one without a rebuild anyway.
 *
 * Why a relation needs a basis at all: the score alone says *how* related, never
 * *why*. 「相关 3 条」 with no reason is the part users distrust, and a stored basis is
 * also what makes the three rules testable one at a time instead of only as a
 * composite number.
 *
 * The row shape is **mirrored**: a pair (a, b) is written as both (a→b) and (b→a)
 * with the same score and basis. That costs one extra row per pair and buys two
 * things — `relatedFor()` stays a single indexed lookup on `note_id`, and when a new
 * note arrives the *older* note's side is written in the same transaction, so it sees
 * the new neighbour immediately instead of waiting for a full recompute.
 *
 * Registered after `applySchema()` like every other new-table migration. The
 * statement is replay-safe: the DROP is `IF EXISTS` and the CREATE is `IF NOT
 * EXISTS`.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../app/logger.js';

const logger = createLogger();

export interface MigrateV33Result {
  /** True when this call actually rebuilt the table (false on a re-run). */
  rebuilt: boolean;
  /** Rows dropped by the rebuild; expected to be 0 on every real install. */
  discardedRows: number;
}

const RELATIONS_DDL = `
CREATE TABLE IF NOT EXISTS note_relations (
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  related_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  score      REAL NOT NULL,
  basis      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, related_id)
)`;

const RELATIONS_INDEXES = [
  // The primary key covers `note_id`; the reverse lookup (who points at me) is only
  // needed by the recompute path, and it runs once per capture.
  `CREATE INDEX IF NOT EXISTS idx_note_relations_related ON note_relations(related_id)`,
];

/** `origin` is v31's name for what is now `basis`; its presence marks the old shape. */
function hasLegacyShape(db: Database.Database): boolean {
  const columns = db.prepare('PRAGMA table_info(note_relations)').all() as Array<{ name: string }>;
  if (columns.length === 0) return false; // no table yet — nothing to rebuild
  return !columns.some((column) => column.name === 'basis');
}

export function migrateV33(db: Database.Database): MigrateV33Result {
  const legacy = hasLegacyShape(db);
  if (!legacy) {
    // Fresh install (or an already-migrated one): create-if-absent and the index.
    db.exec(RELATIONS_DDL);
    for (const statement of RELATIONS_INDEXES) db.exec(statement);
    return { rebuilt: false, discardedRows: 0 };
  }

  const before = (db.prepare('SELECT COUNT(*) AS c FROM note_relations').get() as { c: number }).c;
  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS note_relations');
    db.exec(RELATIONS_DDL);
    for (const statement of RELATIONS_INDEXES) db.exec(statement);
  })();

  if (before > 0) {
    // Should be unreachable — v31's table had no writer. Logged rather than thrown:
    // the rows are recomputable from `notes` at any time, so a loss here is a
    // rebuild, not data loss.
    logger.warn(
      { discardedRows: before },
      '[V33] note_relations was not empty when rebuilt; rows are recomputable via pnpm notes:relate',
    );
  } else {
    logger.info('[V33] Rebuilt note_relations with a basis column (was empty)');
  }
  return { rebuilt: true, discardedRows: before };
}
