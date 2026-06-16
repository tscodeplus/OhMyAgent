import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRetriever } from '../../src/memory/memory-retriever.js';
import { memoryObservability } from '../../src/memory/observability.js';

function createMemoryRepository() {
  return {
    findById: vi.fn(),
    searchByContent: vi.fn(() => []),
  };
}

function createDb() {
  return {
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
    })),
  } as any;
}

describe('MemoryRetriever vector full-scan guard', () => {
  beforeEach(() => {
    memoryObservability.clear();
  });

  it('skips unfiltered cosine scan when embedding count exceeds threshold', async () => {
    const embeddingRepo = {
      count: vi.fn(() => 5001),
      cosineSearch: vi.fn(() => []),
    };
    const retriever = new MemoryRetriever({ memoryRepository: createMemoryRepository() as any, embeddingRepository: embeddingRepo as any, embeddingClient: { model: 'test', isConfigured: vi.fn(() => true), embedOne: vi.fn(async () => new Float32Array([1, 0])) } as any, embeddingCacheRepo: { get: vi.fn(() => undefined), set: vi.fn() } as any, db: createDb(), expansionConfig: undefined as any, fullScanMaxEmbeddings: 5000 });

    const results = await retriever.retrieve({ query: 'anything' });

    expect(results).toEqual([]);
    expect(embeddingRepo.cosineSearch).not.toHaveBeenCalled();
    expect(memoryObservability.snapshot().counts['memory.vector.full_scan_skipped']).toBe(1);
  });
});
