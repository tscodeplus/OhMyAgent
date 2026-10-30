/**
 * `EntityRepository.linkEntities` — the refresh path (P7 of the 2026-10-30
 * review). An edge re-asserted by a newer memory must re-attach to that
 * memory: neighborhood hints filter on `source_memory_id IN (memories just
 * retrieved)` (`src/graph/neighborhood.ts`), so a refresh that keeps the
 * first memory leaves the edge orphaned the moment that memory is deleted.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db';
import { EntityRepository, type EntityEdge } from '../../src/memory/repositories/entity-repository';
import { readHintsForMemories } from '../../src/graph/neighborhood';

describe('EntityRepository.linkEntities refresh re-attributes the edge', () => {
  let db: Database.Database;
  let repo: EntityRepository;
  let alice = '';
  let acme = '';
  const m1 = 'mem-first';
  const m2 = 'mem-second';

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new EntityRepository(db);
    alice = repo.upsertEntity({ name: 'Alice', entityType: 'person' }).id;
    acme = repo.upsertEntity({ name: 'Acme', entityType: 'organization' }).id;
    // `memory_links.source_memory_id` and the hint join read real memory rows
    // (the edges' source memory points at one).
    for (const id of [m1, m2]) {
      db.prepare(
        `INSERT INTO memories (id, scope, scope_key, kind, content, status, created_at, updated_at)
         VALUES (?, 'user', 'k', 'fact', ?, 'active', 1, 1)`,
      ).run(id, `memory ${id}`);
    }
  });

  afterEach(() => {
    db.close();
  });

  function edge(speaker: string = alice): EntityEdge {
    return repo.linkEntities({
      sourceId: speaker,
      targetId: acme,
      relationType: 'works_at',
      confidence: 0.9,
      sourceMemoryId: m1,
    });
  }

  function rows(): EntityEdge[] {
    return db.prepare('SELECT * FROM entity_edges ORDER BY created_at').all() as EntityEdge[];
  }

  it('re-attaches an open edge to the newer asserting memory', () => {
    edge();

    const reasserted = repo.linkEntities({
      sourceId: alice,
      targetId: acme,
      relationType: 'works_at',
      confidence: 0.95,
      sourceMemoryId: m2,
    });

    // No duplicate stacked: the same (subject, relation, target) restates.
    expect(rows()).toHaveLength(1);
    expect(reasserted.id).toBe(rows()[0]!.id);
    expect(rows()[0]!.source_memory_id).toBe(m2);
    expect(rows()[0]!.confidence).toBe(0.95);
    expect(rows()[0]!.valid_to).toBeNull();
  });

  it('leaves an untouched refresh path alone when the caller names no memory', () => {
    edge();

    repo.linkEntities({ sourceId: alice, targetId: acme, relationType: 'works_at' });

    expect(rows()[0]!.source_memory_id).toBe(m1);
  });

  it('never rewrites a closed edge — a new open edge takes the new memory instead', () => {
    const closed = edge();
    repo.retractEdge(closed.id);

    repo.linkEntities({
      sourceId: alice,
      targetId: acme,
      relationType: 'works_at',
      confidence: 0.9,
      sourceMemoryId: m2,
    });

    const [old, open] = rows();
    // History keeps its original attribution: closed rows are not hint
    // candidates, so re-pointing them would be pure data loss.
    expect(old?.source_memory_id).toBe(m1);
    expect(old?.valid_to).not.toBeNull();
    expect(open?.source_memory_id).toBe(m2);
    expect(open?.valid_to).toBeNull();
  });

  it('moves the neighborhood hint to the memory that currently asserts the edge', () => {
    edge();

    const before = readHintsForMemories(db, [m1]);
    expect(before).toHaveLength(1);

    repo.linkEntities({
      sourceId: alice,
      targetId: acme,
      relationType: 'works_at',
      confidence: 0.9,
      sourceMemoryId: m2,
    });

    // The old memory no longer hints, the new one does — even once the first
    // memory (the pre-fix permanent orphan case) is deleted outright.
    expect(readHintsForMemories(db, [m1])).toEqual([]);
    expect(readHintsForMemories(db, [m2])).toHaveLength(1);
    db.prepare('DELETE FROM memories WHERE id = ?').run(m1);
    expect(readHintsForMemories(db, [m2])).toHaveLength(1);
  });
});
