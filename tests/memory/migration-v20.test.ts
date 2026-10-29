/**
 * Migration v20: a searchable page title (I6) and the `to_page_id` index a
 * backlink needs (I5).
 *
 * The two failures this file exists to prevent:
 *
 * 1. v14 created `knowledge_fts_jieba` with `title UNINDEXED`, and there is no
 *    `ALTER` for that flag — so v20 drops and recreates the table. Recreated on
 *    every open it would be a slow boot (and a second writer racing the live
 *    one); not repopulated it would be an empty index. Both are asserted here.
 * 2. `checkConsistency` compares row counts, so the repopulate has to cover
 *    *every* page, not only the active ones: an active-only index reports drift
 *    forever and leaves a page unsearchable after approval.
 */

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateV14 } from '../../src/memory/migration-v14.js';
import { migrateV20 } from '../../src/memory/migration-v20.js';
import { openDatabase } from '../../src/memory/db.js';
import {
  checkConsistency,
  indexKnowledgePage,
  searchKnowledgeIndex,
} from '../../src/memory/knowledge/indexer.js';

/** The v14 shape, without the v20 recreate — the state a real upgrade is in. */
function v14Database(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateV14(db);
  return db;
}

function sqlOf(db: Database.Database, name: string): string {
  const row = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(name) as
    { sql: string | null } | undefined;
  return row?.sql ?? '';
}

function insertPage(
  db: Database.Database,
  page: { id: string; title: string; content: string; status?: string },
): void {
  db.prepare(
    `INSERT INTO knowledge_pages (id, page_type, slug, title, content, status)
     VALUES (?, 'topic', ?, ?, ?, ?)`,
  ).run(page.id, page.id, page.title, page.content, page.status ?? 'active');
}

function indexRowCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS cnt FROM knowledge_fts_jieba').get() as { cnt: number })
    .cnt;
}

describe('migration v20', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('recreates the index with the title indexed and repopulates it', () => {
    db = v14Database();
    insertPage(db, { id: 'p1', title: 'Power Query', content: '正文里没有这个词。' });
    expect(sqlOf(db, 'knowledge_fts_jieba')).toMatch(/title\s+UNINDEXED/i);

    const result = migrateV20(db);

    expect(result).toMatchObject({ rebuiltFts: true, indexedPages: 1 });
    expect(sqlOf(db, 'knowledge_fts_jieba')).not.toMatch(/title\s+UNINDEXED/i);

    // The whole point of I6: the title is searchable on its own. Before v20 this
    // query returned nothing, because the body never repeats the words.
    expect(
      searchKnowledgeIndex(db, 'Power Query', { status: 'active', limit: 10 }).map(
        (hit) => hit.pageId,
      ),
    ).toEqual(['p1']);
  });

  it('indexes a CJK title with the same segmentation the writer uses', () => {
    db = v14Database();
    insertPage(db, { id: 'p1', title: '知识图谱', content: '本体不重复标题。' });

    migrateV20(db);

    expect(
      searchKnowledgeIndex(db, '知识', { status: 'active', limit: 10 }).map((hit) => hit.pageId),
    ).toEqual(['p1']);
  });

  it('repopulates every status, so a pending page is not silently unsearchable', () => {
    db = v14Database();
    insertPage(db, { id: 'live', title: 'Live Page', content: 'x' });
    insertPage(db, { id: 'queued', title: 'Queued Page', content: 'y', status: 'pending' });
    insertPage(db, { id: 'retired', title: 'Retired Page', content: 'z', status: 'archived' });

    const result = migrateV20(db);

    expect(result.indexedPages).toBe(3);
    expect(checkConsistency(db)).toMatchObject({
      pageCount: 3,
      indexedRowCount: 3,
      missingPageIds: [],
      consistent: true,
    });
    // Still a read filter, not a storage one: search never returns the pending row.
    expect(searchKnowledgeIndex(db, 'Queued', { status: 'active', limit: 10 })).toEqual([]);
  });

  it('is a no-op the second time it runs — no duplicate index rows', () => {
    db = v14Database();
    insertPage(db, { id: 'p1', title: 'Power Query', content: '正文' });

    expect(migrateV20(db)).toMatchObject({ rebuiltFts: true, indexedPages: 1 });
    expect(migrateV20(db)).toMatchObject({ rebuiltFts: false, indexedPages: 0 });
    expect(migrateV20(db)).toMatchObject({ rebuiltFts: false, indexedPages: 0 });

    expect(indexRowCount(db)).toBe(1);
    expect(checkConsistency(db).duplicatePageIds).toEqual([]);
  });

  it('leaves a fresh database on the new shape, with nothing to repopulate', () => {
    db = openDatabase(':memory:');

    expect(sqlOf(db, 'knowledge_fts_jieba')).not.toMatch(/title\s+UNINDEXED/i);
    expect(migrateV20(db)).toMatchObject({ rebuiltFts: false, indexedPages: 0 });
    expect(checkConsistency(db).consistent).toBe(true);
  });

  it('keeps rows written by the writer after the recreate', () => {
    db = openDatabase(':memory:');
    db.prepare(
      `INSERT INTO knowledge_pages (id, page_type, slug, title, content, status)
       VALUES ('p1', 'topic', 'pivot', 'Pivot Tables', '数据透视', 'active')`,
    ).run();

    indexKnowledgePage(db, {
      id: 'p1',
      title: 'Kernel Log',
      pageType: 'topic',
      content: '数据透视',
    });

    expect(indexRowCount(db)).toBe(1);
    expect(
      searchKnowledgeIndex(db, 'Kernel', { status: 'active', limit: 10 }).map((hit) => hit.pageId),
    ).toEqual(['p1']);
    expect(searchKnowledgeIndex(db, 'Tables', { status: 'active', limit: 10 })).toEqual([]);
  });

  it('indexes knowledge_links(to_page_id) and leaves the forward direction to the PK', () => {
    db = v14Database();

    const result = migrateV20(db);

    expect(result.createdIndexes).toEqual(['idx_knowledge_links_to']);
    expect(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get('idx_knowledge_links_to'),
    ).toBeDefined();

    const plan = (sql: string) =>
      (db!.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('probe-id') as Array<{ detail: string }>)
        .map((row) => row.detail)
        .join(' ');
    // The reverse read is what the backlink panel does; it used to scan.
    expect(plan('SELECT 1 FROM knowledge_links WHERE to_page_id = ?')).toContain(
      'idx_knowledge_links_to',
    );
    // The forward read is already served by PRIMARY KEY (from_page_id, to_page_id).
    expect(plan('SELECT 1 FROM knowledge_links WHERE from_page_id = ?')).not.toContain('SCAN');
  });

  it('reports the index creation only once', () => {
    db = v14Database();

    expect(migrateV20(db).createdIndexes).toEqual(['idx_knowledge_links_to']);
    expect(migrateV20(db).createdIndexes).toEqual([]);
  });
});
