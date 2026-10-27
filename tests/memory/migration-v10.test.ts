import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateV10 } from '../../src/memory/migration-v10';
import { applySchema } from '../../src/memory/schema';

describe('migration-v10: knowledge-graph tables + messages FTS', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  function tableNames(): string[] {
    return (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
  }

  function indexNames(): string[] {
    return (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
  }

  it('creates the entity tables, their indexes and messages_fts_jieba', () => {
    applySchema(db); // messages table exists in a real database
    const result = migrateV10(db);

    expect(result.created).toEqual(
      expect.arrayContaining([
        'entities',
        'entity_aliases',
        'entity_edges',
        'messages_fts_jieba',
        'idx_entity_aliases_alias',
        'idx_entity_edges_source_relation',
        'idx_entity_edges_target_relation',
        'idx_entity_edges_source_memory',
      ]),
    );
    expect(tableNames()).toEqual(
      expect.arrayContaining(['entities', 'entity_aliases', 'entity_edges', 'messages_fts_jieba']),
    );
    expect(indexNames()).toEqual(
      expect.arrayContaining([
        'idx_entity_aliases_alias',
        'idx_entity_edges_source_relation',
        'idx_entity_edges_target_relation',
        'idx_entity_edges_source_memory',
      ]),
    );
  });

  it('declares the entity columns the repository relies on', () => {
    migrateV10(db);

    const columns = (table: string): string[] =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      );

    expect(columns('entities')).toEqual([
      'id',
      'name',
      'canonical_name',
      'entity_type',
      'description',
      'created_at',
      'updated_at',
    ]);
    expect(columns('entity_aliases')).toEqual(['entity_id', 'alias', 'source', 'created_at']);
    expect(columns('entity_edges')).toEqual([
      'id',
      'source_entity_id',
      'target_entity_id',
      'relation_type',
      'confidence',
      'source_memory_id',
      'source_message_id',
      'valid_from',
      'valid_to',
      'created_at',
    ]);
  });

  it('enforces UNIQUE(canonical_name, entity_type) on entities', () => {
    migrateV10(db);
    const insert = db.prepare(
      'INSERT INTO entities (id, name, canonical_name, entity_type) VALUES (?, ?, ?, ?)',
    );
    insert.run('e1', 'Alice', 'alice', 'person');
    expect(() => insert.run('e2', 'alice', 'alice', 'person')).toThrow(/UNIQUE/);
    // Same canonical name under another type is a different entity.
    expect(() => insert.run('e3', 'Alice', 'alice', 'project')).not.toThrow();
  });

  it('is idempotent: a second run creates nothing and keeps existing rows', () => {
    applySchema(db);
    const first = migrateV10(db);
    expect(first.created.length).toBeGreaterThan(0);

    db.prepare(
      "INSERT INTO entities (id, name, canonical_name, entity_type) VALUES ('e1', 'Alice', 'alice', 'person')",
    ).run();

    const second = migrateV10(db);
    expect(second.created).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM entities').get()).toEqual({ cnt: 1 });
  });

  it('cascades deletes from entities to aliases and edges when foreign keys are on', () => {
    migrateV10(db);
    const now = Date.now();
    db.prepare(
      "INSERT INTO entities (id, name, canonical_name, entity_type) VALUES ('e1', 'Alice', 'alice', 'person')",
    ).run();
    db.prepare(
      "INSERT INTO entities (id, name, canonical_name, entity_type) VALUES ('e2', 'OhMyAgent', 'ohmyagent', 'project')",
    ).run();
    db.prepare(
      "INSERT INTO entity_aliases (entity_id, alias, created_at) VALUES ('e1', 'ally', ?)",
    ).run(now);
    db.prepare(
      `INSERT INTO entity_edges (id, source_entity_id, target_entity_id, relation_type, created_at)
       VALUES ('edge1', 'e1', 'e2', 'works_on', ?)`,
    ).run(now);

    db.prepare("DELETE FROM entities WHERE id = 'e1'").run();

    expect(db.prepare('SELECT COUNT(*) AS cnt FROM entity_aliases').get()).toEqual({ cnt: 0 });
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM entity_edges').get()).toEqual({ cnt: 0 });
  });

  it('backfills messages_fts_jieba from existing messages', () => {
    applySchema(db);
    db.prepare("INSERT INTO sessions (id, chat_id, user_id) VALUES ('s1', 'c1', 'u1')").run();
    const insert = db.prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, 's1', ?, ?, ?)`,
    );
    const now = Date.now();
    insert.run('m1', 'user', '我用 TypeScript 写记忆检索', now);
    insert.run('m2', 'assistant', '数据库设计很重要', now + 1);

    migrateV10(db);

    expect(db.prepare('SELECT COUNT(*) AS cnt FROM messages_fts_jieba').get()).toEqual({ cnt: 2 });
    // jieba segments Chinese, so a segment is searchable as its own token.
    const hits = db
      .prepare(
        'SELECT message_id FROM messages_fts_jieba WHERE messages_fts_jieba MATCH ? ORDER BY message_id',
      )
      .all('"TypeScript" OR "数据库"') as Array<{ message_id: string }>;
    expect(hits.map((hit) => hit.message_id)).toEqual(['m1', 'm2']);
    const original = db
      .prepare("SELECT content_original FROM messages_fts_jieba WHERE message_id = 'm1'")
      .get() as { content_original: string };
    expect(original.content_original).toBe('我用 TypeScript 写记忆检索');
  });

  it('does not re-index messages when messages_fts_jieba is already populated', () => {
    applySchema(db);
    db.prepare("INSERT INTO sessions (id, chat_id, user_id) VALUES ('s1', 'c1', 'u1')").run();
    db.prepare(
      "INSERT INTO messages (id, session_id, role, content) VALUES ('m1', 's1', 'user', 'hello')",
    ).run();

    migrateV10(db);
    migrateV10(db);

    expect(db.prepare('SELECT COUNT(*) AS cnt FROM messages_fts_jieba').get()).toEqual({ cnt: 1 });
  });

  it('starts on a database without a jieba-able messages table', () => {
    // No applySchema: `messages` does not exist yet. The migration must still
    // create its own tables and not throw (a startup failure here bricks boot).
    expect(() => migrateV10(db)).not.toThrow();
    expect(tableNames()).toEqual(
      expect.arrayContaining(['entities', 'entity_aliases', 'entity_edges', 'messages_fts_jieba']),
    );
  });
});
