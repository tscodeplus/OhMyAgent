/**
 * `entity_query` — the model's read access to the knowledge graph.
 *
 * The query itself is covered by `tests/graph/graph-query.test.ts`; this file
 * covers the contract the model sees: compact JSON with names instead of ids, an
 * explicit `truncated` flag, `mentions` in its own array (never an edge), and a
 * plain error instead of a throw on an entity that is not there.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../../src/memory/db';
import { EntityRepository } from '../../../src/memory/repositories/entity-repository';
import { createEntityQueryToolDefinition } from '../../../src/tools/builtins/graph/entity-query-definition';

describe('entity_query tool', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
    const repo = new EntityRepository(db);
    for (const [id, name, type] of [
      ['ent-alice', 'Alice', 'person'],
      ['ent-acme', 'Acme', 'organization'],
      ['ent-bob', 'Bob', 'person'],
    ]) {
      db.prepare(
        `INSERT INTO entities (id, name, canonical_name, entity_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 1)`,
      ).run(id, name, name.toLowerCase(), type);
    }
    repo.linkEntities({
      sourceId: 'ent-alice',
      targetId: 'ent-acme',
      relationType: 'works_at',
      confidence: 0.9,
    });
    repo.linkEntities({ sourceId: 'ent-alice', targetId: 'ent-bob', relationType: 'knows' });
  });

  afterEach(() => {
    db.close();
  });

  async function run(args: Record<string, unknown>, decayHalfLifeDays?: number) {
    const tool = createEntityQueryToolDefinition({ db, decayHalfLifeDays });
    return tool.execute(args as never, {} as never);
  }

  function payloadOf(result: Awaited<ReturnType<typeof run>>): Record<string, any> {
    expect(result.isError).toBeUndefined();
    return JSON.parse(String((result.content[0] as { text: string }).text));
  }

  it('answers with nodes and edges named by entity, not by id', async () => {
    const payload = payloadOf(await run({ name: 'Alice' }));

    expect(payload.entity).toEqual({ name: 'Alice', type: 'person' });
    expect(payload.nodes).toEqual(
      expect.arrayContaining([
        { name: 'Acme', type: 'organization' },
        { name: 'Bob', type: 'person' },
      ]),
    );
    expect(payload.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: 'Alice',
          relation: 'works_at',
          object: 'Acme',
          valid_to: null,
          confidence: 0.9,
        }),
      ]),
    );
    expect(payload.truncated).toBe(false);
    // The mention tier is opt-in, so an unasked payload has no `mentions` key.
    expect(payload).not.toHaveProperty('mentions');
  });

  it('adds co-mentioned names as a separate array, never as an edge', async () => {
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, status, created_at, updated_at)
       VALUES ('mem-1', 'user', 'k', 'fact', 'Alice met Zeta', 'active', 1, 1)`,
    ).run();
    for (const [index, name] of ['Alice', 'Zeta'].entries()) {
      db.prepare(
        `INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type, confidence)
         VALUES (?, 'mem-1', ?, 'MENTIONED', 0.9)`,
      ).run(`link-${index}`, name);
    }

    const payload = payloadOf(await run({ name: 'Alice', includeMentions: true }));

    expect(payload.mentions).toEqual([{ name: 'Zeta', memories: 1 }]);
    const relations = payload.edges.map((edge: { relation: string }) => edge.relation);
    expect(relations).not.toContain('MENTIONED');
    const names = payload.nodes.map((node: { name: string }) => node.name);
    expect(names).not.toContain('Zeta');
  });

  it('lists the curated pages written about the entity', async () => {
    // migration-v21 links a page to the entity its title folds to; that link is
    // what turns "what is asserted about Alice" into "what is written about
    // Alice" without a second lookup at the call site.
    db.prepare(
      `INSERT INTO knowledge_pages
         (id, page_type, slug, title, content, aliases, tags, confidence, version, status,
          entity_id, created_at, updated_at, updated_by)
       VALUES ('p-alice', 'entity', 'alice', 'Alice', 'body', NULL, NULL, NULL, 1, 'active',
               'ent-alice', 10, 10, 'agent')`,
    ).run();

    const payload = payloadOf(await run({ name: 'Alice' }));
    expect(payload.pages).toEqual([{ page_type: 'entity', slug: 'alice', title: 'Alice' }]);
  });

  it('omits pages entirely when the database has no knowledge layer', async () => {
    db.exec('DROP TABLE knowledge_pages');

    const payload = payloadOf(await run({ name: 'Alice' }));
    // Omitted, not an empty array: "no knowledge layer" and "no page written"
    // are different answers, and reporting the first as the second reads as a
    // confirmed absence.
    expect(payload).not.toHaveProperty('pages');
  });

  it('reports decayed confidence only when a half-life is configured', async () => {
    // The stored number is what the producer asserted; the decayed one is what
    // it is worth now. Reporting only the second would hide the assertion, and
    // reporting it when decay is off would imply ageing nobody asked for.
    const DAY = 86_400_000;
    db.prepare(`UPDATE entity_edges SET valid_from = ? WHERE relation_type = 'works_at'`).run(
      Date.now() - 90 * DAY,
    );

    const plain = payloadOf(await run({ name: 'Alice' }));
    expect(
      plain.edges.every((edge: Record<string, unknown>) => !('effective_confidence' in edge)),
    ).toBe(true);

    const decayed = payloadOf(await run({ name: 'Alice' }, 30));
    const worksAt = decayed.edges.find(
      (edge: { relation: string }) => edge.relation === 'works_at',
    ) as { confidence: number; effective_confidence: number };
    // 90 days at a 30-day half-life is three halvings: 0.9 → 0.1125.
    expect(worksAt.confidence).toBeCloseTo(0.9, 6);
    // The tool rounds to three decimals so the JSON stays compact.
    expect(worksAt.effective_confidence).toBeCloseTo(0.112, 3);
    // ...and the stored confidence is still there beside it.
    expect(worksAt.confidence).toBeGreaterThan(worksAt.effective_confidence);
  });

  it('reports the cap instead of silently returning a short answer', async () => {
    const payload = payloadOf(await run({ name: 'Alice', limit: 1 }));
    expect(payload.truncated).toBe(true);
  });

  it('rejects out-of-range arguments instead of clamping them', async () => {
    // depth 3 is the WebUI's ceiling, not the tool's: a 3-hop answer is mostly
    // nodes the question never asked about.
    expect((await run({ name: 'Alice', depth: 3 })).isError).toBe(true);
    expect((await run({ name: 'Alice', limit: 101 })).isError).toBe(true);
    expect((await run({ name: '' })).isError).toBe(true);
  });

  it('answers "no such entity" without throwing on an empty graph', async () => {
    db.exec('DELETE FROM entity_edges; DELETE FROM entity_aliases; DELETE FROM entities');

    const result = await run({ name: 'Alice' });

    expect(result.isError).toBe(true);
    const text = String((result.content[0] as { text: string }).text);
    expect(text).toContain('No entity named "Alice"');
  });
});
