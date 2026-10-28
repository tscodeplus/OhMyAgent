/**
 * `knowledge_fts_jieba` maintenance.
 *
 * The failure this file exists to prevent: `knowledge_fts_jieba` is a
 * *standalone* FTS5 table with no unique constraint, so an INSERT-only update
 * path leaves the superseded body searchable and `knowledge_search` starts
 * returning text that no page contains any more. Hence "delete by page_id, then
 * insert", and hence the one-row-per-page assertion on every write.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import {
  buildSnippet,
  checkConsistency,
  indexKnowledgePage,
  rebuild,
  searchKnowledgeIndex,
} from '../../src/memory/knowledge/indexer.js';
import { KnowledgeRepository } from '../../src/memory/knowledge/repository.js';
import { openSeededDatabase, TWO_MEMORY_SOURCES } from './fixtures.js';

describe('knowledge index', () => {
  let db: Database.Database;
  let repository: KnowledgeRepository;

  beforeEach(() => {
    db = openSeededDatabase();
    repository = new KnowledgeRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function insertPage(slug: string, content: string, status: 'active' | 'pending' = 'active') {
    const result = repository.insertPage(
      {
        pageType: 'topic',
        slug,
        title: slug,
        content,
        sources: TWO_MEMORY_SOURCES,
        status,
        updatedBy: 'agent',
      },
      'agent',
    );
    if (!result.ok) throw new Error(`insert failed: ${result.code}`);
    return result.page;
  }

  function ftsRows(pageId: string): Array<{ content: string; content_original: string }> {
    return db
      .prepare('SELECT content, content_original FROM knowledge_fts_jieba WHERE page_id = ?')
      .all(pageId) as Array<{ content: string; content_original: string }>;
  }

  it('keeps exactly one FTS row per page across repeated writes', () => {
    const page = insertPage('excel-etl', 'Power Query replaces manual VLOOKUP');
    expect(ftsRows(page.id)).toHaveLength(1);

    indexKnowledgePage(db, {
      id: page.id,
      title: page.title,
      pageType: 'topic',
      content: 'Pivot tables replace manual VLOOKUP',
    });
    indexKnowledgePage(db, {
      id: page.id,
      title: page.title,
      pageType: 'topic',
      content: 'Pivot tables replace manual VLOOKUP',
    });

    expect(ftsRows(page.id)).toHaveLength(1);
  });

  it('does not keep the superseded body searchable', () => {
    const page = insertPage('excel-etl', 'Power Query replaces manual VLOOKUP');

    expect(
      searchKnowledgeIndex(db, 'VLOOKUP', { status: 'active', limit: 10 }).map((hit) => hit.pageId),
    ).toEqual([page.id]);

    indexKnowledgePage(db, {
      id: page.id,
      title: page.title,
      pageType: 'topic',
      content: 'Pivot tables only',
    });

    expect(searchKnowledgeIndex(db, 'VLOOKUP', { status: 'active', limit: 10 })).toEqual([]);
    expect(
      searchKnowledgeIndex(db, 'pivot', { status: 'active', limit: 10 }).map((hit) => hit.pageId),
    ).toEqual([page.id]);
  });

  it('indexes the jieba-segmented body but preserves the original for snippets', () => {
    const page = insertPage('zh-page', '知识图谱把实体连接起来');
    const [row] = ftsRows(page.id);

    expect(row.content_original).toBe('知识图谱把实体连接起来');
    // Segmented column: whitespace-joined tokens, not the raw sentence.
    expect(row.content.includes(' ')).toBe(true);
    expect(row.content).not.toBe(row.content_original);
  });

  it('filters by status in SQL, so a pending page is never returned', () => {
    const active = insertPage('visible', 'shared topic about pipelines');
    insertPage('hidden', 'shared topic about pipelines', 'pending');

    const hits = searchKnowledgeIndex(db, 'pipelines', { status: 'active', limit: 10 });
    expect(hits.map((hit) => hit.pageId)).toEqual([active.id]);

    const pendingHits = searchKnowledgeIndex(db, 'pipelines', { status: 'pending', limit: 10 });
    expect(pendingHits).toHaveLength(1);
  });

  it('filters by page type and tag', () => {
    repository.insertPage(
      {
        pageType: 'entity',
        slug: 'power-query',
        title: 'Power Query',
        content: 'Power Query is an ETL tool',
        tags: ['excel', 'etl'],
        sources: TWO_MEMORY_SOURCES,
        status: 'active',
        updatedBy: 'agent',
      },
      'agent',
    );
    insertPage('excel-etl', 'Power Query is an ETL tool');

    expect(
      searchKnowledgeIndex(db, 'power query', { status: 'active', pageType: 'entity', limit: 10 }),
    ).toHaveLength(1);
    expect(
      searchKnowledgeIndex(db, 'power query', { status: 'active', tag: 'etl', limit: 10 }),
    ).toHaveLength(1);
    expect(
      searchKnowledgeIndex(db, 'power query', { status: 'active', tag: 'nope', limit: 10 }),
    ).toEqual([]);
  });

  it('treats a malformed query as no results instead of throwing', () => {
    insertPage('any', 'anything');
    expect(() =>
      searchKnowledgeIndex(db, 'AND OR "', { status: 'active', limit: 5 }),
    ).not.toThrow();
    expect(searchKnowledgeIndex(db, '', { status: 'active', limit: 5 })).toEqual([]);
  });

  describe('checkConsistency', () => {
    it('reports a healthy index', () => {
      insertPage('one', 'first body');
      insertPage('two', 'second body');

      const report = checkConsistency(db);
      expect(report).toMatchObject({
        pageCount: 2,
        indexedRowCount: 2,
        duplicatePageIds: [],
        missingPageIds: [],
        orphanPageIds: [],
        consistent: true,
      });
    });

    it('counts rows, not just row totals — a duplicate and a miss cancel out', () => {
      const page = insertPage('one', 'first body');
      insertPage('two', 'second body');

      // Duplicate one page, drop another: COUNT(*) still matches pageCount.
      db.prepare(
        `INSERT INTO knowledge_fts_jieba (content, content_original, page_id, title, page_type)
         VALUES ('x', 'x', ?, 'one', 'topic')`,
      ).run(page.id);
      db.prepare(
        "DELETE FROM knowledge_fts_jieba WHERE page_id = (SELECT id FROM knowledge_pages WHERE slug = 'two')",
      ).run();

      const report = checkConsistency(db);
      expect(report.indexedRowCount).toBe(report.pageCount);
      expect(report.duplicatePageIds).toEqual([page.id]);
      expect(report.missingPageIds).toHaveLength(1);
      expect(report.consistent).toBe(false);
    });

    it('reports index rows whose page is gone', () => {
      db.prepare(
        `INSERT INTO knowledge_fts_jieba (content, content_original, page_id, title, page_type)
         VALUES ('ghost', 'ghost', 'no-such-page', 'ghost', 'topic')`,
      ).run();

      expect(checkConsistency(db).orphanPageIds).toEqual(['no-such-page']);
    });
  });

  it('rebuilds the index from the page table', () => {
    const page = insertPage('one', 'first body');
    insertPage('two', 'second body');

    db.prepare('DELETE FROM knowledge_fts_jieba').run();
    expect(checkConsistency(db).missingPageIds).toHaveLength(2);

    expect(rebuild(db)).toEqual({ pages: 2 });
    expect(checkConsistency(db).consistent).toBe(true);
    expect(ftsRows(page.id)).toHaveLength(1);
  });
});

describe('buildSnippet', () => {
  const body = [
    '## Excel ETL',
    '我们曾经用 VLOOKUP 手工拼表，后来改成了 Power Query 做清洗与合并。',
    '这一页记录了迁移的决策和遗留的坑。',
  ].join('\n');

  it('centres on the match and marks the clip', () => {
    const longBody = `${'前置说明。'.repeat(30)}VLOOKUP 手工拼表${'后置说明。'.repeat(30)}`;
    const snippet = buildSnippet(longBody, 'VLOOKUP');

    expect(snippet).toContain('VLOOKUP');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(130);
  });

  it('does not clip a body that fits', () => {
    const snippet = buildSnippet('短正文 VLOOKUP', 'VLOOKUP');
    expect(snippet).toBe('短正文 VLOOKUP');
  });

  it('collapses whitespace so a snippet fits one line', () => {
    expect(buildSnippet(body, 'Power Query')).not.toContain('\n');
  });

  it('falls back to the head of the body when the term is not literal', () => {
    const snippet = buildSnippet(body, 'nonexistent-term');
    expect(snippet).toContain('Excel ETL');
  });
});
