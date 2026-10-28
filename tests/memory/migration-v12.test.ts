/**
 * Migration v12: `sessions.archive_exempt_until`.
 *
 * Same invariant as v11: an in-place upgrade ends with the schema a fresh install
 * gets, and the upgrade changes no behaviour — every existing row keeps NULL, i.e.
 * "not exempt", so a database that predates auto-archive does not suddenly start
 * protecting rows from it.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrateV12 } from '../../src/memory/migration-v12';
import { applySchema } from '../../src/memory/schema';

/** sessions table as written by the archive release (v11 columns present). */
const V11_SESSIONS_DDL = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  thread_id TEXT,
  user_id TEXT NOT NULL,
  project_id TEXT,
  channel TEXT,
  external_chat_id TEXT,
  title TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
  updated_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
  metadata TEXT
)`;

function columnNames(db: Database.Database, table: string): string[] {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return cols.map((c) => c.name).sort();
}

describe('migration-v12: sessions.archive_exempt_until', () => {
  it('adds the column, then reports it as skipped', () => {
    const db = new Database(':memory:');
    db.exec(V11_SESSIONS_DDL);

    expect(migrateV12(db)).toEqual({ added: ['archive_exempt_until'], skipped: [] });
    expect(columnNames(db, 'sessions')).toContain('archive_exempt_until');
    // Idempotent: a second run must not throw on the duplicate column.
    expect(migrateV12(db)).toEqual({ added: [], skipped: ['archive_exempt_until'] });
    db.close();
  });

  it('leaves existing rows unexempt', () => {
    const db = new Database(':memory:');
    db.exec(V11_SESSIONS_DDL);
    db.prepare(`INSERT INTO sessions (id, chat_id, user_id) VALUES ('s1', 's1', 'u1')`).run();

    migrateV12(db);

    expect(db.prepare('SELECT archive_exempt_until FROM sessions WHERE id = ?').get('s1')).toEqual({
      archive_exempt_until: null,
    });
    db.close();
  });

  it('does nothing on a fresh database, where applySchema declares the column', () => {
    const db = new Database(':memory:');

    expect(migrateV12(db)).toEqual({ added: [], skipped: [] });
    applySchema(db);
    expect(columnNames(db, 'sessions')).toContain('archive_exempt_until');
    db.close();
  });
});
