/**
 * Migration v13: `memory_sources` + `memories.embedding_status`.
 *
 * Same invariant as v11/v12: an in-place upgrade ends with the schema a fresh
 * install gets, and the upgrade changes no behaviour — historical memories keep
 * `embedding_status IS NULL`, i.e. "unknown", so an operator who upgrades does
 * not immediately see a coverage alarm for rows written before the column
 * existed.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrateV13 } from '../../src/memory/migration-v13';
import { applySchema } from '../../src/memory/schema';
import { openDatabase } from '../../src/memory/db';

/** memories table as written by releases before v13 (no embedding_status). */
const V12_MEMORIES_DDL = `
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  agent_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'shared',
  status TEXT NOT NULL DEFAULT 'active',
  supersedes_id TEXT,
  source_channel TEXT,
  source_message_id TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  invalidated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
  updated_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000)
)`;

const V13_OBJECTS = ['memory_sources', 'idx_memory_sources_message', 'idx_memory_sources_session'];

function columnNames(db: Database.Database, table: string): string[] {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return cols.map((c) => c.name).sort();
}

function indexNames(db: Database.Database, table: string): string[] {
  const rows = db
    .prepare('SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = ?')
    .all('index', table) as Array<{ name: string }>;
  return rows.map((r) => r.name).sort();
}

function openWithForeignKeys(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

describe('migration-v13: memory_sources + memories.embedding_status', () => {
  it('creates memory_sources and its indexes, then reports nothing on a re-run', () => {
    const db = openWithForeignKeys();

    expect(migrateV13(db)).toEqual({ created: V13_OBJECTS, added: [] });
    // `sqlite_autoindex_memory_sources_1` is the (memory_id, message_id) primary
    // key; the two below are the ones this migration creates.
    expect(indexNames(db, 'memory_sources')).toEqual(
      expect.arrayContaining(['idx_memory_sources_message', 'idx_memory_sources_session']),
    );
    // Every later startup hits the idempotent path.
    expect(migrateV13(db)).toEqual({ created: [], added: [] });
    db.close();
  });

  // The real open order is migrateV13() then applySchema(), so `memories` does
  // not exist yet when the FK is declared. SQLite resolves REFERENCES lazily;
  // if that ever stopped holding, bootstrap would die right here.
  it('creates its table before `memories` exists, and still boots', () => {
    const db = openWithForeignKeys();

    expect(() => migrateV13(db)).not.toThrow();
    expect(() => applySchema(db)).not.toThrow();
    expect(columnNames(db, 'memories')).toContain('embedding_status');
    db.close();
  });

  it('adds embedding_status to an upgraded database, leaving historical rows unknown', () => {
    const db = openWithForeignKeys();
    db.exec(V12_MEMORIES_DDL);
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at)
       VALUES ('mem-1', 'user', 'default', 'preference', '偏好 TypeScript', '1000', '1000')`,
    ).run();

    const result = migrateV13(db);
    expect(result.added).toEqual(['embedding_status']);
    expect(db.prepare('SELECT embedding_status FROM memories WHERE id = ?').get('mem-1')).toEqual({
      embedding_status: null,
    });

    // Idempotent: a second run must not throw on the duplicate column.
    expect(migrateV13(db)).toEqual({ created: [], added: [] });
    db.close();
  });

  it('a migrated memories table has the same column set as a fresh one', () => {
    const migratedDb = openWithForeignKeys();
    migratedDb.exec(V12_MEMORIES_DDL);
    migrateV13(migratedDb);

    const freshDb = new Database(':memory:');
    applySchema(freshDb);

    expect(columnNames(migratedDb, 'memories')).toEqual(columnNames(freshDb, 'memories'));
    expect(columnNames(freshDb, 'memories')).toContain('embedding_status');

    migratedDb.close();
    freshDb.close();
  });

  it('is a no-op on a database with no memories table', () => {
    const db = openWithForeignKeys();

    expect(migrateV13(db).added).toEqual([]);
    applySchema(db);
    expect(columnNames(db, 'memories')).toContain('embedding_status');
    db.close();
  });

  it('keeps one row per (memory, message) and stores integer epoch-ms', () => {
    const db = openWithForeignKeys();
    applySchema(db);
    migrateV13(db);

    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at)
       VALUES ('mem-1', 'user', 'default', 'summary', '压缩后的摘要', '1000', '1000')`,
    ).run();

    const insert = db.prepare(
      `INSERT INTO memory_sources (memory_id, message_id, session_id, role, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    insert.run('mem-1', 'msg-1', 'sess-1', 'user', 'pipeline', now);
    insert.run('mem-1', 'msg-2', 'sess-1', 'assistant', 'pipeline', now + 1);

    expect(() => insert.run('mem-1', 'msg-2', 'sess-1', 'assistant', 'pipeline', now)).toThrow(
      /UNIQUE|PRIMARY KEY/,
    );
    expect(
      db.prepare('SELECT created_at FROM memory_sources WHERE message_id = ?').get('msg-1'),
    ).toEqual({ created_at: now });
    db.close();
  });

  it('deletes provenance rows with their memory when foreign keys are on', () => {
    const db = openWithForeignKeys();
    applySchema(db);
    migrateV13(db);

    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at)
       VALUES ('mem-1', 'user', 'default', 'summary', '压缩后的摘要', '1000', '1000')`,
    ).run();
    db.prepare(
      `INSERT INTO memory_sources (memory_id, message_id, session_id, role, source, created_at)
       VALUES ('mem-1', 'msg-1', 'sess-1', 'user', 'pipeline', ?)`,
    ).run(Date.now());

    db.prepare("DELETE FROM memories WHERE id = 'mem-1'").run();

    expect(db.prepare('SELECT COUNT(*) AS cnt FROM memory_sources').get()).toEqual({ cnt: 0 });
    db.close();
  });

  // Registration order is the production concern db.ts:127-132 documents: a
  // column migration registered after applySchema leaves the schema DDL
  // referencing a missing column, and the throw escapes openDatabase().
  it('openDatabase() applies it in the registered order on a fresh database', () => {
    const db = openDatabase(':memory:');
    try {
      expect(columnNames(db, 'memories')).toContain('embedding_status');
      expect(
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_sources'")
          .get(),
      ).toBeDefined();
    } finally {
      db.close();
    }
  });
});
