import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { openDatabase, closeDatabase, getDatabase, resetDatabase } from '../../src/memory/db';
import { applySchema } from '../../src/memory/schema';

describe('openDatabase', () => {
  afterEach(() => {
    closeDatabase();
  });

  it('opens an in-memory database successfully', () => {
    const db = openDatabase(':memory:');
    expect(db).toBeDefined();
    expect(db.open).toBe(true);
    db.close();
  });

  it('enables WAL mode (file-based db)', () => {
    const tmpPath = path.join(os.tmpdir(), `test-wal-${Date.now()}.db`);
    const db = openDatabase(tmpPath);
    const result = db.pragma('journal_mode', { simple: true });
    expect(result).toBe('wal');
    db.close();
    fs.unlinkSync(tmpPath);
  });

  it('WAL pragma is set (memory db returns memory as journal mode)', () => {
    const db = openDatabase(':memory:');
    // :memory: databases cannot use WAL mode; SQLite defaults to 'memory'
    const result = db.pragma('journal_mode', { simple: true });
    expect(result).toBe('memory');
    db.close();
  });

  it('enables foreign keys', () => {
    const db = openDatabase(':memory:');
    const result = db.pragma('foreign_keys', { simple: true });
    expect(result).toBe(1);
    db.close();
  });
});

describe('schema', () => {
  afterEach(() => {
    closeDatabase();
  });

  const EXPECTED_TABLES = [
    'sessions',
    'messages',
    'episodes',
    'memories',
    'memory_embeddings',
    'tool_runs',
    'approval_policies',
    'approval_requests',
    'approval_decisions',
    'schema_version',
  ];

  it('creates all 10 tables', () => {
    const db = openDatabase(':memory:');
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = rows.map((r) => r.name);

    for (const table of EXPECTED_TABLES) {
      expect(tableNames).toContain(table);
    }

    db.close();
  });

  it('creates all required indexes', () => {
    const db = openDatabase(':memory:');
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const indexNames = rows.map((r) => r.name);

    const expectedIndexes = [
      'idx_messages_session',
      'idx_episodes_session',
      'idx_memories_scope',
      'idx_tool_runs_session',
      'idx_approval_policies_scope',
      'idx_approval_requests_session',
      'idx_approval_requests_status',
    ];

    for (const idx of expectedIndexes) {
      expect(indexNames).toContain(idx);
    }

    db.close();
  });

  it('uses CREATE TABLE IF NOT EXISTS (idempotent)', () => {
    const db = openDatabase(':memory:');

    // Running applySchema again should not throw
    expect(() => applySchema(db)).not.toThrow();

    // Verify tables still exist
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>;
    expect(rows.length).toBeGreaterThanOrEqual(10);

    db.close();
  });
});

describe('getDatabase', () => {
  afterEach(() => {
    resetDatabase();
  });

  it('returns a cached connection on subsequent calls', () => {
    const db1 = getDatabase(':memory:');
    const db2 = getDatabase();
    expect(db1).toBe(db2);
  });

  it('throws when first call has no path (no silent :memory: fallback)', () => {
    expect(() => getDatabase()).toThrow(/before initialization/);
  });
});

describe('openDatabase on pre-migration databases (boot-loop regression)', () => {
  // applySchema's index DDL and the memories_fts backfill both reference
  // columns that V2/V3 add. On a database written before those migrations
  // existed, the resulting "no such column" used to escape openDatabase() and
  // abort bootstrap() — so the migrations that would have repaired it were
  // unreachable and the install could never start again.

  let tmpPath: string;

  afterEach(() => {
    closeDatabase();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(tmpPath + suffix, { force: true });
    }
  });

  function createLegacyDb(columns: string[]): void {
    tmpPath = path.join(
      os.tmpdir(),
      `legacy-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    const raw = new Database(tmpPath);
    raw.exec(`CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      ${columns.join(',\n      ')}
    )`);
    raw.exec(`CREATE VIRTUAL TABLE memories_fts USING fts5(
      content, content=memories, content_rowid=rowid,
      tokenize='unicode61 remove_diacritics 2'
    )`);
    raw
      .prepare('INSERT INTO memories (id, scope, scope_key, kind, content) VALUES (?, ?, ?, ?, ?)')
      .run('m1', 'user', 'u1', 'fact', 'the quick brown fox');
    raw.close();
  }

  function columnNames(db: Database.Database, table: string): Set<string> {
    return new Set(
      (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name),
    );
  }

  function indexNames(db: Database.Database): Set<string> {
    return new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
          name: string;
        }>
      ).map((r) => r.name),
    );
  }

  it('boots a database that predates the v2/v3 memories columns', () => {
    createLegacyDb(['metadata TEXT', 'created_at TEXT', 'updated_at TEXT']);

    let db: Database.Database | undefined;
    expect(() => {
      db = openDatabase(tmpPath);
    }).not.toThrow();

    const cols = columnNames(db!, 'memories');
    for (const migrated of ['agent_id', 'visibility', 'status', 'supersedes_id', 'confidence']) {
      expect(cols, `${migrated} should have been added`).toContain(migrated);
    }

    // Indexes over migrated columns must exist, not merely be skipped.
    const indexes = indexNames(db!);
    expect(indexes).toContain('idx_memories_agent');
    expect(indexes).toContain('idx_memories_status');

    // The backfill ran after the migrations rather than throwing before them.
    const ftsCount = db!.prepare('SELECT COUNT(*) as cnt FROM memories_fts').get() as {
      cnt: number;
    };
    expect(ftsCount.cnt).toBe(1);

    db!.close();
  });

  it('still boots when a column no migration ever adds is missing', () => {
    // `memories.updated_at` has no ALTER anywhere, so idx_memories_kind_updated
    // cannot be created on such a row. That costs query speed — it must not
    // cost the ability to start.
    createLegacyDb(['metadata TEXT', 'created_at TEXT']);

    let db: Database.Database | undefined;
    expect(() => {
      db = openDatabase(tmpPath);
    }).not.toThrow();

    expect(indexNames(db!)).not.toContain('idx_memories_kind_updated');
    expect(indexNames(db!)).toContain('idx_memories_status');
    db!.close();
  });

  it('leaves a fresh database fully indexed', () => {
    const db = openDatabase(':memory:');
    const indexes = indexNames(db);
    expect(indexes).toContain('idx_memories_kind_updated');
    expect(indexes).toContain('idx_memories_agent');
    expect(indexes).toContain('idx_memories_status');
    expect(indexes).toContain('idx_sessions_project');
    db.close();
  });
});
