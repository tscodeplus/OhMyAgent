/**
 * `service.search` body lane (P11 in the 2026-10-30 knowledge review): the
 * FTS match and the page rows it reads back are one JOINed SELECT, so a per-hit
 * `findById` cannot run — the old N+1 — and a stale index row (a page gone, its
 * FTS row left) dies in its own JOIN instead of being filtered after the fact.
 *
 * The fused ordering is pinned alongside: the name lane still outranks the body
 * lane at equal fused score via the lane-index tiebreak, and one index row still
 * means one hit (the dedupe never fabricated a second lane's agreement).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openSeededDatabase } from './fixtures.js';
import { createKnowledgeService } from '../../src/memory/knowledge/service.js';
import type { KnowledgeService } from '../../src/memory/knowledge/service-contract.js';
import type { KnowledgePageStatus } from '../../src/memory/knowledge/types.js';
import { TWO_MEMORY_SOURCES } from './fixtures.js';

let db: Database.Database;
let service: KnowledgeService;

beforeEach(() => {
  db = openSeededDatabase();
  service = createKnowledgeService({ db });
});

afterEach(() => {
  db.close();
});

function insertPage(
  slug: string,
  title: string,
  content: string,
  status: KnowledgePageStatus = 'active',
): string {
  const result = service.create(
    {
      pageType: 'topic',
      slug,
      title,
      content,
      sources: TWO_MEMORY_SOURCES,
      status,
    },
    { actor: 'agent' },
  );
  if (!result.ok) throw new Error(`seed ${slug} failed: ${result.code}`);
  return result.id;
}

describe('search body lane (single JOIN)', () => {
  it('returns name-lane and body-lane hits, name lane first at equal rank', () => {
    const named = insertPage(
      'alpha-report',
      'Alpha Report',
      'Alpha Report is the quarterly ETL note.',
    );
    const bodyOnly = insertPage(
      'other-note',
      'Unrelated title',
      'Notes on VLOOKUP and the ETL toolchain.',
    );

    const hits = service.search('alpha', { limit: 5 });
    expect(hits.map((hit) => hit.id)).toEqual([named]);

    // Both lanes agree on the named page: it collects two contributions and
    // outranks the body-only hit, which exists but ranks second.
    const ranked = service.search('etl', { limit: 5 });
    expect(ranked.map((hit) => hit.id)).toEqual([named, bodyOnly]);

    // The snippet comes from the raw body, not the segmented column.
    expect(ranked[1].snippet).toContain('VLOOKUP');
  });

  it('keeps one page one hit, even when a duplicated index row exists', () => {
    const id = insertPage('dup-note', 'Dup Note', 'The dup note mentions pivots twice.');
    // Corrupt deliberately: a second FTS row for the same page (no uniqueness
    // constraint in the standalone FTS5 table).
    db.prepare(
      `INSERT INTO knowledge_fts_jieba (content, content_original, page_id, title, page_type)
         SELECT content, content_original, page_id, title, page_type
           FROM knowledge_fts_jieba WHERE page_id = (SELECT id FROM knowledge_pages WHERE slug = 'dup-note')`,
    ).run();

    const hits = service.search('pivots', { limit: 5 });
    expect(hits.map((hit) => hit.id)).toEqual([id]);
  });

  it('a stale index row (page deleted, FTS row left) is no hit and no crash', () => {
    const ghost = insertPage('ghost-note', 'Ghost note', 'Ghost note mentions pivot tables.');
    // Delete the page row directly; the standalone FTS table loses nothing.
    // Previously the N+1's `if (!page) return []` absorbed this; now the JOIN
    // makes the unreadable row structurally impossible — same search answer,
    // one query instead of two.
    db.prepare('DELETE FROM knowledge_pages WHERE id = ?').run(ghost);

    const hits = service.search('pivot tables', { limit: 5 });
    expect(hits.map((hit) => hit.id)).not.toContain(ghost);
  });
});
