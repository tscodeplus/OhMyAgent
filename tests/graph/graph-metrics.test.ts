/**
 * Tests for the materialised graph metrics (plan §4.3).
 *
 * The point of the two tables is that they are *the same answer, faster* — so every test
 * here compares them against the live algorithm on the same data. A materialisation that
 * quietly changes what the panel reports is worse than the slow version it replaced: the
 * numbers would be wrong in a way no reader can see.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db';
import {
  metricsMaterialised,
  readGraphStats,
  readSeedRanking,
  type GraphStats,
} from '../../src/graph/graph-query';
import { clearGraphMetrics, materializeGraphMetrics } from '../../src/graph/graph-metrics';
import { queryEntityRoster } from '../../src/graph/graph-roster';

describe('materialised graph metrics', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
    seed();
  });

  afterEach(() => {
    db.close();
  });

  /**
   * A hub, a retracted fact, two isolated names and one mention — one of each shape the
   * numbers distinguish: degree vs live degree, isolated vs mention-only, one component.
   */
  function seed(): void {
    const entities: Array<[string, string, string]> = [
      ['ent-hub', 'Hub', 'hub'],
      ['ent-leaf', 'Leaf', 'leaf'],
      ['ent-gone', 'Gone', 'gone'],
      ['ent-alone', 'Alone', 'alone'],
      ['ent-mentioned', 'Mentioned', 'mentioned'],
    ];
    for (const [id, name, canonical] of entities) {
      db.prepare(
        `INSERT INTO entities (id, name, canonical_name, entity_type, created_at, updated_at)
         VALUES (?, ?, ?, 'concept', 1, 1)`,
      ).run(id, name, canonical);
    }
    db.prepare(
      `INSERT INTO entity_edges
         (id, source_entity_id, target_entity_id, relation_type, confidence, valid_from, created_at)
       VALUES ('edge-1', 'ent-hub', 'ent-leaf', 'knows', 0.9, 1000, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO entity_edges
         (id, source_entity_id, target_entity_id, relation_type, confidence,
          valid_from, valid_to, created_at)
       VALUES ('edge-2', 'ent-hub', 'ent-gone', 'lives_in', 0.5, 1000, 2000, 1)`,
    ).run();

    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, status, created_at, updated_at)
       VALUES ('mem-1', 'user', 'k', 'fact', 'Mentioned helped', 'active', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type, confidence)
       VALUES ('link-1', 'mem-1', 'Mentioned', 'MENTIONED', 0.9)`,
    ).run();
  }

  function withoutSnapshotFlags(stats: Omit<GraphStats, 'enabled'>) {
    const { materialized: _materialized, computedAt: _computedAt, ...rest } = stats;
    return rest;
  }

  it('produces exactly the numbers the live algorithm produces', () => {
    const live = readGraphStats(db);
    expect(live.materialized).toBe(false);

    const result = materializeGraphMetrics(db);
    expect(result.metrics).toBe(5);
    expect(result.components).toBe(5);

    const materialised = readGraphStats(db);
    expect(materialised.materialized).toBe(true);
    expect(materialised.computedAt).toBe(result.computedAt);
    // Every number, not a spot check: a panel is read as one table, and a single
    // disagreeing cell makes the whole thing untrustworthy.
    expect(withoutSnapshotFlags(materialised)).toEqual(withoutSnapshotFlags(live));
  });

  it('ranks the overview identically before and after materialisation', () => {
    const live = readSeedRanking(db);
    materializeGraphMetrics(db);
    expect(readSeedRanking(db)).toEqual(live);
    // The hub leads (degree 2), then the alphabetically ordered rest.
    expect(live[0]).toBe('ent-hub');
  });

  it('gives the roster the same numbers before and after materialisation', () => {
    // The roster and the canvas must read one source: two implementations of "how many
    // relations" disagreeing inside a sync window is the bug this whole layer avoids.
    const query = { sort: 'degree' as const, dir: 'desc' as const, limit: 10 };
    const live = queryEntityRoster(db, query).items;
    materializeGraphMetrics(db);
    expect(queryEntityRoster(db, query).items).toEqual(live);
  });

  it('falls back to the live algorithm when the snapshot is cleared', () => {
    materializeGraphMetrics(db);
    expect(metricsMaterialised(db)).toBe(true);

    // This is what `graph:reset` does: the stored degrees describe edges that are gone.
    clearGraphMetrics(db);
    expect(metricsMaterialised(db)).toBe(false);
    expect(readGraphStats(db).materialized).toBe(false);
  });

  it('writes nothing on a dry run but still counts what it would write', () => {
    const result = materializeGraphMetrics(db, { dryRun: true });
    expect(result).toMatchObject({ metrics: 5, components: 5, dryRun: true });
    expect(metricsMaterialised(db)).toBe(false);
  });

  it('recomputes from scratch, so a merged node cannot leave a phantom row', () => {
    materializeGraphMetrics(db);
    // `graph-prune` merges duplicate nodes: the loser's rows must not survive, or the
    // ranking would place a node on the canvas that cannot be opened.
    db.prepare("DELETE FROM entity_edges WHERE source_entity_id = 'ent-gone'").run();
    db.prepare("DELETE FROM entities WHERE id = 'ent-gone'").run();

    materializeGraphMetrics(db);

    const ids = (
      db.prepare('SELECT entity_id AS id FROM entity_graph_metrics ORDER BY 1').all() as Array<{
        id: string;
      }>
    ).map((row) => row.id);
    expect(ids).not.toContain('ent-gone');
    expect(ids).toHaveLength(4);
  });

  it('gives the panel and the component membership the same representative', () => {
    materializeGraphMetrics(db);
    const stats = readGraphStats(db);
    const member = db
      .prepare("SELECT component_id AS id FROM entity_components WHERE entity_id = 'ent-leaf'")
      .get() as { id: string };
    expect(stats.components[0].id).toBe(member.id);
    expect(stats.components[0].size).toBe(2);
  });

  it('reports zeros instead of throwing on a database with no graph tables', () => {
    const empty = openDatabase(':memory:');
    try {
      empty.exec('DROP TABLE entity_edges');
      expect(materializeGraphMetrics(empty)).toMatchObject({ metrics: 0, components: 0 });
      expect(clearGraphMetrics(empty)).toEqual({ metrics: 0, components: 0 });
    } finally {
      empty.close();
    }
  });
});
