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
      expect(response.json()).toEqual({ nodes: [], edges: [], truncated: false, enabled: true });
    });

    it('reports the projection switch instead of leaving empty to mean both things', async () => {
      db.exec('DELETE FROM entity_edges; DELETE FROM entity_aliases; DELETE FROM entities');
      const off = Fastify({ logger: false });
      registerGraphRoutes(off, { db, graphEnabled: () => false });
      await off.ready();

      try {
        const payload = (await off.inject({ method: 'GET', url: '/api/memory/graph' })).json();
        // Same empty arrays as the case above, different answer: the UI has to
        // be able to say "switched off" rather than "nothing accumulated yet".
        expect(payload).toEqual({ nodes: [], edges: [], truncated: false, enabled: false });
      } finally {
        await off.close();
      }
    });

    it('draws a hub together with its spokes, not just the busiest names', async () => {
      // The fixture for the defect the old top-N rule had: five degree-1 spokes rank
      // below every seeded entity by canonical name, so a top-6 list contains none
      // of them and the hub (degree 5) draws as a bare name whose every edge points
      // outside the picture. Selection is now a BFS from the seeds, so the spokes
      // travel with the hub they belong to.
      const hubId = 'ent-hub';
      const spokeIds = [1, 2, 3, 4, 5].map((n) => `ent-spoke-${n}`);
      const insertEntity = db.prepare(
        `INSERT INTO entities (id, name, canonical_name, entity_type, created_at, updated_at)
         VALUES (?, ?, ?, 'concept', 1, 1)`,
      );
      insertEntity.run(hubId, 'Hub', 'hub');
      for (const [index, spokeId] of spokeIds.entries()) {
        insertEntity.run(spokeId, `Spoke ${index + 1}`, `spoke-${index + 1}`);
        repo.linkEntities({ sourceId: hubId, targetId: spokeId, relationType: 'uses' });
      }

      // `limit` is still the NODE budget: six nodes buy the two busiest names as
      // seeds and four of the hub's spokes — the spokes are in, and `EMEA`, which
      // the old rule would have drawn instead, is not.
      const budgeted = (
        await app.inject({ method: 'GET', url: '/api/memory/graph?limit=6' })
      ).json();
      const budgetedIds = budgeted.nodes.map((node: { id: string }) => node.id);

      expect(budgetedIds).toHaveLength(6);
      expect(budgetedIds.slice(0, 2)).toEqual([hubId, ids.alice]);
      expect(budgetedIds).toContain(spokeIds[0]);
      expect(budgetedIds).not.toContain(ids.emea);
      expect(budgeted.truncated).toBe(true);
      // The node shape the UI draws is unchanged by the new selection rule.
      expect(budgeted.nodes[1]).toEqual({
        id: ids.alice,
        name: 'Alice',
        canonical_name: 'alice',
        entity_type: 'person',
        description: 'A teammate who likes tea',
        degree: 3,
      });

      // A budget that fits the spokes keeps every one of them, and the edge list is
      // complete: five hub→spoke edges, alice's three, and bob→berlin. Those nine
      // exceed the node budget, so an edge cap shared with the node budget would
      // have dropped the tail of the list.
      const wider = (await app.inject({ method: 'GET', url: '/api/memory/graph?limit=10' })).json();
      const widerIds = new Set(wider.nodes.map((node: { id: string }) => node.id));
      for (const spokeId of spokeIds) expect(widerIds.has(spokeId)).toBe(true);
      expect(wider.edges).toHaveLength(9);

      // Payload closure: no edge names a node outside the payload.
      for (const edge of wider.edges) {
        expect(widerIds.has(edge.source)).toBe(true);
        expect(widerIds.has(edge.target)).toBe(true);
        expect(typeof edge.confidence).toBe('number');
      }
    });

    it('reports truncation instead of returning an unbounded overview', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/memory/graph?limit=2' });
      const payload = response.json();

      expect(payload.nodes).toHaveLength(2);
      expect(payload.truncated).toBe(true);
    });

    it('draws the whole graph on request instead of the phone-shaped budget', async () => {
      const whole = (await app.inject({ method: 'GET', url: '/api/memory/graph?whole=1' })).json();

      // `limit` is a default for a phone, not a claim about the data: `whole=1`
      // spends the hard cap, so every node and every typed edge among them is here.
      expect(whole.nodes).toHaveLength(5);
      expect(whole.edges).toHaveLength(5);
      expect(whole.truncated).toBe(false);

      // `types` (and `asOf`) still apply — the escape hatch is about size, not about
      // switching the filters off.
      const typed = (
        await app.inject({ method: 'GET', url: '/api/memory/graph?whole=1&types=works_at' })
      ).json();
      expect(typed.nodes).toHaveLength(5);
      expect(typed.edges.map((edge: { relation_type: string }) => edge.relation_type)).toEqual([
        'works_at',
      ]);
    });

    it('orders edge-less nodes by how often the corpus mentions them', async () => {
      // The shape after nodes came from mentions: most nodes have degree 0, so an
      // alphabetical tiebreaker shows an arbitrary slice of the alphabet and can
      // hide the busiest name entirely (`Ubuntu`, 38 mentioning memories, sat
      // behind `API`…`Android` in a truncated overview).
      db.prepare(
        `INSERT INTO memories (id, scope, scope_key, kind, content, status, created_at, updated_at)
         VALUES ('mem-1', 'user', 'k', 'fact', 'Ubuntu 24.04 on Termux', 'active', 1, 1)`,
      ).run();
      for (const name of ['Zeta', 'Ubuntu']) {
        db.prepare(
          `INSERT INTO entities (id, name, canonical_name, entity_type, created_at, updated_at)
           VALUES (?, ?, ?, 'concept', 1, 1)`,
        ).run(`ent-${name}`, name, name.toLowerCase());
      }
      // Ubuntu mentioned twice, Zeta once: same degree (0), different evidence.
      for (const [index, name] of ['Zeta', 'Ubuntu', 'Ubuntu'].entries()) {
        db.prepare(
          `INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type, confidence)
           VALUES (?, 'mem-1', ?, 'MENTIONED', 0.9)`,
        ).run(`link-${index}`, name);
      }

      const response = await app.inject({ method: 'GET', url: '/api/memory/graph?limit=50' });
      const names = response.json().nodes.map((node: { name: string }) => node.name);

      expect(names.indexOf('Ubuntu')).toBeLessThan(names.indexOf('Zeta'));
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
          enabled: true,
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

    // ─── S2: the asserting memory travels with the edge ────────────────────

    it('carries the asserting memory on an edge, and omits it where there is none', async () => {
      new MemoryRepository(db).create({
        id: 'mem-assert',
        scope: 'user',
        scope_key: 'user-1',
        kind: 'fact',
        content: 'Alice knows Bob',
      });
      repo.linkEntities({
        sourceId: ids.alice,
        targetId: ids.bob,
        relationType: 'knows',
        sourceMemoryId: 'mem-assert',
      });

      const payload = (
        await app.inject({ method: 'GET', url: `/api/memory/graph?entity=${ids.alice}` })
      ).json();

      const knows = payload.edges.find((edge: { relation_type: string }) => {
        return edge.relation_type === 'knows';
      });
      // The panel opens this id, so it has to name a memory that exists.
      expect(knows.source_memory_id).toBe('mem-assert');

      // A row without provenance keeps the key absent (migration-v10 made the
      // column nullable), so the UI shows no evidence link rather than a dead one.
      const worksAt = payload.edges.find((edge: { relation_type: string }) => {
        return edge.relation_type === 'works_at';
      });
      expect(worksAt).toBeDefined();
      expect(worksAt).not.toHaveProperty('source_memory_id');
    });

    // ─── S6: the mention tier reaches the WebUI ────────────────────────────

    it('sends mentions with the neighbourhood and never with the overview', async () => {
      new MemoryRepository(db).create({
        id: 'mem-co',
        scope: 'user',
        scope_key: 'user-1',
        kind: 'fact',
        content: 'Alice and Bob met Zeta',
      });
      for (const [index, name] of ['Alice', 'Bob', 'Zeta'].entries()) {
        db.prepare(
          `INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type, confidence)
           VALUES (?, 'mem-co', ?, 'MENTIONED', 0.9)`,
        ).run(`co-${index}`, name);
      }

      const overview = (await app.inject({ method: 'GET', url: '/api/memory/graph' })).json();
      // The frozen contract: an overview has no origin, so a per-origin mention
      // list has no meaning there — the key is absent, not empty.
      expect(overview).not.toHaveProperty('mentions');
      expect(overview).not.toHaveProperty('mentions_truncated');

      const neighbourhood = (
        await app.inject({ method: 'GET', url: `/api/memory/graph?entity=${ids.alice}` })
      ).json();
      const byName = new Map(
        neighbourhood.mentions.map((mention: { name: string }) => [mention.name, mention]),
      );
      // Bob is in the payload because a STATEMENT put it there (`Alice —knows→ Bob`),
      // so it is not also advertised as a mere co-mention: the block's caption is
      // "mentioned together, but not related", and Bob is exactly the name that would
      // make it false. The mention tier explains only what the walk did not reach.
      expect(byName.has('Bob')).toBe(false);
      // Zeta was only ever mentioned, so it comes back without an id rather than
      // with an invented one.
      expect(byName.get('Zeta')).toMatchObject({ memories: 1 });
      expect(byName.get('Zeta')).not.toHaveProperty('entity_id');
      expect(neighbourhood.mentions_truncated).toBe(false);

      // The mention tier is still not connectivity: no edge, no node.
      expect(
        neighbourhood.edges.some((edge: { relation_type: string }) => {
          return edge.relation_type === 'MENTIONED';
        }),
      ).toBe(false);
      expect(neighbourhood.nodes.map((node: { id: string }) => node.id)).not.toContain('Zeta');
    });

    // ─── S4: component drill-down ────────────────────────

    it('drills into one component and stops at its boundary', async () => {
      db.prepare(
        `INSERT INTO entities (id, name, canonical_name, entity_type, created_at, updated_at)
         VALUES ('ent-isolated', 'Isolated', 'isolated', 'concept', 1, 1)`,
      ).run();

      const payload = (
        await app.inject({ method: 'GET', url: `/api/memory/graph?component=${ids.berlin}` })
      ).json();
      const nodeIds = payload.nodes.map((node: { id: string }) => node.id);

      // The clicked entity leads (nodes[0] is the layout centre), and the whole
      // component follows: depth does not apply to a component.
      expect(nodeIds[0]).toBe(ids.berlin);
      expect(nodeIds).toEqual(expect.arrayContaining([ids.alice, ids.bob, ids.acme, ids.emea]));
      expect(nodeIds).toHaveLength(5);
      expect(nodeIds).not.toContain('ent-isolated');
      expect(payload.truncated).toBe(false);
      expect(payload).not.toHaveProperty('mentions');

      // An isolated entity's own component is itself.
      const alone = (
        await app.inject({ method: 'GET', url: '/api/memory/graph?component=ent-isolated' })
      ).json();
      expect(alone.nodes).toHaveLength(1);
      expect(alone.edges).toEqual([]);
    });

    it('404s when the component reference names nothing', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/memory/graph?component=nobody',
      });
      expect(response.statusCode).toBe(404);
    });
  });

  // ─── GET /api/memory/graph/stats ────────────────────────

  describe('GET /api/memory/graph/stats', () => {
    /** `Ubuntu` is mentioned and connected to nothing: the sparse-graph case. */
    function seedStatsExtras(): void {
      db.prepare(
        `INSERT INTO entities (id, name, canonical_name, entity_type, created_at, updated_at)
         VALUES ('ent-isolated', 'Isolated', 'isolated', 'concept', 1, 1)`,
      ).run();
      db.prepare(
        `INSERT INTO entities (id, name, canonical_name, entity_type, created_at, updated_at)
         VALUES ('ent-ubuntu', 'Ubuntu', 'ubuntu', 'concept', 1, 1)`,
      ).run();
      db.prepare(
        `INSERT INTO memories (id, scope, scope_key, kind, content, status, created_at, updated_at)
         VALUES ('mem-ubuntu', 'user', 'k', 'fact', 'Ubuntu 24.04 on Termux', 'active', 1, 1)`,
      ).run();
      db.prepare(
        `INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type, confidence)
         VALUES ('link-ubuntu', 'mem-ubuntu', 'Ubuntu', 'MENTIONED', 0.9)`,
      ).run();
    }

    it('reports connectivity, mentions and components from the stored graph', async () => {
      seedStatsExtras();
      // One page bound to a conversation, linking to an archived one: a link a
      // reader cannot follow, which is what `danglingLinks` counts.
      db.prepare(
        `INSERT INTO knowledge_pages
           (id, page_type, slug, title, content, version, status, scope, created_at, updated_at)
         VALUES ('p-scoped', 'topic', 'scoped', 'Scoped', 'body', 1, 'active', 'channel:c1', 1, 1)`,
      ).run();
      db.prepare(
        `INSERT INTO knowledge_pages
           (id, page_type, slug, title, content, version, status, scope, created_at, updated_at)
         VALUES ('p-gone', 'topic', 'gone', 'Gone', 'body', 1, 'archived', 'global', 1, 1)`,
      ).run();
      db.prepare(
        `INSERT INTO knowledge_links (from_page_id, to_page_id, created_at)
         VALUES ('p-scoped', 'p-gone', 1)`,
      ).run();

      const response = await app.inject({ method: 'GET', url: '/api/memory/graph/stats' });
      expect(response.statusCode).toBe(200);

      expect(response.json()).toEqual({
        enabled: true,
        nodes: 7,
        // Five typed rows, so the number matches a direct SQL count; the retracted
        // was_at is reported as one of them, not as connectivity.
        edges: 5,
        retractedEdges: 1,
        isolated: 2,
        // One of the isolated entities is named by a memory, so it is not invisible:
        // this is the number that explains a sparse graph.
        mentionOnly: 1,
        mentionLinks: 1,
        componentCount: 3,
        largestComponentPct: 0.714,
        components: [
          {
            id: ids.alice,
            size: 5,
            edgeCount: 4,
            nodes: [
              { id: ids.alice, name: 'Alice' },
              { id: ids.berlin, name: 'Berlin' },
              { id: ids.bob, name: 'Bob' },
              { id: ids.acme, name: 'Acme' },
              { id: ids.emea, name: 'EMEA' },
            ],
          },
        ],
        danglingLinks: 1,
        scopedPages: 1,
        // Alphabetical among equal counts: every seeded relation type has one row,
        // and the retracted `was_at` still counts as vocabulary — it is a relation
        // a caller may legitimately ask about with `asOf`.
        relationTypes: ['knows', 'lives_in', 'part_of', 'was_at', 'works_at'],
      });
    });

    it('reports the projection switch instead of pretending the graph is empty', async () => {
      const off = Fastify({ logger: false });
      registerGraphRoutes(off, { db, graphEnabled: () => false });
      await off.ready();

      try {
        const payload = (
          await off.inject({ method: 'GET', url: '/api/memory/graph/stats' })
        ).json();
        expect(payload.enabled).toBe(false);
        // The numbers still describe what is stored — the flag says whether the
        // projection maintains it, which is a different fact.
        expect(payload.nodes).toBe(5);
      } finally {
        await off.close();
      }
    });

    it('answers zeroes on a database that has no graph tables', async () => {
      const bare = openDatabase(':memory:');
      bare.exec('DROP TABLE entity_edges; DROP TABLE entity_aliases; DROP TABLE entities');
      const bareApp = Fastify({ logger: false });
      registerGraphRoutes(bareApp, { db: bare });
      await bareApp.ready();

      try {
        const response = await bareApp.inject({ method: 'GET', url: '/api/memory/graph/stats' });
        // A pre-v10 database is an answer, not a 500: the UI shows a real empty state.
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          enabled: true,
          nodes: 0,
          edges: 0,
          retractedEdges: 0,
          isolated: 0,
          mentionOnly: 0,
          mentionLinks: 0,
          componentCount: 0,
          largestComponentPct: 0,
          components: [],
        });
      } finally {
        await bareApp.close();
        bare.close();
      }
    });

    it('omits the knowledge diagnostics when those tables do not exist', async () => {
      db.exec('DROP TABLE knowledge_links; DROP TABLE knowledge_pages');

      const payload = (await app.inject({ method: 'GET', url: '/api/memory/graph/stats' })).json();

      // Absent, not zero: an install without the knowledge layer has no answer to
      // give, and "0 dangling links" would be a claim it cannot make.
      expect(payload).not.toHaveProperty('danglingLinks');
      expect(payload).not.toHaveProperty('scopedPages');
      expect(payload.nodes).toBe(5);
    });

    it('is not shadowed by /api/memory/:id or by /api/memory/graph', async () => {
      const shared = Fastify({ logger: false });
      shared.get('/api/memory/:id', async (_request, reply) => reply.send({ shadowed: true }));
      registerGraphRoutes(shared, { db });
      await shared.ready();

      try {
        const stats = await shared.inject({ method: 'GET', url: '/api/memory/graph/stats' });
        expect(stats.statusCode).toBe(200);
        expect(stats.json()).toMatchObject({ enabled: true, nodes: 5 });

        // ...and registering it did not take the overview's path away.
        const graph = await shared.inject({ method: 'GET', url: '/api/memory/graph' });
        expect(graph.statusCode).toBe(200);
        expect(graph.json()).toMatchObject({ enabled: true, truncated: false });
        expect(graph.json().nodes.length).toBeGreaterThan(0);
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
      // The page layer is off for `app`, so the section is served empty rather
      // than half-rendered against routes that do not exist.
      expect(payload.pages).toEqual([]);
    });

    it('lists the active pages whose title folds to this entity', async () => {
      new MemoryRepository(db).create({
        id: 'mem-alice',
        scope: 'user',
        scope_key: 'user-1',
        kind: 'fact',
        content: 'Alice likes tea',
      });
      const knowledge = createKnowledgeService({ db });
      const created = knowledge.create(
        {
          pageType: 'entity',
          slug: 'alice',
          title: 'Alice',
          content: 'Alice 喜欢茶。',
          sources: [{ kind: 'memory', id: 'mem-alice' }],
        },
        { actor: 'agent' },
      );
      expect(created.ok).toBe(true);

      const wired = Fastify({ logger: false });
      registerGraphRoutes(wired, { db, knowledge });
      await wired.ready();

      try {
        const payload = (
          await wired.inject({ method: 'GET', url: `/api/memory/entity/${ids.alice}` })
        ).json();
        expect(payload.pages).toHaveLength(1);
        expect(payload.pages[0]).toMatchObject({ title: 'Alice', slug: 'alice' });

        // Nothing on Bob: a page belongs to the node its title folded to.
        const bob = (
          await wired.inject({ method: 'GET', url: `/api/memory/entity/${ids.bob}` })
        ).json();
        expect(bob.pages).toEqual([]);
      } finally {
        await wired.close();
      }
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
        // Additive: the graph's view of the returned memories. `[]` here is the
        // ordinary answer on an empty graph, not an error.
        hints: [],
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
      // `hints` is additive by design: a client that ignores it sees the old shape.
      expect(Object.keys(payload).sort()).toEqual([
        'deduped',
        'hints',
        'lanes',
        'pages',
        'q',
        'results',
      ]);
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
