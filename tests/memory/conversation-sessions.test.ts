import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  ConversationSessions,
  conversationGeneration,
  conversationSlot,
  isConversationChannel,
  normalizeConversationTitle,
  MAX_CONVERSATION_TITLE_CHARS,
} from '../../src/memory/conversation-sessions.js';

/**
 * The module only needs `sessions`, but `SessionRepository.create` relies on the
 * column defaults declared by the real schema, so the DDL is copied verbatim
 * rather than reduced to a stub that would hide a wrong INSERT.
 */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
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
    )
  `);
  return db;
}

describe('conversation ids', () => {
  it('strips the generation suffix to get the chat slot', () => {
    expect(conversationSlot('oc_abc')).toBe('oc_abc');
    expect(conversationSlot('oc_abc~2')).toBe('oc_abc');
    expect(conversationSlot('oc_abc~17')).toBe('oc_abc');
    expect(conversationSlot('telegram:12345~3')).toBe('telegram:12345');
    // A thread id is part of the slot, not a suffix: `oc_x:t_y~2` → `oc_x:t_y`.
    expect(conversationSlot('oc_x:t_y~2')).toBe('oc_x:t_y');
  });

  it('reads the generation, defaulting to 1', () => {
    expect(conversationGeneration('oc_abc')).toBe(1);
    expect(conversationGeneration('oc_abc~2')).toBe(2);
    expect(conversationGeneration('oc_abc~12')).toBe(12);
    // Malformed suffixes must not produce a generation that shadows a real one.
    expect(conversationGeneration('oc_abc~')).toBe(1);
    expect(conversationGeneration('oc_abc~1')).toBe(1);
    expect(conversationGeneration('oc_abc~x')).toBe(1);
  });

  it('only splits channels whose key is the chat handle', () => {
    expect(isConversationChannel('oc_abc')).toBe(true);
    expect(isConversationChannel('telegram:1')).toBe(true);
    expect(isConversationChannel('wechat:u1')).toBe(true);
    expect(isConversationChannel('qq:group:g1')).toBe(true);
    // WebUI sessions are created by the UI and carry a project in chat_id.
    expect(isConversationChannel('2b7f3d0e-1c4a-4a5f-9c1e-0d9f0a1b2c3d')).toBe(false);
    expect(isConversationChannel('webui:p1')).toBe(false);
    expect(isConversationChannel('cron:job1')).toBe(false);
  });

  it('normalises titles for a single-line row', () => {
    expect(normalizeConversationTitle(undefined)).toBeNull();
    expect(normalizeConversationTitle('   ')).toBeNull();
    expect(normalizeConversationTitle('  公众号文案 ')).toBe('公众号文案');
    expect(normalizeConversationTitle('公众号\n文案\t第一期')).toBe('公众号 文案 第一期');
    const long = 'x'.repeat(MAX_CONVERSATION_TITLE_CHARS + 20);
    expect(normalizeConversationTitle(long)).toHaveLength(MAX_CONVERSATION_TITLE_CHARS);
  });
});

describe('ConversationSessions', () => {
  let db: Database.Database;
  let conversations: ConversationSessions;

  beforeEach(() => {
    db = makeDb();
    conversations = new ConversationSessions(db);
  });

  it('resolves an unknown chat to its own slot', () => {
    expect(conversations.resolve('oc_new')).toBe('oc_new');
  });

  it('leaves non-splitting channels alone without touching the database', () => {
    const id = 'webui:project-1';
    expect(conversations.resolve(id)).toBe(id);
    expect(conversations.start(id)).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('opens ~2 under the same chat_id and resolves to it afterwards', () => {
    const first = conversations.start('oc_chat', {
      title: '公众号文案',
      externalChatId: 'oc_chat',
    });
    expect(first).toMatchObject({ id: 'oc_chat', slot: 'oc_chat', generation: 1 });
    // A chat that never wrote a message starts at the slot itself.
    expect(conversations.resolve('oc_chat')).toBe('oc_chat');

    const second = conversations.start('oc_chat', { title: '第二期' });
    expect(second).toMatchObject({ id: 'oc_chat~2', generation: 2, title: '第二期' });
    expect(conversations.resolve('oc_chat')).toBe('oc_chat~2');

    const row = db
      .prepare('SELECT chat_id, channel, title FROM sessions WHERE id = ?')
      .get('oc_chat~2');
    // chat_id is the slot, which is what makes `resolve` a single lookup.
    expect(row).toEqual({ chat_id: 'oc_chat', channel: 'feishu', title: '第二期' });
  });

  it('keeps a legacy row (id = chat_id) as generation 1 and continues from it', () => {
    db.prepare(
      "INSERT INTO sessions (id, chat_id, user_id, channel) VALUES ('oc_old', 'oc_old', 'u', 'feishu')",
    ).run();
    expect(conversations.resolve('oc_old')).toBe('oc_old');

    const next = conversations.start('oc_old');
    expect(next?.id).toBe('oc_old~2');
    expect(next?.title).toBeNull();
    expect(conversations.resolve('oc_old')).toBe('oc_old~2');
    // Retitling applies to the current transcript, not the retired one.
    expect(conversations.currentTitle('oc_old')).toBeNull();
  });

  it('allocates the next generation from the highest suffix, not the newest row', () => {
    for (const id of ['oc_a', 'oc_a~2', 'oc_a~3']) {
      db.prepare('INSERT INTO sessions (id, chat_id, user_id, channel) VALUES (?, ?, ?, ?)').run(
        id,
        'oc_a',
        'u',
        'telegram',
      );
    }
    // Touch the oldest row so "newest by updated_at" and "highest generation"
    // disagree — the generation must win, or /new would reuse a live id.
    db.prepare(
      "UPDATE sessions SET updated_at = cast(strftime('%s','now') as integer) * 1000 + 1000 WHERE id = 'oc_a'",
    ).run();

    expect(conversations.resolve('oc_a')).toBe('oc_a~3');
    expect(conversations.start('oc_a')?.id).toBe('oc_a~4');
  });

  it('inherits the transport handle and user from the previous transcript', () => {
    conversations.start('telegram:42', { externalChatId: '42' });
    const next = conversations.start('telegram:42');
    const row = db
      .prepare('SELECT user_id, external_chat_id, channel FROM sessions WHERE id = ?')
      .get(next!.id);
    expect(row).toEqual({ user_id: 'unknown', external_chat_id: '42', channel: 'telegram' });
  });

  it('renames the current transcript and rejects empty titles', () => {
    conversations.start('oc_r');
    expect(conversations.rename('oc_r', '改名了')).toBe('改名了');
    expect(conversations.currentTitle('oc_r')).toBe('改名了');
    expect(conversations.rename('oc_r', '   ')).toBeNull();
    // Nothing to rename yet.
    expect(conversations.rename('oc_missing', '标题')).toBeNull();
  });
});
