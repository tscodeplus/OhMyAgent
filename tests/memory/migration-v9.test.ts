/**
 * Migration v9: sessions.channel / external_chat_id / title.
 *
 * The invariant under test is that a database upgraded in place ends up with
 * exactly the schema a fresh install gets, and that the backfill fills the new
 * columns once (idempotent on every later startup).
 *
 * The last describe block covers the repository queries that read the new
 * columns (listInbox / countByChannel) — they live here because that is where
 * the v9 columns are created and seeded.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateV9 } from '../../src/memory/migration-v9';
import { migrateV11 } from '../../src/memory/migration-v11';
import { migrateV12 } from '../../src/memory/migration-v12';
import { applySchema } from '../../src/memory/schema';
import { openDatabase } from '../../src/memory/db';
import { SessionRepository } from '../../src/memory/repositories/session-repository';

/** sessions table as written by releases before v9 (project_id comes from v4). */
const LEGACY_SESSIONS_DDL = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  thread_id TEXT,
  user_id TEXT NOT NULL,
  project_id TEXT,
  created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
  updated_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
  metadata TEXT
)`;

interface LegacySessionRow {
  id: string;
  chat_id?: string;
  user_id?: string;
  project_id?: string | null;
  metadata?: string | null;
  updated_at?: string;
}

function insertLegacySession(db: Database.Database, row: LegacySessionRow): void {
  db.prepare(
    `INSERT INTO sessions (id, chat_id, user_id, project_id, metadata, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.chat_id ?? row.id,
    row.user_id ?? 'unknown',
    row.project_id ?? null,
    row.metadata ?? null,
    row.updated_at ?? String(Date.now()),
  );
}

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

function sessionRow(db: Database.Database, id: string) {
  return db
    .prepare('SELECT channel, external_chat_id, title FROM sessions WHERE id = ?')
    .get(id) as
    { channel: string | null; external_chat_id: string | null; title: string | null } | undefined;
}

describe('migration-v9: schema', () => {
  let migrated: Database.Database;
  let fresh: Database.Database;

  beforeEach(() => {
    migrated = new Database(':memory:');
    migrated.exec(LEGACY_SESSIONS_DDL);
    // openDatabase runs every column-adding migration in order; v11 adds
    // `archived_at`, which the fresh schema (compared below) also declares.
    migrateV9(migrated);
    migrateV11(migrated);
    // Later sessions migrations run too, so this compares against the schema the
    // current version actually produces on a fresh install.
    migrateV12(migrated);

    fresh = new Database(':memory:');
    applySchema(fresh);
  });

  afterEach(() => {
    migrated.close();
    fresh.close();
  });

  it('a migrated sessions table has the same column set as a fresh one', () => {
    expect(columnNames(migrated, 'sessions')).toEqual(columnNames(fresh, 'sessions'));
    expect(columnNames(migrated, 'sessions')).toEqual(
      expect.arrayContaining(['channel', 'external_chat_id', 'title']),
    );
  });

  it('creates idx_sessions_channel_updated, like a fresh database', () => {
    expect(indexNames(migrated, 'sessions')).toContain('idx_sessions_channel_updated');
    expect(indexNames(fresh, 'sessions')).toContain('idx_sessions_channel_updated');
  });

  it('reports added then skipped columns and is idempotent on a second run', () => {
    const db = new Database(':memory:');
    db.exec(LEGACY_SESSIONS_DDL);

    expect(migrateV9(db)).toEqual({
      added: ['channel', 'external_chat_id', 'title'],
      skipped: [],
      backfilled: 0,
    });
    expect(migrateV9(db)).toEqual({
      added: [],
      skipped: ['channel', 'external_chat_id', 'title'],
      backfilled: 0,
    });
    db.close();
  });

  it('leaves a fresh (no-table) database to applySchema', () => {
    const db = new Database(':memory:');
    expect(migrateV9(db)).toEqual({ added: [], skipped: [], backfilled: 0 });
    db.close();
  });
});

describe('migration-v9: backfill', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(LEGACY_SESSIONS_DDL);
  });

  afterEach(() => {
    db.close();
  });

  it('copies metadata.title into the title column', () => {
    insertLegacySession(db, { id: 'oc_a', metadata: JSON.stringify({ title: '账单讨论' }) });
    insertLegacySession(db, { id: 'oc_b', metadata: JSON.stringify({ title: 'Standup' }) });
    // No title in metadata → stays NULL.
    insertLegacySession(db, { id: 'oc_c', metadata: JSON.stringify({ other: 1 }) });
    // Malformed JSON → skipped, not thrown.
    insertLegacySession(db, { id: 'oc_d', metadata: '{not json' });
    // Non-string title → skipped.
    insertLegacySession(db, { id: 'oc_e', metadata: JSON.stringify({ title: 42 }) });
    // NULL metadata → skipped.
    insertLegacySession(db, { id: 'oc_f', metadata: null });

    const result = migrateV9(db);

    expect(sessionRow(db, 'oc_a')?.title).toBe('账单讨论');
    expect(sessionRow(db, 'oc_b')?.title).toBe('Standup');
    for (const id of ['oc_c', 'oc_d', 'oc_e', 'oc_f']) {
      expect(sessionRow(db, id)?.title).toBeNull();
    }
    expect(result.backfilled).toBeGreaterThanOrEqual(2);
  });

  it('infers the channel from the session id / chat_id', () => {
    insertLegacySession(db, { id: 'oc_5f1e2d3c4b5a6978' });
    insertLegacySession(db, { id: 'telegram:123456' });
    insertLegacySession(db, { id: 'wechat:wxid_abc' });
    insertLegacySession(db, { id: 'qq:10001' });
    insertLegacySession(db, { id: 'cron:daily-report' });
    insertLegacySession(db, {
      id: '3d1c9a1e-1f2b-4c5d-8e9f-0a1b2c3d4e5f',
      chat_id: 'webui:proj-1',
      project_id: 'proj-1',
    });
    insertLegacySession(db, { id: 'mystery-session' });

    migrateV9(db);

    expect(sessionRow(db, 'oc_5f1e2d3c4b5a6978')?.channel).toBe('feishu');
    expect(sessionRow(db, 'telegram:123456')?.channel).toBe('telegram');
    expect(sessionRow(db, 'wechat:wxid_abc')?.channel).toBe('wechat');
    expect(sessionRow(db, 'qq:10001')?.channel).toBe('qq');
    expect(sessionRow(db, 'cron:daily-report')?.channel).toBe('cron');
    expect(sessionRow(db, '3d1c9a1e-1f2b-4c5d-8e9f-0a1b2c3d4e5f')?.channel).toBe('webui');
    expect(sessionRow(db, 'mystery-session')?.channel).toBe('unknown');
  });

  it('copies chat_id into external_chat_id for IM channels only', () => {
    insertLegacySession(db, { id: 'telegram:123456', chat_id: 'telegram:123456' });
    insertLegacySession(db, { id: 'oc_5f1e2d3c4b5a6978', chat_id: 'oc_5f1e2d3c4b5a6978:om_1' });
    insertLegacySession(db, {
      id: '3d1c9a1e-1f2b-4c5d-8e9f-0a1b2c3d4e5f',
      chat_id: 'webui:proj-1',
      project_id: 'proj-1',
    });
    insertLegacySession(db, { id: 'mystery-session', chat_id: 'mystery-session' });

    migrateV9(db);

    expect(sessionRow(db, 'telegram:123456')?.external_chat_id).toBe('telegram:123456');
    expect(sessionRow(db, 'oc_5f1e2d3c4b5a6978')?.external_chat_id).toBe(
      'oc_5f1e2d3c4b5a6978:om_1',
    );
    // The WebUI chat_id is a synthetic marker, not an external chat.
    expect(sessionRow(db, '3d1c9a1e-1f2b-4c5d-8e9f-0a1b2c3d4e5f')?.external_chat_id).toBeNull();
    expect(sessionRow(db, 'mystery-session')?.external_chat_id).toBeNull();
  });

  it('does not overwrite values that are already set', () => {
    db.exec('ALTER TABLE sessions ADD COLUMN channel TEXT');
    db.exec('ALTER TABLE sessions ADD COLUMN external_chat_id TEXT');
    db.exec('ALTER TABLE sessions ADD COLUMN title TEXT');
    insertLegacySession(db, { id: 'telegram:123456', metadata: JSON.stringify({ title: 'old' }) });
    db.prepare('UPDATE sessions SET channel = ?, external_chat_id = ?, title = ? WHERE id = ?').run(
      'feishu',
      'manual-chat',
      'manual-title',
      'telegram:123456',
    );

    const result = migrateV9(db);

    expect(sessionRow(db, 'telegram:123456')).toEqual({
      channel: 'feishu',
      external_chat_id: 'manual-chat',
      title: 'manual-title',
    });
    expect(result.backfilled).toBe(0);
  });

  it('backfills once — a second run writes nothing', () => {
    insertLegacySession(db, { id: 'telegram:123456', metadata: JSON.stringify({ title: 'hi' }) });

    expect(migrateV9(db).backfilled).toBe(3); // title + channel + external_chat_id
    expect(migrateV9(db).backfilled).toBe(0);
    expect(sessionRow(db, 'telegram:123456')).toEqual({
      channel: 'telegram',
      external_chat_id: 'telegram:123456',
      title: 'hi',
    });
  });
});

describe('migration-v9: openDatabase ordering', () => {
  it('upgrades a pre-v9 database file without applySchema failing on the new index', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-v9-'));
    const dbPath = path.join(tmpDir, 'legacy.db');
    try {
      const legacy = new Database(dbPath);
      legacy.exec(LEGACY_SESSIONS_DDL);
      insertLegacySession(legacy, {
        id: 'telegram:123456',
        metadata: JSON.stringify({ title: 'Legacy chat' }),
      });
      legacy.close();

      const db = openDatabase(dbPath);
      try {
        expect(columnNames(db, 'sessions')).toEqual(
          expect.arrayContaining(['channel', 'external_chat_id', 'title']),
        );
        expect(indexNames(db, 'sessions')).toContain('idx_sessions_channel_updated');
        expect(sessionRow(db, 'telegram:123456')).toEqual({
          channel: 'telegram',
          external_chat_id: 'telegram:123456',
          title: 'Legacy chat',
        });
        // The index is actually usable (a failed CREATE INDEX would be silent).
        const plan = db
          .prepare(
            'EXPLAIN QUERY PLAN SELECT id FROM sessions WHERE channel = ? ORDER BY updated_at DESC',
          )
          .all('telegram') as Array<{ detail: string }>;
        expect(plan.map((p) => p.detail).join(' ')).toContain('idx_sessions_channel_updated');
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('SessionRepository inbox queries (v9 columns)', () => {
  let db: Database.Database;
  let repo: SessionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    repo = new SessionRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedMessage(id: string, sessionId: string, content: string, createdAt: number): void {
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, sessionId, 'user', content, createdAt);
  }

  it('lists only sessions without a project, newest activity first', () => {
    repo.create({ id: 'telegram:1', chat_id: 'telegram:1', user_id: 'u', channel: 'telegram' });
    repo.create({
      id: 'proj-session',
      chat_id: 'webui:proj-1',
      user_id: 'webui-user',
      channel: 'webui',
    });
    repo.create({ id: 'oc_1', chat_id: 'oc_1', user_id: 'u', channel: 'feishu' });
    db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run('proj-1', 'proj-session');
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run('2000', 'telegram:1');
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run('1000', 'oc_1');

    const rows = repo.listInbox({ limit: 10 });

    expect(rows.map((r) => r.id)).toEqual(['telegram:1', 'oc_1']);
  });

  it('returns message_count and a 120-char preview of the newest message', () => {
    repo.create({ id: 'qq:1', chat_id: 'qq:1', user_id: 'u', channel: 'qq', title: 'Group chat' });
    seedMessage('m1', 'qq:1', 'oldest', 1000);
    seedMessage('m2', 'qq:1', 'newest', 2000);
    const long = 'x'.repeat(200);
    seedMessage('m3', 'qq:1', long, 3000);

    const [row] = repo.listInbox({ limit: 10 });

    expect(row.message_count).toBe(3);
    expect(row.preview).toBe('x'.repeat(120));
    expect(row.title).toBe('Group chat');
    expect(row.channel).toBe('qq');
  });

  it('returns an empty preview for a session with no messages', () => {
    repo.create({ id: 'qq:2', chat_id: 'qq:2', user_id: 'u', channel: 'qq' });

    const [row] = repo.listInbox({ limit: 10 });

    expect(row.message_count).toBe(0);
    expect(row.preview).toBe('');
  });

  it('filters by channel and pages with the updated_at cursor', () => {
    repo.create({ id: 'telegram:1', chat_id: 'telegram:1', user_id: 'u', channel: 'telegram' });
    repo.create({ id: 'telegram:2', chat_id: 'telegram:2', user_id: 'u', channel: 'telegram' });
    repo.create({ id: 'oc_1', chat_id: 'oc_1', user_id: 'u', channel: 'feishu' });
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run('3000', 'telegram:1');
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run('2000', 'telegram:2');
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run('1000', 'oc_1');

    expect(repo.listInbox({ channel: 'telegram', limit: 10 }).map((r) => r.id)).toEqual([
      'telegram:1',
      'telegram:2',
    ]);

    const firstPage = repo.listInbox({ limit: 2 });
    expect(firstPage.map((r) => r.id)).toEqual(['telegram:1', 'telegram:2']);
    const nextPage = repo.listInbox({ limit: 2, before: Number(firstPage[1].updated_at) });
    expect(nextPage.map((r) => r.id)).toEqual(['oc_1']);
  });

  it('counts sessions per channel, excluding project sessions', () => {
    repo.create({ id: 'telegram:1', chat_id: 'telegram:1', user_id: 'u', channel: 'telegram' });
    repo.create({ id: 'telegram:2', chat_id: 'telegram:2', user_id: 'u', channel: 'telegram' });
    repo.create({ id: 'oc_1', chat_id: 'oc_1', user_id: 'u', channel: 'feishu' });
    repo.create({
      id: 'proj-session',
      chat_id: 'webui:p',
      user_id: 'webui-user',
      channel: 'webui',
    });
    db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run('p', 'proj-session');

    expect(repo.countByChannel()).toEqual([
      { channel: 'telegram', count: 2 },
      { channel: 'feishu', count: 1 },
    ]);
  });

  it('setChannelIfMissing writes once and keeps updated_at untouched', () => {
    repo.create({ id: 'legacy', chat_id: 'legacy', user_id: 'u' });
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run('1234', 'legacy');

    repo.setChannelIfMissing('legacy', 'telegram', 'telegram:9');
    const after = repo.findById('legacy')!;
    expect(after.channel).toBe('telegram');
    expect(after.external_chat_id).toBe('telegram:9');
    expect(String(after.updated_at)).toBe('1234');

    repo.setChannelIfMissing('legacy', 'feishu', 'oc_override');
    expect(repo.findById('legacy')!.channel).toBe('telegram');
    expect(repo.findById('legacy')!.external_chat_id).toBe('telegram:9');
  });

  it('setTitle writes the title column', () => {
    repo.create({ id: 'oc_1', chat_id: 'oc_1', user_id: 'u', channel: 'feishu' });

    repo.setTitle('oc_1', 'Auto title');

    expect(repo.findById('oc_1')!.title).toBe('Auto title');
  });
});
