/**
 * Tests for the graph roster endpoints (plan §4.1) — the "complete list" half of
 * the graph surface.
 *
 * The contract under test is completeness, not appearance: paging through every
 * page must produce each row exactly once, and the numbers the lists print must
 * equal what `/stats` measures. Two implementations of "how many" that disagree is
 * the failure this file exists to prevent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../../src/memory/db';
import { registerGraphRoutes } from '../../../src/app/webui/graph-routes';

interface RosterRow {
  id: string;
  degree: { out: number; in: number; total: number };
  mentionCount: number;
  aliases: string[];
  aliasCount: number;
}

interface RosterPage {
  items: RosterRow[];
  total: number;
  nextCursor: string | null;
}

interface EdgePage {
  items: Array<{ id: string }>;
  total: number;
  nextCursor: string | null;
  counts: { open: number; retracted: number };
}

describe('graph roster routes', () => {
  let db: Database.Database;
  let app: ReturnType<typeof Fastify>;

  const ids = {
    alice: 'ent-alice',
    bob: 'ent-bob',
    acme: 'ent-acme',
    carol: 'ent-carol',
    dave: 'ent-dave',
    erin: 'ent-erin',
  };
  /** `bob → carol` was retracted at this instant: history, not connectivity. */
  const RETRACTED_AT = 4_000;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    seed();
    app = Fastify({ logger: false });
    registerGraphRoutes(app, { db });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  function insertEntity(id: string, name: string, type: string): void {
    db.prepare(
      `INSERT INTO entities (id, name, canonical_name, entity_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 1)`,
    ).run(id, name, name.toLowerCase(), type);
  }

  function insertEdge(
    id: string,
    source: string,
    target: string,
    relation: string,
    validFrom: number,
    validTo: number | null = null,
  ): void {
    db.prepare(
      `INSERT INTO entity_edges
         (id, source_entity_id, target_entity_id, relation_type, confidence,
          source_memory_id, valid_from, valid_to, created_at)
       VALUES (?, ?, ?, ?, 0.9, 'mem-1', ?, ?, 1)`,
    ).run(id, source, target, relation, validFrom, validTo);
  }

  /**
   * Six entities, three typed edges (one retracted), two aliases, one mention.
   *
   * Degrees are chosen so the sum is checkable by hand: alice 2, bob 2 (one in,
   * one out), acme 1, carol 1, dave 0, erin 0 → 6 = 2 × 3 edges, and the retracted
   * edge counts on both sides because `GraphNode.degree` counts history.
   */
  function seed(): void {
    insertEntity(ids.alice, 'Alice', 'person');
    insertEntity(ids.bob, 'Bob', 'person');
    insertEntity(ids.acme, 'Acme', 'organization');
    insertEntity(ids.carol, 'Carol', 'place');
    insertEntity(ids.dave, 'Dave', 'concept');
    insertEntity(ids.erin, 'Erin', 'concept');

    insertEdge('edge-1', ids.alice, ids.bob, 'knows', 1_000);
    insertEdge('edge-2', ids.alice, ids.acme, 'works_at', 2_000);
    insertEdge('edge-3', ids.bob, ids.carol, 'lives_in', 3_000, RETRACTED_AT);

    for (const [index, alias] of ['艾丽丝', 'Alice Liddell'].entries()) {
      db.prepare(`INSERT INTO entity_aliases (entity_id, alias, created_at) VALUES (?, ?, 1)`).run(
        ids.alice,
        alias,
      );
    }

    // One memory naming Erin: she is isolated but not invisible — the mention tier.
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, status, created_at, updated_at)
       VALUES ('mem-1', 'user', 'k', 'fact', 'Erin helped with the deploy', 'active', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type, confidence)
       VALUES ('link-1', 'mem-1', 'Erin', 'MENTIONED', 0.9)`,
    ).run();
  }

  async function rosterPage(query: string): Promise<RosterPage> {
    const response = await app.inject({ method: 'GET', url: `/api/memory/entities?${query}` });
    expect(response.statusCode).toBe(200);
    return response.json() as RosterPage;
  }

  /** Follows `nextCursor` until it runs out — the only way "complete" is provable. */
  async function rosterAll(query: string, pageSize = 2): Promise<RosterPage['items']> {
    const items: RosterRow[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const page: RosterPage = await rosterPage(
        `${query}&limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      items.push(...page.items);
      if (!page.nextCursor) return items;
      cursor = page.nextCursor;
    }
    throw new Error('cursor never terminated');
  }

  describe('GET /api/memory/entities', () => {
    it('enumerates every entity exactly once across pages', async () => {
      const items = await rosterAll('sort=name&dir=asc');
      expect(items).toHaveLength(6);
      expect(new Set(items.map((row) => row.id)).size).toBe(6);
      expect(items.map((row) => row.id).sort()).toEqual(Object.values(ids).sort());
    });

    it('counts degree from every typed edge, retracted ones included', async () => {
      const items = await rosterAll('sort=degree');
      const byId = new Map(items.map((row) => [row.id, row]));
      expect(byId.get(ids.alice)?.degree).toEqual({ out: 2, in: 0, total: 2 });
      expect(byId.get(ids.bob)?.degree).toEqual({ out: 1, in: 1, total: 2 });
      expect(byId.get(ids.carol)?.degree.total).toBe(1);
      expect(byId.get(ids.dave)?.degree.total).toBe(0);

      // The one red line in the plan: the sum must equal both sides of every edge.
      const sum = items.reduce((total, row) => total + row.degree.total, 0);
      const stats = (await app.inject({ method: 'GET', url: '/api/memory/graph/stats' })).json();
      expect(sum).toBe(2 * stats.edges);
      expect(sum).toBe(6);
    });

    it('filters isolated entities and agrees with the statistics panel', async () => {
      const page = await rosterPage('edges=no');
      const stats = (await app.inject({ method: 'GET', url: '/api/memory/graph/stats' })).json();
      // Carol's only fact was retracted, so there is nothing the canvas can draw for
      // her: the filter measures OPEN connectivity, the same thing the panel counts.
      // (`degree.total` still says 1 — the record holds one edge; two questions.)
      expect(page.total).toBe(3);
      expect(page.items.map((row) => row.id).sort()).toEqual(
        [ids.carol, ids.dave, ids.erin].sort(),
      );
      expect(page.total).toBe(stats.isolated);

      const connected = await rosterPage('edges=yes');
      expect(connected.items.map((row) => row.id).sort()).toEqual(
        [ids.acme, ids.alice, ids.bob].sort(),
      );
    });

    it('reports mention counts with the ranking predicate', async () => {
      const items = await rosterAll('sort=mentions');
      const byId = new Map(items.map((row) => [row.id, row]));
      expect(byId.get(ids.erin)?.mentionCount).toBe(1);
      expect(byId.get(ids.alice)?.mentionCount).toBe(0);
      // Sorted by mentions desc, so the one remembered name leads.
      expect(items[0].id).toBe(ids.erin);
    });

    it('returns aliases with the total so "2 of 9" is sayable', async () => {
      const page = await rosterPage(`q=alice`);
      expect(page.total).toBe(1);
      expect(page.items[0].aliases).toEqual(['Alice Liddell', '艾丽丝']);
      expect(page.items[0].aliasCount).toBe(2);
    });

    it('matches aliases in the substring search', async () => {
      const page = await rosterPage(`q=${encodeURIComponent('艾丽')}`);
      expect(page.items.map((row) => row.id)).toEqual([ids.alice]);
    });

    it('filters by entity type from the served vocabulary', async () => {
      const stats = (await app.inject({ method: 'GET', url: '/api/memory/graph/stats' })).json();
      expect(stats.entityTypes).toEqual(['concept', 'person', 'organization', 'place']);

      const people = await rosterPage('type=person');
      expect(people.items.map((row) => row.id).sort()).toEqual([ids.alice, ids.bob].sort());
    });

    it('keeps paging stable when a row is inserted mid-walk', async () => {
      const first = await rosterPage('sort=name&dir=asc&limit=3');
      expect(first.items.map((row) => row.id)).toEqual([ids.acme, ids.alice, ids.bob]);

      // Sorts before the cursor: a keyset walk will not see it, and that is the
      // correct trade — rows already read never move, and nothing is served twice.
      insertEntity('ent-aaron', 'Aaron', 'person');

      const second = await rosterPage(
        `sort=name&dir=asc&limit=3&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
      );
      expect(second.items.map((row) => row.id)).toEqual([ids.carol, ids.dave, ids.erin]);
      expect(second.nextCursor).toBeNull();
      // The denominator moves, which is why every page prints `total` too.
      expect(second.total).toBe(7);
    });

    it('rejects a sort it does not know and a cursor it cannot decode', async () => {
      const badSort = await app.inject({ method: 'GET', url: '/api/memory/entities?sort=degreee' });
      expect(badSort.statusCode).toBe(400);
      expect(badSort.json().allowed).toContain('degree');

      const badCursor = await app.inject({
        method: 'GET',
        url: '/api/memory/entities?cursor=not-a-cursor',
      });
      expect(badCursor.statusCode).toBe(400);

      const badEdges = await app.inject({ method: 'GET', url: '/api/memory/entities?edges=nope' });
      expect(badEdges.statusCode).toBe(400);
    });

    it('answers with a well-formed empty page before anything was projected', async () => {
      const bare = Fastify({ logger: false });
      const empty = openDatabase(':memory:');
      empty.exec('DROP TABLE entity_edges');
      registerGraphRoutes(bare, { db: empty });
      await bare.ready();

      const response = await bare.inject({ method: 'GET', url: '/api/memory/entities' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ items: [], total: 0, nextCursor: null });
      await bare.close();
      empty.close();
    });
  });

  describe('GET /api/memory/edges', () => {
    it('lists open and retracted edges separately and counts both', async () => {
      const open = await app.inject({ method: 'GET', url: '/api/memory/edges' });
      expect(open.statusCode).toBe(200);
      expect(open.json().items).toHaveLength(2);
      expect(open.json().counts).toEqual({ open: 2, retracted: 1 });

      const retracted = await app.inject({
        method: 'GET',
        url: '/api/memory/edges?status=retracted',
      });
      expect(retracted.json().items).toHaveLength(1);
      expect(retracted.json().items[0]).toMatchObject({
        relationType: 'lives_in',
        validTo: RETRACTED_AT,
        source: { id: ids.bob, name: 'Bob' },
        target: { id: ids.carol, name: 'Carol' },
      });

      const all = await app.inject({ method: 'GET', url: '/api/memory/edges?status=all' });
      expect(all.json().items).toHaveLength(3);
      expect(all.json().total).toBe(3);
    });

    it('agrees with the statistics panel on the totals', async () => {
      const all = (await app.inject({ method: 'GET', url: '/api/memory/edges?status=all' })).json();
      const stats = (await app.inject({ method: 'GET', url: '/api/memory/graph/stats' })).json();
      expect(all.counts.open).toBe(stats.edges - stats.retractedEdges);
      expect(all.counts.open + all.counts.retracted).toBe(stats.edges);
    });

    it('walks every edge exactly once with a keyset cursor', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/memory/edges?status=all&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        });
        const page = response.json() as EdgePage;
        seen.push(...page.items.map((row) => row.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(seen.sort()).toEqual(['edge-1', 'edge-2', 'edge-3']);
    });

    it('filters one direction and one predicate', async () => {
      const fromAlice = (
        await app.inject({ method: 'GET', url: `/api/memory/edges?source=${ids.alice}` })
      ).json();
      expect(fromAlice.items.map((row: { id: string }) => row.id).sort()).toEqual([
        'edge-1',
        'edge-2',
      ]);

      const intoCarol = (
        await app.inject({ method: 'GET', url: `/api/memory/edges?target=${ids.carol}&status=all` })
      ).json();
      expect(intoCarol.items).toHaveLength(1);

      const knows = (
        await app.inject({ method: 'GET', url: '/api/memory/edges?relation=knows' })
      ).json();
      expect(knows.items.map((row: { id: string }) => row.id)).toEqual(['edge-1']);
    });

    it('applies asOf with the same predicate the drawing uses', async () => {
      // Nothing was true at t=1500 except the first edge (valid from 1000).
      const early = (
        await app.inject({ method: 'GET', url: '/api/memory/edges?status=all&asOf=1500' })
      ).json();
      expect(early.items.map((row: { id: string }) => row.id)).toEqual(['edge-1']);

      // At t=3500 the retracted edge is still true: asOf is about the fact, not
      // about `status`, so it comes back without asking for history.
      const middle = (
        await app.inject({ method: 'GET', url: '/api/memory/edges?status=all&asOf=3500' })
      ).json();
      expect(middle.items.map((row: { id: string }) => row.id).sort()).toEqual([
        'edge-1',
        'edge-2',
        'edge-3',
      ]);

      // After the retraction it is history again, and `status=open` excludes it.
      const late = (await app.inject({ method: 'GET', url: '/api/memory/edges?asOf=4500' })).json();
      expect(late.items.map((row: { id: string }) => row.id).sort()).toEqual(['edge-1', 'edge-2']);
    });

    it('rejects an unknown status, sort or cursor', async () => {
      for (const url of [
        '/api/memory/edges?status=maybe',
        '/api/memory/edges?sort=random',
        '/api/memory/edges?cursor=%%%',
      ]) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(400);
      }
    });
  });
});
