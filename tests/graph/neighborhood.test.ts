/**
 * Structural hints (`src/graph/neighborhood.ts`) — the graph's one retrieval-side
 * consumer.
 *
 * What is pinned here is the shape of the promise: hints come from *edges*, they
 * carry the memory that stated them, closed and low-confidence edges stay out, and
 * a database without the graph tables yields nothing instead of throwing (the graph
 * layer is optional, and most installs have never run a backfill).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db';
import { EntityRepository } from '../../src/memory/repositories/entity-repository';
import { formatHints, readHintsForMemories } from '../../src/graph/neighborhood';

describe('readHintsForMemories', () => {
  let db: Database.Database;
  let repo: EntityRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new EntityRepository(db);
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, status, created_at, updated_at)
       VALUES ('mem-1', 'user', 'u', 'fact', 'excel-mcp 通过 Power Query 读取文件', 'active', '1', '1')`,
    ).run();
  });

  afterEach(() => {
    db.close();
  });

  function edge(
    subject: string,
    target: string,
    options: { relation?: string; memoryId?: string; confidence?: number } = {},
  ): void {
    const source = repo.upsertEntity({ name: subject, entityType: 'product' });
    const object = repo.upsertEntity({ name: target, entityType: 'product' });
    repo.linkEntities({
      sourceId: source.id,
      targetId: object.id,
      relationType: options.relation ?? 'USES',
      confidence: options.confidence ?? 0.9,
      sourceMemoryId: options.memoryId ?? 'mem-1',
    });
  }

  it('returns the edges stated by the given memories, with their source id', () => {
    edge('excel-mcp', 'Power Query');
    const hints = readHintsForMemories(db, ['mem-1']);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatchObject({
      subject: 'excel-mcp',
      relation: 'USES',
      object: 'Power Query',
      memoryId: 'mem-1',
      memoryRef: 'mem-1',
    });
  });

  it('ignores edges stated by a memory that was not asked about', () => {
    edge('excel-mcp', 'Power Query', { memoryId: 'mem-other' });
    expect(readHintsForMemories(db, ['mem-1'])).toEqual([]);
  });

  it('ignores closed edges — a retracted relation is history, not a hint', () => {
    edge('excel-mcp', 'Power Query');
    db.prepare("UPDATE entity_edges SET valid_to = ? WHERE relation_type = 'USES'").run(Date.now());
    expect(readHintsForMemories(db, ['mem-1'])).toEqual([]);
  });

  it('ignores edges below the confidence floor', () => {
    edge('excel-mcp', 'Power Query', { confidence: 0.2 });
    expect(readHintsForMemories(db, ['mem-1'], { minConfidence: 0.6 })).toEqual([]);
  });

  it('respects the limit and orders by confidence', () => {
    edge('a-tool', 'b-tool', { confidence: 0.7 });
    edge('c-tool', 'd-tool', { confidence: 0.95 });
    const hints = readHintsForMemories(db, ['mem-1'], { limit: 1 });
    expect(hints.map((hint) => hint.subject)).toEqual(['c-tool']);
  });

  it('returns nothing for no seeds instead of scanning the table', () => {
    edge('excel-mcp', 'Power Query');
    expect(readHintsForMemories(db, [])).toEqual([]);
  });

  it('returns nothing when the graph tables do not exist', () => {
    const bare = openDatabase(':memory:');
    try {
      bare.prepare('DROP TABLE IF EXISTS entity_edges').run();
      expect(readHintsForMemories(bare, ['mem-1'])).toEqual([]);
    } finally {
      bare.close();
    }
  });

  it('formats each hint with its source reference', () => {
    expect(
      formatHints([
        {
          subject: 'excel-mcp',
          relation: 'USES',
          object: 'Power Query',
          memoryId: 'abcdef123456',
          memoryRef: 'abcdef12',
        },
      ]),
    ).toEqual(['excel-mcp —USES→ Power Query [mem:abcdef12]']);
  });
});
