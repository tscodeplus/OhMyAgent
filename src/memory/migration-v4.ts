/**
 * Migration v4: Add project_id to sessions table and create projects table.
 *
 * This migration enables the Project-based WebUI conversation model.
 * - sessions.project_id: NULL for IM sessions, set for WebUI sessions
 * - projects table: lightweight conversation containers
 */

import type Database from 'better-sqlite3';

export function migrateV4(db: Database.Database): void {
  // Check if sessions table exists first (fresh DB may not have it yet)
  const tableCheck = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
  ).get() as { name: string } | undefined;

  if (tableCheck) {
    // Table exists — check for project_id column
    const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    const hasProjectId = columns.some((col) => col.name === 'project_id');

    if (!hasProjectId) {
      db.exec('ALTER TABLE sessions ADD COLUMN project_id TEXT');
      console.log('[migration-v4] Added project_id column to existing sessions table');
    }

    // Ensure index exists on existing tables (idempotent). On a fresh DB the
    // sessions table doesn't exist yet — applySchema (which runs after this
    // migration) creates both the table and this index, so we skip it here.
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)');
  }
  // If table doesn't exist yet, applySchema will create it with project_id column

  // Create projects table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      agent_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
      updated_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000)
    )
  `);

  console.log('[migration-v4] Projects table and sessions index ready');
}
