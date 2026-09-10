import { describe, it, expect, vi } from 'vitest';
import { applyRecallCharBudget } from '../../src/memory/memory-retriever.js';
import type { RetrievedMemory } from '../../src/memory/memory-retriever.js';

function item(id: string, content: string, score = 1): RetrievedMemory {
  return {
    id,
    content,
    scope: 'user',
    kind: 'fact',
    score,
    createdAt: 0,
  };
}

describe('applyRecallCharBudget', () => {
  it('is a no-op when both budgets are 0', () => {
    const results = [item('a', 'x'.repeat(500))];
    const out = applyRecallCharBudget(results, { maxCharsPerMemory: 0, maxTotalRecallChars: 0 });
    expect(out).toBe(results);
    expect(out[0].content).toHaveLength(500);
  });

  it('truncates oversized items with an ellipsis marker', () => {
    const out = applyRecallCharBudget([item('a', 'x'.repeat(100))], {
      maxCharsPerMemory: 10,
      maxTotalRecallChars: 0,
    });
    expect(out[0].content).toBe('x'.repeat(10) + '…');
  });

  it('keeps all items when each fits the total budget', () => {
    const results = [item('a', 'abcdefghij', 3), item('b', 'klmnop', 2), item('c', 'xyz', 1)];
    const out = applyRecallCharBudget(results, { maxCharsPerMemory: 0, maxTotalRecallChars: 100 });
    expect(out.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops items that overflow the total budget, keeping the highest scores', () => {
    const results = [item('a', 'a'.repeat(10), 3), item('b', 'b'.repeat(10), 2), item('c', 'c', 1)];
    const out = applyRecallCharBudget(results, { maxCharsPerMemory: 0, maxTotalRecallChars: 15 });
    // a(10) + b(10) would be 20 > 15 → b dropped; c fits (10 + 1 = 11).
    expect(out.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('always keeps the top item even when it alone exceeds the total budget', () => {
    const results = [item('a', 'a'.repeat(50), 3), item('b', 'b', 1)];
    const out = applyRecallCharBudget(results, { maxCharsPerMemory: 0, maxTotalRecallChars: 10 });
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('a');
    expect(out[0].content).toBe('a'.repeat(10) + '…');
  });

  it('combines per-item truncation with a total budget', () => {
    const results = [item('a', 'a'.repeat(100), 3), item('b', 'b'.repeat(100), 2)];
    const out = applyRecallCharBudget(results, {
      maxCharsPerMemory: 10,
      maxTotalRecallChars: 30,
    });
    expect(out[0].content).toBe('a'.repeat(10) + '…');
    expect(out[1].content).toBe('b'.repeat(10) + '…');
    expect(out).toHaveLength(2);
  });
});

describe('MemoryRetriever recall char budget integration', () => {
  const expandQueryLLMMock = vi.hoisted(() =>
    vi.fn(async () => ({ baseline: { ftsQuery: '', filteredTokens: [] }, variants: [] })),
  );
  vi.mock('../../src/memory/query-expansion-llm.js', () => ({
    expandQueryLLM: expandQueryLLMMock,
  }));

  it('truncates oversized results on the text fallback path', async () => {
    const { MemoryRetriever } = await import('../../src/memory/memory-retriever.js');
    const longA = 'a'.repeat(60);
    const longB = 'b'.repeat(60);
    const memoryRepo = {
      searchByContent: vi.fn(() => [
        {
          id: 'mem-a',
          scope: 'user',
          scope_key: 'u',
          kind: 'fact',
          content: longA,
          metadata: null,
          agent_id: null,
          visibility: 'shared',
          status: 'active',
          supersedes_id: null,
          source_channel: null,
          source_message_id: null,
          confidence: 1,
          invalidated_at: null,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'mem-b',
          scope: 'user',
          scope_key: 'u',
          kind: 'fact',
          content: longB,
          metadata: null,
          agent_id: null,
          visibility: 'shared',
          status: 'active',
          supersedes_id: null,
          source_channel: null,
          source_message_id: null,
          confidence: 1,
          invalidated_at: null,
          created_at: '2026-01-02T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
        },
      ]),
      findByIds: vi.fn(() => []),
    };
    const retriever = new MemoryRetriever({
      memoryRepository: memoryRepo as any,
      embeddingRepository: {} as any,
      embeddingClient: { isConfigured: () => false } as any,
      embeddingCacheRepo: { get: () => undefined, set: () => undefined } as any,
      db: { prepare: () => ({ all: () => [] }) } as any,
      expansionConfig: {
        enabled: false,
        minQueryLength: 15,
        minScoreTrigger: 0.3,
        maxVariants: 0,
        logger: { warn() {}, info() {}, error() {}, debug() {} } as any,
      },
      defaultMinScore: 0.01,
      recallConfig: {
        prefilterMultiplier: 5,
        prefilterMin: 20,
        mergeCandidateMultiplier: 3,
        maxCharsPerMemory: 20,
        maxTotalRecallChars: 0,
      },
    });

    const results = await retriever.retrieve({ query: 'probe', topK: 5, textOnly: true });
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe('a'.repeat(20) + '…');
    expect(results[1].content).toBe('b'.repeat(20) + '…');
  });
});
