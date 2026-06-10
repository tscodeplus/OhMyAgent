import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema.js';
import {
  EmbeddingCacheRepo,
  hashContent,
  bufferToFloat32Array,
} from '../../src/memory/repositories/embedding-cache-repository.js';
import { QueryResultCache } from '../../src/memory/query-result-cache.js';
import type { RetrievedMemory } from '../../src/memory/memory-retriever.js';

// ---------------------------------------------------------------------------
// EmbeddingCacheRepo — unit tests against an in-memory SQLite database
// ---------------------------------------------------------------------------
describe('EmbeddingCacheRepo', () => {
  let db: Database.Database;
  let repo: EmbeddingCacheRepo;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    repo = new EmbeddingCacheRepo(db, 100); // small max for testing trim
  });

  afterEach(() => {
    db.close();
  });

  // Test 1: get non-existent hash returns undefined
  it('returns undefined for non-existent hash', () => {
    expect(repo.get('nonexistent')).toBeUndefined();
  });

  // Test 2: set and get round-trip
  it('stores and retrieves an embedding cache entry', () => {
    const embedding = new Float32Array([0.1, 0.2, 0.3]);
    repo.set({
      content_hash: 'abc123',
      embedding: Buffer.from(embedding.buffer),
      model: 'test-model',
      dimension: 3,
      created_at: new Date().toISOString(),
    });
    const entry = repo.get('abc123');
    expect(entry).toBeDefined();
    expect(entry!.model).toBe('test-model');
    expect(entry!.dimension).toBe(3);
    const restored = bufferToFloat32Array(entry!.embedding);
    expect(restored[0]).toBeCloseTo(0.1);
    expect(restored[1]).toBeCloseTo(0.2);
    expect(restored[2]).toBeCloseTo(0.3);
  });

  // Test 3: duplicate set overwrites
  it('overwrites existing entry on duplicate hash', () => {
    repo.set({
      content_hash: 'abc',
      embedding: Buffer.from(new Float32Array([1, 2]).buffer),
      model: 'm1',
      dimension: 2,
      created_at: '2020-01-01',
    });
    repo.set({
      content_hash: 'abc',
      embedding: Buffer.from(new Float32Array([3, 4]).buffer),
      model: 'm2',
      dimension: 2,
      created_at: '2020-01-02',
    });
    const entry = repo.get('abc');
    expect(entry!.model).toBe('m2');
  });

  // Test 4: count
  it('counts entries correctly', () => {
    expect(repo.count()).toBe(0);
    repo.set({
      content_hash: 'a',
      embedding: Buffer.alloc(4),
      model: 'm',
      dimension: 1,
      created_at: new Date().toISOString(),
    });
    repo.set({
      content_hash: 'b',
      embedding: Buffer.alloc(4),
      model: 'm',
      dimension: 1,
      created_at: new Date().toISOString(),
    });
    expect(repo.count()).toBe(2);
  });

  // Test 5: trim removes oldest entries
  it('trim removes oldest entries first', () => {
    // Insert 5 entries with different timestamps
    for (let i = 0; i < 5; i++) {
      repo.set({
        content_hash: `hash${i}`,
        embedding: Buffer.alloc(4),
        model: 'm',
        dimension: 1,
        created_at: new Date(2020, 0, i + 1).toISOString(),
      });
    }
    // Trim to max 3
    const removed = repo.trim(3);
    expect(removed).toBeGreaterThanOrEqual(2);
    // Oldest entries (hash0, hash1) should be removed
    expect(repo.get('hash0')).toBeUndefined();
    expect(repo.get('hash1')).toBeUndefined();
    expect(repo.get('hash4')).toBeDefined();
  });

  // Test 6: auto-trim on set when over capacity
  it('auto-trims when count exceeds maxEntries', () => {
    const smallRepo = new EmbeddingCacheRepo(db, 3);
    for (let i = 0; i < 5; i++) {
      smallRepo.set({
        content_hash: `h${i}`,
        embedding: Buffer.alloc(4),
        model: 'm',
        dimension: 1,
        created_at: new Date(2020, 0, i + 1).toISOString(),
      });
    }
    expect(smallRepo.count()).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// hashContent utility
// ---------------------------------------------------------------------------
describe('hashContent', () => {
  it('produces deterministic hash for same input', () => {
    const h1 = hashContent('hello', 'model-a');
    const h2 = hashContent('hello', 'model-a');
    expect(h1).toBe(h2);
  });

  it('different content produces different hash', () => {
    const h1 = hashContent('hello', 'model-a');
    const h2 = hashContent('world', 'model-a');
    expect(h1).not.toBe(h2);
  });

  it('different model produces different hash', () => {
    const h1 = hashContent('hello', 'model-a');
    const h2 = hashContent('hello', 'model-b');
    expect(h1).not.toBe(h2);
  });

  it('returns 32-char hex string', () => {
    const h = hashContent('test', 'model');
    expect(h.length).toBe(32);
    expect(/^[0-9a-f]+$/.test(h)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// bufferToFloat32Array utility
// ---------------------------------------------------------------------------
describe('bufferToFloat32Array', () => {
  it('round-trips Float32Array -> Buffer -> Float32Array', () => {
    const original = new Float32Array([1.5, -2.3, 3.14, 0.0]);
    const buf = Buffer.from(original.buffer);
    const restored = bufferToFloat32Array(buf);
    expect(restored.length).toBe(4);
    expect(restored[0]).toBeCloseTo(1.5);
    expect(restored[1]).toBeCloseTo(-2.3);
    expect(restored[2]).toBeCloseTo(3.14);
    expect(restored[3]).toBeCloseTo(0.0);
  });
});

// ---------------------------------------------------------------------------
// QueryResultCache — in-memory LRU cache for query results
// ---------------------------------------------------------------------------
describe('QueryResultCache', () => {
  const sampleResults = (prefix: string): RetrievedMemory[] => [
    { id: `${prefix}-1`, content: `${prefix} result A`, scope: 'user', scopeKey: 'u1', kind: 'fact', score: 0.95 },
    { id: `${prefix}-2`, content: `${prefix} result B`, scope: 'user', scopeKey: 'u1', kind: 'fact', score: 0.85 },
  ];

  // Test 1: get non-existent key returns undefined
  it('returns undefined for non-existent key', () => {
    const cache = new QueryResultCache();
    expect(cache.get('nonexistent', 3)).toBeUndefined();
  });

  // Test 2: set and get round-trip
  it('stores and retrieves query results', () => {
    const cache = new QueryResultCache();
    const results = sampleResults('test');
    cache.set('hello', 3, undefined, undefined, results);
    const got = cache.get('hello', 3);
    expect(got).toBeDefined();
    expect(got).toHaveLength(2);
    expect(got![0].content).toBe('test result A');
    expect(got![0].score).toBe(0.95);
  });

  // Test 3: hit consistency — multiple gets return the same values
  it('returns consistent data on repeated gets', () => {
    const cache = new QueryResultCache();
    const results = sampleResults('hit');
    cache.set('repeated', 2, 'chat', 'c1', results);
    const first = cache.get('repeated', 2, 'chat', 'c1');
    const second = cache.get('repeated', 2, 'chat', 'c1');
    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
  });

  // Test 4: different scope produces different key (no cross-contamination)
  it('isolates entries by scope and scopeKey', () => {
    const cache = new QueryResultCache();
    const resultsA = sampleResults('a');
    const resultsB = sampleResults('b');
    cache.set('query', 3, 'chat', 'c1', resultsA);
    cache.set('query', 3, 'user', 'u1', resultsB);

    const gotA = cache.get('query', 3, 'chat', 'c1');
    const gotB = cache.get('query', 3, 'user', 'u1');
    expect(gotA).toBeDefined();
    expect(gotB).toBeDefined();
    expect(gotA![0].id).toBe('a-1');
    expect(gotB![0].id).toBe('b-1');
  });

  it('isolates entries by kind filter', () => {
    const cache = new QueryResultCache();
    const factResults = sampleResults('fact');
    const preferenceResults = sampleResults('preference');

    cache.set('query', 3, 'user', 'u1', factResults, 'agent-a', 'fact');
    cache.set('query', 3, 'user', 'u1', preferenceResults, 'agent-a', 'preference');

    expect(cache.get('query', 3, 'user', 'u1', 'agent-a', 'fact')![0].id).toBe('fact-1');
    expect(cache.get('query', 3, 'user', 'u1', 'agent-a', 'preference')![0].id).toBe('preference-1');
  });

  it('isolates entries by minScore', () => {
    const cache = new QueryResultCache();
    const broadResults = sampleResults('broad');
    const strictResults = sampleResults('strict');

    cache.set('query', 3, 'user', 'u1', broadResults, 'agent-a', undefined, 0.01);
    cache.set('query', 3, 'user', 'u1', strictResults, 'agent-a', undefined, 0.6);

    expect(cache.get('query', 3, 'user', 'u1', 'agent-a', undefined, 0.01)![0].id).toBe('broad-1');
    expect(cache.get('query', 3, 'user', 'u1', 'agent-a', undefined, 0.6)![0].id).toBe('strict-1');
  });

  // Test 5: TTL expiration
  it('expires entries after ttl', async () => {
    const cache = new QueryResultCache(100, 10); // max 100, ttl 10ms
    const results = sampleResults('ttl');
    cache.set('expire-me', 3, undefined, undefined, results);

    // Immediately after set, entry should be present
    expect(cache.get('expire-me', 3)).toBeDefined();

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(cache.get('expire-me', 3)).toBeUndefined();
  });

  // Test 6: maxEntries eviction
  it('evicts oldest entries when over maxEntries', () => {
    const cache = new QueryResultCache(3); // max 3 entries
    for (let i = 0; i < 5; i++) {
      cache.set(`q${i}`, 3, undefined, undefined, sampleResults(`e${i}`));
    }
    // Size should not exceed max
    expect(cache.size).toBeLessThanOrEqual(3);
    // Oldest entries should be evicted
    expect(cache.get('q0', 3)).toBeUndefined();
    expect(cache.get('q1', 3)).toBeUndefined();
    // Most recent entries should still be present
    expect(cache.get('q4', 3)).toBeDefined();
  });

  // Test 7: clear removes all entries
  it('clears all entries', () => {
    const cache = new QueryResultCache();
    cache.set('a', 3, undefined, undefined, sampleResults('x'));
    cache.set('b', 3, undefined, undefined, sampleResults('y'));
    expect(cache.size).toBeGreaterThan(0);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('a', 3)).toBeUndefined();
    expect(cache.get('b', 3)).toBeUndefined();
  });

  // Test 8: size reflects current count
  it('reports correct size', () => {
    const cache = new QueryResultCache(100);
    expect(cache.size).toBe(0);

    cache.set('k1', 3, undefined, undefined, sampleResults('s1'));
    expect(cache.size).toBe(1);

    cache.set('k2', 3, 'chat', 'c1', sampleResults('s2'));
    expect(cache.size).toBe(2);

    cache.clear();
    expect(cache.size).toBe(0);
  });
});
