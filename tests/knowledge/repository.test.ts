/**
 * Knowledge repository: page rows, citations, links, log — and the transactional
 * shape that keeps them from disagreeing.
 *
 * The load-bearing assertions here are the refusals, not the happy path: a create
 * that overwrites, an update that drops `expectedVersion`, or a write that leaves
 * a page row without its index row are exactly the failures that would be
 * invisible in production until a search returned stale text.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { KnowledgeRepository } from '../../src/memory/knowledge/repository.js';
import type {
  CreateKnowledgePageInput,
  KnowledgePageStatus,
} from '../../src/memory/knowledge/types.js';
import {
  MEMORY_A,
  MEMORY_B,
  MESSAGE_ID,
  openSeededDatabase,
  SESSION_ID,
  TWO_MEMORY_SOURCES,
} from './fixtures.js';

describe('KnowledgeRepository', () => {
  let db: Database.Database;
  let repository: KnowledgeRepository;

  beforeEach(() => {
    db = openSeededDatabase();
    repository = new KnowledgeRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function createInput(
    overrides: Partial<CreateKnowledgePageInput> = {},
  ): CreateKnowledgePageInput & {
    status: KnowledgePageStatus;
    updatedBy: string;
  } {
    return {
      pageType: 'topic',
      slug: 'excel-etl',
      title: 'Excel ETL',
      content: '用 [[power-query]] 替代手工 VLOOKUP。',
      sources: TWO_MEMORY_SOURCES,
      status: 'active',
      updatedBy: 'agent',
      ...overrides,
    };
  }

  function counts() {
    const one = (sql: string) => (db.prepare(sql).get() as { cnt: number }).cnt;
    return {
      pages: one('SELECT COUNT(*) AS cnt FROM knowledge_pages'),
      sources: one('SELECT COUNT(*) AS cnt FROM knowledge_sources'),
      links: one('SELECT COUNT(*) AS cnt FROM knowledge_links'),
      fts: one('SELECT COUNT(*) AS cnt FROM knowledge_fts_jieba'),
      log: one('SELECT COUNT(*) AS cnt FROM knowledge_log'),
    };
  }

  describe('insertPage', () => {
    it('writes the page, its citations, its index row and a log entry together', () => {
      const result = repository.insertPage(createInput(), 'agent');
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.created).toBe(true);
      expect(result.page.slug).toBe('excel-etl');
      expect(result.page.version).toBe(1);
      expect(result.page.status).toBe('active');
      expect(result.danglingLinks).toEqual(['power-query']);

      expect(counts()).toMatchObject({ pages: 1, sources: 2, links: 0, fts: 1, log: 2 });
      // One log row for the write, one for the dangling citation it recorded.
      expect(
        (
          db.prepare('SELECT action FROM knowledge_log ORDER BY rowid').all() as Array<{
            action: string;
          }>
        ).map((row) => row.action),
      ).toEqual(['create', 'link']);
    });

    it('normalises the slug on the way in', () => {
      const result = repository.insertPage(createInput({ slug: 'Excel ETL' }), 'agent');
      expect(result.ok && result.page.slug).toBe('excel-etl');
    });

    it('refuses to overwrite an existing page and hands back its body', () => {
      repository.insertPage(createInput({ content: '第一版正文' }), 'agent');

      const second = repository.insertPage(createInput({ content: '第二版正文' }), 'agent');
      expect(second).toMatchObject({ ok: false, code: 'version_conflict', currentVersion: 1 });
      if (second.ok || second.code !== 'version_conflict') return;
      expect(second.currentContent).toBe('第一版正文');

      expect(counts().pages).toBe(1);
      expect(repository.findBySlug('excel-etl', 'topic')?.content).toBe('第一版正文');
    });

    it('allows the same slug under a different page type', () => {
      repository.insertPage(createInput(), 'agent');
      const other = repository.insertPage(createInput({ pageType: 'project' }), 'agent');
      expect(other.ok).toBe(true);
      expect(counts().pages).toBe(2);
    });

    it('records the pending action when curation writes into the review queue', () => {
      repository.insertPage(createInput({ status: 'pending' }), 'system');
      expect(
        db.prepare("SELECT actor, version FROM knowledge_log WHERE action = 'pending'").get() as {
          actor: string;
          version: number;
        },
      ).toMatchObject({ actor: 'system', version: 1 });
    });

    it('rolls back everything when the index write fails', () => {
      db.exec('DROP TABLE knowledge_fts_jieba');

      expect(() => repository.insertPage(createInput(), 'agent')).toThrow();

      const remaining = (table: string) =>
        (db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number }).cnt;
      expect(remaining('knowledge_pages')).toBe(0);
      expect(remaining('knowledge_sources')).toBe(0);
      expect(remaining('knowledge_log')).toBe(0);
    });

    it('resolves a link to a page that already exists', () => {
      const target = repository.insertPage(
        createInput({ slug: 'power-query', title: 'Power Query', content: 'Power Query 是什么' }),
        'agent',
      );
      expect(target.ok).toBe(true);
      if (!target.ok) return;

      const linking = repository.insertPage(
        createInput({ slug: 'excel-etl', content: '见 [[power-query]] 与 [[topic/power-query]]' }),
        'agent',
      );
      expect(linking.ok).toBe(true);
      if (!linking.ok) return;

      expect(linking.danglingLinks).toEqual([]);
      expect(repository.linksOf(linking.page.id)).toEqual([
        {
          from_page_id: linking.page.id,
          to_page_id: target.page.id,
          label: null,
          created_at: expect.any(Number),
        },
      ]);
    });

    it('records a dangling link in the log without failing the write', () => {
      const result = repository.insertPage(
        createInput({ content: '[[not-written-yet]]' }),
        'agent',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.danglingLinks).toEqual(['not-written-yet']);

      const linkLog = db
        .prepare("SELECT reason FROM knowledge_log WHERE action = 'link'")
        .get() as { reason: string };
      expect(linkLog.reason).toContain('not-written-yet');
      expect(repository.linksOf(result.page.id)).toEqual([]);
    });
  });

  describe('updatePage', () => {
    function inserted() {
      const result = repository.insertPage(
        createInput({ content: '第一版 VLOOKUP 正文' }),
        'agent',
      );
      if (!result.ok) throw new Error('insert failed');
      return result.page;
    }

    it('bumps the version, re-indexes and re-reads links', () => {
      const page = inserted();
      const target = repository.insertPage(
        createInput({ slug: 'power-query', title: 'Power Query', content: '本体' }),
        'agent',
      );
      if (!target.ok) throw new Error('insert failed');

      const updated = repository.updatePage(
        { id: page.id },
        { content: '第二版正文，见 [[power-query]]', expectedVersion: 1 },
        'agent',
      );
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;

      expect(updated.page.version).toBe(2);
      expect(updated.danglingLinks).toEqual([]);
      expect(repository.linksOf(page.id)).toHaveLength(1);

      // The index holds the new body only — one row, old text gone.
      expect(
        db
          .prepare('SELECT COUNT(*) AS cnt FROM knowledge_fts_jieba WHERE page_id = ?')
          .get(page.id),
      ).toEqual({ cnt: 1 });
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS cnt FROM knowledge_fts_jieba WHERE page_id = ? AND content_original LIKE '%VLOOKUP%'",
          )
          .get(page.id),
      ).toEqual({ cnt: 0 });
    });

    it('drops link rows whose wikilink was removed from the body', () => {
      const target = repository.insertPage(
        createInput({ slug: 'power-query', title: 'Power Query', content: '本体' }),
        'agent',
      );
      if (!target.ok) throw new Error('insert failed');
      const page = repository.insertPage(
        createInput({ slug: 'excel-etl', content: '见 [[power-query]]' }),
        'agent',
      );
      if (!page.ok) throw new Error('insert failed');
      expect(repository.linksOf(page.page.id)).toHaveLength(1);

      repository.updatePage(
        { id: page.page.id },
        { content: '不再引用', expectedVersion: 1 },
        'agent',
      );
      expect(repository.linksOf(page.page.id)).toEqual([]);
    });

    it('refuses a content update that carries no expectedVersion', () => {
      const page = inserted();
      const result = repository.updatePage({ id: page.id }, { content: '悄悄覆盖' }, 'agent');

      expect(result).toMatchObject({
        ok: false,
        code: 'version_conflict',
        currentVersion: 1,
        currentContent: '第一版 VLOOKUP 正文',
      });
      expect(repository.findById(page.id)?.content).toBe('第一版 VLOOKUP 正文');
    });

    it('refuses a stale expectedVersion and returns the current body', () => {
      const page = inserted();
      repository.updatePage({ id: page.id }, { content: '第二版', expectedVersion: 1 }, 'agent');

      const stale = repository.updatePage(
        { id: page.id },
        { content: '第三版', expectedVersion: 1 },
        'agent',
      );
      expect(stale).toMatchObject({
        ok: false,
        code: 'version_conflict',
        currentVersion: 2,
        currentContent: '第二版',
      });
    });

    it('allows a metadata-only update without expectedVersion', () => {
      const page = inserted();
      const result = repository.updatePage({ id: page.id }, { tags: ['excel', 'etl'] }, 'agent');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.page.tags).toBe('["excel","etl"]');
      expect(result.page.content).toBe('第一版 VLOOKUP 正文');
    });

    it('replaces the citation set when sources are given', () => {
      const page = inserted();
      const result = repository.updatePage(
        { slug: 'excel-etl', pageType: 'topic' },
        { sources: [{ kind: 'message', id: MESSAGE_ID }], expectedVersion: 1 },
        'agent',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(repository.sourcesOf(page.id)).toEqual([
        expect.objectContaining({ source_kind: 'message', source_id: MESSAGE_ID }),
      ]);
    });

    it('reports not_found with the slug it was given', () => {
      expect(repository.updatePage({ slug: 'nope' }, { title: 'x' }, 'agent')).toEqual({
        ok: false,
        code: 'not_found',
        slug: 'nope',
      });
    });
  });

  describe('setStatus', () => {
    it('flips the status, bumps the version and logs it', () => {
      const result = repository.insertPage(createInput({ status: 'pending' }), 'system');
      if (!result.ok) throw new Error('insert failed');

      expect(repository.setStatus(result.page.id, 'active', 'user')).toBe(true);
      const page = repository.findById(result.page.id)!;
      expect(page.status).toBe('active');
      expect(page.version).toBe(2);
      expect(
        (
          db.prepare('SELECT reason FROM knowledge_log ORDER BY rowid DESC LIMIT 1').get() as {
            reason: string;
          }
        ).reason,
      ).toBe('status: pending -> active');
    });

    it('is a no-op for an unknown id or an unchanged status', () => {
      const result = repository.insertPage(createInput(), 'agent');
      if (!result.ok) throw new Error('insert failed');

      expect(repository.setStatus('missing', 'archived', 'user')).toBe(false);
      expect(repository.setStatus(result.page.id, 'active', 'user')).toBe(false);
    });
  });

  describe('missingSources (anti-hallucination gate)', () => {
    it('accepts citations of real rows of the right kind', () => {
      expect(
        repository.missingSources([
          { kind: 'memory', id: MEMORY_A },
          { kind: 'message', id: MESSAGE_ID },
          { kind: 'session', id: SESSION_ID },
        ]),
      ).toEqual([]);
    });

    it('rejects invented ids', () => {
      expect(repository.missingSources([{ kind: 'memory', id: 'memory-does-not-exist' }])).toEqual([
        { kind: 'memory', id: 'memory-does-not-exist' },
      ]);
    });

    it('rejects an id that exists in a different table', () => {
      // MEMORY_A is a memory id; citing it as a message must not pass.
      expect(repository.missingSources([{ kind: 'message', id: MEMORY_A }])).toEqual([
        { kind: 'message', id: MEMORY_A },
      ]);
    });
  });

  describe('reads', () => {
    it('orders lists by updated_at descending and respects the status filter', () => {
      repository.insertPage(createInput({ slug: 'one', title: 'One' }), 'agent');
      const second = repository.insertPage(
        createInput({ slug: 'two', title: 'Two', status: 'pending' }),
        'agent',
      );
      if (!second.ok) throw new Error('insert failed');
      db.prepare('UPDATE knowledge_pages SET updated_at = 999 WHERE id = ?').run(second.page.id);

      expect(repository.list({ status: 'active' }).map((page) => page.slug)).toEqual(['one']);
      expect(repository.list({ status: 'pending' }).map((page) => page.slug)).toEqual(['two']);
      expect(repository.list({ status: 'pending', pageType: 'topic' })).toHaveLength(1);
      expect(repository.list({ status: 'pending', pageType: 'entity' })).toHaveLength(0);
    });

    it('finds a page by title or alias, not only by slug', () => {
      repository.insertPage(
        createInput({
          pageType: 'entity',
          slug: 'power-query',
          title: 'Power Query',
          aliases: ['PQ'],
        }),
        'agent',
      );

      expect(
        repository.findByTitleOrAlias('Power Query', { status: 'active', limit: 5 }),
      ).toHaveLength(1);
      expect(repository.findByTitleOrAlias('PQ', { status: 'active', limit: 5 })).toHaveLength(1);
      expect(
        repository.findByTitleOrAlias('power query', { status: 'active', limit: 5 }),
      ).toHaveLength(1);
      expect(repository.findByTitleOrAlias('PQ', { status: 'pending', limit: 5 })).toHaveLength(0);
    });

    it('matches a title by prefix, which is what a half-remembered name looks like', () => {
      repository.insertPage(
        createInput({ pageType: 'entity', slug: 'power-query', title: 'Power Query' }),
        'agent',
      );
      repository.insertPage(
        createInput({ pageType: 'topic', slug: 'power-bi', title: 'Power BI' }),
        'agent',
      );
      repository.insertPage(createInput({ slug: 'excel-etl', title: 'Excel ETL' }), 'agent');

      expect(
        repository
          .findByTitleOrAlias('power', { status: 'active', limit: 5 })
          .map((page) => page.slug)
          .sort(),
      ).toEqual(['power-bi', 'power-query']);
      // Anchored: a prefix match cannot reach into the middle of a title.
      expect(repository.findByTitleOrAlias('query', { status: 'active', limit: 5 })).toEqual([]);
    });

    it('sorts an exact title above the pages that merely prefix-match it', () => {
      repository.insertPage(createInput({ slug: 'power', title: 'Power' }), 'agent');
      const newer = repository.insertPage(
        createInput({ pageType: 'topic', slug: 'power-bi', title: 'Power BI' }),
        'agent',
      );
      if (!newer.ok) throw new Error('insert failed');
      // Newest otherwise wins, so without the exactness key this page would lead.
      db.prepare('UPDATE knowledge_pages SET updated_at = 9999999999999 WHERE id = ?').run(
        newer.page.id,
      );

      expect(
        repository
          .findByTitleOrAlias('power', { status: 'active', limit: 5 })
          .map((page) => page.slug),
      ).toEqual(['power', 'power-bi']);
    });

    it('treats LIKE metacharacters in the query literally', () => {
      repository.insertPage(
        createInput({ pageType: 'topic', slug: 'pct-done', title: '100% Done', content: 'x' }),
        'agent',
      );

      expect(
        repository
          .findByTitleOrAlias('100%', { status: 'active', limit: 5 })
          .map((page) => page.slug),
      ).toEqual(['pct-done']);
      // Escaped, so this is "titles starting with a literal %" — not "everything".
      expect(repository.findByTitleOrAlias('%', { status: 'active', limit: 5 })).toEqual([]);
      expect(repository.findByTitleOrAlias('_', { status: 'active', limit: 5 })).toEqual([]);
    });
  });

  describe('linksTo (backlinks)', () => {
    function link(from: string, to: string): void {
      const result = repository.insertPage(
        createInput({ slug: from, content: `见 [[${to}]]` }),
        'agent',
      );
      if (!result.ok) throw new Error(`insert failed: ${result.code}`);
    }

    it('returns the active pages that cite the given page', () => {
      const target = repository.insertPage(
        createInput({
          pageType: 'entity',
          slug: 'power-query',
          title: 'Power Query',
          content: '本体',
        }),
        'agent',
      );
      if (!target.ok) throw new Error('insert failed');
      const linker = repository.insertPage(
        createInput({
          slug: 'excel-etl',
          title: 'Excel ETL',
          content: '见 [[entity/power-query|PQ]]',
        }),
        'agent',
      );
      if (!linker.ok) throw new Error('insert failed');

      expect(repository.linksTo(target.page.id)).toEqual([
        { slug: 'excel-etl', title: 'Excel ETL', label: 'PQ' },
      ]);
      // The forward direction is unchanged: the linker has one outgoing link.
      expect(repository.linksOf(linker.page.id)).toHaveLength(1);
    });

    it('drops a linker that is not active', () => {
      const target = repository.insertPage(
        createInput({
          pageType: 'entity',
          slug: 'power-query',
          title: 'Power Query',
          content: '本体',
        }),
        'agent',
      );
      if (!target.ok) throw new Error('insert failed');

      link('live-page', 'power-query');
      const queued = repository.insertPage(
        createInput({
          slug: 'queued-page',
          title: 'Queued Page',
          content: '见 [[power-query]]',
          status: 'pending',
        }),
        'agent',
      );
      if (!queued.ok) throw new Error('insert failed');

      expect(repository.linksTo(target.page.id).map((backlink) => backlink.slug)).toEqual([
        'live-page',
      ]);
    });

    it('ignores a dangling link row instead of failing', () => {
      // Only reachable with foreign keys off (the FK cascades on delete), which is
      // exactly the connection a script or a test can open.
      db.pragma('foreign_keys = OFF');
      db.prepare(
        `INSERT INTO knowledge_links (from_page_id, to_page_id, label, created_at)
         VALUES ('gone-page', 'no-such-page', NULL, ?)`,
      ).run(Date.now());
      db.pragma('foreign_keys = ON');

      expect(repository.linksTo('no-such-page')).toEqual([]);
    });

    it('returns nothing for a page nobody cites', () => {
      const page = repository.insertPage(createInput(), 'agent');
      if (!page.ok) throw new Error('insert failed');

      expect(repository.linksTo(page.page.id)).toEqual([]);
    });
  });
});
