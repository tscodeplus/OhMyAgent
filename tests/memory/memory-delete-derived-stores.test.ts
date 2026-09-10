import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { applySchema } from '../../src/memory/schema';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository';
import { EmbeddingRepository } from '../../src/memory/repositories/embedding-repository';
import {
  MemoryTermRepository,
  extractMemoryTerms,
} from '../../src/memory/repositories/memory-term-repository';
import { generateId } from '../../src/shared/ids';

/**
 * Physical deletes must clean derived stores (terms / links / embeddings /
 * FTS) — historical deletes prove FK cascade alone is insufficient (some
 * paths ran without foreign_keys=ON, and vec0 has no FK cascade at all).
 */
describe('MemoryRepository physical delete cleans derived stores', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = OFF'); // simulate paths that ran without FK enforcement
    applySchema(db);
    sqliteVec.load(db);
    repo = new MemoryRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedDerivedStores(id: string): void {
    new MemoryTermRepository(db).replaceForMemory(
      id,
      extractMemoryTerms('用户偏好使用 Windows 操作系统'),
    );
    db.prepare(
      'INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type) VALUES (?, ?, ?, ?)',
    ).run(generateId(), id, 'windows', 'prefers');
    new EmbeddingRepository(db).create({
      id: generateId(),
      memory_id: id,
      embedding: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]),
      model: 'test',
      dimension: 8,
    });
  }

  function countRows(table: string, column: string, id: string): number {
    const row = db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${column} IN (?, ?)`).get(id, id);
    return (row as { n: number }).n;
  }

  it('delete() removes terms, links, and embeddings', () => {
    const id = repo.upsert({
      id: generateId(),
      scope: 'user',
      scope_key: 'default',
      kind: 'preference',
      content: '用户偏好使用 Windows 操作系统',
    }).id;
    seedDerivedStores(id);
    expect(countRows('memory_terms', 'memory_id', id)).toBeGreaterThan(0);
    expect(countRows('memory_embeddings', 'memory_id', id)).toBeGreaterThan(0);

    expect(repo.delete(id)).toBe(true);

    expect(countRows('memory_terms', 'memory_id', id)).toBe(0);
    expect(countRows('memory_links', 'source_memory_id', id)).toBe(0);
    expect(countRows('memory_embeddings', 'memory_id', id)).toBe(0);
    expect(countRows('vec_memory_embeddings', 'memory_id', id)).toBe(0);
  });

  it('deleteByScope() removes derived stores for every deleted memory', () => {
    const first = repo.upsert({
      id: generateId(),
      scope: 'project',
      scope_key: 'proj-1',
      kind: 'fact',
      content: 'project fact Windows',
    }).id;
    const second = repo.upsert({
      id: generateId(),
      scope: 'project',
      scope_key: 'proj-1',
      kind: 'fact',
      content: 'another project fact',
    }).id;
    seedDerivedStores(first);
    seedDerivedStores(second);

    expect(repo.deleteByScope('project', 'other')).toBe(0);
    expect(repo.deleteByScope('project', 'proj-1')).toBe(2);

    expect(
      (
        db.prepare('SELECT COUNT(*) n FROM memories WHERE id IN (?, ?)').get(first, second) as {
          n: number;
        }
      ).n,
    ).toBe(0);
    expect(countRows('memory_terms', 'memory_id', first)).toBe(0);
    expect(countRows('memory_embeddings', 'memory_id', second)).toBe(0);
    expect(countRows('memory_links', 'source_memory_id', first)).toBe(0);
  });
});
