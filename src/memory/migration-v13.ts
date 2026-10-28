/**
 * Migration v13: memory provenance (`memory_sources`) + embedding visibility
 * (`memories.embedding_status`).
 *
 * `memory_sources` is many-to-many because one summary memory is compressed out
 * of N messages — a single `memories.source_message_id` column cannot express
 * that, and the measured result was 0/28 memories with any provenance at all.
 * `source_message_id` stays as the "primary source" convenience column and is
 * written alongside, so a reader that needs only one link does not have to
 * aggregate.
 *
 * Timestamps of the NEW table are INTEGER epoch-milliseconds (`Date.now()`),
 * NOT the TEXT digit-string `cast(strftime('%s','now') as integer) * 1000`
 * default the older tables carry — the same rule migration-v10 set for its
 * tables. There is no legacy writer to stay compatible with, and INTEGER keeps
 * "messages around this memory" a plain range comparison instead of a
 * `parseEpochMs` round-trip per row.
 *
 * `memories.embedding_status` ('ok' | 'skipped' | 'failed') makes vector-leg
 * coverage visible: memory-writer.ts used to `return` silently both when no
 * embedding provider is configured and when the call failed, so those two were
 * indistinguishable from the outside. Historical rows keep NULL, which means
 * "unknown" — reported separately and never counted in the denominator,
 * otherwise the first coverage report would read ~7% on a database that is
 * merely old.
 *
 * Runs BEFORE applySchema (same ordering constraint as v4/v9/v11/v12): schema.ts
 * declares `embedding_status` on `memories`, and `CREATE TABLE IF NOT EXISTS`
 * cannot add a column to a table that already exists — the index/schema DDL
 * would throw on an upgraded database and abort startup.
 *
 * Idempotent: every table/index is `CREATE ... IF NOT EXISTS` and the column add
 * is skipped when `PRAGMA table_info` already lists it, so this runs on every
 * startup rather than once behind a version gate.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../app/logger.js';

const logger = createLogger();

export interface MigrateV13Result {
  /** Tables/indexes this call created (empty on a re-run). */
  created: string[];
  /** Columns this call added (empty on a re-run, and on a fresh database). */
  added: string[];
}

const DDL_MEMORY_SOURCES = `
CREATE TABLE IF NOT EXISTS memory_sources (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  session_id TEXT,
  role TEXT,
  -- 'pipeline' passes it through at write time; 'backfill' matched by content;
  -- 'manual' written by an operator/tool
  source TEXT NOT NULL,
  created_at INTEGER,
  PRIMARY KEY (memory_id, message_id)
)`;

interface SchemaObject {
  kind: 'table' | 'index';
  name: string;
  ddl: string;
}

const V13_OBJECTS: SchemaObject[] = [
  { kind: 'table', name: 'memory_sources', ddl: DDL_MEMORY_SOURCES },
  {
    kind: 'index',
    name: 'idx_memory_sources_message',
    ddl: 'CREATE INDEX IF NOT EXISTS idx_memory_sources_message ON memory_sources(message_id)',
  },
  {
    kind: 'index',
    name: 'idx_memory_sources_session',
    ddl: 'CREATE INDEX IF NOT EXISTS idx_memory_sources_session ON memory_sources(session_id)',
  },
];

const COLUMN = 'embedding_status';

function schemaObjectExists(db: Database.Database, kind: 'table' | 'index', name: string): boolean {
  return (
    db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(kind, name) !==
    undefined
  );
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return new Set(cols.map((c) => c.name));
}

/**
 * Apply the v13 schema. Safe to call on every startup.
 */
export function migrateV13(db: Database.Database): MigrateV13Result {
  const created: string[] = [];

  // The table is created even on a fresh database, where `memories` does not
  // exist yet — SQLite does not resolve the REFERENCES target at CREATE time,
  // and FK enforcement only needs it once a row is written.
  for (const object of V13_OBJECTS) {
    const existed = schemaObjectExists(db, object.kind, object.name);
    db.exec(object.ddl);
    if (!existed) created.push(object.name);
  }

  // ON DELETE CASCADE above only fires when the connection has FK enforcement
  // on. openDatabase() sets `foreign_keys = ON`; a connection opened directly
  // with `new Database(...)` (tests, scripts) defaults to OFF and would leave
  // rows behind pointing at deleted memories.
  if (db.pragma('foreign_keys', { simple: true }) !== 1) {
    logger.warn(
      '[migration-v13] PRAGMA foreign_keys is OFF on this connection — memory_sources ON DELETE CASCADE will not fire',
    );
  }

  const added: string[] = [];
  const memoryColumns = tableColumns(db, 'memories');
  // Empty set = fresh database: DDL_MEMORIES in schema.ts already declares the
  // column and applySchema (which runs right after) creates the table.
  if (memoryColumns.size > 0 && !memoryColumns.has(COLUMN)) {
    db.exec(`ALTER TABLE memories ADD COLUMN ${COLUMN} TEXT`);
    added.push(COLUMN);
  }

  if (created.length > 0) {
    logger.info(`[migration-v13] Created: ${created.join(', ')}`);
  }
  if (added.length > 0) {
    logger.info(`[migration-v13] Added columns: ${added.join(', ')}`);
  }

  return { created, added };
}
