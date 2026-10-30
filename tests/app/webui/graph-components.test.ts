/**
 * Tests for the component list and the paged component drill-down (plan §4.2).
 *
 * The property that matters is the same one the roster has: enumerating every page must
 * reproduce the whole component exactly once, and every page must be a connected picture
 * on its own (edges only join nodes that are actually in that page).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../../src/memory/db';
import { registerGraphRoutes } from '../../../src/app/webui/graph-routes';

interface ComponentRow {
  id: string;
  size: number;
  edgeCount: number;
  nodes: Array<{ id: string; name: string }>;
}

interface ComponentPage {
  items: ComponentRow[];
  total: number;
  minSize: number;
  nextCursor: string | null;
}

interface GraphPage {
  nodes: Array<{ id: string }>;
  edges: Array<{ source: string; target: string }>;
  truncated: boolean;
}

describe('graph component routes', () => {
  let db: Database.Database;
  let app: ReturnType<typeof Fastify>;

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

  /** One path a—b—c—d—e plus two isolated names: 6 entities, 4 edges, 3 components. */
  function seed(): void {
    for (const [id, name] of [
      ['ent-a', 'A'],
      ['ent-b', 'B'],
      ['ent-c', 'C'],
      ['ent-d', 'D'],
      ['ent-e', 'E'],
      ['ent-alone', 'Alone'],
      ['ent-other', 'Other'],
    ]) {
      db.prepare(
        `INSERT INTO entities (id, name, canonical_name, entity_type, created_at, updated_at)
         VALUES (?, ?, ?, 'concept', 1, 1)`,
      ).run(id, name, name.toLowerCase());
    }
    for (const [index, [from, to]] of [
      ['ent-a', 'ent-b'],
      ['ent-b', 'ent-c'],
      ['ent-c', 'ent-d'],
      ['ent-d', 'ent-e'],
    ].entries()) {
      db.prepare(
        `INSERT INTO entity_edges
           (id, source_entity_id, target_entity_id, relation_type, confidence, created_at)
         VALUES (?, ?, ?, 'knows', 0.9, 1)`,
      ).run(`edge-${index}`, from, to);
    }
  }

  async function page(query: string): Promise<GraphPage> {
    const response = await app.inject({ method: 'GET', url: `/api/memory/graph?${query}` });
    expect(response.statusCode).toBe(200);
    return response.json() as GraphPage;
  }

  it('lists every multi-node component with a true total, not a capped 8', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/memory/components' });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as ComponentPage;

    expect(payload.total).toBe(1);
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({ size: 5, edgeCount: 4 });
    // Isolation is not a gap, so the two lone names are absent by default.
    expect(payload.items[0].nodes.map((node) => node.id)).not.toContain('ent-alone');

    // The panel's denominator and this list's total are the same number.
    const stats = (await app.inject({ method: 'GET', url: '/api/memory/graph/stats' })).json();
    expect(stats.multiNodeComponents).toBe(payload.total);
    expect(stats.componentCount).toBe(3);
  });

  it('pages the component list and rejects a cursor it cannot decode', async () => {
    // Five separate two-node components, so the list itself needs two pages.
    for (let index = 0; index < 5; index++) {
      db.prepare(
        `INSERT INTO entities (id, name, canonical_name, entity_type, created_at, updated_at)
         VALUES (?, ?, ?, 'concept', 1, 1)`,
      ).run(`ent-x${index}`, `X${index}`, `x${index}`);
      db.prepare(
        `INSERT INTO entities (id, name, canonical_name, entity_type, created_at, updated_at)
         VALUES (?, ?, ?, 'concept', 1, 1)`,
      ).run(`ent-y${index}`, `Y${index}`, `y${index}`);
      db.prepare(
        `INSERT INTO entity_edges
           (id, source_entity_id, target_entity_id, relation_type, confidence, created_at)
         VALUES (?, ?, ?, 'knows', 0.9, 1)`,
      ).run(`edge-x${index}`, `ent-x${index}`, `ent-y${index}`);
    }

    const first = (
      await app.inject({ method: 'GET', url: '/api/memory/components?limit=3' })
    ).json() as ComponentPage;
    expect(first.items).toHaveLength(3);
    expect(first.total).toBe(6);

    const second = (
      await app.inject({
        method: 'GET',
        url: `/api/memory/components?limit=3&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
      })
    ).json() as ComponentPage;
    expect(second.items).toHaveLength(3);
    expect(second.nextCursor).toBeNull();

    const seen = [...first.items, ...second.items].map((row) => row.id);
    expect(new Set(seen).size).toBe(6);

    const bad = await app.inject({ method: 'GET', url: '/api/memory/components?cursor=%%%' });
    expect(bad.statusCode).toBe(400);
  });

  it('pages a component in BFS order and keeps each page closed', async () => {
    const first = await page('component=ent-a&limit=2');
    expect(first.nodes.map((node) => node.id)).toEqual(['ent-a', 'ent-b']);
    expect(first.truncated).toBe(true);
    // The only edge between the two returned nodes; a—b is bounded by b—c, which is
    // not in this page, and an edge with one endpoint missing would be a fake arrow.
    expect(first.edges).toHaveLength(1);

    // Every page starts with the entity the drill-down was opened on: it is what the UI
    // centres the layout on and the name it prints as the subject. Deriving `origin` from
    // the page instead made page two re-centre on an unrelated member.
    const second = await page('component=ent-a&limit=2&cursor=eyJvIjoyfQ');
    expect(second.nodes.map((node) => node.id)).toEqual(['ent-a', 'ent-c', 'ent-d']);
    expect(second.truncated).toBe(true);
    // Closure still holds: a—c is not an edge, and c—d is the only one whose two
    // endpoints are both here (besides a—b, whose b is on page one).
    expect(second.edges.map((edge) => [edge.source, edge.target])).toEqual([['ent-c', 'ent-d']]);

    const third = await page('component=ent-a&limit=2&cursor=eyJvIjo0fQ');
    expect(third.nodes.map((node) => node.id)).toEqual(['ent-a', 'ent-e']);
    expect(third.truncated).toBe(false);
    // a—e is not an edge, so the pinned origin brings no edge with it.
    expect(third.edges).toEqual([]);
  });

  it('answers past the end of a component with an empty page, not a 404', async () => {
    const beyond = await page('component=ent-a&limit=2&cursor=eyJvIjoxMH0');
    expect(beyond.nodes.map((node) => node.id)).toEqual(['ent-a']);
    expect(beyond.truncated).toBe(false);
    expect(beyond.edges).toEqual([]);
  });

  it('pages from a component member that is not its representative', async () => {
    // BFS starts where the reader clicked: paging is a view of the same component,
    // not a fixed enumeration, so entering from d gives d's shells.
    const first = await page('component=ent-d&limit=2');
    expect(first.nodes.map((node) => node.id).sort()).toEqual(['ent-c', 'ent-d']);
  });

  it('rejects a bad cursor on the drill-down instead of restarting it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/memory/graph?component=ent-a&cursor=nonsense',
    });
    expect(response.statusCode).toBe(400);
  });
});
