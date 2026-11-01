/**
 * Migration v34: `capture_runs` records how much of the conversation it could read.
 *
 * v31 created this table as "one row per capture attempt: the window, the model, the
 * outcome", but the window was only ever recorded as a message-id list and a token
 * estimate — which cannot express "the budget cut 14 of 20 messages". That distinction
 * matters now that a capture can read a whole session: a note distilled from the tail
 * of a conversation and a note distilled from all of it are different claims, and a
 * reply that says nothing about it makes the first look like the second.
 *
 * `ALTER TABLE ... ADD COLUMN` with a `NOT NULL DEFAULT 0` is the honest shape here
 * (unlike v33's rebuild): the column is additive, every existing row genuinely dropped
 * zero messages — they were written by the suffix windows that always fit — and SQLite
 * can add a defaulted column without rewriting rows. `DEFAULT 0` also keeps old rows
 * readable as "no truncation", which is true of them.
 *
 * Replay-safe: SQLite has no `ADD COLUMN IF NOT EXISTS`, so the column list is checked
 * first; a re-run is a no-op.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../app/logger.js';

const logger = createLogger();

export interface MigrateV34Result {
  /** True when this call added the column (false on a re-run). */
  added: boolean;
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

export function migrateV34(db: Database.Database): MigrateV34Result {
  const exists =
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'capture_runs'`,
        )
        .get() as { c: number }
    ).c > 0;
  if (!exists) return { added: false };
  if (hasColumn(db, 'capture_runs', 'dropped_messages')) return { added: false };

  db.exec('ALTER TABLE capture_runs ADD COLUMN dropped_messages INTEGER NOT NULL DEFAULT 0');
  logger.info('[V34] capture_runs gained dropped_messages (0 on every existing row)');
  return { added: true };
}
