/**
 * Migration v12: `sessions.archive_exempt_until` — "do not auto-archive me yet".
 *
 * Auto-archive flags conversations whose last activity (`updated_at`) is older
 * than `archive.auto.days`. A conversation the operator pulls out of 归档 by hand
 * is usually old by exactly that measure — that is why it was in the archive — so
 * without a marker the next sweep (which runs every two hours) would put it right
 * back, and restoring it would be pointless.
 *
 * Restoring therefore records an expiry, epoch-ms digit string like every other
 * timestamp here:
 *   - NULL      → no exemption; eligible as soon as it is old enough
 *   - '1712…'   → eligible again after that instant
 *
 * The exemption is "one more inactivity window", not "forever": a restored
 * conversation that is then forgotten still gets tidied up eventually. It is
 * deliberately *not* an `updated_at` bump — `updated_at` means "last activity",
 * and re-sorting a conversation to the top of its list (with a 刚刚 timestamp it
 * did not earn) would corrupt both that ordering and the auto-archive clock.
 *
 * Runs BEFORE applySchema (same ordering constraint as v4/v9/v11): the column is
 * declared in schema.ts, and `CREATE TABLE IF NOT EXISTS` cannot add a column to
 * an existing table.
 *
 * Idempotent: the column add is skipped when it already exists.
 */

import type Database from 'better-sqlite3';

export interface V12MigrationResult {
  added: string[];
  skipped: string[];
}

const COLUMN = 'archive_exempt_until';

export function migrateV12(db: Database.Database): V12MigrationResult {
  const added: string[] = [];
  const skipped: string[] = [];

  const cols = db.pragma('table_info(sessions)') as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));

  // Fresh database: DDL_SESSIONS already declares the column and applySchema
  // creates the table right after, so there is nothing to alter here.
  if (colNames.size === 0) {
    return { added, skipped };
  }

  if (colNames.has(COLUMN)) {
    skipped.push(COLUMN);
  } else {
    db.exec(`ALTER TABLE sessions ADD COLUMN ${COLUMN} TEXT`);
    added.push(COLUMN);
  }

  return { added, skipped };
}
