/**
 * Tests for the read-only knowledge-graph API (graph-routes.ts).
 *
 * Covers the WebUI↔server contract:
 *   GET /api/memory/graph        — overview (degree-ordered) and neighbourhood
 *                                  payloads, depth / asOf / types / limit filters
 *   GET /api/memory/entity/:id   — entity record + alias list
 *   GET /api/search              — unified entity / memory / message retrieval
 *
 * The graph tables are populated by a background sync, so the "tables are
 * EMPTY" case is a first-class contract here, not an edge case: those endpoints
 * must answer with well-formed empty payloads and the UI must show an empty
 * state — never a 500.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../../src/memory/db';
import { registerGraphRoutes } from '../../../src/app/webui/graph-routes';
import { EntityRepository } from '../../../src/memory/repositories/entity-repository';
import { MemoryRepository } from '../../../src/memory/repositories/memory-repository';
import { EmbeddingRepository } from '../../../src/memory/repositories/embedding-repository';
import { EmbeddingCacheRepo } from '../../../src/memory/repositories/embedding-cache-repository';
import { MemoryRetriever } from '../../../src/memory/memory-retriever';
import { tokenizeForIndex } from '../../../src/memory/fts-tokenizer';
import { createKnowledgeService } from '../../../src/memory/knowledge/service';
import type { KnowledgeService } from '../../../src/memory/knowledge/service-contract';

describe('knowledge-graph routes', () => {
  let db: Database.Database;
  let app: ReturnType<typeof Fastify>;
  let repo: EntityRepository;
  /** Held so a test can prove a filtered leg is not called at all. */
  let retriever: MemoryRetriever;

  const ids = {
    alice: 'ent-alice',
    bob: 'ent-bob',
    acme: 'ent-acme',
    berlin: 'ent-berlin',
    emea: 'ent-emea',
  };
  /** Retraction instant for alice→berlin; asOf comparisons pivot on it. */
  const RETRACTED_AT = 1_700_000_000_000;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    repo = new EntityRepository(db);
    seedGraph();
    app = Fastify({ logger: false });
    retriever = createRetriever(db);
    registerGraphRoutes(app, { db, memoryRetriever: retriever });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  /** Four entities and four edges — enough for depth-2 and retraction cases. */
  function seedGraph(): void {
    db.prepare(
      `INSERT INTO entities (id, name, canonical_name, entity_type, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(ids.alice, 'Alice', 'alice', 'person', 'A teammate who likes tea', 1, 1);
    db.prepare(
      `INSERT INTO entities (id, name, canonical_name, entity_type, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(ids.bob, 'Bob', 'bob', 'person', null, 1, 1);
    db.prepare(
      `INSERT INTO entities (id, name, canonical_name, entity_type, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(ids.acme, 'Acme', 'acme', 'organization', null, 1, 1);
    db.prepare(
      `INSERT INTO entities (id, name, canonical_name, entity_type, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(ids.berlin, 'Berlin', 'berlin', 'place', null, 1, 1);
    db.prepare(
      `INSERT INTO entities (id, name, canonical_name, entity_type, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(ids.emea, 'EMEA', 'emea', 'region', null, 1, 1);

    // Valid edges.
    repo.linkEntities({ sourceId: ids.alice, targetId: ids.acme, relationType: 'works_at' });
    repo.linkEntities({ sourceId: ids.alice, targetId: ids.bob, relationType: 'knows' });
    repo.linkEntities({ sourceId: ids.bob, targetId: ids.berlin, relationType: 'lives_in' });
    // Only reachable from Alice at depth 2 (alice → berlin → emea).
    repo.linkEntities({ sourceId: ids.berlin, targetId: ids.emea, relationType: 'part_of' });

    // Retracted edge: kept in the table with valid_to set (history, not delete).
    const retracted = repo.linkEntities({
      sourceId: ids.alice,
      targetId: ids.berlin,
      relationType: 'was_at',
      validFrom: RETRACTED_AT - 5_000,
    });
    repo.retractEdge(retracted.id, RETRACTED_AT);

    repo.addAlias(ids.alice, '艾丽丝');
  }

  /** Real retriever over the same DB; textOnly never touches the embedding API. */
  function createRetriever(database: Database.Database): MemoryRetriever {
    return new MemoryRetriever({
      memoryRepository: new MemoryRepository(database),
      embeddingRepository: new EmbeddingRepository(database),
      embeddingCacheRepo: new EmbeddingCacheRepo(database),
      embeddingClient: {
        model: 'stub',
        isConfigured: () => false,
        embedOne: async () => new Float32Array(0),
      },
      db: database,
    });
  }

  function seedMessage(
    id: string,
    sessionId: string,
    content: string,
    createdAt = 1_600_000_000_000,
  ) {
    db.prepare(
      `INSERT INTO sessions (id, chat_id, user_id, project_id, channel, external_chat_id, title, metadata, created_at, updated_at)
       VALUES (?, ?, 'webui-user', NULL, NULL, ?, NULL, NULL, ?, ?)`,
    ).run(sessionId, sessionId, sessionId, String(createdAt), String(createdAt));
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)`,
    ).run(id, sessionId, content, String(createdAt));
    // migration-v10 backfilled the index before this row existed.
    db.prepare(
      `INSERT INTO messages_fts_jieba (content, content_original, message_id, session_id, role, created_at)
       VALUES (?, ?, ?, ?, 'user', ?)`,
    ).run(tokenizeForIndex(content), content, id, sessionId, createdAt);
  }

  // ─── GET /api/memory/graph ───────────────────────────────────────────────

  describe('GET /api/memory/graph', () => {
    it('returns an empty, well-formed payload when nothing was ever written', async () => {
      db.exec('DELETE FROM entity_edges; DELETE FROM entity_aliases; DELETE FROM entities');

      const response = await app.inject({ method: 'GET', url: '/api/memory/graph' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ nodes: [], edges: [], truncated: false });
    });

    it('overviews the busiest entities first and only the edges between them', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/memory/graph?limit=5' });
      expect(response.statusCode).toBe(200);
      const payload = response.json();

      expect(payload.truncated).toBe(false);
      // alice: works_at + knows + was_at = 3 → first; the 2-degree pair is
      // ordered by canonical name (berlin before bob).
      expect(payload.nodes.map((node: { id: string }) => node.id)).toEqual([
        ids.alice,
        ids.berlin,
        ids.bob,
        ids.acme,
        ids.emea,
      ]);
      expect(payload.nodes[0]).toEqual({
        id: ids.alice,
        name: 'Alice',
        canonical_name: 'alice',
        entity_type: 'person',
        description: 'A teammate who likes tea',
        degree: 3,
      });

      // Every edge has both endpoints in the node list.
      const nodeIds = new Set(payload.nodes.map((node: { id: string }) => node.id));
      for (const edge of payload.edges) {
        expect(nodeIds.has(edge.source)).toBe(true);
        expect(nodeIds.has(edge.target)).toBe(true);
        expect(typeof edge.confidence).toBe('number');
      }
      // All five edges, the retracted one included (no asOf filter).
      expect(payload.edges).toHaveLength(5);
    });

    it('reports truncation instead of returning an unbounded overview', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/memory/graph?limit=2' });
      const payload = response.json();

      expect(payload.nodes).toHaveLength(2);
      expect(payload.truncated).toBe(true);
    });

    it('resolves an entity by id, canonical name and alias', async () => {
      for (const ref of [ids.alice, 'Alice', 'alice', '艾丽丝']) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/memory/graph?entity=${encodeURIComponent(ref)}`,
        });
        expect(response.statusCode, `entity=${ref}`).toBe(200);
        expect(response.json().nodes[0].id).toBe(ids.alice);
      }
    });

    it('walks exactly one hop by default and two with depth=2', async () => {
      const oneHop = (
        await app.inject({ method: 'GET', url: `/api/memory/graph?entity=${ids.alice}` })
      ).json();
      const oneHopIds = oneHop.nodes.map((node: { id: string }) => node.id);
      expect(oneHopIds).toEqual(expect.arrayContaining([ids.alice, ids.acme, ids.bob, ids.berlin]));
      expect(oneHopIds).not.toContain(ids.emea);

      const twoHops = (
        await app.inject({ method: 'GET', url: `/api/memory/graph?entity=${ids.alice}&depth=2` })
      ).json();
      expect(twoHops.nodes.map((node: { id: string }) => node.id)).toContain(ids.emea);
    });

    it('honours asOf: a retracted fact is present before the retraction, gone after it', async () => {
      const before = (
        await app.inject({
          method: 'GET',
          url: `/api/memory/graph?entity=${ids.alice}&asOf=${RETRACTED_AT - 1}`,
        })
      ).json();
      const retractedEdge = before.edges.find((edge: { relation_type: string }) => {
        return edge.relation_type === 'was_at';
      });
      expect(retractedEdge).toBeDefined();
      expect(retractedEdge.valid_to).toBe(RETRACTED_AT);

      const after = (
        await app.inject({
          method: 'GET',
          url: `/api/memory/graph?entity=${ids.alice}&asOf=${RETRACTED_AT + 1}`,
        })
      ).json();
      expect(
        after.edges.some((edge: { relation_type: string }) => edge.relation_type === 'was_at'),
      ).toBe(false);
      expect(after.nodes.map((node: { id: string }) => node.id)).not.toContain(ids.berlin);
    });

    it('restricts traversal to the requested relation types', async () => {
      const payload = (
        await app.inject({
          method: 'GET',
          url: `/api/memory/graph?entity=${ids.alice}&types=works_at`,
        })
      ).json();

      expect(payload.nodes.map((node: { id: string }) => node.id)).toEqual([ids.alice, ids.acme]);
      expect(payload.edges.map((edge: { relation_type: string }) => edge.relation_type)).toEqual([
        'works_at',
      ]);
    });

    it('404s when the requested entity names nothing', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/memory/graph?entity=nobody' });
      expect(response.statusCode).toBe(404);
    });

    it('404s for an entity on a database that has no graph tables at all', async () => {
      const bare = openDatabase(':memory:');
      bare.exec('DROP TABLE entity_edges; DROP TABLE entity_aliases; DROP TABLE entities');
      const bareApp = Fastify({ logger: false });
      registerGraphRoutes(bareApp, { db: bare });
      await bareApp.ready();

      try {
        expect((await bareApp.inject({ method: 'GET', url: '/api/memory/graph' })).json()).toEqual({
          nodes: [],
          edges: [],
          truncated: false,
        });
        const missing = await bareApp.inject({
          method: 'GET',
          url: '/api/memory/graph?entity=alice',
        });
        expect(missing.statusCode).toBe(404);
      } finally {
        await bareApp.close();
        bare.close();
      }
    });

    it('is not shadowed by the parameterised /api/memory/:id route', async () => {
      const shared = Fastify({ logger: false });
      shared.get('/api/memory/:id', async (_request, reply) => reply.send({ shadowed: true }));
      registerGraphRoutes(shared, { db });
      await shared.ready();

      try {
        const response = await shared.inject({ method: 'GET', url: '/api/memory/graph' });
        expect(response.json()).not.toEqual({ shadowed: true });
        expect(response.json().nodes.length).toBeGreaterThan(0);
      } finally {
        await shared.close();
      }
    });
  });

  // ─── GET /api/memory/entity/:id ──────────────────────────────────────────

  describe('GET /api/memory/entity/:id', () => {
    it('returns the entity record with its aliases', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/memory/entity/${ids.alice}` });

      expect(response.statusCode).toBe(200);
      const payload = response.json();
      expect(payload.entity.id).toBe(ids.alice);
      expect(payload.entity.entity_type).toBe('person');
      expect(payload.aliases).toEqual(['艾丽丝']);
    });

    it('404s for an unknown entity id', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/memory/entity/missing' });
      expect(response.statusCode).toBe(404);
    });
  });

  // ─── GET /api/search ─────────────────────────────────────────────────────

  describe('GET /api/search', () => {
    it('rejects a blank query', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/search' })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/api/search?q=%20%20' })).statusCode).toBe(
        400,
      );
    });

    it('limits the response to the kinds asked for', async () => {
      new MemoryRepository(db).create({
        id: 'mem-alice',
        scope: 'user',
        scope_key: 'user-1',
        kind: 'preference',
        content: 'Alice prefers dark mode',
      });
      seedMessage('msg-alice', 'sess-alice', 'Alice and Bob met in Berlin');

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=Alice&kinds=entity,message',
      });
      expect(response.statusCode).toBe(200);
      const kinds = response.json().results.map((result: { kind: string }) => result.kind);
      expect(kinds).toContain('entity');
      expect(kinds).toContain('message');
      // Filtering server-side matters because each leg is capped at `limit`:
      // hiding a kind in the UI after the fact would return a short page.
      expect(kinds).not.toContain('memory');
    });

    it('skips the memory leg entirely when it is filtered out', async () => {
      new MemoryRepository(db).create({
        id: 'mem-alice',
        scope: 'user',
        scope_key: 'user-1',
        kind: 'preference',
        content: 'Alice prefers dark mode',
      });
      const spy = vi.spyOn(retriever, 'retrieve');
      await app.inject({ method: 'GET', url: '/api/search?q=Alice&kinds=entity' });
      // The only leg that can reach the provider must not be touched.
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('narrows the memory leg to the requested memory kinds', async () => {
      const memories = new MemoryRepository(db);
      memories.create({
        id: 'mem-pref',
        scope: 'user',
        scope_key: 'user-1',
        kind: 'preference',
        content: 'Alice prefers dark mode',
      });
      memories.create({
        id: 'mem-fact',
        scope: 'user',
        scope_key: 'user-1',
        kind: 'fact',
        content: 'Alice works in Berlin',
      });

      const onlyFacts = await app.inject({
        method: 'GET',
        url: '/api/search?q=Alice&kinds=memory&memory_kinds=fact',
      });
      expect(onlyFacts.statusCode).toBe(200);
      const factIds = onlyFacts.json().results.map((result: { id: string }) => result.id);
      expect(factIds).toContain('mem-fact');
      expect(factIds).not.toContain('mem-pref');

      // Absent parameter keeps the old behaviour: every memory kind.
      const allKinds = await app.inject({ method: 'GET', url: '/api/search?q=Alice&kinds=memory' });
      const allIds = allKinds.json().results.map((result: { id: string }) => result.id);
      expect(allIds).toEqual(expect.arrayContaining(['mem-fact', 'mem-pref']));
    });

    it('rejects an empty memory_kinds list', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=Alice&memory_kinds=,',
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects an unknown or empty kind list', async () => {
      const unknown = await app.inject({
        method: 'GET',
        url: '/api/search?q=Alice&kinds=entity,file',
      });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().error).toContain('file');

      const empty = await app.inject({ method: 'GET', url: '/api/search?q=Alice&kinds=,' });
      expect(empty.statusCode).toBe(400);
    });

    it('finds entities, memories and messages in one response', async () => {
      new MemoryRepository(db).create({
        id: 'mem-alice',
        scope: 'user',
        scope_key: 'user-1',
        kind: 'preference',
        content: 'Alice prefers dark mode',
      });
      seedMessage('msg-alice', 'sess-alice', 'Alice and Bob met in Berlin');

      const response = await app.inject({ method: 'GET', url: '/api/search?q=Alice' });
      expect(response.statusCode).toBe(200);
      const payload = response.json();

      expect(payload.q).toBe('Alice');
      const kinds = payload.results.map((result: { kind: string }) => result.kind);
      expect(kinds).toContain('entity');
      expect(kinds).toContain('memory');
      expect(kinds).toContain('message');

      const entityHit = payload.results.find(
        (result: { kind: string }) => result.kind === 'entity',
      );
      expect(entityHit).toMatchObject({
        id: ids.alice,
        title: 'Alice',
        snippet: 'A teammate who likes tea',
      });

      const messageHit = payload.results.find(
        (result: { kind: string }) => result.kind === 'message',
      );
      expect(messageHit).toMatchObject({ id: 'msg-alice', session_id: 'sess-alice' });
      expect(messageHit.created_at).toBe(1_600_000_000_000);

      // Stable, ordered by score.
      const scores = payload.results.map((result: { score: number }) => result.score);
      expect([...scores].sort((a: number, b: number) => b - a)).toEqual(scores);
    });

    it('matches message text after HTML is stripped from the snippet', async () => {
      seedMessage('msg-html', 'sess-html', '<b>Berlin</b> is where Bob lives');

      const payload = (
        await app.inject({ method: 'GET', url: '/api/search?q=Berlin&limit=5' })
      ).json();
      const hit = payload.results.find((result: { id: string }) => result.id === 'msg-html');
      expect(hit).toBeDefined();
      // The row is title + snippet read as one string: the head goes in the
      // title, so the match is asserted against the pair, not the snippet alone.
      expect(hit.title).not.toContain('<');
      expect(hit.snippet).not.toContain('<');
      expect(`${hit.title} ${hit.snippet}`).toContain('Berlin');
    });

    it('truncates long titles and snippets', async () => {
      db.prepare('UPDATE entities SET description = ? WHERE id = ?').run('x'.repeat(500), ids.bob);

      const payload = (await app.inject({ method: 'GET', url: '/api/search?q=Bob' })).json();
      const hit = payload.results.find((result: { id: string }) => result.id === ids.bob);
      expect(hit.snippet.length).toBeLessThanOrEqual(201);
      expect(hit.snippet.endsWith('…')).toBe(true);
    });

    it('answers entities and messages only when no memory retriever is wired', async () => {
      const bareApp = Fastify({ logger: false });
      registerGraphRoutes(bareApp, { db });
      await bareApp.ready();

      try {
        const response = await bareApp.inject({ method: 'GET', url: '/api/search?q=Alice' });
        expect(response.statusCode).toBe(200);
        const kinds = response.json().results.map((result: { kind: string }) => result.kind);
        expect(kinds).toContain('entity');
        expect(kinds).not.toContain('memory');
      } finally {
        await bareApp.close();
      }
    });

    it('returns an empty result list on an empty graph instead of failing', async () => {
      db.exec('DELETE FROM entity_edges; DELETE FROM entity_aliases; DELETE FROM entities');

      const response = await app.inject({ method: 'GET', url: '/api/search?q=nothingmatches' });
      expect(response.statusCode).toBe(200);
      // `q` and `results` are the original contract; `pages` / `lanes` / `deduped`
      // are additive and stay well-formed when nothing matched.
      expect(response.json()).toEqual({
        q: 'nothingmatches',
        results: [],
        pages: [],
        lanes: {
          message: { hits: 0, dropped: 0 },
          memory: { hits: 0, dropped: 0 },
          knowledge: { hits: 0, dropped: 0 },
        },
        deduped: [],
      });
    });

    // ─── K5: the ranking comes from unifiedSearch(), not from this handler ───

    /** A second app with the knowledge lane wired — `app` stays the layer-off case. */
    async function appWithKnowledge(
      knowledge: Pick<KnowledgeService, 'search' | 'get'>,
    ): Promise<ReturnType<typeof Fastify>> {
      const wired = Fastify({ logger: false });
      registerGraphRoutes(wired, { db, memoryRetriever: retriever, knowledge });
      await wired.ready();
      return wired;
    }

    function seedMemory(id: string, content: string, kind = 'preference'): void {
      new MemoryRepository(db).create({
        id,
        scope: 'user',
        scope_key: 'user-1',
        kind,
        content,
      });
    }

    /**
     * One active page. `sources` must resolve to real rows — a page with no
     * citation is refused by the same anti-hallucination gate — so a test that
     * wants no page-wins dedupe cites a message instead of a memory.
     */
    function seedPage(
      knowledge: KnowledgeService,
      slug: string,
      content: string,
      sources: Array<{ kind: 'memory' | 'message'; id: string }>,
    ): void {
      const created = knowledge.create(
        { pageType: 'topic', slug, title: `Alice 的偏好 (${slug})`, content, sources },
        { actor: 'agent' },
      );
      expect(created.ok).toBe(true);
    }

    it('answers from all three lanes and reports what each contributed', async () => {
      seedMemory('mem-alice', 'Alice prefers dark mode');
      seedMessage('msg-alice', 'sess-alice', 'Alice and Bob met in Berlin');
      const knowledge = createKnowledgeService({ db });
      seedPage(knowledge, 'alice-topic', 'Alice 偏好深色主题。', [
        { kind: 'message', id: 'msg-alice' },
      ]);

      const wired = await appWithKnowledge(knowledge);
      try {
        const response = await wired.inject({ method: 'GET', url: '/api/search?q=Alice' });
        expect(response.statusCode).toBe(200);
        const payload = response.json();

        // Lane attribution: every lane says how many rows it returned.
        expect(payload.lanes.message.hits).toBeGreaterThan(0);
        expect(payload.lanes.memory.hits).toBeGreaterThan(0);
        expect(payload.lanes.knowledge.hits).toBeGreaterThan(0);

        const resultKinds = payload.results.map((result: { kind: string }) => result.kind);
        expect(resultKinds).toContain('message');
        expect(resultKinds).toContain('memory');

        // Pages ride in their own array, in the row shape the UI already renders.
        expect(payload.pages).toHaveLength(1);
        expect(payload.pages[0]).toMatchObject({ kind: 'knowledge', title: expect.any(String) });
        expect(payload.pages[0].title).toContain('Alice');
        expect(payload.deduped).toEqual([]);

        // One ordering across the fused lanes: within a kind the scores descend.
        const scores = payload.results.map((result: { score: number }) => result.score);
        expect([...scores].sort((a: number, b: number) => b - a)).toEqual(scores);
      } finally {
        await wired.close();
      }
    });

    it('drops a memory the returned page cites, and says which page covers it', async () => {
      seedMemory('mem-cited', 'Alice prefers dark mode');
      const knowledge = createKnowledgeService({ db });
      seedPage(knowledge, 'alice-topic', 'Alice 偏好深色主题。', [
        { kind: 'memory', id: 'mem-cited' },
      ]);

      const wired = await appWithKnowledge(knowledge);
      try {
        const response = await wired.inject({ method: 'GET', url: '/api/search?q=Alice' });
        expect(response.statusCode).toBe(200);
        const payload = response.json();

        const memoryIds = payload.results
          .filter((result: { kind: string }) => result.kind === 'memory')
          .map((result: { id: string }) => result.id);
        // Page wins: the memory it was curated from is not a second answer.
        expect(memoryIds).not.toContain('mem-cited');
        expect(payload.deduped).toEqual([
          {
            lane: 'memory',
            id: 'mem-cited',
            reason: 'cited_by_knowledge_page',
            page_slug: 'alice-topic',
          },
        ]);
        expect(payload.lanes.memory).toEqual({ hits: 1, dropped: 1 });
        expect(payload.pages).toHaveLength(1);
        expect(payload.pages[0].title).toContain('alice-topic');
      } finally {
        await wired.close();
      }
    });

    it('keeps the original response shape for a memory-only query', async () => {
      seedMemory('mem-alice', 'Alice prefers dark mode');

      const response = await app.inject({
        method: 'GET',
        url: '/api/search?q=Alice&kinds=memory',
      });
      expect(response.statusCode).toBe(200);
      const payload = response.json();

      // Nothing removed or renamed: `q` + `results` are the old payload, the rest
      // is additive (which is why the WebUI needs no change to keep working).
      expect(Object.keys(payload).sort()).toEqual(['deduped', 'lanes', 'pages', 'q', 'results']);
      expect(payload.q).toBe('Alice');
      expect(payload.pages).toEqual([]);
      expect(payload.lanes.memory).toEqual({ hits: 1, dropped: 0 });

      expect(payload.results).toHaveLength(1);
      const [row] = payload.results;
      expect(Object.keys(row).sort()).toEqual([
        'created_at',
        'id',
        'kind',
        'score',
        'snippet',
        'title',
      ]);
      expect(row).toMatchObject({
        kind: 'memory',
        id: 'mem-alice',
        title: 'Alice prefers dark mode',
        // title + snippet read as one string, as they did before the fusion.
        snippet: '',
      });
    });

    it('answers from the memory and message lanes when the knowledge layer is off', async () => {
      seedMemory('mem-alice', 'Alice prefers dark mode');
      seedMessage('msg-alice', 'sess-alice', 'Alice and Bob met in Berlin');

      // `app` was registered without a knowledge service — the state of every
      // install where `knowledge.enabled` is false.
      const response = await app.inject({ method: 'GET', url: '/api/search?q=Alice' });
      expect(response.statusCode).toBe(200);
      const payload = response.json();

      expect(payload.pages).toEqual([]);
      expect(payload.lanes.knowledge).toEqual({ hits: 0, dropped: 0 });
      expect(payload.lanes.knowledge.error).toBeUndefined();
      expect(payload.deduped).toEqual([]);
      expect(payload.results.map((result: { kind: string }) => result.kind)).toEqual(
        expect.arrayContaining(['memory', 'message']),
      );
    });

    it('does not fail the request when the knowledge lane throws', async () => {
      seedMessage('msg-alice', 'sess-alice', 'Alice and Bob met in Berlin');
      const broken = {
        search: (): never => {
          throw new Error('knowledge index unavailable');
        },
        get: () => null,
      };

      const wired = await appWithKnowledge(broken);
      try {
        const response = await wired.inject({ method: 'GET', url: '/api/search?q=Alice' });
        expect(response.statusCode).toBe(200);
        const payload = response.json();

        expect(payload.lanes.knowledge.error).toContain('knowledge index unavailable');
        expect(payload.pages).toEqual([]);
        // The other lanes still answer — a broken lane is a thinner page, not a 500.
        expect(payload.results.some((result: { kind: string }) => result.kind === 'message')).toBe(
          true,
        );
      } finally {
        await wired.close();
      }
    });
  });
});
