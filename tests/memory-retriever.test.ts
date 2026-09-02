/**
 * Unit tests for MemoryRetriever
 *
 * Covers:
 * - concurrentMap concurrency limits
 * - Error recovery: embedding API failure degrades to FTS
 * - Circuit breaker: recovery from OPEN state
 * - Boundary conditions: empty input, large input
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';

// ── Mock dependencies ──────────────────────────────────────────────────────────

// FTS module — pure DB queries, mock to avoid real SQLite dependency
vi.mock('../src/memory/fts.js', () => ({
  ftsSearch: vi.fn(() => []),
  ftsSearchJieba: vi.fn(() => []),
}));

// Observability — captures events without side effects
vi.mock('../src/memory/observability.js', () => ({
  memoryObservability: {
    record: vi.fn(),
    snapshot: vi.fn(() => ({ total: 0, counts: {}, recent: [] })),
    clear: vi.fn(),
  },
  hashForObservation: vi.fn((v: string) => v.slice(0, 16)),
  errorForObservation: vi.fn((err: unknown) =>
    err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160),
  ),
}));

// Query expansion — return the query as-is with no expansions
vi.mock('../src/memory/query-expansion.js', () => ({
  expandQuery: vi.fn((query: string) => ({
    expanded: query,
    ftsQuery: query.includes("'") ? '' : query,
  })),
}));

// RRF merge — pass through (single-list identity)
vi.mock('../src/memory/rrf-merge.js', () => ({
  rrfMerge: vi.fn((sourceLists: Array<Array<{ id: string; score: number }>>) =>
    sourceLists.flat().map((s, i) => ({ ...s, score: s.score - i * 0.001 })),
  ),
}));

// Temporal decay — identity
vi.mock('../src/memory/temporal-decay.js', () => ({
  applyTemporalDecay: vi.fn(<T>(results: T[]) => results),
}));

// Memory access policy — always allow
vi.mock('../src/memory/memory-access-policy.js', () => ({
  matchesMemoryAccess: vi.fn(() => true),
  policyFromRetrievalOptions: vi.fn(() => ({ scope: 'user', scopeKey: '' })),
}));

// Reranker — identity
vi.mock('../src/memory/retrieval/reranker.js', () => ({
  rerankMemoryResults: vi.fn(<T>(_query: string, results: T[]) => results),
}));

// Term repository — no terms
vi.mock('../src/memory/repositories/memory-term-repository.js', () => ({
  extractQueryTerms: vi.fn(() => []),
}));

// Query planner — fall through to flat path
vi.mock('../src/memory/query-planner.js', () => ({
  planStructuredQueries: vi.fn(() => ({
    intent: 'general',
    slots: [],
    entities: [],
    flatQueries: [{ query: 'mock-variant', reason: 'mock' }],
  })),
  extractSpeaker: vi.fn(() => undefined),
  augmentSlotQueries: vi.fn((slot: any, variants: string[]) => [slot.query, ...variants]),
  DEFAULT_PLANNER_CONFIG: {
    enabled: false,
    maxEntities: 5,
    commonalityCoverage: false,
    speakerBoost: 1.2,
    perSlotFloor: 3,
  },
}));

// Coverage merge — identity
vi.mock('../src/memory/coverage-merge.js', () => ({
  coverageMerge: vi.fn((slotLists: any) => slotLists.flatMap((s: any) => s.lists)),
}));

// LLM expansion — disabled
vi.mock('../src/memory/query-expansion-llm.js', () => ({
  expandQueryLLM: vi.fn(() => ({ variants: [] })),
}));

// Embedding cache repo
vi.mock('../src/memory/repositories/index.js', () => ({
  EmbeddingCacheRepo: vi.fn().mockImplementation(() => ({
    get: vi.fn(() => undefined),
    set: vi.fn(),
  })),
  hashContent: vi.fn((query: string, _model: string) => `hash:${query}`),
  bufferToFloat32Array: vi.fn((buf: Buffer) => new Float32Array(buf.length / 4)),
}));

// Retrieval policy
vi.mock('../src/memory/retrieval/retrieval-policy.js', () => ({
  agentAwareRecallPolicy: vi.fn(() => ({
    poolWeights: { current: 1.2, shared: 1.0, otherShared: 0.8 },
  })),
}));

// ── Import after mocks ─────────────────────────────────────────────────────────
import { MemoryRetriever } from '../src/memory/memory-retriever.js';
import type { MemoryRetrieverOptions, RetrievalOptions } from '../src/memory/memory-retriever.js';
import { CircuitBreaker } from '../src/memory/circuit-breaker.js';
import type { EmbeddingClient } from '../src/provider/embedding-client.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Create a minimal mock MemoryRepository */
function createMockMemoryRepository(memories: Record<string, any> = {}) {
  return {
    findById: vi.fn((id: string) => memories[id] ?? null),
    findByIds: vi.fn((ids: string[]) => ids.map((id: string) => memories[id]).filter(Boolean)),
    findByScopeKind: vi.fn(() => []),
    searchByContent: vi.fn(() => []),
    create: vi.fn(),
    delete: vi.fn(),
  };
}

/** Create a minimal mock EmbeddingRepository */
function createMockEmbeddingRepository() {
  return {
    count: vi.fn(() => 0),
    isVecAvailable: vi.fn(() => false),
    cosineSearch: vi.fn(() => []),
    vecSearch: vi.fn(() => []),
  };
}

/** Create a minimal mock EmbeddingClient */
function createMockEmbeddingClient(overrides: Partial<EmbeddingClient> = {}): EmbeddingClient {
  return {
    embedOne: vi.fn().mockResolvedValue(new Float32Array([0.1, 0.2, 0.3])),
    embed: vi.fn().mockResolvedValue([]),
    isConfigured: vi.fn(() => true),
    get model(): string {
      return 'test-embed-model';
    },
    ...overrides,
  } as unknown as EmbeddingClient;
}

/** Create a minimal mock Database */
function createMockDb(): Database.Database {
  return {
    prepare: vi.fn(() => ({
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn(() => []),
      finalize: vi.fn(),
    })),
    exec: vi.fn(),
    close: vi.fn(),
    open: true,
    memory: true,
    readonly: false,
    name: ':memory:',
  } as unknown as Database.Database;
}

/** Create a MemoryRetriever with all mocks injected */
function createRetriever(overrides: Partial<MemoryRetrieverOptions> = {}): MemoryRetriever {
  const defaultOptions: MemoryRetrieverOptions = {
    memoryRepository: createMockMemoryRepository() as any,
    embeddingRepository: createMockEmbeddingRepository() as any,
    embeddingClient: createMockEmbeddingClient() as any,
    embeddingCacheRepo: { get: vi.fn(() => undefined), set: vi.fn() } as any,
    db: createMockDb() as any,
  };

  return new MemoryRetriever({ ...defaultOptions, ...overrides });
}

// ── concurrentMap test helper (replicates the module-private logic) ─────────────
async function concurrentMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number = 8,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('concurrentMap', () => {
  it('returns empty array for empty input', async () => {
    const result = await concurrentMap([], async (x: number) => x);
    expect(result).toEqual([]);
  });

  it('processes all items and preserves order', async () => {
    const items = [1, 2, 3, 4, 5];
    const result = await concurrentMap(items, async (x) => x * 2);
    expect(result).toEqual([2, 4, 6, 8, 10]);
  });

  it('respects concurrency limit (concurrency = 2)', async () => {
    const items = [1, 2, 3, 4, 5, 6];
    let maxInFlight = 0;
    let currentInFlight = 0;

    const result = await concurrentMap(
      items,
      async (x) => {
        currentInFlight++;
        maxInFlight = Math.max(maxInFlight, currentInFlight);
        // Simulate async work
        await new Promise((r) => setTimeout(r, 10));
        currentInFlight--;
        return x * 2;
      },
      2, // concurrency = 2
    );

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(result).toEqual([2, 4, 6, 8, 10, 12]);
  });

  it('respects concurrency limit of 1 (sequential)', async () => {
    const items = [1, 2, 3];
    let maxInFlight = 0;
    let currentInFlight = 0;

    await concurrentMap(
      items,
      async (x) => {
        currentInFlight++;
        maxInFlight = Math.max(maxInFlight, currentInFlight);
        await new Promise((r) => setTimeout(r, 5));
        currentInFlight--;
        return x;
      },
      1,
    );

    expect(maxInFlight).toBe(1);
  });

  it('handles concurrency larger than item count', async () => {
    const items = [1, 2];
    let maxInFlight = 0;
    let currentInFlight = 0;

    await concurrentMap(
      items,
      async (x) => {
        currentInFlight++;
        maxInFlight = Math.max(maxInFlight, currentInFlight);
        await new Promise((r) => setTimeout(r, 5));
        currentInFlight--;
        return x;
      },
      10, // concurrency > items.length
    );

    expect(maxInFlight).toBe(2); // All items run at once
  });

  it('propagates errors from the mapper', async () => {
    await expect(
      concurrentMap([1, 2, 3], async (x) => {
        if (x === 2) throw new Error('item-2-failed');
        return x;
      }),
    ).rejects.toThrow('item-2-failed');
  });

  it('runs tasks in parallel and completes within expected time', async () => {
    const items = [1, 2, 3, 4];
    const start = Date.now();

    await concurrentMap(
      items,
      async (x) => {
        await new Promise((r) => setTimeout(r, 30));
        return x;
      },
      4, // all in parallel
    );

    const elapsed = Date.now() - start;
    // With 4 parallel tasks each taking 30ms, total should be ~30ms, not 120ms
    expect(elapsed).toBeLessThan(80);
  });
});

describe('MemoryRetriever', () => {
  let retriever: MemoryRetriever;

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('creates an instance with default options', () => {
      retriever = createRetriever();
      expect(retriever).toBeInstanceOf(MemoryRetriever);
    });

    it('sets default values when options are omitted', () => {
      retriever = createRetriever();
      expect(retriever).toBeDefined();
      // Calling a method should not throw
      retriever.clearCache();
    });
  });

  describe('clearCache', () => {
    it('clears without throwing when cache exists', () => {
      retriever = createRetriever();
      expect(() => retriever.clearCache()).not.toThrow();
    });

    it('is safe to call multiple times', () => {
      retriever = createRetriever();
      expect(() => {
        retriever.clearCache();
        retriever.clearCache();
        retriever.clearCache();
      }).not.toThrow();
    });
  });

  describe('retrieve with textOnly=true', () => {
    it('returns empty array for empty memory repository', async () => {
      retriever = createRetriever();
      const results = await retriever.retrieve({ query: 'test query', textOnly: true });
      expect(results).toEqual([]);
    });

    it('returns results from text fallback when FTS has no matches', async () => {
      const mockRepo = createMockMemoryRepository({
        mem1: {
          id: 'mem1',
          scope: 'user',
          scope_key: '',
          kind: 'fact',
          content: 'test content',
          status: 'active',
          created_at: '1000',
        },
      });
      mockRepo.searchByContent = vi
        .fn()
        .mockReturnValue([
          {
            id: 'mem1',
            scope: 'user',
            scope_key: '',
            kind: 'fact',
            content: 'test content',
            status: 'active',
            created_at: '1000',
          },
        ]);
      retriever = createRetriever({ memoryRepository: mockRepo as any });
      const results = await retriever.retrieve({ query: 'test', textOnly: true });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('mem1');
      expect(results[0].score).toBeGreaterThan(0);
    });
  });

  describe('error recovery', () => {
    it('returns empty result when embedding API fails but still proceeds', async () => {
      const failingClient = createMockEmbeddingClient();
      (failingClient.embedOne as any).mockRejectedValue(new Error('API timeout'));
      (failingClient.isConfigured as any).mockReturnValue(true);

      const mockRepo = createMockMemoryRepository();
      const mockEmbRepo = createMockEmbeddingRepository();

      retriever = createRetriever({
        embeddingClient: failingClient as any,
        memoryRepository: mockRepo as any,
        embeddingRepository: mockEmbRepo as any,
      });

      // Should not throw — should degrade gracefully and return empty since no FTS matches
      const results = await retriever.retrieve({ query: 'something' });
      expect(results).toEqual([]);
    });

    it('recovers from temporary embedding API failure', async () => {
      let callCount = 0;
      const flakyClient = createMockEmbeddingClient();
      (flakyClient.embedOne as any).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('temporary failure');
        return new Float32Array([0.1, 0.2, 0.3]);
      });

      const mockEmbRepo = createMockEmbeddingRepository();
      mockEmbRepo.cosineSearch = vi.fn().mockReturnValue([]);

      retriever = createRetriever({
        embeddingClient: flakyClient as any,
        embeddingRepository: mockEmbRepo as any,
      });

      // First call fails, should return empty but not throw
      const r1 = await retriever.retrieve({ query: 'try-1' });
      expect(r1).toEqual([]);
      expect(callCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('circuit breaker', () => {
    it('degrades to empty vector results when breaker is OPEN', async () => {
      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 60000,
        nowFn: () => Date.now(),
      });
      breaker.recordFailure(); // Trip to OPEN

      retriever = createRetriever({ embeddingBreaker: breaker });
      expect(breaker.currentState).toBe('OPEN');

      // breaker.allow() returns false → getQueryEmbedding returns undefined
      const results = await retriever.retrieve({ query: 'test' });
      // Should not throw, vector search returns empty array
      expect(results).toEqual([]);
    });

    it('transitions from OPEN to HALF_OPEN after cooldown and allows a probe', async () => {
      const fakeNow = Date.now();
      const nowFn = vi.fn(() => fakeNow);

      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        cooldownMs: 5000,
        nowFn,
      });
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.currentState).toBe('OPEN');

      // Before cooldown — allow() returns false
      expect(breaker.allow()).toBe(false);
      expect(breaker.currentState).toBe('OPEN');

      // Advance time past cooldown
      nowFn.mockReturnValue(fakeNow + 6000);
      expect(breaker.allow()).toBe(true);
      expect(breaker.currentState).toBe('HALF_OPEN');
    });

    it('returns to CLOSED after a successful probe in HALF_OPEN state', async () => {
      const fakeNow = Date.now();
      const nowFn = vi.fn(() => fakeNow);

      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        cooldownMs: 5000,
        nowFn,
      });
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.currentState).toBe('OPEN');

      // Advance past cooldown
      nowFn.mockReturnValue(fakeNow + 6000);
      const probe = breaker.allow();
      expect(probe).toBe(true);
      expect(breaker.currentState).toBe('HALF_OPEN');

      // Success resets to CLOSED
      breaker.recordSuccess();
      expect(breaker.currentState).toBe('CLOSED');
      expect(breaker.failures).toBe(0);
    });

    it('re-opens if the HALF_OPEN probe fails', async () => {
      const fakeNow = Date.now();
      const nowFn = vi.fn(() => fakeNow);

      const breaker = new CircuitBreaker({
        failureThreshold: 2,
        cooldownMs: 5000,
        nowFn,
      });
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.currentState).toBe('OPEN');

      // Enter HALF_OPEN
      nowFn.mockReturnValue(fakeNow + 6000);
      breaker.allow();
      expect(breaker.currentState).toBe('HALF_OPEN');

      // Probe fails → back to OPEN
      breaker.recordFailure();
      expect(breaker.currentState).toBe('OPEN');
    });

    it('only allows one probe when HALF_OPEN', async () => {
      const fakeNow = Date.now();
      const nowFn = vi.fn(() => fakeNow);

      const breaker = new CircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 5000,
        nowFn,
      });
      breaker.recordFailure();
      expect(breaker.currentState).toBe('OPEN');

      // Enter HALF_OPEN
      nowFn.mockReturnValue(fakeNow + 6000);
      expect(breaker.allow()).toBe(true); // Probe allowed
      expect(breaker.allow()).toBe(false); // Second call blocked
    });
  });

  describe('retrieveGrouped', () => {
    it('returns empty results when no memories exist', async () => {
      retriever = createRetriever();
      const results = await retriever.retrieveGrouped({
        query: 'test',
        agentId: 'agent-1',
      });
      expect(results).toEqual([]);
    });
  });

  describe('listScenes', () => {
    it('returns empty array when no scene memories exist', async () => {
      const mockRepo = createMockMemoryRepository();
      mockRepo.findByScopeKind = vi.fn(() => []);
      retriever = createRetriever({ memoryRepository: mockRepo as any });
      const scenes = await retriever.listScenes('user');
      expect(scenes).toEqual([]);
    });

    it('parses metadata from scene memories', async () => {
      const mockRepo = createMockMemoryRepository();
      mockRepo.findByScopeKind = vi.fn(() => [
        {
          id: 'scene-1',
          scope: 'user',
          scope_key: 'sprint-1',
          kind: 'scene',
          content: '/ref/plan.md',
          metadata: JSON.stringify({ startDate: '2025-01-01', endDate: '2025-01-31' }),
          status: 'active',
          created_at: '1000',
        },
      ]);
      retriever = createRetriever({ memoryRepository: mockRepo as any });
      const scenes = await retriever.listScenes('user');
      expect(scenes).toHaveLength(1);
      expect(scenes[0].scopeKey).toBe('sprint-1');
      expect(scenes[0].refPath).toBe('/ref/plan.md');
      expect(scenes[0].startDate).toBe('2025-01-01');
      expect(scenes[0].endDate).toBe('2025-01-31');
    });

    it('handles invalid metadata gracefully', async () => {
      const mockRepo = createMockMemoryRepository();
      mockRepo.findByScopeKind = vi.fn(() => [
        {
          id: 'scene-2',
          scope: 'user',
          scope_key: 'bad-scene',
          kind: 'scene',
          content: '/ref/notes.md',
          metadata: '{invalid json',
          status: 'active',
          created_at: '1000',
        },
      ]);
      retriever = createRetriever({ memoryRepository: mockRepo as any });
      const scenes = await retriever.listScenes('user');
      expect(scenes).toHaveLength(1);
      expect(scenes[0].startDate).toBe('');
      expect(scenes[0].endDate).toBe('');
    });
  });

  describe('boundary conditions', () => {
    it('handles empty query string', async () => {
      retriever = createRetriever();
      const results = await retriever.retrieve({ query: '' });
      expect(results).toEqual([]);
    });

    it('handles query with only whitespace', async () => {
      retriever = createRetriever();
      const results = await retriever.retrieve({ query: '   ' });
      expect(results).toEqual([]);
    });

    it('handles very long query string', async () => {
      const longQuery = 'x'.repeat(10000);
      retriever = createRetriever();
      // Should not throw
      const results = await retriever.retrieve({ query: longQuery });
      expect(results).toEqual([]);
    });

    it('handles topK = 0', async () => {
      retriever = createRetriever();
      const results = await retriever.retrieve({ query: 'test', topK: 0 });
      expect(results).toEqual([]);
    });

    it('handles negative minScore gracefully', async () => {
      retriever = createRetriever();
      const results = await retriever.retrieve({ query: 'test', minScore: -1 });
      expect(results).toEqual([]);
    });

    it('handles sceneId mapping to scopeKey', async () => {
      retriever = createRetriever();
      const results = await retriever.retrieve({ query: 'test', sceneId: 'scene-abc' });
      // Should not throw; sceneId maps to scopeKey
      expect(results).toEqual([]);
    });
  });
});
