import { describe, it, expect, vi } from 'vitest';
import { MemoryRetriever } from '../../src/memory/memory-retriever';
import type { Memory } from '../../src/memory/repositories/memory-repository';

/**
 * Multi-hop entity-graph expansion: memory → entity → memory → entity → memory.
 *
 * The fixture is a two-hop chain — mem-a shares Alice with mem-b, mem-b shares
 * Bob with mem-c — so only the second hop can surface mem-c.
 */

function createMemory(id: string, content: string): Memory {
  const now = new Date().toISOString();
  return {
    id,
    scope: 'user',
    scope_key: 'user-1',
    kind: 'fact',
    content,
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
  };
}

const MEMORIES = [
  createMemory('mem-a', 'Alice orders latte every morning'),
  createMemory('mem-b', 'Alice pairs with Bob on the retrieval rewrite'),
  createMemory('mem-c', 'Bob prefers espresso'),
];

const ENTITIES_BY_MEMORY: Record<string, string> = {
  'mem-a': 'Alice',
  'mem-b': 'Bob',
  'mem-c': 'Bob',
};

/** Entities of `ids`' memories; the same entity is shared by several memories. */
const LINKS_BY_ENTITY: Record<string, Array<{ source_memory_id: string; confidence: number }>> = {
  Alice: [
    { source_memory_id: 'mem-a', confidence: 1 },
    { source_memory_id: 'mem-b', confidence: 0.9 },
  ],
  Bob: [
    { source_memory_id: 'mem-b', confidence: 1 },
    { source_memory_id: 'mem-c', confidence: 0.9 },
    { source_memory_id: 'mem-a', confidence: 0.5 }, // back-edge: cycle safety
  ],
};

function createLinkRepo() {
  return {
    findEntitiesByMemoryIds: vi.fn((memoryIds: string[]) =>
      memoryIds
        .filter((id) => ENTITIES_BY_MEMORY[id] !== undefined)
        .map((id) => ({
          target_entity: ENTITIES_BY_MEMORY[id],
          source_memory_id: id,
          confidence: 0.9,
        })),
    ),
    findByEntities: vi.fn(
      (entities: string[]) =>
        new Map(entities.map((entity) => [entity, LINKS_BY_ENTITY[entity] ?? []])),
    ),
  };
}

function createRetriever(linkRepo: ReturnType<typeof createLinkRepo>) {
  const byId = new Map(MEMORIES.map((memory) => [memory.id, memory]));
  return new MemoryRetriever({
    memoryRepository: {
      findById: vi.fn((id: string) => byId.get(id)),
      findByIds: vi.fn((ids: string[]) =>
        ids.map((id) => byId.get(id)).filter((memory): memory is Memory => memory !== undefined),
      ),
      searchByContent: vi.fn(() => []),
    } as never,
    embeddingRepository: {
      cosineSearch: vi.fn(() => [{ memory_id: 'mem-a', score: 0.9 }]),
    } as never,
    embeddingClient: {
      isConfigured: vi.fn(() => true),
      embedOne: vi.fn(async () => new Float32Array([0.1, 0.2, 0.3])),
    } as never,
    embeddingCacheRepo: {
      get: vi.fn(() => undefined),
      set: vi.fn(),
      count: vi.fn(() => 0),
      trim: vi.fn(() => 0),
    },
    memoryLinkRepo: linkRepo as never,
    db: { prepare: vi.fn(() => ({ all: vi.fn(() => []) })) } as never,
  });
}

describe('entity-graph multi-hop expansion', () => {
  it('surfaces a two-hop neighbour through the middle memory', async () => {
    const linkRepo = createLinkRepo();
    const page = await createRetriever(linkRepo).retrieve({ query: 'beverage', topK: 3 });

    expect(page.map((result) => result.id)).toEqual(['mem-a', 'mem-b', 'mem-c']);
  });

  it('stops at the first hop when the second adds nothing', async () => {
    const linkRepo = createLinkRepo();
    linkRepo.findEntitiesByMemoryIds.mockImplementation((memoryIds: string[]) =>
      memoryIds.includes('mem-b')
        ? []
        : memoryIds
            .filter((id) => ENTITIES_BY_MEMORY[id] !== undefined)
            .map((id) => ({
              target_entity: ENTITIES_BY_MEMORY[id],
              source_memory_id: id,
              confidence: 0.9,
            })),
    );

    const page = await createRetriever(linkRepo).retrieve({ query: 'beverage', topK: 3 });

    expect(page.map((result) => result.id)).toEqual(['mem-a', 'mem-b']);
  });

  it('terminates on a cycle and never returns a memory twice', async () => {
    const linkRepo = createLinkRepo();
    const page = await createRetriever(linkRepo).retrieve({ query: 'beverage', topK: 5 });

    const ids = page.map((result) => result.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(linkRepo.findEntitiesByMemoryIds.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
