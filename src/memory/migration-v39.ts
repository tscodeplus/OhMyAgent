/**
 * Migration v39: `maintenance_runs.cursor` — how far a backlog-shaped phase got.
 *
 * `DreamCycle.synthesize` used to pick its batch of memories with
 * `ORDER BY RANDOM()`, so a backlog larger than `synthesizeBatchSize` was
 * advanced statistically: each night re-sampled from the whole table, the tail
 * could go unvisited indefinitely, and an interrupted run restarted from a
 * different random place. A cursor turns "sample 50 random rows" into "continue
 * after row N", which is what makes the phase converge and makes a timed-out or
 * killed run resumable instead of wasteful.
 *
 * Column shape: `TEXT` holding the integer `memories.rowid` the phase last
 * looked at, `'0'` meaning "wrapped back to the head", NULL meaning "never ran"
 * (every row written before this release). `memories.rowid` rather than
 * `created_at` on purpose: `created_at` is TEXT that holds epoch-millisecond
 * digit strings for schema-written rows and ISO strings for application writes,
 * so ordering by it is a *lexicographic* comparison across two shapes
 * (`"1788..."` sorts before `"2026-..."` regardless of time). The rowid is a
 * stable integer, insertion order is conversation order for the write paths that
 * matter here, and the merge direction still compares `created_at` through
 * `parseEpochMs` in JS.
 *
 * Runs BEFORE applySchema, same ordering constraint as v4/v9/v11/v12/v38:
 * schema.ts declares the column and `CREATE TABLE IF NOT EXISTS` cannot add it
 * to an existing table. Idempotent: the ALTER is skipped when the column is
 * already there, and a fresh database has no table yet (schema.ts creates it
 * with the column).
 */

import type Database from 'better-sqlite3';

export interface V39MigrationResult {
  /** Columns this run added (`[]` when the table or the column already existed). */
  added: string[];
}

const TABLE = 'maintenance_runs';
const COLUMN = 'cursor';

export function migrateV39(db: Database.Database): V39MigrationResult {
  const added: string[] = [];

  const cols = db.pragma(`table_info(${TABLE})`) as Array<{ name: string }>;
  // Fresh database: the table does not exist yet and applySchema will create it
  // from DDL_MAINTENANCE_RUNS, which already declares the column.
  if (cols.length === 0) return { added };
  if (cols.some((c) => c.name === COLUMN)) return { added };

  db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} TEXT`);
  added.push(COLUMN);
  return { added };
}
