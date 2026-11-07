/**
 * messages_fts_jieba used to be written exactly once — by the migration-v10
 * backfill, and only while the index was empty. Every message created after the
 * first boot was therefore invisible to unified search, silently: `/api/search`
 * returned results, just never the newest ones. These tests pin the write path
 * down at the repository boundary, which is where the drift originated.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema.js';
import { migrateV10 } from '../../src/memory/migration-v10.js';
import { MessageRepository } from '../../src/memory/repositories/message-repository.js';
import { repairMessageJiebaFts } from '../../src/memory/fts.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  migrateV10(db);
  return db;
}

/** messages.session_id is a foreign key (foreign_keys=ON), so the parent row must exist. */
function seedSession(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO sessions (id, chat_id, user_id, channel, created_at, updated_at)
     VALUES (?, ?, 'unknown', 'webui', ?, ?)`,
  ).run(id, id, Date.now(), Date.now());
}

function ftsCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM messages_fts_jieba').get() as { c: number }).c;
}

function ftsRow(db: Database.Database, messageId: string) {
  return db.prepare('SELECT * FROM messages_fts_jieba WHERE message_id = ?').get(messageId) as
    { content: string; content_original: string; session_id: string; role: string } | undefined;
}

describe('message repository keeps messages_fts_jieba current', () => {
  let db: Database.Database;
  let repo: MessageRepository;

  beforeEach(() => {
    db = openTestDb();
    repo = new MessageRepository(db);
    seedSession(db, 's1');
    seedSession(db, 's2');
    seedSession(db, 'other');
  });

  afterEach(() => {
    db.close();
  });

  it('indexes a message on create', () => {
    const msg = repo.create({
      id: 'm1',
      session_id: 's1',
      role: 'user',
      content: '用户喜欢用 Python 处理表格',
    });

    const row = ftsRow(db, 'm1');
    expect(row).toBeDefined();
    expect(row?.content_original).toBe('用户喜欢用 Python 处理表格');
    expect(row?.session_id).toBe('s1');
    expect(row?.role).toBe('user');
    expect(row?.content).toContain('用户');
    expect(msg.id).toBe('m1');
  });

  it('is findable through MATCH after create', () => {
    repo.create({ id: 'm2', session_id: 's1', role: 'user', content: '石景山周末打球' });

    const hits = db
      .prepare('SELECT message_id FROM messages_fts_jieba WHERE messages_fts_jieba MATCH ?')
      .all('"石景山"') as Array<{ message_id: string }>;

    expect(hits.map((h) => h.message_id)).toContain('m2');
  });

  it('replaces the index entry on update instead of duplicating it', () => {
    repo.create({ id: 'm3', session_id: 's1', role: 'user', content: '旧的内容' });
    repo.update('m3', { content: '全新的内容' });

    expect(ftsCount(db)).toBe(1);
    expect(ftsRow(db, 'm3')?.content_original).toBe('全新的内容');
  });

  it('does not reindex when only metadata changes', () => {
    repo.create({ id: 'm4', session_id: 's1', role: 'user', content: '稳定内容' });
    const before = ftsRow(db, 'm4');

    repo.update('m4', { metadata: JSON.stringify({ foo: 'bar' }) });

    expect(ftsRow(db, 'm4')).toEqual(before);
  });

  it('removes the index entry on delete', () => {
    repo.create({ id: 'm5', session_id: 's1', role: 'user', content: '要删除的消息' });
    expect(ftsCount(db)).toBe(1);

    expect(repo.delete('m5')).toBe(true);
    expect(ftsCount(db)).toBe(0);
  });

  it('removes every indexed message of a session', () => {
    repo.create({ id: 'm6', session_id: 's2', role: 'user', content: '一' });
    repo.create({ id: 'm7', session_id: 's2', role: 'assistant', content: '二' });
    repo.create({ id: 'm8', session_id: 'other', role: 'user', content: '三' });
    expect(ftsCount(db)).toBe(3);

    expect(repo.deleteBySessionId('s2')).toBe(2);

    expect(ftsCount(db)).toBe(1);
    expect(ftsRow(db, 'm8')).toBeDefined();
  });

  it('does not index an empty-bodied WebUI card', () => {
    // `approval-*` / `question-*` are UI state in a `messages` row: nothing to
    // tokenise, and an indexed card would make the index disagree with the set
    // of searchable messages the deploy check compares it against.
    repo.create({ id: 'approval-1', session_id: 's1', role: 'assistant', content: '' });
    expect(ftsRow(db, 'approval-1')).toBeUndefined();
    expect(ftsCount(db)).toBe(0);

    // Giving it a body does index it.
    repo.update('approval-1', { content: '批准了这个命令' });
    expect(ftsRow(db, 'approval-1')?.content_original).toBe('批准了这个命令');
    expect(ftsCount(db)).toBe(1);
  });

  it('drops the index entry when a message is emptied', () => {
    repo.create({ id: 'm9', session_id: 's1', role: 'assistant', content: '先有内容' });
    repo.update('m9', { content: '' });
    expect(ftsCount(db)).toBe(0);
  });

  it('upsert replaces the row and keeps exactly one index entry', () => {
    const card = {
      id: 'question-1',
      session_id: 's1',
      role: 'assistant',
      content: '要选哪个？',
      metadata: JSON.stringify({ userQuestion: { status: 'pending' } }),
    };
    repo.upsert(card);
    repo.upsert({ ...card, metadata: JSON.stringify({ userQuestion: { status: 'answered' } }) });

    expect(ftsCount(db)).toBe(1);
    expect(ftsRow(db, 'question-1')?.content_original).toBe('要选哪个？');
  });

  it('indexes the message timestamp as epoch millis, not 0', () => {
    // `messages.created_at` is TEXT and a numeric bind lands as
    // "1793618776783.0"; the old parser read that as 0, so every indexed row
    // lost its time and the search lane had to recover it from `messages`.
    const createdAt = 1793618776783;
    repo.create({
      id: 'ts1',
      session_id: 's1',
      role: 'user',
      content: '带时间戳的消息',
      created_at: createdAt,
    });

    const row = db
      .prepare('SELECT created_at FROM messages_fts_jieba WHERE message_id = ?')
      .get('ts1') as { created_at: string };
    expect(row.created_at).toBe(String(createdAt));
  });

  it('never throws when the FTS table is absent', () => {
    // A fixture (or a pre-v10 database) without messages_fts_jieba must not make
    // every message write fail — the index is an accelerator, not the record.
    const bare = new Database(':memory:');
    bare.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
        tool_call_id TEXT, created_at TEXT,
        metadata TEXT);
    `);
    const bareRepo = new MessageRepository(bare);

    expect(() =>
      bareRepo.create({ id: 'x1', session_id: 's1', role: 'user', content: '你好' }),
    ).not.toThrow();
    expect(bareRepo.findById('x1')?.content).toBe('你好');

    // Second write must be just as quiet (the missing table is memoised).
    expect(() =>
      bareRepo.create({ id: 'x2', session_id: 's1', role: 'user', content: '再见' }),
    ).not.toThrow();

    bare.close();
  });
});

/**
 * migration-v10 backfills only an EMPTY index, and every raw-SQL writer bypassed
 * the hook, so drift had no repair path: the message stayed missing from search
 * forever with no error anywhere. `repairMessageJiebaFts` is that path, run once
 * per boot; the deploy check runs the exact anti-join the count heuristic stands
 * in for.
 */
describe('repairMessageJiebaFts', () => {
  let db: Database.Database;
  let repo: MessageRepository;

  beforeEach(() => {
    db = openTestDb();
    repo = new MessageRepository(db);
    seedSession(db, 's1');
  });

  afterEach(() => {
    db.close();
  });

  /** A writer that bypassed the hook — what the WebUI senders used to be. */
  function insertRaw(id: string, content: string): void {
    db.prepare(
      "INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, 's1', 'user', ?, ?)",
    ).run(id, content, Date.now());
  }

  it('leaves an aligned index alone', () => {
    repo.create({ id: 'a1', session_id: 's1', role: 'user', content: '已经索引过的消息' });

    expect(repairMessageJiebaFts(db)).toEqual({ indexed: 0, pruned: 0, rebuilt: false });
  });

  it('does not count empty-bodied cards as drift', () => {
    repo.create({ id: 'a2', session_id: 's1', role: 'assistant', content: '' });

    expect(repairMessageJiebaFts(db).rebuilt).toBe(false);
  });

  it('indexes a message written by raw SQL', () => {
    insertRaw('a3', '绕过了写入钩子的消息');

    const result = repairMessageJiebaFts(db);

    expect(result.rebuilt).toBe(true);
    expect(result.indexed).toBe(1);
    expect(ftsRow(db, 'a3')).toBeDefined();
    expect(ftsCount(db)).toBe(1);
  });

  it('prunes an index row whose message is gone', () => {
    repo.create({ id: 'a4', session_id: 's1', role: 'user', content: '即将被直接删除' });
    db.prepare("DELETE FROM messages WHERE id = 'a4'").run();

    const result = repairMessageJiebaFts(db);

    expect(result.rebuilt).toBe(true);
    expect(result.pruned).toBe(1);
    expect(ftsCount(db)).toBe(0);
  });

  it('leaves nothing for the deploy check to find', () => {
    // The exact anti-join `deploy-termux.sh check` runs (SEARCHABLE_MESSAGE_SQL).
    const missing = () =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM messages m
             WHERE length(trim(COALESCE(m.content, ''))) > 0
               AND NOT EXISTS (SELECT 1 FROM messages_fts_jieba f WHERE f.message_id = m.id)`,
          )
          .get() as { n: number }
      ).n;

    repo.create({ id: 'a5', session_id: 's1', role: 'user', content: '正常写入' });
    insertRaw('a6', '绕过写入');
    repo.create({ id: 'question-9', session_id: 's1', role: 'assistant', content: '' });
    expect(missing()).toBe(1);

    repairMessageJiebaFts(db);

    expect(missing()).toBe(0);
  });

  it('never throws when the FTS table is absent', () => {
    const bare = new Database(':memory:');
    bare.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT);');

    expect(repairMessageJiebaFts(bare)).toEqual({ indexed: 0, pruned: 0, rebuilt: false });

    bare.close();
  });
});
