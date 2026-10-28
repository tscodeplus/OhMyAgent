/**
 * Migration v11: `sessions.archived_at`.
 *
 * The invariant is the same as v4/v9: a database upgraded in place ends up with
 * exactly the schema (and index) a fresh install gets — and, crucially, the
 * upgrade archives nothing. Every existing row keeps `archived_at IS NULL`, so
 * an operator who upgrades does not find their whole history moved into 归档.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrateV11 } from '../../src/memory/migration-v11';
import { migrateV12 } from '../../src/memory/migration-v12';
import { applySchema } from '../../src/memory/schema';
import { SessionRepository } from '../../src/memory/repositories/session-repository';

/** sessions table as written by releases before v11 (v9 columns present). */
const V10_SESSIONS_DDL = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  thread_id TEXT,
  user_id TEXT NOT NULL,
  project_id TEXT,
  channel TEXT,
  external_chat_id TEXT,
  title TEXT,
  created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
  updated_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
  metadata TEXT
)`;

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

describe('migration-v11: sessions.archived_at', () => {
  it('adds the column and the index, then reports them as skipped', () => {
    const db = new Database(':memory:');
    db.exec(V10_SESSIONS_DDL);

    expect(migrateV11(db)).toEqual({ added: ['archived_at'], skipped: [] });
    expect(columnNames(db, 'sessions')).toContain('archived_at');
    expect(indexNames(db, 'sessions')).toContain('idx_sessions_archived');

    // Every later startup hits the idempotent path.
    expect(migrateV11(db)).toEqual({ added: [], skipped: ['archived_at'] });
    db.close();
  });

  it('archives nothing — existing rows stay active', () => {
    const db = new Database(':memory:');
    db.exec(V10_SESSIONS_DDL);
    db.prepare(
      `INSERT INTO sessions (id, chat_id, user_id, channel, created_at, updated_at)
       VALUES ('oc_1', 'oc_1', 'unknown', 'feishu', '1000', '1000')`,
    ).run();

    migrateV11(db);

    expect(db.prepare('SELECT archived_at FROM sessions WHERE id = ?').get('oc_1')).toEqual({
      archived_at: null,
    });
    db.close();
  });

  it('a migrated table has the same column set as a fresh one', () => {
    const migratedDb = new Database(':memory:');
    migratedDb.exec(V10_SESSIONS_DDL);
    migrateV11(migratedDb);
    // The later sessions migration, so the comparison is against the full chain
    // and not against a schema this version no longer produces.
    migrateV12(migratedDb);

    const freshDb = new Database(':memory:');
    applySchema(freshDb);

    expect(columnNames(migratedDb, 'sessions')).toEqual(columnNames(freshDb, 'sessions'));
    expect(indexNames(migratedDb, 'sessions')).toContain('idx_sessions_archived');
    expect(indexNames(freshDb, 'sessions')).toContain('idx_sessions_archived');

    migratedDb.close();
    freshDb.close();
  });

  it('is a no-op on a database whose sessions table is empty/uncreated', () => {
    const db = new Database(':memory:');
    // No table at all: the fresh path, where applySchema creates everything.
    expect(migrateV11(db)).toEqual({ added: [], skipped: [] });
    db.close();
  });
});

describe('SessionRepository archive queries', () => {
  function openSeeded(): { db: Database.Database; repo: SessionRepository } {
    const db = new Database(':memory:');
    applySchema(db);
    db.prepare(
      `INSERT INTO projects (id, name, agent_id) VALUES ('proj-1', 'OMA 开发', 'default')`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO sessions (id, chat_id, user_id, project_id, channel, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('p1', 'webui:proj-1', 'webui-user', 'proj-1', null, '上下文压缩', '1000', '1000');
    insert.run('p2', 'webui:proj-1', 'webui-user', 'proj-1', null, '记忆检索', '2000', '2000');
    insert.run('oc_1', 'oc_1', 'unknown', null, 'feishu', '公众号文案', '3000', '3000');
    insert.run('tg_1', 'tg_1', 'unknown', null, 'telegram', null, '4000', '4000');
    return { db, repo: new SessionRepository(db) };
  }

  it('hides archived rows from the inbox and counts them out of the channel badges', () => {
    const { db, repo } = openSeeded();
    repo.setArchived(['oc_1'], true);

    expect(repo.listInbox({ limit: 10 }).map((row) => row.id)).toEqual(['tg_1']);
    expect(repo.countByChannel()).toEqual([{ channel: 'telegram', count: 1 }]);
    // Opt-in path, for tooling that wants the full picture.
    expect(repo.listInbox({ limit: 10, includeArchived: true })).toHaveLength(2);
    expect(repo.countByChannel({ includeArchived: true })).toEqual(
      expect.arrayContaining([{ channel: 'feishu', count: 1 }]),
    );
    db.close();
  });

  it('reports how many rows a batch actually changed', () => {
    const { db, repo } = openSeeded();

    expect(repo.setArchived(['p1', 'p2'], true)).toBe(2);
    // Re-archiving is a no-op, not a failure: only the new row counts.
    expect(repo.setArchived(['p1', 'oc_1'], true)).toBe(1);
    expect(repo.setArchived(['p1', 'oc_1'], false)).toBe(2);
    expect(repo.setArchived(['p1'], false)).toBe(0);
    expect(repo.setArchived([], true)).toBe(0);
    db.close();
  });

  it('does not bump updated_at when archiving', () => {
    const { db, repo } = openSeeded();
    repo.setArchived(['p1'], true);
    expect(db.prepare('SELECT updated_at FROM sessions WHERE id = ?').get('p1')).toEqual({
      updated_at: '1000',
    });
    db.close();
  });

  it('lists archived rows by last activity, carrying the pre-archive owner', () => {
    const { db, repo } = openSeeded();
    repo.setArchived(['p1', 'oc_1'], true);
    // Archive instants contradict activity order (p1 was archived later but was
    // last active earlier), so this only passes if the sort is by `updated_at`.
    db.prepare("UPDATE sessions SET archived_at = '6000' WHERE id = 'p1'").run();
    db.prepare("UPDATE sessions SET archived_at = '5000' WHERE id = 'oc_1'").run();

    const rows = repo.listArchived({ limit: 10 });
    expect(rows.map((row) => row.id)).toEqual(['oc_1', 'p1']);
    expect(rows[0]).toMatchObject({
      kind: 'inbox',
      project_id: null,
      channel: 'feishu',
      archived_at: 5000,
      updated_at: 3000,
    });
    expect(rows[1]).toMatchObject({
      kind: 'project',
      project_id: 'proj-1',
      project_name: 'OMA 开发',
      channel: null,
      archived_at: 6000,
      updated_at: 1000,
    });

    // The cursor is exclusive on `updated_at`, the field the list is ordered by.
    expect(repo.listArchived({ limit: 10, before: 3000 }).map((row) => row.id)).toEqual(['p1']);
    db.close();
  });

  it('groups archive counts by the owner the row came from', () => {
    const { db, repo } = openSeeded();
    repo.setArchived(['p1', 'p2', 'oc_1'], true);

    expect(repo.countArchivedByOwner()).toEqual(
      expect.arrayContaining([
        {
          kind: 'project',
          project_id: 'proj-1',
          project_name: 'OMA 开发',
          channel: null,
          count: 2,
        },
        { kind: 'inbox', project_id: null, project_name: null, channel: 'feishu', count: 1 },
      ]),
    );
    expect(repo.countArchivedByOwner()).toHaveLength(2);
    db.close();
  });

  it('clearArchive restores one row without touching updated_at', () => {
    const { db, repo } = openSeeded();
    repo.setArchived(['oc_1'], true);

    expect(repo.clearArchive('oc_1')).toBe(true);
    // Already active — nothing to change.
    expect(repo.clearArchive('oc_1')).toBe(false);
    // Newest activity first, which is `updated_at`, not the archive order.
    expect(repo.listInbox({ limit: 10 }).map((row) => row.id)).toEqual(['tg_1', 'oc_1']);
    expect(db.prepare('SELECT updated_at FROM sessions WHERE id = ?').get('oc_1')).toEqual({
      updated_at: '3000',
    });
    db.close();
  });
});
