/**
 * Migration v11: `sessions.archived_at` — the WebUI archive flag.
 *
 * The WebUI sidebar lists two kinds of conversations (project chats and IM
 * inbox transcripts). "Archive" means "I am done with this for now": the row
 * leaves its list and shows up under 归档, still fully readable, and a new
 * incoming message brings it back (see AgentService's turn-start clearArchive).
 *
 * The flag is a nullable TEXT column holding epoch milliseconds as a digit
 * string, exactly like created_at/updated_at:
 *   - NULL      → active (the default for every existing row, so the upgrade is
 *                 invisible: nothing is archived by migration)
 *   - '1712…'   → archived at that instant; the archive list sorts on it.
 * Read it with `parseEpochMs` from `shared/timestamp.ts`, never `new Date(...)`.
 *
 * Archive is a WebUI list-visibility fact only: memory retrieval, search, the
 * knowledge graph and IM delivery all ignore it.
 *
 * Runs BEFORE applySchema (same ordering constraint as v4/v9): the index
 * `idx_sessions_archived` is declared in schema.ts, and `CREATE TABLE IF NOT
 * EXISTS` cannot add a column to an existing table — without this ALTER, the
 * index statement would throw on an upgraded database and abort startup.
 *
 * Idempotent: the column add is skipped when it already exists, and the index
 * is `IF NOT EXISTS`.
 */

import type Database from 'better-sqlite3';

export interface V11MigrationResult {
  added: string[];
  skipped: string[];
}

const COLUMN = 'archived_at';

const INDEX_ARCHIVED =
  'CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(archived_at, updated_at DESC)';

export function migrateV11(db: Database.Database): V11MigrationResult {
  const added: string[] = [];
  const skipped: string[] = [];

  const cols = db.pragma('table_info(sessions)') as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));

  // Fresh database: DDL_SESSIONS already declares the column and applySchema
  // (which runs right after) creates the index. The table does not exist yet,
  // so neither the ALTER nor the CREATE INDEX could run here.
  if (colNames.size === 0) {
    return { added, skipped };
  }

  if (colNames.has(COLUMN)) {
    skipped.push(COLUMN);
  } else {
    db.exec(`ALTER TABLE sessions ADD COLUMN ${COLUMN} TEXT`);
    added.push(COLUMN);
  }

  db.exec(INDEX_ARCHIVED);

  return { added, skipped };
}
