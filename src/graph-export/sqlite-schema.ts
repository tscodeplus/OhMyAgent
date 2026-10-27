/**
 * Schema introspection shared by the vault projection.
 *
 * The exporter is read-only and must survive a database that predates some
 * tables or columns (an install that has not run the latest memory migration,
 * or the entity tables added after this exporter shipped), so every read is
 * built from what the database actually reports instead of from a fixed schema.
 */

import type Database from 'better-sqlite3';

/**
 * True when `table` exists.
 *
 * Deliberately the plain `sqlite_master` lookup: a missing table is a normal
 * state for this exporter, not an error.
 */
export function hasTable(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(table) as { name?: string } | undefined;
  return row?.name === table;
}

/** Column names of `table`, in declaration order. */
export function tableColumns(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as { name?: string }[];
  return rows.map((row) => String(row.name ?? '')).filter(Boolean);
}

/** First candidate that exists in `columns` (case-insensitive), or null. */
export function pickColumn(columns: string[], candidates: string[]): string | null {
  const lowered = columns.map((column) => column.toLowerCase());
  for (const candidate of candidates) {
    const index = lowered.indexOf(candidate.toLowerCase());
    if (index !== -1) return columns[index];
  }
  return null;
}
