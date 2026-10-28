/**
 * Migration v14: the knowledge layer.
 *
 * v14 is the one table-creating migration of the K1–K4 set, so the invariant is
 * different from v11–v13: nothing pre-existing changes shape. What must hold is
 * that an upgraded database (applySchema already ran, no knowledge tables) ends
 * with exactly the objects a fresh install gets, that a re-run creates nothing,
 * and that the pieces the repository depends on — the closed `page_type`, the
 * `(page_type, slug)` uniqueness, the CASCADE from a page to its sources and
 * links, and a jieba-searchable FTS index with the metadata the search path
 * reads — are actually in place.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateV14 } from '../../src/memory/migration-v14';
import { applySchema } from '../../src/memory/schema';
import { tokenizeForIndex } from '../../src/memory/fts-tokenizer';

/** Creation order as `migrateV14` reports it. */
const V14_OBJECTS = [
  'knowledge_pages',
  'idx_knowledge_pages_slug',
  'idx_knowledge_pages_tag',
  'knowledge_sources',
  'idx_knowledge_sources_lookup',
  'knowledge_links',
  'knowledge_log',
  'idx_knowledge_log_page',
  'knowledge_fts_jieba',
];

describe('migration-v14: knowledge tables + knowledge FTS index', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  function columnNames(table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
  }

  it('creates every object, then reports nothing on a re-run', () => {
    expect(migrateV14(db).created).toEqual(V14_OBJECTS);

    // Idempotent: the second startup creates nothing and keeps rows.
    db.prepare(
      `INSERT INTO knowledge_pages (id, page_type, slug, title, content, created_at, updated_at)
       VALUES ('p1', 'topic', 'power-query', 'Power Query', '正文', 1000, 1000)`,
    ).run();
    expect(migrateV14(db).created).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM knowledge_pages').get()).toEqual({ cnt: 1 });
  });

  it('upgrades a pre-K2 database without touching the existing tables', () => {
    applySchema(db);
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at)
       VALUES ('mem-1', 'user', 'default', 'preference', '偏好 TypeScript', '1000', '1000')`,
    ).run();

    expect(migrateV14(db).created).toEqual(V14_OBJECTS);
    // The next open runs applySchema again, then this migration as a no-op.
    applySchema(db);
    expect(migrateV14(db).created).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM memories').get()).toEqual({ cnt: 1 });
  });

  it('declares the columns the repository and the tools read', () => {
    migrateV14(db);

    expect(columnNames('knowledge_pages')).toEqual([
      'id',
      'page_type',
      'slug',
      'title',
      'content',
      'aliases',
      'tags',
      'confidence',
      'version',
      'status',
      'created_at',
      'updated_at',
      'updated_by',
    ]);
    // `scope` is the memories vocabulary (user/project/session/system); a page
    // kind is deliberately called `page_type` instead.
    expect(columnNames('knowledge_pages')).not.toContain('scope');
    expect(columnNames('knowledge_sources')).toEqual([
      'page_id',
      'source_kind',
      'source_id',
      'created_at',
    ]);
    expect(columnNames('knowledge_links')).toEqual([
      'from_page_id',
      'to_page_id',
      'label',
      'created_at',
    ]);
    expect(columnNames('knowledge_log')).toEqual([
      'id',
      'page_id',
      'action',
      'actor',
      'version',
      'reason',
      'created_at',
    ]);
    expect(columnNames('knowledge_fts_jieba')).toEqual([
      'content',
      'content_original',
      'page_id',
      'title',
      'page_type',
    ]);
  });

  it('applies the documented defaults: version 1, status active', () => {
    migrateV14(db);

    db.prepare(
      `INSERT INTO knowledge_pages (id, page_type, slug, title, content)
       VALUES ('p1', 'decision', 'db-as-truth', 'DB 即真相', '正文')`,
    ).run();

    expect(
      db.prepare('SELECT version, status, created_at FROM knowledge_pages WHERE id = ?').get('p1'),
    ).toEqual({ version: 1, status: 'active', created_at: null });
  });

  it('enforces one page per (page_type, slug)', () => {
    migrateV14(db);
    const insert = db.prepare(
      `INSERT INTO knowledge_pages (id, page_type, slug, title, content)
       VALUES (?, ?, ?, ?, '正文')`,
    );

    insert.run('p1', 'entity', 'power-query', 'Power Query');
    // Same slug under another page type is a different page.
    expect(() => insert.run('p2', 'topic', 'power-query', 'Power Query 主题')).not.toThrow();
    expect(() => insert.run('p3', 'entity', 'power-query', 'Power Query 重复')).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it('cascades a page delete to its sources and links', () => {
    migrateV14(db);
    const insertPage = db.prepare(
      `INSERT INTO knowledge_pages (id, page_type, slug, title, content) VALUES (?, ?, ?, ?, '正文')`,
    );
    insertPage.run('p1', 'project', 'ohmyagent', 'OhMyAgent');
    insertPage.run('p2', 'topic', 'mcp', 'MCP');
    db.prepare(
      `INSERT INTO knowledge_sources (page_id, source_kind, source_id, created_at)
       VALUES ('p1', 'memory', 'mem-1', ?)`,
    ).run(Date.now());
    db.prepare(
      `INSERT INTO knowledge_links (from_page_id, to_page_id, label, created_at)
       VALUES ('p1', 'p2', 'uses', ?)`,
    ).run(Date.now());

    db.prepare("DELETE FROM knowledge_pages WHERE id = 'p1'").run();

    expect(db.prepare('SELECT COUNT(*) AS cnt FROM knowledge_sources').get()).toEqual({ cnt: 0 });
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM knowledge_links').get()).toEqual({ cnt: 0 });
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM knowledge_pages').get()).toEqual({ cnt: 1 });
  });

  it('keeps exactly one FTS row per page and searches the jieba-segmented body', () => {
    migrateV14(db);
    const upsertFts = (pageId: string, body: string): void => {
      // Standalone FTS5 has no unique constraint: delete-then-insert is the only
      // way an update replaces the indexed body (see src/memory/fts.ts).
      db.prepare('DELETE FROM knowledge_fts_jieba WHERE page_id = ?').run(pageId);
      db.prepare(
        `INSERT INTO knowledge_fts_jieba (content, content_original, page_id, title, page_type)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(tokenizeForIndex(body), body, pageId, 'Power Query', 'topic');
    };

    upsertFts('p1', '用 TypeScript 写知识检索');
    upsertFts('p1', '用 TypeScript 写知识检索与导出');

    expect(db.prepare('SELECT COUNT(*) AS cnt FROM knowledge_fts_jieba').get()).toEqual({ cnt: 1 });

    const hits = db
      .prepare(
        'SELECT page_id, content_original, page_type FROM knowledge_fts_jieba WHERE knowledge_fts_jieba MATCH ?',
      )
      .all('"TypeScript" OR "知识"') as Array<{
      page_id: string;
      content_original: string;
      page_type: string;
    }>;
    expect(hits).toEqual([
      { page_id: 'p1', content_original: '用 TypeScript 写知识检索与导出', page_type: 'topic' },
    ]);
  });

  it('appends to knowledge_log and filters it by page, newest first', () => {
    migrateV14(db);
    const insert = db.prepare(
      `INSERT INTO knowledge_log (id, page_id, action, actor, version, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    insert.run('log-1', 'p1', 'create', 'agent', 1, '首次写入', now);
    insert.run('log-2', 'p1', 'update', 'user', 2, '用户修订', now + 1);
    insert.run('log-3', null, 'merge', 'system', null, '实体归一提案', now + 2);

    const rows = db
      .prepare(
        'SELECT id FROM knowledge_log WHERE page_id = ? ORDER BY created_at DESC, id LIMIT 10',
      )
      .all('p1') as Array<{ id: string }>;
    expect(rows.map((row) => row.id)).toEqual(['log-2', 'log-1']);
  });
});
