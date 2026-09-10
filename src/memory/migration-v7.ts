/**
 * Migration v7: Normalize memory_observation_events.created_at to epoch-ms.
 *
 * Legacy databases carry a table whose DEFAULT is `datetime('now')` (UTC
 * 'YYYY-MM-DD HH:MM:SS' strings) while the current schema DDL expects
 * epoch-ms digit strings. applySchema's CREATE TABLE IF NOT EXISTS never
 * upgrades the DEFAULT, migration-v5 only converted existing rows — so every
 * new insert kept writing UTC strings and time-window queries mixing both
 * formats broke (CAST('2026-...' AS INTEGER) = 2026).
 *
 * Fix: rebuild the table with the canonical epoch-ms DEFAULT and convert any
 * remaining datetime-formatted values. Idempotent — skipped when the table's
 * DEFAULT is already epoch-ms based.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../app/logger.js';

const logger = createLogger();

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name) !==
    undefined
  );
}

export function migrateV7(db: Database.Database): void {
  try {
    if (!tableExists(db, 'memory_observation_events')) return;

    const ddl = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name = 'memory_observation_events'",
      )
      .get() as { sql: string } | undefined;
    if (!ddl?.sql) return;

    // Canonical table (created by schema.ts) uses the epoch-ms DEFAULT — skip.
    if (!ddl.sql.includes("datetime('now')")) return;

    logger.info('[migration-v7] Normalizing memory_observation_events.created_at to epoch-ms');

    // Entirely-digit strings are already epoch-ms; anything else (e.g.
    // '2026-09-10 08:44:43' from the legacy datetime DEFAULT) goes through
    // SQLite's date parser. A bare GLOB '[0-9]*' would wrongly match dates too
    // — they also start with a digit (the year).
    const normalizeExpr =
      "CASE WHEN created_at NOT GLOB '*[^0-9]*' THEN created_at " +
      "ELSE CAST(strftime('%s', created_at) AS INTEGER) * 1000 END";

    db.transaction(() => {
      db.prepare(
        `CREATE TABLE memory_observation_events_v7 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event TEXT NOT NULL,
          details TEXT,
          created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000)
        )`,
      ).run();
      db.prepare(
        `INSERT INTO memory_observation_events_v7 (id, event, details, created_at)
         SELECT id, event, details, ${normalizeExpr} FROM memory_observation_events`,
      ).run();
      db.prepare('DROP TABLE memory_observation_events').run();
      db.prepare(
        'ALTER TABLE memory_observation_events_v7 RENAME TO memory_observation_events',
      ).run();
    })();

    // Restore the event/created_at index dropped together with the old table.
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_memory_observation_events_event ON memory_observation_events(event, created_at)',
    ).run();

    logger.info('[migration-v7] memory_observation_events.created_at normalized to epoch-ms');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      '[migration-v7] failed (non-fatal, continuing startup)',
    );
  }
}
