/**
 * `pnpm knowledge:reindex` — rebuild and `--check`.
 *
 * The command's job grew with migration-v20: the index now carries the title as
 * well as the body, so a rebuild must re-derive both, and `--check` must stay
 * green on a database that holds a `pending` page. That last one is the mirror
 * invariant, not a cosmetic detail — `checkConsistency` compares row counts, so
 * an index that skipped non-active pages would report drift on every install
 * that ever used `curate.shadow`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { reindexKnowledge } from '../../scripts/knowledge-reindex.js';
import { KnowledgeRepository } from '../../src/memory/knowledge/repository.js';
import {
  checkConsistency,
  searchKnowledgeIndex,
  rebuild,
} from '../../src/memory/knowledge/indexer.js';
import type { KnowledgePageStatus } from '../../src/memory/knowledge/types.js';
import { openSeededDatabase, TWO_MEMORY_SOURCES } from './fixtures.js';

describe('knowledge reindex', () => {
  let db: Database.Database;
  let repository: KnowledgeRepository;

  beforeEach(() => {
    db = openSeededDatabase();
    repository = new KnowledgeRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function insert(slug: string, title: string, content: string, status: KnowledgePageStatus) {
    const result = repository.insertPage(
      {
        pageType: 'topic',
        slug,
        title,
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

  it('rebuilds the body and the title of every page', () => {
    const page = insert('pivot', 'Pivot Tables', '数据透视的用法。', 'active');
    // Simulate drift: a write that changed the page row without touching the index.
    db.prepare(
      "UPDATE knowledge_pages SET title = 'Kernel Log', content = '内核日志。' WHERE id = ?",
    ).run(page.id);

    expect(searchKnowledgeIndex(db, 'Kernel', { status: 'active', limit: 5 })).toEqual([]);

    const summary = reindexKnowledge(db);

    expect(summary).toMatchObject({ mode: 'rebuild', indexedPages: 1, orphanRowsRemoved: 0 });
    expect(summary.consistency.consistent).toBe(true);
    expect(
      searchKnowledgeIndex(db, 'Kernel', { status: 'active', limit: 5 }).map((hit) => hit.pageId),
    ).toEqual([page.id]);
    expect(searchKnowledgeIndex(db, 'Pivot', { status: 'active', limit: 5 })).toEqual([]);
  });

  it('stays consistent with a pending page in the table', () => {
    insert('live', 'Live Page', '正文。', 'active');
    insert('queued', 'Queued Page', '草稿。', 'pending');

    // What the migration promises, and what the write path already does: the
    // index mirrors the page table, and `status` is applied by the reader.
    expect(checkConsistency(db).consistent).toBe(true);
    expect(reindexKnowledge(db).consistency).toMatchObject({
      pageCount: 2,
      indexedRowCount: 2,
      missingPageIds: [],
      consistent: true,
    });
  });

  it('keeps --check green and writes nothing', () => {
    insert('live', 'Live Page', '正文。', 'active');
    insert('queued', 'Queued Page', '草稿。', 'pending');

    const before = db.prepare('SELECT COUNT(*) AS cnt FROM knowledge_fts_jieba').get();
    const summary = reindexKnowledge(db, { check: true });

    expect(summary).toMatchObject({ mode: 'check', indexedPages: 0, orphanRowsRemoved: 0 });
    expect(summary.consistency.consistent).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS cnt FROM knowledge_fts_jieba').get()).toEqual(before);
  });

  it('keeps the one-row-per-page property after a full rebuild', () => {
    const page = insert('pivot', 'Pivot Tables', '数据透视。', 'active');

    rebuild(db);

    expect(
      db.prepare('SELECT COUNT(*) AS cnt FROM knowledge_fts_jieba WHERE page_id = ?').get(page.id),
    ).toEqual({ cnt: 1 });
    expect(checkConsistency(db).duplicatePageIds).toEqual([]);
  });

  it('removes index rows whose page is gone', () => {
    const page = insert('pivot', 'Pivot Tables', '数据透视。', 'active');
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM knowledge_pages WHERE id = ?').run(page.id);
    db.pragma('foreign_keys = ON');

    expect(reindexKnowledge(db).orphanRowsRemoved).toBe(1);
    expect(checkConsistency(db).consistent).toBe(true);
  });
});
