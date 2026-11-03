/**
 * Migration v38: `sessions.is_placeholder`.
 *
 * Two things have to be true after an in-place upgrade:
 *   - the column exists and matches the shape a fresh install gets (the same
 *     invariant v4/v9/v11/v12 are tested for), and
 *   - the rows earlier releases already wrote are flagged, because that is the
 *     whole point: without the backfill the operator keeps staring at the empty
 *     新会话 / 0 条消息 rows they reported.
 *
 * The backfill is deliberately narrow — untitled IM sessions that hold no
 * messages — and harmless when it over-reaches, because a flagged row that later
 * receives a message is still listed by the repository queries.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrateV38 } from '../../src/memory/migration-v38';
import { applySchema } from '../../src/memory/schema';
import { SessionRepository } from '../../src/memory/repositories/session-repository';
import { ConversationSessions } from '../../src/memory/conversation-sessions';

/** sessions table as written by the release before v38. */
const V37_SESSIONS_DDL = `
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
  archive_exempt_until TEXT,
  created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
  updated_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
  metadata TEXT
)`;

const MESSAGES_DDL = `
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT,
  metadata TEXT
)`;

function legacyDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(V37_SESSIONS_DDL);
  db.exec(MESSAGES_DDL);
  return db;
}

function seed(
  db: Database.Database,
  row: { id: string; chat_id?: string; project_id?: string | null; title?: string | null },
): void {
  db.prepare(
    `INSERT INTO sessions (id, chat_id, user_id, project_id, channel, title)
     VALUES (?, ?, 'u', ?, 'feishu', ?)`,
  ).run(row.id, row.chat_id ?? row.id, row.project_id ?? null, row.title ?? null);
}

function seedMessage(db: Database.Database, sessionId: string): void {
  db.prepare(
    "INSERT INTO messages (id, session_id, role, content) VALUES (?, ?, 'user', 'hi')",
  ).run(`m-${sessionId}`, sessionId);
}

function columnNames(db: Database.Database): string[] {
  const cols = db.pragma('table_info(sessions)') as Array<{ name: string }>;
  return cols.map((c) => c.name).sort();
}

describe('migration-v38: sessions.is_placeholder', () => {
  it('adds the column and reports it as skipped on the next boot', () => {
    const db = legacyDb();
    expect(migrateV38(db).added).toEqual(['is_placeholder']);
    expect(columnNames(db)).toContain('is_placeholder');
    expect(migrateV38(db).added).toEqual([]);
    db.close();
  });

  it('leaves a fresh (no-table) database to applySchema', () => {
    const db = new Database(':memory:');
    expect(migrateV38(db)).toEqual({ added: [], flagged: 0 });
    applySchema(db);
    expect(columnNames(db)).toContain('is_placeholder');
    db.close();
  });

  it('flags the empty untitled IM rows a delete left behind, and nothing else', () => {
    const db = legacyDb();
    // The reported shape: deleting the archived transcript of a chat opens an
    // empty transcript for its slot — untitled, no messages.
    seed(db, { id: 'oc_1~3', chat_id: 'oc_1' });
    seed(db, { id: 'wechat:a~2', chat_id: 'wechat:a' });
    // A conversation with content keeps its place in the list.
    seed(db, { id: 'oc_2' });
    seedMessage(db, 'oc_2');
    // A titled IM conversation is not a placeholder, whatever its message count.
    seed(db, { id: 'oc_3', title: '公众号文案' });
    // Project chats are created by the WebUI on purpose; the flag never applies.
    seed(db, { id: 'p1', project_id: 'proj-1' });

    const result = migrateV38(db);

    expect(result.flagged).toBe(2);
    const flagged = db
      .prepare('SELECT id FROM sessions WHERE is_placeholder = 1 ORDER BY id')
      .all() as Array<{ id: string }>;
    expect(flagged.map((row) => row.id)).toEqual(['oc_1~3', 'wechat:a~2']);
    db.close();
  });

  it('flags nothing once every placeholder row already carries the flag', () => {
    const db = legacyDb();
    seed(db, { id: 'oc_1~3', chat_id: 'oc_1' });
    const first = migrateV38(db);
    expect(first.flagged).toBe(1);
    // Replay: the row is flagged, so the second run is a no-op.
    expect(migrateV38(db).flagged).toBe(0);
    db.close();
  });

  it('hides flagged rows from the inbox until they hold a message', () => {
    const db = legacyDb();
    seed(db, { id: 'oc_1' });
    seed(db, { id: 'oc_1~2', chat_id: 'oc_1' });
    migrateV38(db);
    const repo = new SessionRepository(db);

    // The deleted conversation is gone, the replacement is bookkeeping.
    expect(repo.listInbox({ limit: 10 })).toEqual([]);
    expect(repo.countByChannel()).toEqual([]);

    // The flag is cleared at turn start; even without that, a row with content is
    // never hidden (the query's EXISTS half).
    db.prepare('UPDATE sessions SET is_placeholder = 1 WHERE id = ?').run('oc_1~2');
    seedMessage(db, 'oc_1~2');
    expect(repo.listInbox({ limit: 10 }).map((row) => row.id)).toEqual(['oc_1~2']);

    expect(repo.clearPlaceholder('oc_1~2')).toBe(true);
    expect(repo.clearPlaceholder('oc_1~2')).toBe(false);
    expect(db.prepare('SELECT is_placeholder FROM sessions WHERE id = ?').get('oc_1~2')).toEqual({
      is_placeholder: 0,
    });
    db.close();
  });

  it('keeps a delete-then-message round trip visible, end to end', async () => {
    // The replacement a delete opens is hidden; the chat's next message makes it
    // a conversation again — the flow the operator reported, run to completion.
    const db = new Database(':memory:');
    applySchema(db);
    const conversations = new ConversationSessions(db);
    const repo = new SessionRepository(db);
    const first = conversations.start('oc_9');
    db.prepare(
      "INSERT INTO messages (id, session_id, role, content) VALUES ('m1', ?, 'user', 'x')",
    ).run(first!.id);
    expect(repo.listInbox({ limit: 10 }).map((row) => row.id)).toEqual(['oc_9']);

    const replacement = conversations.forget('oc_9').replacementId!;
    expect(repo.listInbox({ limit: 10 })).toEqual([]);

    conversations.resolve('oc_9');
    db.prepare(
      "INSERT INTO messages (id, session_id, role, content) VALUES ('m2', ?, 'user', 'y')",
    ).run(replacement);
    repo.clearPlaceholder(replacement);

    expect(repo.listInbox({ limit: 10 }).map((row) => row.id)).toEqual([replacement]);
    db.close();
  });
});
