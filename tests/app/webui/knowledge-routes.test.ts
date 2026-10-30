/**
 * Tests for the knowledge-page API (knowledge-routes.ts) — the WebUI page
 * editor behind plan §6 K2 / §12 item 4.
 *
 * This is an integration test: the real `createKnowledgeService` (`service.ts`)
 * runs against a real `openDatabase(':memory:')` built by the real migration
 * chain, so the assertions cover the whole path the editor takes — HTTP
 * validation, the service's transaction (page + FTS + links + log), and the
 * camelCase payloads the UI consumes.
 *
 * What is pinned here:
 *   - `GET  /api/knowledge/pages`   — default active filter, pageType/limit/offset
 *   - `GET  /api/knowledge/pending` — the shadow review queue
 *   - page scope                    — `?scope=` on both lists, scope in every
 *                                     payload; the console write stays global
 *   - `GET  /api/knowledge/search`  — `q` required, per-type/tag filters, snippets
 *   - `GET  /api/knowledge/page/:id`, `/page/:pageType/:slug` — detail + 404
 *   - `PUT  /api/knowledge/page/:id` — 409 on a stale `expectedVersion`, 400 on a
 *                                     missing one, 400 on a dead citation
 *   - `POST /api/knowledge/page`     — create from the editor (actor `user`),
 *                                     409 when the type/slug is taken
 *   - `POST /api/knowledge/page/:id/approve|archive` — the shadow workflow
 *   - `GET  /api/knowledge/stats`    — counts by status/pageType + FTS parity
 *
 * The rule with the most riding on it: a `pending` page must never appear in a
 * browse list or a search result, because a shadow page that reads like a
 * confirmed fact is worse than no page at all.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import { registerKnowledgeRoutes } from '../../../src/app/webui/knowledge-routes.js';
import { openDatabase } from '../../../src/memory/db.js';
import type { KnowledgeService } from '../../../src/memory/knowledge/service-contract.js';
import type {
  KnowledgePageStatus,
  KnowledgeSourceInput,
  PageType,
} from '../../../src/memory/knowledge/types.js';
import {
  MEMORY_A,
  MEMORY_B,
  MESSAGE_ID,
  SESSION_ID,
  knowledgeService,
  openSeededDatabase,
} from '../../knowledge/fixtures.js';

/** Seed page ids, resolved in `beforeEach`. */
let POWER_QUERY: string;
let RETIRED: string;
let SHADOW: string;

describe('knowledge routes', () => {
  let db: Database.Database;
  let service: KnowledgeService;
  let app: ReturnType<typeof Fastify>;

  /**
   * Write a page through the service (not raw SQL), so its FTS row, links and
   * log entry exist exactly as production writes them.
   */
  function seedPage(input: {
    pageType: PageType;
    slug: string;
    title: string;
    content: string;
    tags?: string[];
    status?: KnowledgePageStatus;
    sources?: KnowledgeSourceInput[];
    /** Omitted means `global`, the write default (migration-v22). */
    scope?: string;
  }): string {
    const result = service.create(
      {
        pageType: input.pageType,
        slug: input.slug,
        title: input.title,
        content: input.content,
        tags: input.tags,
        status: input.status,
        sources: input.sources ?? [{ kind: 'memory', id: MEMORY_A }],
        updatedBy: 'agent',
      },
      { actor: 'agent', enforceAdmission: false, scope: input.scope },
    );
    if (!result.ok) throw new Error(`seed page failed: ${result.code}`);
    return result.id;
  }

  beforeEach(async () => {
    db = openSeededDatabase();
    service = knowledgeService(db);

    POWER_QUERY = seedPage({
      pageType: 'topic',
      slug: 'power-query',
      title: 'Power Query',
      // `VLOOKUP` appears only in the body, so a hit on it comes from the FTS
      // leg rather than from the title/alias leg.
      content: 'Power Query 用于清洗表格数据，替代手工 VLOOKUP。延伸阅读：[[entity/globex]]。',
      tags: ['data'],
    });
    RETIRED = seedPage({
      pageType: 'topic',
      slug: 'retired-topic',
      title: 'Retired Topic',
      content: 'archived body',
    });
    service.setStatus(RETIRED, 'archived', 'agent');
    SHADOW = seedPage({
      pageType: 'entity',
      slug: 'acme-corp',
      title: 'Acme Corp',
      content: 'Acme Corp 是做电池的',
      status: 'pending',
    });

    app = Fastify({ logger: false });
    registerKnowledgeRoutes(app, { db, service });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  describe('GET /api/knowledge/pages', () => {
    it('lists active pages by default and never leaks a pending one', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/knowledge/pages' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        pages: Array<{
          id: string;
          status: string;
          pageType: string;
          slug: string;
          tags: string[];
          aliases: string[];
          version: number;
        }>;
        count: number;
        limit: number;
        offset: number;
      };
      expect(body.pages.map((page) => page.id)).toEqual([POWER_QUERY]);
      expect(body.count).toBe(1);
      expect(body.limit).toBe(20);
      expect(body.offset).toBe(0);
      // camelCase JSON, JSON-array columns parsed.
      expect(body.pages[0]).toMatchObject({
        slug: 'power-query',
        pageType: 'topic',
        status: 'active',
        version: 1,
        tags: ['data'],
        aliases: [],
      });
    });

    it('rejects ?status=pending and points at the review queue', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/knowledge/pages?status=pending' });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toContain('/api/knowledge/pending');
    });

    it('serves archived pages on request', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/knowledge/pages?status=archived' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { pages: Array<{ id: string }> }).pages.map((p) => p.id)).toEqual([
        RETIRED,
      ]);
    });

    it('filters by pageType and rejects an unknown one', async () => {
      const topics = await app.inject({
        method: 'GET',
        url: '/api/knowledge/pages?pageType=topic',
      });
      expect((topics.json() as { pages: Array<{ id: string }> }).pages.map((p) => p.id)).toEqual([
        POWER_QUERY,
      ]);

      // The only entity is the pending one, so this must be empty — not a leak.
      const entities = await app.inject({
        method: 'GET',
        url: '/api/knowledge/pages?pageType=entity',
      });
      expect((entities.json() as { pages: unknown[] }).pages).toEqual([]);

      const badType = await app.inject({
        method: 'GET',
        url: '/api/knowledge/pages?pageType=person',
      });
      expect(badType.statusCode).toBe(400);
      expect((badType.json() as { error: string }).error).toContain('entity');
    });

    it('rejects an unknown status instead of ignoring the filter', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/knowledge/pages?status=nope' });
      expect(res.statusCode).toBe(400);
    });

    it('clamps limit to the page-size ceiling', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/knowledge/pages?limit=9999',
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { limit: number }).limit).toBe(100);
    });
  });

  describe('GET /api/knowledge/pending', () => {
    it('returns the shadow queue with bodies, so the reviewer can read them', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/knowledge/pending' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        pages: Array<{ id: string; status: string; content: string }>;
        count: number;
      };
      expect(body.pages.map((page) => page.id)).toEqual([SHADOW]);
      expect(body.pages[0]).toMatchObject({ status: 'pending' });
      expect(body.pages[0].content).toContain('电池');
      expect(body.count).toBe(1);
    });

    /**
     * The reviewer's first judgement is "is this corroborated", and neither number
     * is visible in the body: a draft can read perfectly and still be one chat
     * talking to itself. `independent` counts conversations, not rows, because that
     * is what admission rule 2 measured — see `countIndependentSources`.
     */
    it('reports citations and independent conversations per row', async () => {
      const sameChat = seedPage({
        pageType: 'topic',
        slug: 'excel-etl',
        title: 'Excel ETL',
        content: 'Excel ETL 走 Power Query',
        status: 'pending',
        // Both fixture memories were written in one conversation (`user-knowledge`).
        sources: [
          { kind: 'memory', id: MEMORY_A },
          { kind: 'memory', id: MEMORY_B },
        ],
      });
      const res = await app.inject({ method: 'GET', url: '/api/knowledge/pending' });
      const body = res.json() as {
        pages: Array<{ id: string; sources: { total: number; independent: number } }>;
        requireSources: number;
      };
      const row = body.pages.find((page) => page.id === sameChat);
      expect(row?.sources).toEqual({ total: 2, independent: 1 });
      // The row that cites one memory reports the same thing it always did.
      const single = body.pages.find((page) => page.id === SHADOW);
      expect(single?.sources).toEqual({ total: 1, independent: 1 });
      expect(body.requireSources).toBe(2);
    });

    it('echoes the configured threshold instead of a hardcoded one', async () => {
      const configured = Fastify({ logger: false });
      registerKnowledgeRoutes(configured, { db, service, requireSources: 5 });
      await configured.ready();
      const body = (
        await configured.inject({ method: 'GET', url: '/api/knowledge/pending' })
      ).json() as { requireSources: number };
      expect(body.requireSources).toBe(5);
      await configured.close();

      // `require_sources: 0` would make every draft look corroborated; the route
      // clamps to the same floor the curator applies.
      const zero = Fastify({ logger: false });
      registerKnowledgeRoutes(zero, { db, service, requireSources: 0 });
      await zero.ready();
      const clamped = (
        await zero.inject({ method: 'GET', url: '/api/knowledge/pending' })
      ).json() as { requireSources: number };
      expect(clamped.requireSources).toBe(1);
      await zero.close();
    });
  });

  /**
   * Page scope (migration-v22): a page belongs to the conversation that wrote
   * it. The console is the one reader meant to see all of them, so the default
   * here is every scope and `?scope=` is the narrowing filter — and every
   * payload names the scope, because an approver cannot judge a draft without
   * knowing which chat proposed it.
   */
  describe('page scope', () => {
    /** One scoped page per chat — the shape a channel-curation write produces. */
    function seedScopedChats(): void {
      seedPage({
        pageType: 'topic',
        slug: 'feishu-only',
        title: 'Feishu Only',
        content: 'Feishu 群里的正文',
        scope: 'feishu:oc_1',
      });
      seedPage({
        pageType: 'topic',
        slug: 'telegram-only',
        title: 'Telegram Only',
        content: 'Telegram 会话里的正文',
        scope: 'telegram:session:s1',
      });
    }

    it('lists every scope by default, each page naming its own', async () => {
      seedScopedChats();

      const res = await app.inject({ method: 'GET', url: '/api/knowledge/pages' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        pages: Array<{ slug: string; scope: string }>;
        count: number;
      };
      // Unscoped is the console default: the two chat pages sit beside the
      // global seed rather than replacing it.
      expect(body.count).toBe(3);
      expect(Object.fromEntries(body.pages.map((page) => [page.slug, page.scope]))).toEqual({
        'power-query': 'global',
        'feishu-only': 'feishu:oc_1',
        'telegram-only': 'telegram:session:s1',
      });
    });

    it('narrows ?scope= to that scope plus the global pages', async () => {
      seedScopedChats();

      const res = await app.inject({
        method: 'GET',
        url: '/api/knowledge/pages?scope=feishu:oc_1',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { pages: Array<{ slug: string }>; count: number };
      // Read rule, not equality: `power-query` is global and stays visible in
      // the chat, `telegram-only` belongs to another conversation.
      expect(body.pages.map((page) => page.slug).sort()).toEqual(['feishu-only', 'power-query']);
      expect(body.count).toBe(2);
    });

    it('returns an empty list for a scope nobody wrote under, not an error', async () => {
      seedScopedChats();

      // A scope nobody wrote under is a filter that matches no conversation, not
      // a 400. Global pages still answer it — that is the read rule (`S` plus
      // `global`, never equality) — so the genuinely empty case is a filter no
      // global page passes either.
      const empty = await app.inject({
        method: 'GET',
        url: '/api/knowledge/pages?scope=wechat:ghost&pageType=project',
      });
      expect(empty.statusCode).toBe(200);
      const body = empty.json() as { pages: unknown[]; count: number; limit: number };
      expect(body.pages).toEqual([]);
      expect(body.count).toBe(0);
      // Still an ordinary list response, paging included: the UI renders its
      // empty state instead of an error.
      expect(body.limit).toBe(20);

      // Without the type filter the same unknown scope still returns the global
      // pages, and none of another chat's.
      const globalsOnly = await app.inject({
        method: 'GET',
        url: '/api/knowledge/pages?scope=wechat:ghost',
      });
      expect(
        (globalsOnly.json() as { pages: Array<{ scope: string }> }).pages.map((p) => p.scope),
      ).toEqual(['global']);

      // An empty parameter is "no filter", not "global only" — the console only
      // narrows when it is asked to.
      const blank = await app.inject({ method: 'GET', url: '/api/knowledge/pages?scope=' });
      expect((blank.json() as { count: number }).count).toBe(3);
    });

    it('carries the scope in the detail payload', async () => {
      const scoped = seedPage({
        pageType: 'topic',
        slug: 'feishu-only',
        title: 'Feishu Only',
        content: 'Feishu 群里的正文',
        scope: 'feishu:oc_1',
      });

      const byId = await app.inject({ method: 'GET', url: `/api/knowledge/page/${scoped}` });
      expect(byId.statusCode).toBe(200);
      expect((byId.json() as { page: { scope: string } }).page.scope).toBe('feishu:oc_1');

      const byPair = await app.inject({
        method: 'GET',
        url: '/api/knowledge/page/topic/feishu-only',
      });
      expect(byPair.statusCode).toBe(200);
      expect((byPair.json() as { page: { scope: string } }).page.scope).toBe('feishu:oc_1');

      // A page written without a scope is global, and the detail says so.
      const global = await app.inject({ method: 'GET', url: `/api/knowledge/page/${POWER_QUERY}` });
      expect((global.json() as { page: { scope: string } }).page.scope).toBe('global');
    });

    it('filters the review queue by scope and keeps the global drafts', async () => {
      const feishuDraft = seedPage({
        pageType: 'entity',
        slug: 'wework',
        title: 'WeWork',
        content: 'WeWork 的正文',
        status: 'pending',
        scope: 'feishu:oc_1',
      });
      const otherDraft = seedPage({
        pageType: 'entity',
        slug: 'other-chat',
        title: 'Other Chat',
        content: '别的群的正文',
        status: 'pending',
        scope: 'telegram:session:s1',
      });

      const all = await app.inject({ method: 'GET', url: '/api/knowledge/pending' });
      const allBody = all.json() as { pages: Array<{ id: string; scope: string }>; count: number };
      expect(allBody.count).toBe(3);
      expect(allBody.pages.find((page) => page.id === SHADOW)?.scope).toBe('global');
      expect(allBody.pages.find((page) => page.id === feishuDraft)?.scope).toBe('feishu:oc_1');

      const scoped = await app.inject({
        method: 'GET',
        url: '/api/knowledge/pending?scope=feishu:oc_1',
      });
      expect(scoped.statusCode).toBe(200);
      const body = scoped.json() as { pages: Array<{ id: string }>; count: number };
      // The global draft is still this chat's to review; the telegram one is not.
      expect(body.pages.map((page) => page.id).sort()).toEqual([SHADOW, feishuDraft].sort());
      expect(body.count).toBe(2);
      expect(body.pages.map((page) => page.id)).not.toContain(otherDraft);
    });

    it('writes a console page as global, so every chat can read it', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/api/knowledge/page',
        payload: {
          pageType: 'topic',
          title: 'Console Page',
          content: '控制台写入的正文',
          sources: [{ kind: 'memory', id: MEMORY_A }],
        },
      });
      expect(created.statusCode).toBe(201);
      const id = (created.json() as { id: string }).id;

      const detail = await app.inject({ method: 'GET', url: `/api/knowledge/page/${id}` });
      expect((detail.json() as { page: { scope: string } }).page.scope).toBe('global');

      // And the page a reviewer approves is readable from a chat — the whole
      // reason the queue writes global.
      const inChat = await app.inject({
        method: 'GET',
        url: '/api/knowledge/pages?scope=feishu:oc_1',
      });
      expect(
        (inChat.json() as { pages: Array<{ id: string }> }).pages.map((page) => page.id),
      ).toContain(id);
    });
  });

  describe('GET /api/knowledge/search', () => {
    it('requires q', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/knowledge/search' });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('q is required');
    });

    it('finds a body term and returns a snippet around it', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/knowledge/search?q=VLOOKUP' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        q: string;
        hits: Array<{ id: string; slug: string; pageType: string; snippet: string; score: number }>;
        count: number;
        limit: number;
      };
      expect(body.q).toBe('VLOOKUP');
      expect(body.count).toBe(1);
      expect(body.hits[0]).toMatchObject({
        id: POWER_QUERY,
        slug: 'power-query',
        pageType: 'topic',
      });
      expect(body.hits[0].snippet).toContain('VLOOKUP');
      expect(typeof body.hits[0].score).toBe('number');
    });

    it('honours pageType, tag and limit', async () => {
      const wrongType = await app.inject({
        method: 'GET',
        url: '/api/knowledge/search?q=VLOOKUP&pageType=entity',
      });
      expect((wrongType.json() as { hits: unknown[] }).hits).toEqual([]);

      const tagged = await app.inject({
        method: 'GET',
        url: '/api/knowledge/search?q=VLOOKUP&tag=data',
      });
      expect((tagged.json() as { hits: Array<{ id: string }> }).hits.map((h) => h.id)).toEqual([
        POWER_QUERY,
      ]);

      const wrongTag = await app.inject({
        method: 'GET',
        url: '/api/knowledge/search?q=VLOOKUP&tag=nope',
      });
      expect((wrongTag.json() as { hits: unknown[] }).hits).toEqual([]);

      const limited = await app.inject({
        method: 'GET',
        url: '/api/knowledge/search?q=VLOOKUP&limit=1',
      });
      expect((limited.json() as { limit: number }).limit).toBe(1);
    });

    it('rejects an unknown pageType', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/knowledge/search?q=VLOOKUP&pageType=bogus',
      });
      expect(res.statusCode).toBe(400);
    });

    it('does not return a pending page for a matching query', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/knowledge/search?q=电池' });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { hits: unknown[] }).hits).toEqual([]);
    });
  });

  describe('GET /api/knowledge/page/:id and /page/:pageType/:slug', () => {
    it('returns the page with its sources and its dangling links', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/knowledge/page/${POWER_QUERY}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        page: { id: string; version: number; tags: string[]; updatedBy: string };
        sources: Array<{ kind: string; id: string; createdAt: number | null }>;
        links: Array<{ slug: string; label: string | null; missing: boolean }>;
        backlinks: Array<{ slug: string; title: string; label: string | null }>;
      };
      expect(body.page).toMatchObject({ id: POWER_QUERY, version: 1, tags: ['data'] });
      expect(body.sources).toHaveLength(1);
      expect(body.sources[0]).toMatchObject({ kind: 'memory', id: MEMORY_A });
      // A link to a page that does not exist is reported, not dropped: the
      // editor renders it as a "create this page" affordance.
      expect(body.links).toEqual([{ slug: 'entity/globex', label: null, missing: true }]);
      expect(body.backlinks).toEqual([]);
    });

    it('names the pages that cite this one', async () => {
      seedPage({
        pageType: 'topic',
        slug: 'excel-etl',
        title: 'Excel ETL',
        content: '见 [[topic/power-query|PQ]]。',
      });

      const res = await app.inject({ method: 'GET', url: `/api/knowledge/page/${POWER_QUERY}` });
      expect(res.statusCode).toBe(200);
      expect(
        (
          res.json() as {
            backlinks: Array<{
              slug: string;
              title: string;
              label: string | null;
              relation_type: string | null;
            }>;
          }
        ).backlinks,
      ).toEqual([{ slug: 'excel-etl', title: 'Excel ETL', label: 'PQ', relation_type: 'ABOUT' }]);

      // The type + slug address serves the same detail.
      const byPair = await app.inject({
        method: 'GET',
        url: '/api/knowledge/page/topic/power-query',
      });
      expect(
        (byPair.json() as { backlinks: Array<{ slug: string }> }).backlinks.map(
          (backlink) => backlink.slug,
        ),
      ).toEqual(['excel-etl']);
    });

    it('resolves type + slug and 404s an unknown pair', async () => {
      const ok = await app.inject({
        method: 'GET',
        url: '/api/knowledge/page/topic/power-query',
      });
      expect(ok.statusCode).toBe(200);
      expect((ok.json() as { page: { id: string } }).page.id).toBe(POWER_QUERY);

      const wrongType = await app.inject({
        method: 'GET',
        url: '/api/knowledge/page/entity/power-query',
      });
      expect(wrongType.statusCode).toBe(404);

      const missing = await app.inject({
        method: 'GET',
        url: '/api/knowledge/page/topic/no-such-page',
      });
      expect(missing.statusCode).toBe(404);
      expect((missing.json() as { error: string }).error).toBe('Not Found');
    });

    it('rejects an unknown pageType in the path', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/knowledge/page/person/power-query',
      });
      expect(res.statusCode).toBe(400);
    });

    it('404s an unknown id', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/knowledge/page/no-such-id' });
      expect(res.statusCode).toBe(404);
    });

    it('404s a pending page by id — its body belongs to the review queue', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/knowledge/page/${SHADOW}` });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('PUT /api/knowledge/page/:id', () => {
    it('writes as the user and bumps the version', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/knowledge/page/${POWER_QUERY}`,
        payload: { content: 'Power Query 的正文改写', expectedVersion: 1 },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; id: string; version: number; created: boolean };
      expect(body).toMatchObject({ ok: true, id: POWER_QUERY, version: 2, created: false });

      const detail = await app.inject({ method: 'GET', url: `/api/knowledge/page/${POWER_QUERY}` });
      const page = (detail.json() as { page: { content: string; updatedBy: string } }).page;
      expect(page.content).toBe('Power Query 的正文改写');
      expect(page.updatedBy).toBe('user');
    });

    it('409s a stale expectedVersion and hands back the current body', async () => {
      // Someone else edited the page after this client read version 1.
      const first = await app.inject({
        method: 'PUT',
        url: `/api/knowledge/page/${POWER_QUERY}`,
        payload: { content: '别人已经改过的正文', expectedVersion: 1 },
      });
      expect(first.statusCode).toBe(200);

      const stale = await app.inject({
        method: 'PUT',
        url: `/api/knowledge/page/${POWER_QUERY}`,
        payload: { content: '我的编辑', expectedVersion: 1 },
      });
      expect(stale.statusCode).toBe(409);
      const body = stale.json() as {
        code: string;
        currentVersion: number;
        currentContent: string;
      };
      expect(body.code).toBe('version_conflict');
      expect(body.currentVersion).toBe(2);
      expect(body.currentContent).toBe('别人已经改过的正文');

      // Nothing was overwritten.
      const detail = await app.inject({ method: 'GET', url: `/api/knowledge/page/${POWER_QUERY}` });
      const page = (detail.json() as { page: { content: string; version: number } }).page;
      expect(page.content).toBe('别人已经改过的正文');
      expect(page.version).toBe(2);
    });

    it('400s a missing or non-integer expectedVersion', async () => {
      const missing = await app.inject({
        method: 'PUT',
        url: `/api/knowledge/page/${POWER_QUERY}`,
        payload: { content: 'x' },
      });
      expect(missing.statusCode).toBe(400);
      expect((missing.json() as { error: string }).error).toContain('expectedVersion');

      const fractional = await app.inject({
        method: 'PUT',
        url: `/api/knowledge/page/${POWER_QUERY}`,
        payload: { content: 'x', expectedVersion: 1.5 },
      });
      expect(fractional.statusCode).toBe(400);
    });

    it('400s status in the body — approval is a separate endpoint', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/knowledge/page/${SHADOW}`,
        payload: { status: 'active', expectedVersion: 1 },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toContain('/approve');

      const queue = await app.inject({ method: 'GET', url: '/api/knowledge/pending' });
      expect((queue.json() as { pages: Array<{ id: string }> }).pages.map((p) => p.id)).toEqual([
        SHADOW,
      ]);
    });

    it('400s an edit with no editable field', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/knowledge/page/${POWER_QUERY}`,
        payload: { expectedVersion: 1 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('400s a citation that does not resolve', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/knowledge/page/${POWER_QUERY}`,
        payload: {
          expectedVersion: 1,
          sources: [{ kind: 'memory', id: 'memory-does-not-exist' }],
        },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json() as { code: string; missing: Array<{ id: string }> };
      expect(body.code).toBe('unknown_sources');
      expect(body.missing).toEqual([{ kind: 'memory', id: 'memory-does-not-exist' }]);
    });

    it('400s a source of an unknown kind', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/knowledge/page/${POWER_QUERY}`,
        payload: { expectedVersion: 1, sources: [{ kind: 'notebook', id: 'n1' }] },
      });
      expect(res.statusCode).toBe(400);
    });

    it('404s an unknown page', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/knowledge/page/no-such-id',
        payload: { content: 'x', expectedVersion: 1 },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/knowledge/page', () => {
    it('creates a page, deriving the slug from the title', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/knowledge/page',
        payload: {
          pageType: 'decision',
          title: 'Adopt SQLite as primary store',
          content: '决定用 SQLite 主存，markdown 只做导出',
          sources: [{ kind: 'session', id: SESSION_ID }],
          tags: ['storage'],
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as {
        ok: boolean;
        created: boolean;
        id: string;
        slug: string;
        pageType: string;
        status: string;
        version: number;
        danglingLinks: string[];
      };
      expect(body).toMatchObject({
        ok: true,
        created: true,
        slug: 'adopt-sqlite-as-primary-store',
        pageType: 'decision',
        status: 'active',
        version: 1,
        danglingLinks: [],
      });

      const detail = await app.inject({ method: 'GET', url: `/api/knowledge/page/${body.id}` });
      expect(detail.statusCode).toBe(200);
      const page = (detail.json() as { page: { updatedBy: string; tags: string[] } }).page;
      expect(page.updatedBy).toBe('user');
      expect(page.tags).toEqual(['storage']);
    });

    it('normalises an explicit slug', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/knowledge/page',
        payload: {
          pageType: 'topic',
          slug: '  Data   Warehouse ',
          title: 'Data Warehouse',
          content: 'body',
          sources: [{ kind: 'message', id: MESSAGE_ID }],
        },
      });
      expect(res.statusCode).toBe(201);
      expect((res.json() as { slug: string }).slug).toBe('data-warehouse');
    });

    it('409s a pageType/slug that already exists, with the current body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/knowledge/page',
        payload: {
          pageType: 'topic',
          slug: 'power-query',
          title: 'Power Query',
          content: '重写的正文',
          sources: [{ kind: 'memory', id: MEMORY_A }],
        },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json() as {
        code: string;
        currentVersion: number;
        currentContent: string;
      };
      expect(body.code).toBe('version_conflict');
      expect(body.currentVersion).toBe(1);
      expect(body.currentContent).toContain('VLOOKUP');
    });

    it('400s a create with no citation', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/knowledge/page',
        payload: { pageType: 'topic', title: 'Orphan', content: 'body' },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toContain('sources');
    });

    it('400s an unknown pageType or an empty title', async () => {
      const badType = await app.inject({
        method: 'POST',
        url: '/api/knowledge/page',
        payload: { pageType: 'person', title: 'T', content: 'b', sources: [] },
      });
      expect(badType.statusCode).toBe(400);

      const badTitle = await app.inject({
        method: 'POST',
        url: '/api/knowledge/page',
        payload: {
          pageType: 'topic',
          title: '   ',
          content: 'b',
          sources: [{ kind: 'memory', id: MEMORY_A }],
        },
      });
      expect(badTitle.statusCode).toBe(400);
    });

    it('400s a title no slug can be derived from', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/knowledge/page',
        payload: {
          pageType: 'topic',
          title: '🎉🎉',
          content: 'body',
          sources: [{ kind: 'memory', id: MEMORY_A }],
        },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toContain('slug');
    });
  });

  describe('POST /api/knowledge/page/:id/approve and /archive', () => {
    it('approve moves a pending page into the browse list and out of the queue', async () => {
      const before = await app.inject({ method: 'GET', url: `/api/knowledge/page/${SHADOW}` });
      expect(before.statusCode).toBe(404);

      const res = await app.inject({
        method: 'POST',
        url: `/api/knowledge/page/${SHADOW}/approve`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        ok: boolean;
        status: string;
        page: { page: { id: string; status: string } } | null;
      };
      expect(body.ok).toBe(true);
      expect(body.status).toBe('active');
      // The refreshed page comes back in the same detail shape as GET /page/:id.
      expect(body.page?.page).toMatchObject({ id: SHADOW, status: 'active' });

      const listed = await app.inject({ method: 'GET', url: '/api/knowledge/pages' });
      expect((listed.json() as { pages: Array<{ id: string }> }).pages.map((p) => p.id)).toContain(
        SHADOW,
      );

      const queue = await app.inject({ method: 'GET', url: '/api/knowledge/pending' });
      expect((queue.json() as { pages: unknown[] }).pages).toEqual([]);

      // And it is now readable as a page.
      const after = await app.inject({ method: 'GET', url: `/api/knowledge/page/${SHADOW}` });
      expect(after.statusCode).toBe(200);
    });

    it('archive removes a page from the default list but keeps the row', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/knowledge/page/${POWER_QUERY}/archive`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { status: string; page: unknown };
      expect(body.status).toBe('archived');
      // `service.get` is active-only, so the detail cannot be re-read here.
      expect(body.page).toBeNull();

      const listed = await app.inject({ method: 'GET', url: '/api/knowledge/pages' });
      expect((listed.json() as { pages: unknown[] }).pages).toEqual([]);

      const archived = await app.inject({
        method: 'GET',
        url: '/api/knowledge/pages?status=archived',
      });
      expect((archived.json() as { pages: Array<{ id: string }> }).pages.map((p) => p.id)).toEqual(
        expect.arrayContaining([POWER_QUERY]),
      );
    });

    it('404s both actions on an unknown page', async () => {
      expect(
        (await app.inject({ method: 'POST', url: '/api/knowledge/page/nope/approve' })).statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ method: 'POST', url: '/api/knowledge/page/nope/archive' })).statusCode,
      ).toBe(404);
    });
  });

  describe('GET /api/knowledge/stats', () => {
    it('counts by status and pageType, and reports a consistent index', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/knowledge/stats' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        total: number;
        byStatus: Record<string, number>;
        byPageType: Record<string, number>;
        fts: { consistent: boolean; pageCount: number; indexedRowCount: number } | null;
      };
      expect(body.total).toBe(3);
      expect(body.byStatus).toEqual({ active: 1, pending: 1, archived: 1 });
      expect(body.byPageType).toEqual({
        entity: 1,
        project: 0,
        topic: 2,
        decision: 0,
        snippet: 0,
      });
      expect(body.fts).toMatchObject({ consistent: true, pageCount: 3, indexedRowCount: 3 });
    });

    it('reports index drift instead of a blanket ok', async () => {
      db.prepare('DELETE FROM knowledge_fts_jieba WHERE page_id = ?').run(POWER_QUERY);

      const res = await app.inject({ method: 'GET', url: '/api/knowledge/stats' });
      const body = res.json() as {
        fts: { consistent: boolean; missingPageIds: string[]; indexedRowCount: number };
      };
      expect(body.fts.consistent).toBe(false);
      expect(body.fts.indexedRowCount).toBe(2);
      expect(body.fts.missingPageIds).toEqual([POWER_QUERY]);
    });

    it('reports zeros on an install with no pages', async () => {
      const emptyDb = openDatabase(':memory:');
      const emptyApp = Fastify({ logger: false });
      registerKnowledgeRoutes(emptyApp, { db: emptyDb, service: knowledgeService(emptyDb) });
      await emptyApp.ready();
      try {
        const res = await emptyApp.inject({ method: 'GET', url: '/api/knowledge/stats' });
        expect(res.statusCode).toBe(200);
        const body = res.json() as {
          total: number;
          byStatus: Record<string, number>;
          byPageType: Record<string, number>;
          fts: { consistent: boolean } | null;
        };
        expect(body.total).toBe(0);
        expect(body.byStatus).toEqual({ active: 0, pending: 0, archived: 0 });
        expect(body.byPageType).toEqual({
          entity: 0,
          project: 0,
          topic: 0,
          decision: 0,
          snippet: 0,
        });
        // An empty index is consistent — nothing is missing from it.
        expect(body.fts).toMatchObject({ consistent: true });
      } finally {
        await emptyApp.close();
        emptyDb.close();
      }
    });
  });
});
