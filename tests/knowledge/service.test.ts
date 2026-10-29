/**
 * Knowledge service: admission, shadow mode, citations and the status filter.
 *
 * The two rules this file exists to pin down, because both fail silently:
 *
 * - a `pending` page must be invisible to `search`, `get`, `titlesForInjection`
 *   *and* link resolution — an injected shadow page is indistinguishable from a
 *   confirmed fact, and a shadow page satisfying a citation is the same leak one
 *   step removed;
 * - a page may only cite rows that exist, so `unknown_sources` has to be a
 *   refusal, not a warning.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createKnowledgeService } from '../../src/memory/knowledge/service.js';
import type { KnowledgeService } from '../../src/memory/knowledge/service-contract.js';
import type { CreateKnowledgePageInput } from '../../src/memory/knowledge/types.js';
import {
  MEMORY_A,
  MEMORY_B,
  MESSAGE_ID,
  openSeededDatabase,
  SESSION_ID,
  TWO_MEMORY_SOURCES,
} from './fixtures.js';

describe('knowledge service', () => {
  let db: Database.Database;
  let service: KnowledgeService;

  beforeEach(() => {
    db = openSeededDatabase();
    service = createKnowledgeService({ db });
  });

  afterEach(() => {
    db.close();
  });

  function createInput(
    overrides: Partial<CreateKnowledgePageInput> = {},
  ): CreateKnowledgePageInput {
    return {
      pageType: 'topic',
      slug: 'excel-etl',
      title: 'Excel ETL',
      content: '用 Power Query 替代手工 VLOOKUP，数据清洗走一条流水线。',
      sources: TWO_MEMORY_SOURCES,
      ...overrides,
    };
  }

  describe('create', () => {
    it('creates an active page and reports its version', () => {
      const result = service.create(createInput(), { actor: 'agent' });
      expect(result).toMatchObject({
        ok: true,
        slug: 'excel-etl',
        pageType: 'topic',
        version: 1,
        status: 'active',
        created: true,
      });
    });

    it('rejects a page type outside the closed set', () => {
      const result = service.create(createInput({ pageType: 'person' as never }), {
        actor: 'agent',
      });
      expect(result).toMatchObject({ ok: false, code: 'invalid_page_type' });
      if (result.ok) return;
      expect(result.code === 'invalid_page_type' && result.allowed).toContain('entity');
    });

    it('derives the slug from the title when the slug normalises away', () => {
      const result = service.create(createInput({ slug: '!!!', title: 'Power Query' }), {
        actor: 'agent',
      });
      expect(result.ok && result.slug).toBe('power-query');
    });

    it('refuses a page whose slug cannot be derived at all', () => {
      expect(
        service.create(createInput({ slug: '!!!', title: '🙂' }), { actor: 'agent' }),
      ).toMatchObject({ ok: false, code: 'admission_rejected', reason: 'no_subject' });
    });

    it('refuses a citation that does not resolve', () => {
      const result = service.create(
        createInput({ sources: [{ kind: 'memory', id: 'memory-invented' }] }),
        { actor: 'agent' },
      );
      expect(result).toMatchObject({ ok: false, code: 'unknown_sources' });
      if (result.ok || result.code !== 'unknown_sources') return;
      expect(result.missing).toEqual([{ kind: 'memory', id: 'memory-invented' }]);
      expect(service.list()).toEqual([]);
    });

    it('refuses a citation that exists under another kind', () => {
      expect(
        service.create(createInput({ sources: [{ kind: 'message', id: MEMORY_A }] }), {
          actor: 'agent',
        }),
      ).toMatchObject({ ok: false, code: 'unknown_sources' });
    });

    it('refuses a page with no citations at all', () => {
      expect(service.create(createInput({ sources: [] }), { actor: 'agent' })).toEqual({
        ok: false,
        code: 'unknown_sources',
        missing: [],
      });
    });

    it('deduplicates citations before applying the recurrence rule', () => {
      // The same memory twice is one source, not two.
      expect(
        service.create(createInput({ sources: [TWO_MEMORY_SOURCES[0], TWO_MEMORY_SOURCES[0]] }), {
          actor: 'agent',
          enforceAdmission: true,
        }),
      ).toMatchObject({ ok: false, code: 'admission_rejected', reason: 'not_recurrent' });
    });

    it('accepts three kinds of citation', () => {
      const result = service.create(
        createInput({
          sources: [
            { kind: 'memory', id: MEMORY_A },
            { kind: 'message', id: MESSAGE_ID },
            { kind: 'session', id: SESSION_ID },
          ],
        }),
        { actor: 'agent' },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(service.get({ slug: 'excel-etl' })?.sources).toHaveLength(3);
    });
  });

  describe('admission (two of three rules)', () => {
    const curation = { actor: 'agent', enforceAdmission: true } as const;

    it('passes on a nameable subject plus recurrence', () => {
      expect(service.create(createInput({ title: 'Power Query' }), curation)).toMatchObject({
        ok: true,
      });
    });

    it('rejects a single-source page from curation', () => {
      expect(
        service.create(
          createInput({ title: 'Power Query', sources: [TWO_MEMORY_SOURCES[0]] }),
          curation,
        ),
      ).toMatchObject({ ok: false, code: 'admission_rejected', reason: 'not_recurrent' });
    });

    it('rejects a preference statement as having no subject', () => {
      expect(
        service.create(createInput({ title: '用户希望以后都用 Power Query' }), curation),
      ).toMatchObject({ ok: false, code: 'admission_rejected', reason: 'no_subject' });
    });

    it('accepts a preference statement when the user asked for it', () => {
      // subject fails; recurrence (2 sources) and the user's request carry it.
      expect(
        service.create(createInput({ title: '用户希望以后都用 Power Query' }), {
          actor: 'user',
          enforceAdmission: true,
        }),
      ).toMatchObject({ ok: true });
    });

    it('lets a single source through when requireSources is lowered', () => {
      const permissive = createKnowledgeService({ db, config: { requireSources: 1 } });
      expect(
        permissive.create(createInput({ sources: [TWO_MEMORY_SOURCES[0]] }), curation),
      ).toMatchObject({ ok: true });
    });

    it('does not apply admission to a direct write', () => {
      expect(
        service.create(
          createInput({ title: '用户希望以后都用 Power Query', sources: [TWO_MEMORY_SOURCES[0]] }),
          {
            actor: 'agent',
          },
        ),
      ).toMatchObject({ ok: true });
    });
  });

  describe('shadow mode', () => {
    let shadowed: KnowledgeService;

    beforeEach(() => {
      shadowed = createKnowledgeService({ db, config: { shadow: true } });
    });

    function curationWrite() {
      return shadowed.create(createInput({ slug: 'shadow-page', title: 'Shadow Page' }), {
        actor: 'agent',
        enforceAdmission: true,
      });
    }

    it('lands curation writes as pending', () => {
      expect(curationWrite()).toMatchObject({ ok: true, status: 'pending' });
    });

    it('does not queue a direct write', () => {
      expect(
        shadowed.create(createInput({ slug: 'direct-page', title: 'Direct Page' }), {
          actor: 'agent',
        }),
      ).toMatchObject({ ok: true, status: 'active' });
    });

    it('honours an explicit status', () => {
      expect(
        shadowed.create(
          createInput({ slug: 'explicit-page', title: 'Explicit', status: 'active' }),
          {
            actor: 'agent',
            enforceAdmission: true,
          },
        ),
      ).toMatchObject({ ok: true, status: 'active' });
    });

    it('keeps a pending page out of every reader until it is approved', () => {
      const written = curationWrite();
      expect(written.ok).toBe(true);
      if (!written.ok) return;

      // Not searchable…
      expect(shadowed.search('Power Query')).toEqual([]);
      // …not readable…
      expect(shadowed.get({ slug: 'shadow-page', pageType: 'topic' })).toBeNull();
      expect(shadowed.get({ id: written.id })).toBeNull();
      // …not injected…
      expect(shadowed.titlesForInjection('Power Query', 2)).toEqual([]);
      // …and not in the default list.
      expect(shadowed.list()).toEqual([]);
      expect(shadowed.list({ status: 'active' })).toEqual([]);

      // The review queue is the only way in.
      expect(shadowed.listPending().map((page) => page.slug)).toEqual(['shadow-page']);

      // Approval flips it: same page, now visible.
      expect(shadowed.setStatus(written.id, 'active', 'user')).toBe(true);
      expect(shadowed.search('Power Query').map((hit) => hit.slug)).toEqual(['shadow-page']);
      expect(shadowed.get({ slug: 'shadow-page', pageType: 'topic' })?.page.id).toBe(written.id);
      expect(shadowed.listPending()).toEqual([]);
    });

    it('keeps a pending page from satisfying a link', () => {
      curationWrite();

      const linking = shadowed.create(
        createInput({
          slug: 'index-page',
          title: 'Index Page',
          content: '见 [[topic/shadow-page]]',
        }),
        { actor: 'agent' },
      );
      expect(linking.ok).toBe(true);
      if (!linking.ok) return;

      // The citation stays dangling: a shadow page must not resolve.
      expect(service.linksOf(linking.id)).toEqual([]);
      const detail = shadowed.get({ slug: 'index-page' });
      expect(detail?.links).toEqual([{ slug: 'topic/shadow-page', label: null, missing: true }]);
    });
  });

  describe('search', () => {
    beforeEach(() => {
      service.create(
        createInput({
          pageType: 'entity',
          slug: 'power-query',
          title: 'Power Query',
          aliases: ['PQ'],
          tags: ['excel'],
          content: 'Power Query 是 Excel 里的数据清洗工具。',
        }),
        { actor: 'agent' },
      );
      service.create(
        createInput({ slug: 'excel-etl', title: 'Excel ETL', content: '流水线的编排与调度。' }),
        { actor: 'agent' },
      );
    });

    it('returns hits with a snippet of the original body', () => {
      const hits = service.search('数据清洗');
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ slug: 'power-query', pageType: 'entity' });
      expect(hits[0].snippet).toContain('数据清洗');
      expect(hits[0].score).toBeGreaterThan(0);
    });

    it('finds a page by alias even when the body never mentions it', () => {
      expect(service.search('PQ').map((hit) => hit.slug)).toEqual(['power-query']);
    });

    it('filters by page type and by tag', () => {
      expect(service.search('数据清洗', { pageType: 'topic' })).toEqual([]);
      expect(service.search('数据清洗', { pageType: 'entity' })).toHaveLength(1);
      expect(service.search('数据清洗', { tag: 'excel' })).toHaveLength(1);
      expect(service.search('数据清洗', { tag: 'nope' })).toEqual([]);
    });

    it('clamps the limit and tolerates an empty query', () => {
      expect(service.search('数据清洗', { limit: 999 })).toHaveLength(1);
      expect(service.search('   ')).toEqual([]);
    });

    it('finds a page by a word that appears only in its title', () => {
      // I6: v14 marked the title UNINDEXED and the name leg was exact-only, so a
      // page whose body never repeats its own title was reachable only by typing
      // the whole name.
      service.create(
        createInput({ slug: 'pivot-tables', title: 'Pivot Tables', content: '数据透视的用法。' }),
        { actor: 'agent' },
      );

      expect(service.search('Pivot').map((hit) => hit.slug)).toEqual(['pivot-tables']);
      expect(service.search('pivot tab').map((hit) => hit.slug)).toEqual(['pivot-tables']);
    });

    it('ranks a page found by both lanes above one found by a body match alone', () => {
      service.create(
        createInput({
          pageType: 'entity',
          slug: 'two-lane',
          title: 'Warehouse',
          content: 'Warehouse 的数据分层。',
        }),
        { actor: 'agent' },
      );
      service.create(
        createInput({ slug: 'body-only', title: 'Body Only', content: '提到了 Warehouse 一次。' }),
        { actor: 'agent' },
      );

      // Name leg + BM25 versus BM25 alone: fused by rank, so two contributions win.
      expect(service.search('Warehouse').map((hit) => hit.slug)[0]).toBe('two-lane');
    });
  });

  describe('get', () => {
    it('returns the page with sources and resolved links', () => {
      service.create(
        createInput({
          pageType: 'entity',
          slug: 'power-query',
          title: 'Power Query',
          content: '本体',
        }),
        { actor: 'agent' },
      );
      service.create(
        createInput({
          slug: 'excel-etl',
          content: '见 [[power-query]]、[[entity/power-query|PQ]]、[[missing]]',
        }),
        { actor: 'agent' },
      );

      const detail = service.get({ slug: 'excel-etl', pageType: 'topic' });
      expect(detail?.page.slug).toBe('excel-etl');
      expect(detail?.sources).toHaveLength(2);
      expect(detail?.links).toEqual([
        { slug: 'power-query', label: null, missing: false },
        { slug: 'entity/power-query', label: 'PQ', missing: false },
        { slug: 'missing', label: null, missing: true },
      ]);
    });

    it('does not list a self-link as a relation', () => {
      service.create(createInput({ content: '见 [[topic/excel-etl]]' }), { actor: 'agent' });
      expect(service.get({ slug: 'excel-etl' })?.links).toEqual([]);
    });

    it('returns null for an unknown ref', () => {
      expect(service.get({ slug: 'nope' })).toBeNull();
      expect(service.get({ id: 'nope' })).toBeNull();
    });
  });

  describe('backlinks', () => {
    function seedPages(): { target: string; linker: string } {
      const target = service.create(
        createInput({
          pageType: 'entity',
          slug: 'power-query',
          title: 'Power Query',
          content: '本体',
        }),
        { actor: 'agent' },
      );
      const linker = service.create(
        createInput({
          slug: 'excel-etl',
          title: 'Excel ETL',
          content: '见 [[entity/power-query|PQ]]。',
        }),
        { actor: 'agent' },
      );
      if (!target.ok || !linker.ok) throw new Error('insert failed');
      return { target: target.id, linker: linker.id };
    }

    it('names the active pages that cite the page', () => {
      seedPages();

      expect(service.backlinks({ slug: 'power-query', pageType: 'entity' })).toEqual([
        { slug: 'excel-etl', title: 'Excel ETL', label: 'PQ', relation_type: 'MENTIONS' },
      ]);
    });

    it('keeps a shadow page out of the backlink list', () => {
      const shadowed = createKnowledgeService({ db, config: { shadow: true } });
      const target = shadowed.create(
        createInput({
          pageType: 'entity',
          slug: 'power-query',
          title: 'Power Query',
          content: '本体',
        }),
        { actor: 'agent' },
      );
      const queued = shadowed.create(
        createInput({
          slug: 'draft',
          title: 'Draft',
          content: '见 [[power-query]]。',
          status: 'pending',
        }),
        { actor: 'agent' },
      );
      if (!target.ok || !queued.ok) throw new Error('insert failed');

      expect(shadowed.backlinks({ id: target.id })).toEqual([]);
    });

    it('returns nothing for a page that is not readable', () => {
      const { target } = seedPages();
      service.setStatus(target, 'archived', 'user');

      expect(service.backlinks({ id: target })).toEqual([]);
      expect(service.backlinks({ slug: 'nope' })).toEqual([]);
    });
  });

  describe('titlesForInjection', () => {
    it('returns at most `max` titles', () => {
      for (const slug of ['one', 'two', 'three']) {
        service.create(
          createInput({ slug, title: `Page ${slug}`, content: 'the same pipeline topic' }),
          { actor: 'agent' },
        );
      }

      expect(service.titlesForInjection('pipeline', 2)).toHaveLength(2);
      expect(service.titlesForInjection('pipeline', 100)).toHaveLength(3);
    });

    it('never invents a hit', () => {
      service.create(createInput(), { actor: 'agent' });
      expect(service.titlesForInjection('完全无关的查询词', 2)).toEqual([]);
      expect(service.titlesForInjection('', 2)).toEqual([]);
    });
  });

  describe('update', () => {
    it('refuses to clobber without expectedVersion and hands back the body', () => {
      const created = service.create(createInput({ content: '第一版' }), { actor: 'agent' });
      expect(created.ok).toBe(true);

      const result = service.update(
        { slug: 'excel-etl', pageType: 'topic' },
        { content: '第二版' },
        {
          actor: 'agent',
        },
      );
      expect(result).toMatchObject({
        ok: false,
        code: 'version_conflict',
        currentVersion: 1,
        currentContent: '第一版',
      });
    });

    it('updates with the version that was read', () => {
      service.create(createInput({ content: '第一版' }), { actor: 'agent' });
      const result = service.update(
        { slug: 'excel-etl', pageType: 'topic' },
        { content: '第二版', expectedVersion: 1 },
        { actor: 'agent' },
      );

      expect(result).toMatchObject({ ok: true, version: 2, created: false });
      expect(service.get({ slug: 'excel-etl' })?.page.content).toBe('第二版');
    });

    it('refuses an update that cites an unknown row', () => {
      service.create(createInput(), { actor: 'agent' });
      expect(
        service.update(
          { slug: 'excel-etl' },
          { sources: [{ kind: 'memory', id: 'memory-invented' }], expectedVersion: 1 },
          { actor: 'agent' },
        ),
      ).toMatchObject({ ok: false, code: 'unknown_sources' });
    });

    it('reports not_found for a page that does not exist', () => {
      expect(service.update({ slug: 'nope' }, { title: 'x' }, { actor: 'agent' })).toMatchObject({
        ok: false,
        code: 'not_found',
        slug: 'nope',
      });
    });
  });

  describe('list', () => {
    it('defaults to active pages and pages newest-first', () => {
      service.create(createInput({ slug: 'one', title: 'One' }), { actor: 'agent' });
      service.create(createInput({ slug: 'two', title: 'Two' }), { actor: 'agent' });
      db.prepare("UPDATE knowledge_pages SET updated_at = 1 WHERE slug = 'one'").run();

      expect(service.list().map((page) => page.slug)).toEqual(['two', 'one']);
      expect(service.list({ limit: 1 }).map((page) => page.slug)).toEqual(['two']);
      expect(service.list({ offset: 1 }).map((page) => page.slug)).toEqual(['one']);
      expect(service.list({ pageType: 'entity' })).toEqual([]);
    });

    it('keeps archived pages out of the default view', () => {
      const created = service.create(createInput(), { actor: 'agent' });
      if (!created.ok) throw new Error('create failed');
      service.setStatus(created.id, 'archived', 'user');

      expect(service.list()).toEqual([]);
      expect(service.list({ status: 'archived' })).toHaveLength(1);
      expect(service.get({ slug: 'excel-etl' })).toBeNull();
    });
  });
});
