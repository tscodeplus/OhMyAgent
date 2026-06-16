import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository';
import { EmbeddingRepository } from '../../src/memory/repositories/embedding-repository';
import { MemoryWriter } from '../../src/memory/memory-writer';
import { EmbeddingCacheRepo } from '../../src/memory/repositories/embedding-cache-repository';

let db: Database.Database;
let memoryRepo: MemoryRepository;
let embeddingRepo: EmbeddingRepository;
let idCounter = 0;

function uniqueId(prefix: string): string {
  idCounter++;
  return `${prefix}-${Date.now()}-${idCounter}`;
}

/**
 * Create a mock EmbeddingClient that returns deterministic vectors.
 * Uses 8 dimensions with a hash that spreads across all dimensions
 * to produce well-separated unit vectors for different texts.
 */
function createMockEmbeddingClient() {
  const stored = new Map<string, Float32Array>();

  function textToVector(text: string): Float32Array {
    const DIM = 8;
    const vec = new Float32Array(DIM);
    // Use multiple independent hash seeds to fill each dimension
    for (let d = 0; d < DIM; d++) {
      let h = (d + 1) * 0x9e3779b9; // golden ratio seed per dimension
      for (let i = 0; i < text.length; i++) {
        h = ((h << 5) - h + text.charCodeAt(i)) | 0;
      }
      // Map to [-1, 1]
      vec[d] = (h & 0xffff) / 0x7fff - 1;
    }
    // Normalize to unit vector
    let norm = 0;
    for (let i = 0; i < DIM; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < DIM; i++) vec[i] /= norm;
    return vec;
  }

  return {
    isConfigured: vi.fn(() => true),
    model: 'default',
    embedOne: vi.fn(async (text: string) => {
      if (!stored.has(text)) {
        stored.set(text, textToVector(text));
      }
      return stored.get(text)!;
    }),
    stored,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  memoryRepo = new MemoryRepository(db);
  embeddingRepo = new EmbeddingRepository(db);
  idCounter = 0;
});

afterEach(() => {
  db.close();
});

function createWriter(embeddingClient?: ReturnType<typeof createMockEmbeddingClient>, onMemoryChanged?: () => void) {
  const client = embeddingClient ?? createMockEmbeddingClient();
  const mockCacheRepo = {
    get: vi.fn(() => undefined),
    set: vi.fn(),
  } as unknown as EmbeddingCacheRepo;
  const writer = new MemoryWriter({ memoryRepository: memoryRepo, embeddingRepository: embeddingRepo, embeddingClient: client, embeddingCacheRepo: mockCacheRepo, onMemoryChanged: onMemoryChanged });
  return { writer, embeddingClient: client };
}

describe('MemoryWriter', () => {
  describe('write', () => {
    it('creates memory and embedding by default', async () => {
      const { writer, embeddingClient } = createWriter();

      const result = await writer.write({
        content: 'User prefers dark mode',
        scope: 'user',
        scopeKey: 'u1',
        kind: 'preference',
      });

      expect(result.isDuplicate).toBe(false);
      expect(result.id).toBeTruthy();
      expect(result.duplicateOf).toBeUndefined();

      // Memory was created
      const memory = memoryRepo.findById(result.id);
      expect(memory).toBeDefined();
      expect(memory!.content).toBe('User prefers dark mode');
      expect(memory!.scope).toBe('user');
      expect(memory!.scope_key).toBe('u1');
      expect(memory!.kind).toBe('preference');

      // Embedding was generated
      expect(embeddingClient.embedOne).toHaveBeenCalledWith('User prefers dark mode');

      // Embedding was stored in repository
      const emb = embeddingRepo.findByMemoryId(result.id);
      expect(emb).toBeDefined();
      expect(emb!.model).toBe('default');
      expect(emb!.dimension).toBe(8);
    });

    it('creates memory with default kind=fact', async () => {
      const { writer } = createWriter();

      const result = await writer.write({
        content: 'Some fact',
        scope: 'chat',
        scopeKey: 'c1',
      });

      const memory = memoryRepo.findById(result.id);
      expect(memory!.kind).toBe('fact');
    });

    it('creates memory with empty scopeKey when not provided', async () => {
      const { writer } = createWriter();

      const result = await writer.write({
        content: 'Content without scope key',
        scope: 'global',
      });

      const memory = memoryRepo.findById(result.id);
      expect(memory!.scope_key).toBe('');
    });

    it('skips embedding when generateEmbedding=false', async () => {
      const { writer, embeddingClient } = createWriter();

      const result = await writer.write({
        content: 'No embedding needed',
        scope: 'user',
        scopeKey: 'u1',
        generateEmbedding: false,
      });

      expect(result.isDuplicate).toBe(false);
      expect(result.id).toBeTruthy();

      // Memory was created
      const memory = memoryRepo.findById(result.id);
      expect(memory).toBeDefined();
      expect(memory!.content).toBe('No embedding needed');

      // Embedding was NOT generated
      expect(embeddingClient.embedOne).not.toHaveBeenCalled();

      // No embedding stored
      const emb = embeddingRepo.findByMemoryId(result.id);
      expect(emb).toBeUndefined();
    });

    it('exact-match dedup still works when generateEmbedding=false', async () => {
      const { writer } = createWriter();

      // Write first memory
      const first = await writer.write({
        content: 'Exact same content',
        scope: 'user',
        scopeKey: 'u1',
      });
      expect(first.isDuplicate).toBe(false);

      // Write duplicate content with embedding disabled — exact-match dedup still catches it
      const second = await writer.write({
        content: 'Exact same content',
        scope: 'user',
        scopeKey: 'u1',
        generateEmbedding: false,
      });
      expect(second.isDuplicate).toBe(true);
      expect(second.duplicateOf).toBe(first.id);
    });
  });

  describe('hasSimilarMemory', () => {
    it('returns match when similarity >= threshold (cosine fallback)', async () => {
      const { writer, embeddingClient } = createWriter();
      const text = 'User prefers dark mode';

      // Generate the embedding the mock would produce, then store it
      const embedding = await embeddingClient.embedOne(text);
      const mem = memoryRepo.create({
        id: uniqueId('mem'),
        scope: 'user',
        scope_key: 'u1',
        kind: 'fact',
        content: text,
      });
      embeddingRepo.create({
        id: uniqueId('emb'),
        memory_id: mem.id,
        embedding,
        model: 'test',
        dimension: 8,
      });

      // Search with same text — should match (identical vectors = similarity 1.0)
      const match = await writer.hasSimilarMemory(text, 0.9);
      expect(match).not.toBeNull();
      expect(match!.id).toBe(mem.id);
    });

    it('returns null when no similar memory exists', async () => {
      const { writer, embeddingClient } = createWriter();

      // Store embedding for one text
      const storedText = 'User prefers dark mode';
      const storedEmbedding = await embeddingClient.embedOne(storedText);
      const mem = memoryRepo.create({
        id: uniqueId('mem'),
        scope: 'user',
        scope_key: 'u1',
        kind: 'fact',
        content: storedText,
      });
      embeddingRepo.create({
        id: uniqueId('emb'),
        memory_id: mem.id,
        embedding: storedEmbedding,
        model: 'test',
        dimension: 8,
      });

      // The mock generates different vectors for different text.
      // Use threshold=1.0 so only exact matches pass
      const match = await writer.hasSimilarMemory('Completely different topic', 1.0);
      expect(match).toBeNull();
    });

    it('returns null when no embeddings exist', async () => {
      const { writer } = createWriter();

      const match = await writer.hasSimilarMemory('Some content', 0.5);
      expect(match).toBeNull();
    });

    it('respects threshold parameter', async () => {
      const { writer, embeddingClient } = createWriter();
      const text = 'existing content';

      // Generate and store the mock's embedding
      const embedding = await embeddingClient.embedOne(text);
      const mem = memoryRepo.create({
        id: uniqueId('mem'),
        scope: 'user',
        scope_key: 'u1',
        kind: 'fact',
        content: text,
      });
      embeddingRepo.create({
        id: uniqueId('emb'),
        memory_id: mem.id,
        embedding,
        model: 'test',
        dimension: 8,
      });

      // Identical text → identical vector → similarity = 1.0, so threshold 1.0 passes
      const match = await writer.hasSimilarMemory(text, 1.0);
      expect(match).not.toBeNull();
    });
  });

  describe('writeBatch', () => {
    it('writes multiple memories', async () => {
      const { writer } = createWriter();

      // Use texts that produce sufficiently distinct hash vectors
      // to avoid false-positive dedup
      const results = await writer.writeBatch([
        { content: 'The quick brown fox jumps over the lazy dog', scope: 'user', scopeKey: 'u1' },
        { content: 'A completely different sentence about quantum physics', scope: 'user', scopeKey: 'u1' },
        { content: 'Yet another unrelated text concerning cooking recipes', scope: 'chat', scopeKey: 'c1', kind: 'task' },
      ]);

      expect(results).toHaveLength(3);
      expect(results.every(r => r.isDuplicate === false)).toBe(true);
      expect(results.every(r => r.id)).toBeTruthy();

      // All three memories exist
      for (const r of results) {
        expect(memoryRepo.findById(r.id)).toBeDefined();
      }

      // All three have embeddings
      for (const r of results) {
        expect(embeddingRepo.findByMemoryId(r.id)).toBeDefined();
      }
    });

    it('handles empty batch', async () => {
      const { writer } = createWriter();

      const results = await writer.writeBatch([]);
      expect(results).toHaveLength(0);
    });

    it('skips embedding for items with generateEmbedding=false', async () => {
      const { writer } = createWriter();

      const results = await writer.writeBatch([
        { content: 'With embedding', scope: 'user', scopeKey: 'u1' },
        { content: 'Without embedding', scope: 'user', scopeKey: 'u1', generateEmbedding: false },
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].isDuplicate).toBe(false);
      expect(results[1].isDuplicate).toBe(false);

      // First has embedding
      expect(embeddingRepo.findByMemoryId(results[0].id)).toBeDefined();
      // Second does not
      expect(embeddingRepo.findByMemoryId(results[1].id)).toBeUndefined();
    });
  });

  describe('deduplication', () => {
    it('write with similar content in the same scopeKey returns isDuplicate=true', async () => {
      const { writer } = createWriter();

      // Write first memory
      const first = await writer.write({
        content: 'User prefers dark mode',
        scope: 'user',
        scopeKey: 'u1',
      });
      expect(first.isDuplicate).toBe(false);

      // Write duplicate content
      const second = await writer.write({
        content: 'User prefers dark mode',
        scope: 'user',
        scopeKey: 'u1',
      });
      expect(second.isDuplicate).toBe(true);
      expect(second.duplicateOf).toBe(first.id);
      expect(second.id).toBe(first.id);
    });

    it('does not flag different content as duplicate', async () => {
      const { writer } = createWriter();

      const first = await writer.write({
        content: 'User prefers dark mode',
        scope: 'user',
        scopeKey: 'u1',
      });

      // Write different content with the mock returning a different vector
      const second = await writer.write({
        content: 'User likes spicy food',
        scope: 'user',
        scopeKey: 'u1',
      });

      expect(second.isDuplicate).toBe(false);
      expect(second.id).toBeTruthy();
    });

    it('respects custom dedupThreshold', async () => {
      const { writer } = createWriter();

      // Write first memory
      const first = await writer.write({
        content: 'Test dedup threshold',
        scope: 'user',
        scopeKey: 'u1',
      });
      expect(first.isDuplicate).toBe(false);

      // With threshold=1.0, identical mock vectors should still match
      const second = await writer.write({
        content: 'Test dedup threshold',
        scope: 'user',
        scopeKey: 'u1',
        dedupThreshold: 1.0,
      });
      expect(second.isDuplicate).toBe(true);
      expect(second.duplicateOf).toBe(first.id);
    });

    it('duplicate detection does not create the memory', async () => {
      const { writer, embeddingClient } = createWriter();

      const first = await writer.write({
        content: 'Unique content here',
        scope: 'user',
        scopeKey: 'u1',
      });

      // Reset call count
      const callCountBefore = embeddingClient.embedOne.mock.calls.length;

      const second = await writer.write({
        content: 'Unique content here',
        scope: 'user',
        scopeKey: 'u1',
      });

      expect(second.isDuplicate).toBe(true);

      // Exact-match dedup catches the duplicate before embedding check —
      // no additional embedOne calls needed
      expect(embeddingClient.embedOne.mock.calls.length).toBe(callCountBefore);
    });

    it('does not dedup private memories across agents', async () => {
      const { writer } = createWriter();

      const first = await writer.write({
        content: 'Same private preference',
        scope: 'user',
        scopeKey: '',
        kind: 'preference',
        visibility: 'private',
        agentId: 'agent-a',
      });
      expect(first.isDuplicate).toBe(false);

      const second = await writer.write({
        content: 'Same private preference',
        scope: 'user',
        scopeKey: '',
        kind: 'preference',
        visibility: 'private',
        agentId: 'agent-b',
      });
      expect(second.isDuplicate).toBe(false);
      expect(memoryRepo.findById(second.id)!.agent_id).toBe('agent-b');
    });

    it('stores a new conflicting preference instead of semantic-deduping it', async () => {
      const { writer } = createWriter();

      const oldPref = await writer.write({
        content: '以后称呼我为大拿',
        scope: 'user',
        scopeKey: 'u1',
        kind: 'preference',
        dedupThreshold: 0,
      });

      const newPref = await writer.write({
        content: '以后称呼我为Boss',
        scope: 'user',
        scopeKey: 'u1',
        kind: 'preference',
        dedupThreshold: 0,
      });

      expect(newPref.isDuplicate).toBe(false);
      expect(memoryRepo.findById(newPref.id)?.status).toBe('active');
      expect(memoryRepo.findById(oldPref.id)?.status).toBe('superseded');
    });

    it('supersedes shared name preferences across scopeKeys', async () => {
      const { writer } = createWriter();

      const otherScope = await writer.write({
        content: '以后称呼我为大拿',
        scope: 'user',
        scopeKey: 'u2',
        kind: 'preference',
        generateEmbedding: false,
      });

      await writer.write({
        content: '以后称呼我为Boss',
        scope: 'user',
        scopeKey: 'u1',
        kind: 'preference',
        generateEmbedding: false,
      });

      expect(memoryRepo.findById(otherScope.id)?.status).toBe('superseded');
    });

    it('keeps non-global preferences isolated by scopeKey', async () => {
      const { writer } = createWriter();

      const otherScope = await writer.write({
        content: '用户偏好使用 pnpm 工具',
        scope: 'user',
        scopeKey: 'u2',
        kind: 'preference',
        generateEmbedding: false,
      });

      await writer.write({
        content: '用户偏好使用 npm 工具',
        scope: 'user',
        scopeKey: 'u1',
        kind: 'preference',
        generateEmbedding: false,
      });

      expect(memoryRepo.findById(otherScope.id)?.status).toBe('active');
    });

    it('invalidates recall cache after create and exact duplicate update', async () => {
      const onMemoryChanged = vi.fn();
      const { writer } = createWriter(undefined, onMemoryChanged);

      await writer.write({
        content: 'Cache invalidation content',
        scope: 'user',
        scopeKey: 'u1',
      });
      await writer.write({
        content: 'Cache invalidation content',
        scope: 'user',
        scopeKey: 'u1',
        generateEmbedding: false,
      });

      expect(onMemoryChanged).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('writes embeddings without requiring sqlite-vec', async () => {
      const { writer } = createWriter();

      const result = await writer.write({
        content: 'Content with no vec extension',
        scope: 'user',
        scopeKey: 'u1',
      });

      expect(result.isDuplicate).toBe(false);
      expect(result.id).toBeTruthy();

      // Memory still created
      const memory = memoryRepo.findById(result.id);
      expect(memory).toBeDefined();

      // Embedding still stored in repository
      const emb = embeddingRepo.findByMemoryId(result.id);
      expect(emb).toBeDefined();
    });

    it('uses cosine search in hasSimilarMemory', async () => {
      const { writer } = createWriter();

      // No embeddings exist, so should return null
      const match = await writer.hasSimilarMemory('test', 0.5);
      expect(match).toBeNull();
    });
  });
});
