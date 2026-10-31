/**
 * v10 now declares exactly one object: `messages_fts_jieba`. The entity tables
 * and their indexes went with the graph (v32 drops them from old databases), so
 * this file asserts the FTS half — creation, idempotency, the jieba backfill and
 * the "no jieba dictionary" failure mode — and that the entity tables are gone.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { migrateV10 } from '../../src/memory/migration-v10.js';
import { applySchema } from '../../src/memory/schema.js';

vi.mock('../../src/memory/fts-tokenizer.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/memory/fts-tokenizer.js')>(
    '../../src/memory/fts-tokenizer.js',
  );
  return {
    ...actual,
    isJiebaAvailable: () => true,
    tokenizeForIndex: (text: string) => text.split('').join(' '),
  };
});

describe('migration-v10: messages FTS', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('creates messages_fts_jieba and nothing else', () => {
    const { created } = migrateV10(db);
    expect(created).toEqual(['messages_fts_jieba']);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'entity%'`)
      .all() as Array<{ name: string }>;
    expect(tables).toEqual([]);
  });

  it('is idempotent: a second run creates nothing and keeps rows', () => {
    migrateV10(db);
    db.prepare(
      `INSERT INTO messages_fts_jieba (content, content_original, message_id, session_id, role, created_at)
       VALUES ('a b', 'ab', 'm1', 's1', 'user', 1)`,
    ).run();

    const second = migrateV10(db);
    expect(second.created).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) n FROM messages_fts_jieba').get() as { n: number }).n).toBe(
      1,
    );
  });

  it('backfills the index from messages when it is empty', () => {
    applySchema(db);
    db.prepare(
      `INSERT INTO sessions (id, chat_id, user_id, project_id, created_at, updated_at)
       VALUES ('s1', 'chat-1', 'u1', NULL, 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at) VALUES ('m1','s1','user','你好世界',1)`,
    ).run();

    migrateV10(db);

    const rows = db
      .prepare('SELECT content, content_original, message_id FROM messages_fts_jieba')
      .all() as Array<{ content: string; content_original: string; message_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message_id).toBe('m1');
    expect(rows[0]!.content_original).toBe('你好世界');
  });

  it('boots when the jieba dictionary is unavailable', async () => {
    vi.resetModules();
    vi.doUnmock('../../src/memory/fts-tokenizer.js');
    vi.doMock('../../src/memory/fts-tokenizer.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/memory/fts-tokenizer.js')>(
        '../../src/memory/fts-tokenizer.js',
      );
      return { ...actual, isJiebaAvailable: () => false };
    });

    const fresh = new Database(':memory:');
    const { migrateV10: migrate } = await import('../../src/memory/migration-v10.js');
    expect(() => migrate(fresh)).not.toThrow();
    fresh.close();
    vi.doUnmock('../../src/memory/fts-tokenizer.js');
  });
});
