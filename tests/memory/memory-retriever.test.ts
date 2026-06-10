import { describe, it, expect, vi } from 'vitest';
import { MemoryRetriever } from '../../src/memory/memory-retriever.js';
import { textFallbackRetrieve } from '../../src/memory/fallback-retriever.js';
import type { Memory } from '../../src/memory/repositories/memory-repository.js';

// Spy on the LLM expansion entrypoint so gating tests can assert (a) whether it
// runs at all and (b) the initialMaxScore the retriever computes from its probe.
const expandQueryLLMMock = vi.hoisted(() =>
  vi.fn(async () => ({ baseline: { ftsQuery: '', filteredTokens: [] }, variants: [] })),
);
vi.mock('../../src/memory/query-expansion-llm.js', () => ({
  expandQueryLLM: expandQueryLLMMock,
}));

// ─── Mock Helpers ───

function createMockMemory(overrides: Partial<Memory> = {}): Memory {
  const now = new Date().toISOString();
  return {
    id: 'mem-1',
    scope: 'user',
    scope_key: 'user-1',
    kind: 'fact',
    content: 'User prefers dark mode',
    metadata: null,
    agent_id: null,
    visibility: 'shared',
    status: 'active',
    supersedes_id: null,
    source_channel: null,
    source_message_id: null,
    confidence: 1.0,
    invalidated_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function createOlderMemory(hoursAgo: number, overrides: Partial<Memory> = {}): Memory {
  const now = new Date();
  now.setHours(now.getHours() - hoursAgo);
  return createMockMemory({
    created_at: now.toISOString(),
    ...overrides,
  });
}

function createMockMemoryRepository(memories: Memory[] = []) {
  const byId = new Map(memories.map(m => [m.id, m]));
  return {
    findById: vi.fn((id: string) => byId.get(id) ?? undefined),
    searchByContent: vi.fn((_query: string, _scope?: string, _scopeKey?: string) => {
      return memories;
    }),
  };
}

function createMockEmbeddingRepository(results: Array<{ memory_id: string; score: number }> = []) {
  return {
    cosineSearch: vi.fn((_query: Float32Array, limit: number) => results.slice(0, limit)),
  };
}

function createMockEmbeddingClient(embedding?: Float32Array) {
  const defaultEmb = new Float32Array([0.1, 0.2, 0.3]);
  return {
    isConfigured: vi.fn(() => true),
    embedOne: vi.fn(async (_text: string) => embedding ?? defaultEmb),
  };
}

function createMockDb() {
  return {
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
    })),
  } as any;
}

function createMockEmbeddingCacheRepo() {
  return {
    get: vi.fn(() => undefined),
    set: vi.fn(),
  };
}

// ─── MemoryRetriever Tests ───

describe('MemoryRetriever', () => {
  describe('retrieve', () => {
    it('falls back through all tiers when vec0 is unavailable', async () => {
      // sqlite-vec is intentionally not used in the main path; cosine is the vector tier.
      const memory = createMockMemory({ id: 'mem-cosine-1', content: 'Found via cosine' });
      const memoryRepo = createMockMemoryRepository([memory]);
      const embeddingRepo = createMockEmbeddingRepository([
        { memory_id: 'mem-cosine-1', score: 0.85 },
      ]);
      const embeddingClient = createMockEmbeddingClient();
      const mockDb = createMockDb();

      const mockCacheRepo = createMockEmbeddingCacheRepo();
      const retriever = new MemoryRetriever(
        memoryRepo as any,
        embeddingRepo as any,
        embeddingClient as any,
        mockCacheRepo,
        mockDb,
      );

      const results = await retriever.retrieve({ query: 'test query' });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('mem-cosine-1');
      expect(results[0].score).toBeGreaterThan(0);
    });

    it('falls back to tier 2 when tier 1 returns empty', async () => {
      const memory = createMockMemory({ id: 'mem-cosine-2', content: 'Cosine result' });
      const memoryRepo = createMockMemoryRepository([memory]);
      const embeddingRepo = createMockEmbeddingRepository([
        { memory_id: 'mem-cosine-2', score: 0.7 },
      ]);
      const embeddingClient = createMockEmbeddingClient();
      const mockDb = createMockDb();

      const mockCacheRepo = createMockEmbeddingCacheRepo();
      const retriever = new MemoryRetriever(
        memoryRepo as any,
        embeddingRepo as any,
        embeddingClient as any,
        mockCacheRepo,
        mockDb,
      );

      const results = await retriever.retrieve({ query: 'test' });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('mem-cosine-2');
    });

    it('falls back to tier 3 when both tier 1 and tier 2 return empty', async () => {
      const memory = createMockMemory({ id: 'mem-text-1', content: 'Text match result' });
      const memoryRepo = createMockMemoryRepository([memory]);
      const embeddingRepo = createMockEmbeddingRepository([]); // empty
      const embeddingClient = createMockEmbeddingClient();
      const mockDb = createMockDb();

      const mockCacheRepo = createMockEmbeddingCacheRepo();
      const retriever = new MemoryRetriever(
        memoryRepo as any,
        embeddingRepo as any,
        embeddingClient as any,
        mockCacheRepo,
        mockDb,
      );

      const results = await retriever.retrieve({ query: 'test' });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('mem-text-1');
      expect(results[0].score).toBeGreaterThan(0);
    });

    it('returns empty array when all tiers return empty', async () => {
      const memoryRepo = createMockMemoryRepository([]);
      const embeddingRepo = createMockEmbeddingRepository([]);
      const embeddingClient = createMockEmbeddingClient();
      const mockDb = createMockDb();

      const mockCacheRepo = createMockEmbeddingCacheRepo();
      const retriever = new MemoryRetriever(
        memoryRepo as any,
        embeddingRepo as any,
        embeddingClient as any,
        mockCacheRepo,
        mockDb,
      );

      const results = await retriever.retrieve({ query: 'nonexistent' });
      expect(results).toHaveLength(0);
    });
  });

  describe('topK limits results', () => {
    it('limits results to topK', async () => {
      const memories = Array.from({ length: 5 }, (_, i) =>
        createMockMemory({ id: `mem-${i}`, content: `Content ${i}` })
      );
      const memoryRepo = createMockMemoryRepository(memories);
      const embeddingRepo = createMockEmbeddingRepository(
        memories.map(m => ({ memory_id: m.id, score: 0.9 - memories.indexOf(m) * 0.1 }))
      );
      const embeddingClient = createMockEmbeddingClient();
      const mockDb = createMockDb();

      const mockCacheRepo = createMockEmbeddingCacheRepo();
      const retriever = new MemoryRetriever(
        memoryRepo as any,
        embeddingRepo as any,
        embeddingClient as any,
        mockCacheRepo,
        mockDb,
      );

      const results = await retriever.retrieve({ query: 'test', topK: 2 });
      expect(results).toHaveLength(2);
    });
  });

  describe('minScore filters results', () => {
    it('filters out results below minScore across all tiers', async () => {
      // cosine returns 0.2 (below 0.6), text fallback returns 0.5 (below 0.6)
      // With minScore 0.6, both cosine and text fallback should be filtered
      const memory = createMockMemory();
      const memoryRepo = createMockMemoryRepository([memory]);
      const embeddingRepo = createMockEmbeddingRepository([
        { memory_id: 'mem-1', score: 0.2 },
      ]);
      const embeddingClient = createMockEmbeddingClient();
      const mockDb = createMockDb();

      const mockCacheRepo = createMockEmbeddingCacheRepo();
      const retriever = new MemoryRetriever(
        memoryRepo as any,
        embeddingRepo as any,
        embeddingClient as any,
        mockCacheRepo,
        mockDb,
      );

      const results = await retriever.retrieve({ query: 'test', minScore: 0.6 });
      expect(results).toHaveLength(0);
    });

    it('keeps results above minScore', async () => {
      const memory = createMockMemory();
      const memoryRepo = createMockMemoryRepository([memory]);
      const embeddingRepo = createMockEmbeddingRepository([
        { memory_id: 'mem-1', score: 0.7 },
      ]);
      const embeddingClient = createMockEmbeddingClient();
      const mockDb = createMockDb();

      const mockCacheRepo = createMockEmbeddingCacheRepo();
      const retriever = new MemoryRetriever(
        memoryRepo as any,
        embeddingRepo as any,
        embeddingClient as any,
        mockCacheRepo,
        mockDb,
      );

      const results = await retriever.retrieve({ query: 'test' });
      expect(results).toHaveLength(1);
    });

    it('respects custom minScore', async () => {
      const memory = createMockMemory();
      const memoryRepo = createMockMemoryRepository([memory]);
      const embeddingRepo = createMockEmbeddingRepository([
        { memory_id: 'mem-1', score: 0.5 },
      ]);
      const embeddingClient = createMockEmbeddingClient();
      const mockDb = createMockDb();

      const mockCacheRepo = createMockEmbeddingCacheRepo();
      const retriever = new MemoryRetriever(
        memoryRepo as any,
        embeddingRepo as any,
        embeddingClient as any,
        mockCacheRepo,
        mockDb,
      );

      // minScore 0.6: cosine 0.5 < 0.6 filtered, text fallback 0.5 < 0.6 filtered
      const results = await retriever.retrieve({ query: 'test', minScore: 0.6 });
      expect(results).toHaveLength(0);
    });
  });

  describe('temporal decay', () => {
    it('recent memories score higher than older ones', async () => {
      const recentMemory = createOlderMemory(1, { // 1 hour old
        id: 'mem-recent',
        content: 'Recent',
      });
      const olderMemory = createOlderMemory(200, { // ~8 days old
        id: 'mem-old',
        content: 'Old',
      });
      const memoryRepo = createMockMemoryRepository([recentMemory, olderMemory]);
      const embeddingRepo = createMockEmbeddingRepository([
        { memory_id: 'mem-recent', score: 0.7 },
        { memory_id: 'mem-old', score: 0.7 },
      ]);
      const embeddingClient = createMockEmbeddingClient();
      const mockDb = createMockDb();

      const mockCacheRepo = createMockEmbeddingCacheRepo();
      const retriever = new MemoryRetriever(
        memoryRepo as any,
        embeddingRepo as any,
        embeddingClient as any,
        mockCacheRepo,
        mockDb,
      );

      const results = await retriever.retrieve({ query: 'test', topK: 2 });
      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('mem-recent');
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    it('core kind (preference) memories are exempt from decay', async () => {
      const factMemory = createOlderMemory(48, { // 2 days old
        id: 'mem-fact',
        content: 'A fact',
        kind: 'fact',
      });
      const prefMemory = createOlderMemory(48, { // 2 days old
        id: 'mem-pref',
        content: 'A preference',
        kind: 'preference',
      });
      const memoryRepo = createMockMemoryRepository([factMemory, prefMemory]);
      const embeddingRepo = createMockEmbeddingRepository([
        { memory_id: 'mem-pref', score: 0.7 },
        { memory_id: 'mem-fact', score: 0.7 },
      ]);
      const embeddingClient = createMockEmbeddingClient();
      const mockDb = createMockDb();

      const mockCacheRepo = createMockEmbeddingCacheRepo();
      const retriever = new MemoryRetriever(
        memoryRepo as any,
        embeddingRepo as any,
        embeddingClient as any,
        mockCacheRepo,
        mockDb,
      );

      const results = await retriever.retrieve({ query: 'test', topK: 2 });
      expect(results).toHaveLength(2);
      // Preference should score higher (no decay applied)
      expect(results[0].id).toBe('mem-pref');
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    it('accepts custom decayConfig in constructor', async () => {
      const memory = createMockMemory();
      const memoryRepo = createMockMemoryRepository([memory]);
      const embeddingRepo = createMockEmbeddingRepository([
        { memory_id: 'mem-1', score: 0.7 },
      ]);
      const embeddingClient = createMockEmbeddingClient();
      const mockDb = createMockDb();

      const mockCacheRepo = createMockEmbeddingCacheRepo();
      const retriever = new MemoryRetriever(
        memoryRepo as any,
        embeddingRepo as any,
        embeddingClient as any,
        mockCacheRepo,
        mockDb,
        undefined,
        { halfLifeDays: 7 },
      );

      const results = await retriever.retrieve({ query: 'test' });
      expect(results).toHaveLength(1);
    });
  });

  describe('embedding client error handling', () => {
    it('skips vec and cosine tiers when embedding fails, falls back to text', async () => {
      const memory = createMockMemory();
      const memoryRepo = createMockMemoryRepository([memory]);
      const embeddingRepo = createMockEmbeddingRepository([
        { memory_id: 'mem-1', score: 0.8 },
      ]);
      const embeddingClient = {
        embedOne: vi.fn(async () => {
          throw new Error('API error');
        }),
      };
      const mockDb = createMockDb();

      const mockCacheRepo = createMockEmbeddingCacheRepo();
      const retriever = new MemoryRetriever(
        memoryRepo as any,
        embeddingRepo as any,
        embeddingClient as any,
        mockCacheRepo,
        mockDb,
      );

      const results = await retriever.retrieve({ query: 'test' });
      // Embedding fails, so vec and cosine both skip, text fallback returns
      expect(results).toHaveLength(1);
      expect(results[0].score).toBeGreaterThan(0);
    });
  });

  describe('agent-aware grouped retrieval', () => {
    it('weights current agent memories above shared and other shared pools', async () => {
      const current = createMockMemory({
        id: 'mem-current',
        agent_id: 'agent-a',
        visibility: 'private',
        content: 'Current agent memory',
      } as any);
      const shared = createMockMemory({
        id: 'mem-shared',
        agent_id: null,
        visibility: 'shared',
        content: 'Shared memory',
      } as any);
      const otherShared = createMockMemory({
        id: 'mem-other-shared',
        agent_id: 'agent-b',
        visibility: 'shared',
        content: 'Other shared memory',
      } as any);
      const otherPrivate = createMockMemory({
        id: 'mem-other-private',
        agent_id: 'agent-b',
        visibility: 'private',
        content: 'Other private memory',
      } as any);
      const memoryRepo = createMockMemoryRepository([otherPrivate, otherShared, shared, current]);
      const retriever = new MemoryRetriever(
        memoryRepo as any,
        createMockEmbeddingRepository([]) as any,
        createMockEmbeddingClient() as any,
        createMockEmbeddingCacheRepo(),
        createMockDb(),
      );

      const results = await retriever.retrieveGrouped({ query: 'memory', agentId: 'agent-a', topK: 3 });

      expect(results.map(r => r.id)).toEqual(['mem-current', 'mem-shared', 'mem-other-shared']);
      expect(results.map(r => r.sourcePool)).toEqual(['current', 'shared', 'other']);
      expect(results.map(r => r.id)).not.toContain('mem-other-private');
    });
  });

  describe('scope and scopeKey filtering', () => {
    it('passes scope and scopeKey to text fallback', async () => {
      const memoryRepo = createMockMemoryRepository([]);
      const embeddingRepo = createMockEmbeddingRepository([]);
      const embeddingClient = createMockEmbeddingClient();
      const mockDb = createMockDb();

      const mockCacheRepo = createMockEmbeddingCacheRepo();
      const retriever = new MemoryRetriever(
        memoryRepo as any,
        embeddingRepo as any,
        embeddingClient as any,
        mockCacheRepo,
        mockDb,
      );

      await retriever.retrieve({ query: 'test', scope: 'user', scopeKey: 'u1' });
      expect(memoryRepo.searchByContent).toHaveBeenCalledWith('test', 'user', 'u1');
    });

    it('filters vector results by requested scope', async () => {
      const userMemory = createMockMemory({ id: 'mem-user', scope: 'user', content: 'User memory' });
      const sessionMemory = createMockMemory({ id: 'mem-session', scope: 'session', content: 'Session memory' });
      const memoryRepo = createMockMemoryRepository([userMemory, sessionMemory]);
      const embeddingRepo = createMockEmbeddingRepository([
        { memory_id: 'mem-session', score: 0.95 },
        { memory_id: 'mem-user', score: 0.9 },
      ]);
      const retriever = new MemoryRetriever(
        memoryRepo as any,
        embeddingRepo as any,
        createMockEmbeddingClient() as any,
        createMockEmbeddingCacheRepo(),
        createMockDb(),
      );

      const results = await retriever.retrieve({ query: 'test', scope: 'user', topK: 2 });
      expect(results.map(r => r.id)).toEqual(['mem-user']);
    });

    it('does not return another agent private vector result', async () => {
      const privateOther = createMockMemory({
        id: 'mem-private-other',
        agent_id: 'agent-b',
        visibility: 'private',
        content: 'Private other',
      } as any);
      const own = createMockMemory({
        id: 'mem-own',
        agent_id: 'agent-a',
        visibility: 'private',
        content: 'Own memory',
      } as any);
      const memoryRepo = createMockMemoryRepository([privateOther, own]);
      const embeddingRepo = createMockEmbeddingRepository([
        { memory_id: 'mem-private-other', score: 0.99 },
        { memory_id: 'mem-own', score: 0.9 },
      ]);
      const retriever = new MemoryRetriever(
        memoryRepo as any,
        embeddingRepo as any,
        createMockEmbeddingClient() as any,
        createMockEmbeddingCacheRepo(),
        createMockDb(),
      );

      const results = await retriever.retrieve({ query: 'test', agentId: 'agent-a', topK: 2 });
      expect(results.map(r => r.id)).toEqual(['mem-own']);
    });

    it('overfetches before access filtering so valid lower-ranked vector results survive', async () => {
      const inaccessible = createMockMemory({
        id: 'mem-private-other',
        agent_id: 'agent-b',
        visibility: 'private',
        content: 'Private other',
      } as any);
      const own = createMockMemory({
        id: 'mem-own',
        agent_id: 'agent-a',
        visibility: 'private',
        content: 'Own memory',
      } as any);
      const memoryRepo = createMockMemoryRepository([inaccessible, own]);
      const embeddingRepo = createMockEmbeddingRepository([
        { memory_id: 'mem-private-other', score: 0.99 },
        { memory_id: 'mem-own', score: 0.9 },
      ]);
      const retriever = new MemoryRetriever(
        memoryRepo as any,
        embeddingRepo as any,
        createMockEmbeddingClient() as any,
        createMockEmbeddingCacheRepo(),
        createMockDb(),
      );

      const results = await retriever.retrieve({ query: 'test', agentId: 'agent-a', topK: 1 });
      expect(results.map(r => r.id)).toEqual(['mem-own']);
      expect(embeddingRepo.cosineSearch).toHaveBeenCalledWith(expect.any(Float32Array), 20, expect.any(Array));
    });

    it('isolates cached retrieval results by kind filter', async () => {
      const fact = createMockMemory({ id: 'mem-fact', kind: 'fact', content: 'Fact memory' });
      const preference = createMockMemory({ id: 'mem-pref', kind: 'preference', content: 'Preference memory' });
      const memoryRepo = createMockMemoryRepository([fact, preference]);
      const embeddingRepo = createMockEmbeddingRepository([
        { memory_id: 'mem-fact', score: 0.95 },
        { memory_id: 'mem-pref', score: 0.9 },
      ]);
      const retriever = new MemoryRetriever(
        memoryRepo as any,
        embeddingRepo as any,
        createMockEmbeddingClient() as any,
        createMockEmbeddingCacheRepo(),
        createMockDb(),
      );

      const factResults = await retriever.retrieve({ query: 'test', kind: 'fact', topK: 1 });
      const preferenceResults = await retriever.retrieve({ query: 'test', kind: 'preference', topK: 1 });

      expect(factResults.map(r => r.id)).toEqual(['mem-fact']);
      expect(preferenceResults.map(r => r.id)).toEqual(['mem-pref']);
    });
  });
});

// ─── textFallbackRetrieve Tests ───

describe('textFallbackRetrieve', () => {
  it('returns memories with default score', async () => {
    const memory = createMockMemory();
    const memoryRepo = {
      searchByContent: vi.fn(() => [memory]),
    };

    const results = await textFallbackRetrieve(memoryRepo as any, 'test', 3);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(0.5);
    expect(results[0].content).toBe('User prefers dark mode');
  });

  it('limits results to topK', async () => {
    const memories = Array.from({ length: 5 }, (_, i) =>
      createMockMemory({ id: `mem-${i}`, content: `Content ${i}` })
    );
    const memoryRepo = {
      searchByContent: vi.fn(() => memories),
    };

    const results = await textFallbackRetrieve(memoryRepo as any, 'test', 2);
    expect(results).toHaveLength(2);
  });

  it('passes scope and scopeKey to repository', async () => {
    const memoryRepo = {
      searchByContent: vi.fn(() => []),
    };

    await textFallbackRetrieve(memoryRepo as any, 'test', 3, 'user', 'u1');
    expect(memoryRepo.searchByContent).toHaveBeenCalledWith('test', 'user', 'u1');
  });

  it('returns empty array when no matches', async () => {
    const memoryRepo = {
      searchByContent: vi.fn(() => []),
    };

    const results = await textFallbackRetrieve(memoryRepo as any, 'nonexistent', 3);
    expect(results).toHaveLength(0);
  });

  it('maps memory fields correctly', async () => {
    const memory = createMockMemory({
      id: 'mem-map-test',
      scope: 'chat',
      scope_key: 'chat-1',
      kind: 'preference',
      content: 'User likes blue',
    });
    const memoryRepo = {
      searchByContent: vi.fn(() => [memory]),
    };

    const results = await textFallbackRetrieve(memoryRepo as any, 'blue', 3);
    expect(results[0]).toEqual({
      id: 'mem-map-test',
      content: 'User likes blue',
      scope: 'chat',
      scopeKey: 'chat-1',
      kind: 'preference',
      score: 0.5,
      createdAt: expect.any(Number),
    });
  });
});

describe('MemoryRetriever — commonality coverage path', () => {
  // Query-aware embedding: a query mentioning an entity maps to that entity's
  // one-hot vector, so each slot's vector search returns that entity's turns.
  function entityVec(text: string): Float32Array {
    const t = text.toLowerCase();
    if (t.includes('jon')) return new Float32Array([1, 0, 0]);
    if (t.includes('gina')) return new Float32Array([0, 1, 0]);
    return new Float32Array([0, 0, 1]);
  }

  it('surfaces both entities and populates speaker for a "both" question', async () => {
    const mkTurn = (id: string, speaker: string, text: string) =>
      createMockMemory({
        id, scope: 'public_eval', scope_key: 'conv-30', kind: 'dialogue_turn',
        content: `${speaker} said: ${text}`,
        metadata: JSON.stringify({ speaker }),
      });
    const memories = [
      mkTurn('jon-1', 'Jon', 'dance is my stress relief'),
      mkTurn('jon-2', 'Jon', 'I love dancing every day'),
      mkTurn('jon-3', 'Jon', 'dancing is my passion'),
      mkTurn('gina-1', 'Gina', 'dance is my go-to for stress relief'),
    ];
    const memoryRepo = createMockMemoryRepository(memories);

    const embeddingRepo = {
      isVecAvailable: () => false,
      count: () => memories.length,
      cosineSearch: vi.fn((q: Float32Array, limit: number) =>
        memories
          .map(m => ({ memory_id: m.id, score: dot(q, entityVec(m.content)) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit),
      ),
    };
    const embeddingClient = { model: 'm', embedOne: vi.fn(async (t: string) => entityVec(t)) };
    const mockDb = createMockDb();
    const mockCacheRepo = createMockEmbeddingCacheRepo();

    const retriever = new MemoryRetriever(
      memoryRepo as any,
      embeddingRepo as any,
      embeddingClient as any,
      mockCacheRepo as any,
      mockDb,
    );

    const results = await retriever.retrieve({
      query: 'How do Jon and Gina both like to destress?',
      scope: 'public_eval', scopeKey: 'conv-30', topK: 5,
    });
    const ids = results.map(r => r.id);
    expect(ids).toContain('gina-1');        // minority entity guaranteed a seat
    expect(ids.some(id => id.startsWith('jon'))).toBe(true);
    expect(results.find(r => r.id === 'gina-1')?.kind).toBe('dialogue_turn');
  });
});

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

describe('MemoryRetriever recall config', () => {
  function captureLimit(recallConfig?: any) {
    const memory = createMockMemory({ id: 'mem-1', content: 'recall depth probe' });
    const memoryRepo = createMockMemoryRepository([memory]);
    let capturedLimit = -1;
    const embeddingRepo = {
      cosineSearch: vi.fn((_q: Float32Array, limit: number) => {
        capturedLimit = limit;
        return [{ memory_id: 'mem-1', score: 0.8 }].slice(0, limit);
      }),
    };
    const retriever = new MemoryRetriever(
      memoryRepo as any,
      embeddingRepo as any,
      createMockEmbeddingClient() as any,
      createMockEmbeddingCacheRepo(),
      createMockDb(),
      { enabled: false, minQueryLength: 15, minScoreTrigger: 0.3, maxVariants: 0, logger: { warn() {}, info() {}, error() {}, debug() {} } as any },
      undefined,
      undefined,
      0.01,
      undefined,
      undefined,
      undefined,
      undefined,
      recallConfig,
    );
    return { retriever, getLimit: () => capturedLimit };
  }

  it('uses default prefilter depth max(topK*5, 20) when unset', async () => {
    const { retriever, getLimit } = captureLimit();
    await retriever.retrieve({ query: 'probe', topK: 3 });
    expect(getLimit()).toBe(20); // max(3*5, 20)
  });

  it('honors a deeper recall config', async () => {
    const { retriever, getLimit } = captureLimit({ prefilterMultiplier: 15, prefilterMin: 60, mergeCandidateMultiplier: 8 });
    await retriever.retrieve({ query: 'probe', topK: 3 });
    expect(getLimit()).toBe(60); // max(3*15, 60)
  });
});

describe('MemoryRetriever score-gated expansion', () => {
  const quietLogger = { warn() {}, info() {}, error() {}, debug() {} } as any;

  function buildRetriever(expansionConfig: any, topScore = 0.8) {
    const memory = createMockMemory({ id: 'mem-1', content: 'expansion gate probe' });
    const memoryRepo = createMockMemoryRepository([memory]);
    // Isolate the gate signal to the vector probe: no FTS LIKE-fallback (0.5) and
    // no term hits, so the probe max reflects the cosine similarity we set.
    memoryRepo.searchByContent = vi.fn(() => []);
    const embeddingRepo = {
      cosineSearch: vi.fn((_q: Float32Array, limit: number) =>
        [{ memory_id: 'mem-1', score: topScore }].slice(0, limit),
      ),
    };
    return new MemoryRetriever(
      memoryRepo as any,
      embeddingRepo as any,
      createMockEmbeddingClient() as any,
      createMockEmbeddingCacheRepo(),
      createMockDb(),
      expansionConfig,
      undefined, undefined, 0.01,
    );
  }

  it('does not probe or call the LLM when expansion is disabled', async () => {
    expandQueryLLMMock.mockClear();
    const retriever = buildRetriever({ enabled: false, minQueryLength: 15, minScoreTrigger: 0.3, maxVariants: 4, logger: quietLogger });
    await retriever.retrieve({ query: 'what martial arts has John done', topK: 3 });
    expect(expandQueryLLMMock).not.toHaveBeenCalled();
  });

  it('does not probe or call the LLM when expansionConfig is absent', async () => {
    expandQueryLLMMock.mockClear();
    const memory = createMockMemory({ id: 'mem-1' });
    const retriever = new MemoryRetriever(
      createMockMemoryRepository([memory]) as any,
      createMockEmbeddingRepository([{ memory_id: 'mem-1', score: 0.8 }]) as any,
      createMockEmbeddingClient() as any,
      createMockEmbeddingCacheRepo(),
      createMockDb(),
      undefined as any,
    );
    await retriever.retrieve({ query: 'probe query', topK: 3 });
    expect(expandQueryLLMMock).not.toHaveBeenCalled();
  });

  it('when enabled, passes the probe top similarity as initialMaxScore', async () => {
    expandQueryLLMMock.mockClear();
    const retriever = buildRetriever(
      { enabled: true, minQueryLength: 15, minScoreTrigger: 0.3, maxVariants: 4, logger: quietLogger },
      0.82,
    );
    await retriever.retrieve({ query: 'what martial arts has John done', topK: 3 });
    expect(expandQueryLLMMock).toHaveBeenCalledTimes(1);
    const [query, , initialMaxScore] = expandQueryLLMMock.mock.calls[0] as any[];
    expect(query).toBe('what martial arts has John done');
    // Probe cosine score flows through as the gate signal (same [0,1] scale).
    expect(initialMaxScore).toBeCloseTo(0.82, 5);
  });

  it('passes a weak probe score through so the gate can trigger expansion', async () => {
    expandQueryLLMMock.mockClear();
    const retriever = buildRetriever(
      { enabled: true, minQueryLength: 15, minScoreTrigger: 0.3, maxVariants: 4, logger: quietLogger },
      0.12,
    );
    await retriever.retrieve({ query: 'what martial arts has John done', topK: 3 });
    const [, , initialMaxScore] = expandQueryLLMMock.mock.calls[0] as any[];
    expect(initialMaxScore).toBeLessThan(0.3); // below trigger → real gate would expand
  });
});
