/**
 * `queryEntityGraph` — the one read query behind `/api/memory/graph` and the
 * `entity_query` tool.
 *
 * What matters here is not that a walk happens (the repository owns that) but
 * that every *answer* is honest: a retracted fact disappears at the right
 * instant, a relation filter narrows the walk instead of only the result, a cap
 * that cuts the payload says so, and co-occurrence is never dressed as a
 * statement — not even when a legacy database still holds a `MENTIONED` row in
 * `entity_edges`.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db';
import { EntityRepository } from '../../src/memory/repositories/entity-repository';
import { parseGraphAsOf, queryEntityGraph } from '../../src/graph/graph-query';

describe('queryEntityGraph', () => {
  let db: Database.Database;
  let repo: EntityRepository;

  const ids = {
    alice: 'ent-alice',
    bob: 'ent-bob',
    acme: 'ent-acme',
    berlin: 'ent-berlin',
    emea: 'ent-emea',
  };
  /** Retraction instant for alice→berlin; asOf comparisons pivot on it. */
  const RETRACTED_AT = 1_700_000_000_000;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new EntityRepository(db);
    seed();
  });

  afterEach(() => {
    db.close();
  });

  function addEntity(id: string, name: string, entityType: string): void {
    db.prepare(
      `INSERT INTO entities (id, name, canonical_name, entity_type, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).run(id, name, name.toLowerCase(), entityType, 1, 1);
  }

  /**
   * Alice —works_at→ Acme, Alice —knows→ Bob, Bob —lives_in→ Berlin,
   * Berlin —part_of→ EMEA (depth 2 only), plus a retracted Alice —was_at→ Berlin.
   */
  function seed(): void {
    addEntity(ids.alice, 'Alice', 'person');
    addEntity(ids.bob, 'Bob', 'person');
    addEntity(ids.acme, 'Acme', 'organization');
    addEntity(ids.berlin, 'Berlin', 'place');
    addEntity(ids.emea, 'EMEA', 'region');

    repo.linkEntities({ sourceId: ids.alice, targetId: ids.acme, relationType: 'works_at' });
    repo.linkEntities({ sourceId: ids.alice, targetId: ids.bob, relationType: 'knows' });
    repo.linkEntities({ sourceId: ids.bob, targetId: ids.berlin, relationType: 'lives_in' });
    repo.linkEntities({ sourceId: ids.berlin, targetId: ids.emea, relationType: 'part_of' });

    const retracted = repo.linkEntities({
      sourceId: ids.alice,
      targetId: ids.berlin,
      relationType: 'was_at',
      validFrom: RETRACTED_AT - 5_000,
    });
    repo.retractEdge(retracted.id, RETRACTED_AT);
  }

  function seedMemory(id: string): void {
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, status, created_at, updated_at)
       VALUES (?, 'user', 'k', 'fact', ?, 'active', 1, 1)`,
    ).run(id, `memory ${id}`);
  }

  function addMentionLink(id: string, memoryId: string, target: string): void {
    db.prepare(
      `INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type, confidence)
       VALUES (?, ?, ?, 'MENTIONED', 0.9)`,
    ).run(id, memoryId, target);
  }

  const nodeIds = (query: { nodes: Array<{ id: string }> }): string[] =>
    query.nodes.map((node) => node.id);

  it('walks one hop by default and two with depth=2', () => {
    const oneHop = queryEntityGraph(db, ids.alice);
    expect(oneHop).toBeDefined();
    expect(oneHop?.origin.id).toBe(ids.alice);
    expect(nodeIds(oneHop!)).toEqual(expect.arrayContaining([ids.acme, ids.bob, ids.berlin]));
    expect(nodeIds(oneHop!)).not.toContain(ids.emea);

    const twoHops = queryEntityGraph(db, ids.alice, { depth: 2 });
    expect(nodeIds(twoHops!)).toContain(ids.emea);
  });

  it('resolves a reference by id, canonical name and alias', () => {
    repo.addAlias(ids.alice, '艾丽丝');
    for (const ref of [ids.alice, 'Alice', 'alice', '艾丽丝']) {
      expect(queryEntityGraph(db, ref)?.origin.id, `ref=${ref}`).toBe(ids.alice);
    }
  });

  it('honours asOf: a retracted fact is present before the retraction and gone after it', () => {
    const before = queryEntityGraph(db, ids.alice, { asOf: RETRACTED_AT - 1 });
    const retractedEdge = before?.edges.find((edge) => edge.relation_type === 'was_at');
    expect(retractedEdge).toBeDefined();
    expect(retractedEdge?.valid_to).toBe(RETRACTED_AT);

    const after = queryEntityGraph(db, ids.alice, { asOf: RETRACTED_AT + 1 });
    expect(after?.edges.some((edge) => edge.relation_type === 'was_at')).toBe(false);
    expect(nodeIds(after!)).not.toContain(ids.berlin);
  });

  it('narrows the walk — not just the edge list — to the requested relation types', () => {
    const query = queryEntityGraph(db, ids.alice, { relationTypes: ['works_at'] });

    expect(nodeIds(query!)).toEqual([ids.acme]);
    expect(query?.edges.map((edge) => edge.relation_type)).toEqual(['works_at']);
  });

  it('reports truncation when a cap cut the payload', () => {
    const truncated = queryEntityGraph(db, ids.alice, { limit: 1 });
    expect(truncated?.truncated).toBe(true);

    const complete = queryEntityGraph(db, ids.alice, { limit: 10 });
    expect(complete?.truncated).toBe(false);
  });

  it('never returns a MENTIONED row as an edge, even when a legacy database holds one', () => {
    // A pre-K3 build could project co-occurrence into `entity_edges`;
    // `legacy-cleanup` deletes those rows, but until it runs a read surface is
    // the last gate. Insert the row the projector now refuses.
    db.prepare(
      `INSERT INTO entity_edges (id, source_entity_id, target_entity_id, relation_type, confidence, created_at)
       VALUES ('edge-mention', ?, ?, 'MENTIONED', 0.9, ?)`,
    ).run(ids.alice, ids.emea, 1);

    const query = queryEntityGraph(db, ids.alice, { includeMentions: true });

    expect(query?.edges.some((edge) => edge.relation_type === 'MENTIONED')).toBe(false);
    // ...and it is not connectivity either: the node the mention reached is not
    // a neighbour of a statement walk.
    expect(nodeIds(query!)).not.toContain(ids.emea);
    expect(query?.mentions).toEqual([]);
  });

  it('puts co-mentioned names in `mentions` only, and only when asked', () => {
    // Two memories name Alice; one also names Zeta, the other Yotta. Alice is
    // the queried entity, so it is never its own mention neighbour.
    seedMemory('mem-1');
    addMentionLink('link-1', 'mem-1', 'Alice');
    addMentionLink('link-2', 'mem-1', 'Zeta');
    addMentionLink('link-3', 'mem-1', 'Zeta');
    seedMemory('mem-2');
    addMentionLink('link-4', 'mem-2', 'Alice');
    addMentionLink('link-5', 'mem-2', 'Yotta');

    const without = queryEntityGraph(db, ids.alice);
    expect(without?.mentions).toEqual([]);
    // The mention tier never leaks into the statement tier.
    expect(without?.edges.every((edge) => edge.relation_type !== 'MENTIONED')).toBe(true);
    expect(nodeIds(without!)).not.toContain('Zeta');

    const withMentions = queryEntityGraph(db, ids.alice, { includeMentions: true });
    expect(withMentions?.mentions).toEqual([
      { name: 'Yotta', memories: 1 },
      { name: 'Zeta', memories: 1 },
    ]);
    expect(nodeIds(withMentions!)).not.toContain('Zeta');
  });

  it('answers undefined for an unknown entity and for a database with no graph tables', () => {
    expect(queryEntityGraph(db, 'nobody')).toBeUndefined();

    const bare = openDatabase(':memory:');
    bare.exec('DROP TABLE entity_edges; DROP TABLE entity_aliases; DROP TABLE entities');
    try {
      expect(queryEntityGraph(bare, 'alice')).toBeUndefined();
    } finally {
      bare.close();
    }
  });

  it('parses asOf from epoch ms, the digit-string form and ISO-8601 — never as 0', () => {
    expect(parseGraphAsOf(1700000000000)).toBe(1700000000000);
    expect(parseGraphAsOf('1700000000000')).toBe(1700000000000);
    expect(parseGraphAsOf('2023-11-14T22:13:20.000Z')).toBe(1700000000000);
    // Unparsable means "no temporal filter"; 0 would hide every edge.
    expect(parseGraphAsOf('not a time')).toBeUndefined();
    expect(parseGraphAsOf(undefined)).toBeUndefined();
  });
});
