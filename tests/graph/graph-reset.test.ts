import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema';
import { migrateV10 } from '../../src/memory/migration-v10';
import { EntityRepository } from '../../src/memory/repositories/entity-repository';
import { LEGACY_PLACEHOLDER_ENTITY_TYPE } from '../../src/graph/graph-sync';
import { parseResetArgs, resetGraph } from '../../scripts/graph-reset';

const NOW = 1_700_000_000_000;

interface EdgeRow {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  source_memory_id: string | null;
  valid_to: number | null;
}

/**
 * `graph:reset` removes exactly what the pre-K3 projection invented — the
 * `memory:<id>` placeholder nodes, the `MENTIONED` co-occurrence edges and the
 * orphan edges — and leaves every real entity and fact alone.
 */
describe('graph-reset: cleaning up the pre-K3 projection', () => {
  let db: Database.Database;
  let repo: EntityRepository;

  function seedPlaceholder(id: string): string {
    const entityId = `ent-${id}`;
    db.prepare(
      `INSERT INTO entities (id, name, canonical_name, entity_type, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).run(entityId, id, id, LEGACY_PLACEHOLDER_ENTITY_TYPE, NOW, NOW);
    return entityId;
  }

  function seedEdge(input: {
    id: string;
    source: string;
    target: string;
    relation: string;
    sourceMemoryId?: string | null;
    validTo?: number | null;
  }): void {
    db.prepare(
      `INSERT INTO entity_edges (
         id, source_entity_id, target_entity_id, relation_type, confidence,
         source_memory_id, source_message_id, valid_from, valid_to, created_at
       ) VALUES (?, ?, ?, ?, 0.8, ?, NULL, ?, ?, ?)`,
    ).run(
      input.id,
      input.source,
      input.target,
      input.relation,
      input.sourceMemoryId ?? null,
      NOW,
      input.validTo ?? null,
      NOW,
    );
  }

  function entityNames(): string[] {
    return (
      db.prepare('SELECT name FROM entities ORDER BY name').all() as Array<{ name: string }>
    ).map((row) => row.name);
  }

  function edges(): EdgeRow[] {
    return db
      .prepare(
        `SELECT id, source_entity_id, target_entity_id, relation_type, source_memory_id, valid_to
         FROM entity_edges ORDER BY id`,
      )
      .all() as EdgeRow[];
  }

  /** The shape the old projector left on the reference database. */
  function seedLegacyGraph(): void {
    const alice = repo.upsertEntity({ name: 'Alice Smith', entityType: 'person' });
    const acme = repo.upsertEntity({ name: 'Acme Corp', entityType: 'organization' });
    const chengyu = repo.upsertEntity({ name: '程语', entityType: 'concept' });
    // A real fact: both endpoints are real, and it stays.
    repo.linkEntities({
      sourceId: alice.id,
      targetId: acme.id,
      relationType: 'WORKS_AT',
      confidence: 0.9,
      validFrom: NOW,
    });
    // Legacy co-occurrence between two real entities: not a statement, deleted.
    seedEdge({ id: 'mention-real', source: alice.id, target: chengyu.id, relation: 'MENTIONED' });
    // Two placeholder nodes and their edges.
    const placeholderA = seedPlaceholder('memory:m1');
    const placeholderB = seedPlaceholder('memory:m2');
    seedEdge({
      id: 'placeholder-a',
      source: placeholderA,
      target: chengyu.id,
      relation: 'MENTIONED',
      sourceMemoryId: 'm1',
    });
    seedEdge({
      id: 'placeholder-b',
      source: placeholderB,
      target: acme.id,
      relation: 'MENTIONED',
      sourceMemoryId: 'm2',
    });
    // An edge whose memory was deleted (the measured orphan).
    seedEdge({
      id: 'orphan-memory',
      source: alice.id,
      target: acme.id,
      relation: 'FOUNDED',
      sourceMemoryId: 'memory-that-is-gone',
    });
  }

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    migrateV10(db);
    repo = new EntityRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('deletes the placeholders, MENTIONED edges and orphans without touching real entities', () => {
    seedLegacyGraph();

    const summary = resetGraph(db);

    expect(summary).toEqual({
      placeholderEntities: 2,
      placeholderEdges: 2,
      mentionEdges: 1,
      orphanEndpointEdges: 0,
      orphanMemoryEdges: 1,
    });
    // Real entities survive; only the two memory: nodes are gone.
    expect(entityNames()).toEqual(['Acme Corp', 'Alice Smith', '程语']);
    expect(edges()).toEqual([
      expect.objectContaining({
        relation_type: 'WORKS_AT',
        source_memory_id: null,
        valid_to: null,
      }),
    ]);
  });

  it('reports the same counts on a dry run and deletes nothing', () => {
    seedLegacyGraph();
    const entitiesBefore = entityNames();
    const edgesBefore = edges();

    const summary = resetGraph(db, { dryRun: true });

    expect(summary.placeholderEntities).toBe(2);
    expect(summary.placeholderEdges).toBe(2);
    expect(summary.mentionEdges).toBe(1);
    expect(summary.orphanMemoryEdges).toBe(1);
    expect(entityNames()).toEqual(entitiesBefore);
    expect(edges()).toEqual(edgesBefore);
  });

  it('is idempotent — a second run finds nothing', () => {
    seedLegacyGraph();
    resetGraph(db);

    const second = resetGraph(db);

    expect(second).toEqual({
      placeholderEntities: 0,
      placeholderEdges: 0,
      mentionEdges: 0,
      orphanEndpointEdges: 0,
      orphanMemoryEdges: 0,
    });
  });

  it('deletes edges whose endpoint no longer exists', () => {
    const alice = repo.upsertEntity({ name: 'Alice Smith', entityType: 'person' });
    // Written while `PRAGMA foreign_keys` was off, which is how the measured
    // orphan appeared: only the edge row exists.
    db.pragma('foreign_keys = OFF');
    seedEdge({
      id: 'orphan-endpoint',
      source: alice.id,
      target: 'deleted-entity',
      relation: 'KNOWS',
    });
    db.pragma('foreign_keys = ON');

    const summary = resetGraph(db);

    expect(summary.orphanEndpointEdges).toBe(1);
    expect(edges()).toEqual([]);
    expect(entityNames()).toEqual(['Alice Smith']);
  });

  it('works through more rows than one batch holds', () => {
    for (let index = 0; index < 5; index++) seedPlaceholder(`memory:m${index}`);

    const summary = resetGraph(db, { limit: 2 });

    expect(summary.placeholderEntities).toBe(5);
    expect(entityNames()).toEqual([]);
  });

  it('leaves a graph with no legacy rows completely alone', () => {
    const alice = repo.upsertEntity({ name: 'Alice Smith', entityType: 'person' });
    const acme = repo.upsertEntity({ name: 'Acme Corp', entityType: 'organization' });
    repo.linkEntities({
      sourceId: alice.id,
      targetId: acme.id,
      relationType: 'WORKS_AT',
      confidence: 1,
      validFrom: NOW,
    });

    const summary = resetGraph(db);

    expect(summary.placeholderEntities).toBe(0);
    expect(summary.mentionEdges).toBe(0);
    expect(edges()).toHaveLength(1);
  });
});

describe('graph-reset: CLI arguments', () => {
  it('defaults to a 500-row batch and no dry run', () => {
    expect(parseResetArgs([])).toEqual({
      limit: 500,
      dryRun: false,
      verbose: false,
      help: false,
    });
  });

  it('accepts --limit in both spellings and rejects what cannot be honoured', () => {
    expect(parseResetArgs(['--limit', '20']).limit).toBe(20);
    expect(parseResetArgs(['--limit=20']).limit).toBe(20);
    expect(() => parseResetArgs(['--limit', '0'])).toThrow(/--limit/);
    expect(() => parseResetArgs(['--nope'])).toThrow(/unknown option/);
  });
});
