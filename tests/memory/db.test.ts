import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
    const tableNames = rows.map(r => r.name);

    for (const table of EXPECTED_TABLES) {
      expect(tableNames).toContain(table);
    }

    db.close();
  });

  it('creates all required indexes', () => {
    const db = openDatabase(':memory:');
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    const indexNames = rows.map(r => r.name);

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
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
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
