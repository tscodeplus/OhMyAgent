import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { applySchema } from '../../src/memory/schema';
import { migrateV14 } from '../../src/memory/migration-v14';
import { migrateV21 } from '../../src/memory/migration-v21';
import { migrateV22 } from '../../src/memory/migration-v22';
import { migrateV24 } from '../../src/memory/migration-v24';
import { MemoryRepository } from '../../src/memory/repositories/memory-repository';
import { EmbeddingRepository } from '../../src/memory/repositories/embedding-repository';
import { MemoryWriter } from '../../src/memory/memory-writer';
import type { MergeConfig } from '../../src/memory/memory-merge';
import type { JudgeEngine } from '../../src/judge/engine';
import { EmbeddingCacheRepo } from '../../src/memory/repositories/embedding-cache-repository';
import { KnowledgeRepository } from '../../src/memory/knowledge/repository';

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
    embedBatch: vi.fn(async (texts: string[]) => texts.map(textToVector)),
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

function createWriter(
  embeddingClient?: ReturnType<typeof createMockEmbeddingClient>,
  onMemoryChanged?: () => void,
  mergeConfig?: MergeConfig,
) {
  const client = embeddingClient ?? createMockEmbeddingClient();
  const mockCacheRepo = {
    get: vi.fn(() => undefined),
    set: vi.fn(),
  } as unknown as EmbeddingCacheRepo;
  const writer = new MemoryWriter({
    memoryRepository: memoryRepo,
    embeddingRepository: embeddingRepo,
    embeddingClient: client,
    embeddingCacheRepo: mockCacheRepo,
    // The shared connection is what the knowledge-layer writes read (§8 S1);
    // every other derived write in the writer takes it the same way.
    db,
    mergeConfig,
    onMemoryChanged: onMemoryChanged,
  });
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
        {
          content: 'A completely different sentence about quantum physics',
          scope: 'user',
          scopeKey: 'u1',
        },
        {
          content: 'Yet another unrelated text concerning cooking recipes',
          scope: 'chat',
          scopeKey: 'c1',
          kind: 'task',
        },
      ]);

      expect(results).toHaveLength(3);
      expect(results.every((r) => r.isDuplicate === false)).toBe(true);
      expect(results.every((r) => r.id)).toBeTruthy();

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

  /**
   * Plan §3.1 (revision A1): `writePreference` picks the kind from the topic.
   * These three cases exist to stop anyone "simplifying" the criterion back to
   * `preferred_name` — that would drop the supersede semantics for style/tool/
   * language/workflow preferences, which are exactly the ones that get revised.
   */
  describe('writePreference kind selection', () => {
    it('writes a generic sentence as fact so hygiene can reclaim it', async () => {
      const { writer } = createWriter();

      const written = await writer.writePreference('S', 'E:\\Excel 目录下有 4 个文件');

      expect(memoryRepo.findById(written.id)?.kind).toBe('fact');
    });

    it('keeps a name preference as preference and supersedes the old one', async () => {
      const { writer } = createWriter();

      const older = await writer.writePreference('S', '以后称呼我为大拿');
      const newer = await writer.writePreference('S', '称呼我为 Boss');

      expect(memoryRepo.findById(newer.id)?.kind).toBe('preference');
      expect(memoryRepo.findById(newer.id)?.status).toBe('active');
      expect(memoryRepo.findById(older.id)?.status).toBe('superseded');
    });

    it('keeps a communication-style preference as preference', async () => {
      const { writer } = createWriter();

      const written = await writer.writePreference('S', '回复简洁点');

      expect(memoryRepo.findById(written.id)?.kind).toBe('preference');
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

  describe('purgeStaleSummaries', () => {
    // purgeStaleSummaries is private — reach it through a typed escape hatch
    function purgeStaleSummaries(
      writer: MemoryWriter,
      oldContent: string,
      scope: string,
      scopeKey: string,
    ): Promise<void> {
      return (
        writer as unknown as {
          purgeStaleSummaries(oldContent: string, scope: string, scopeKey: string): Promise<void>;
        }
      ).purgeStaleSummaries(oldContent, scope, scopeKey);
    }

    function createSummary(id: string, scopeKey: string, content: string) {
      return memoryRepo.create({
        id,
        scope: 'session',
        scope_key: scopeKey,
        kind: 'summary',
        content,
      });
    }

    it('deletes the target summary but keeps other sessions whose summary only shares a common word', async () => {
      const { writer } = createWriter();

      // Target session: summary references the whole old preference
      const target = createSummary(
        uniqueId('summary'),
        'u1',
        'Project status changed and user approved the plan',
      );
      // Other session: summary only happens to contain the common word "Project"
      const other = createSummary(
        uniqueId('summary'),
        'u2',
        'Project planning notes for a different team',
      );

      await purgeStaleSummaries(writer, 'Project status changed', 'session', 'u1');

      expect(memoryRepo.findById(target.id)).toBeUndefined();
      expect(memoryRepo.findById(other.id)).toBeDefined();
    });

    it('keeps summaries in the same session that only partially match the tokens', async () => {
      const { writer } = createWriter();

      const fullMatch = createSummary(
        uniqueId('summary'),
        'u1',
        'Project status changed yesterday',
      );
      // Only "status" appears — not the full token sequence
      const partial = createSummary(uniqueId('summary'), 'u1', 'Daily status report for the team');
      // Only "changed" appears
      const partial2 = createSummary(
        uniqueId('summary'),
        'u1',
        'Everything changed after the meeting',
      );

      await purgeStaleSummaries(writer, 'Project status changed', 'session', 'u1');

      expect(memoryRepo.findById(fullMatch.id)).toBeUndefined();
      expect(memoryRepo.findById(partial.id)).toBeDefined();
      expect(memoryRepo.findById(partial2.id)).toBeDefined();
    });

    it('does not delete non-summary memories even when they contain the full token sequence', async () => {
      const { writer } = createWriter();

      const fact = memoryRepo.create({
        id: uniqueId('mem'),
        scope: 'session',
        scope_key: 'u1',
        kind: 'fact',
        content: 'Project status changed — fact record',
      });

      await purgeStaleSummaries(writer, 'Project status changed', 'session', 'u1');

      expect(memoryRepo.findById(fact.id)).toBeDefined();
    });

    it('does nothing when oldContent yields no tokens', async () => {
      const { writer } = createWriter();

      const summary = createSummary(uniqueId('summary'), 'u1', 'Any summary at all');

      await purgeStaleSummaries(writer, '！、。', 'session', 'u1');

      expect(memoryRepo.findById(summary.id)).toBeDefined();
    });

    it('does nothing when no summary matches', async () => {
      const { writer } = createWriter();

      const summary = createSummary(uniqueId('summary'), 'u1', 'Unrelated meeting notes');

      await purgeStaleSummaries(writer, 'Project status changed', 'session', 'u1');

      expect(memoryRepo.findById(summary.id)).toBeDefined();
    });

    it('scopes single-token matches to the target session and requires the full token', async () => {
      const { writer } = createWriter();

      // Chinese content stays a single token — matched as the full phrase
      const target = createSummary(uniqueId('summary'), 'u1', '用户偏好红色主题配色的界面');
      // Other session contains only the short substring "红色", not the full token
      const other = createSummary(uniqueId('summary'), 'u2', '红色是另一个话题的关键词');
      // Same session, but only a substring of the token
      const partial = createSummary(uniqueId('summary'), 'u1', '主题配色方案待定');

      await purgeStaleSummaries(writer, '红色主题配色', 'session', 'u1');

      expect(memoryRepo.findById(target.id)).toBeUndefined();
      expect(memoryRepo.findById(other.id)).toBeDefined();
      expect(memoryRepo.findById(partial.id)).toBeDefined();
    });
  });

  /**
   * Plan §8 S1 (revision A3). A page that cites a memory is a copy of that
   * memory's text and `knowledge_sources` has no foreign key to `memories`, so a
   * rewritten memory used to leave its page `active` — and `active` is the only
   * status every reader sees, including the per-turn injection lane that never
   * consults `unified-search`. Invalidation therefore belongs on the write side,
   * and these cases pin the three properties that make that affordable: it fires
   * only for a real text change, it stays silent when nothing cites the memory,
   * and it can never fail the memory write.
   */
  describe('knowledge page invalidation', () => {
    const ORIGINAL = 'Deploy target is the staging cluster';
    const CORRECTED = 'Deploy target is the production cluster';

    /**
     * The knowledge tables arrive with migration-v14/v21/v22/v24, not
     * `applySchema` — `KnowledgeRepository` writes `entity_id`, `scope` and
     * `normalized_title`, which the later ones add.
     */
    function setupKnowledgeLayer(): KnowledgeRepository {
      migrateV14(db);
      migrateV21(db);
      migrateV22(db);
      migrateV24(db);
      return new KnowledgeRepository(db);
    }

    function citedPage(repository: KnowledgeRepository, memoryId: string) {
      const result = repository.insertPage(
        {
          pageType: 'topic',
          slug: `page-for-${memoryId}`,
          title: `Page for ${memoryId}`,
          content: 'A curated summary of the cited memory.',
          sources: [{ kind: 'memory', id: memoryId }],
          status: 'active',
          updatedBy: 'agent',
        },
        'agent',
      );
      if (!result.ok) throw new Error(`page setup refused: ${result.code}`);
      return result.page;
    }

    function pageStatus(id: string): string | undefined {
      return (
        db.prepare('SELECT status FROM knowledge_pages WHERE id = ?').get(id) as
          { status: string } | undefined
      )?.status;
    }

    function logRows(pageId: string): Array<{ action: string; actor: string; reason: string }> {
      return db
        .prepare('SELECT action, actor, reason FROM knowledge_log WHERE page_id = ?')
        .all(pageId) as Array<{ action: string; actor: string; reason: string }>;
    }

    /** Fixed vectors: 0.8 cosine — above the merge threshold, below near-exact. */
    function createSteeredEmbeddingClient() {
      const vectors: Record<string, number[]> = {
        [ORIGINAL]: [1, 0, 0, 0, 0, 0, 0, 0],
        [CORRECTED]: [0.8, 0.6, 0, 0, 0, 0, 0, 0],
      };
      return {
        isConfigured: vi.fn(() => true),
        model: 'default',
        embedOne: vi.fn(async (text: string) =>
          Float32Array.from(vectors[text] ?? [1, 0, 0, 0, 0, 0, 0, 0]),
        ),
        embedBatch: vi.fn(async (texts: string[]) =>
          texts.map((text) => Float32Array.from(vectors[text] ?? [1, 0, 0, 0, 0, 0, 0, 0])),
        ),
      } as unknown as ReturnType<typeof createMockEmbeddingClient>;
    }

    /**
     * `more-precise` is the judged relation that rewrites the existing memory's
     * text — the only writer path where a page's cited content goes stale without
     * an LLM call, so it is what makes the update branch testable.
     */
    function mergeConfigRewritingContent(): MergeConfig {
      const engine = {
        modeFor: () => 'active',
        decideMany: async () => ({
          source: 'judge',
          mode: 'active',
          outcome: { action: 'route', choice: 'more-precise' },
        }),
      } as unknown as JudgeEngine;
      return {
        mergeThreshold: 0.5,
        judgeGet: () => engine,
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        } as unknown as Logger,
      };
    }

    async function writeCorrected(
      writer: MemoryWriter,
      content: string,
    ): Promise<Awaited<ReturnType<MemoryWriter['write']>>> {
      return writer.write({
        content,
        scope: 'project',
        scopeKey: 'p1',
        kind: 'fact',
        dedupThreshold: 0.5,
      });
    }

    it('re-queues an active page when the memory it cites is rewritten', async () => {
      const { writer } = createWriter(
        createSteeredEmbeddingClient(),
        undefined,
        mergeConfigRewritingContent(),
      );
      const first = await writeCorrected(writer, ORIGINAL);
      const repository = setupKnowledgeLayer();
      const page = citedPage(repository, first.id);
      expect(page.status).toBe('active');

      const second = await writeCorrected(writer, CORRECTED);

      expect(second.action).toBe('merged');
      expect(memoryRepo.findById(first.id)!.content).toBe(CORRECTED);
      expect(pageStatus(page.id)).toBe('pending');
      // The log row is the only record of *why* the page left the index, so the
      // cause (memory id + which write) is asserted literally.
      expect(logRows(page.id).filter((row) => row.action === 'pending')).toEqual([
        {
          action: 'pending',
          actor: 'system',
          reason: `memory ${first.id} updated: cited page re-queued for review`,
        },
      ]);
    });

    it('writes nothing when no page cites the memory', async () => {
      const { writer } = createWriter(
        createSteeredEmbeddingClient(),
        undefined,
        mergeConfigRewritingContent(),
      );
      const first = await writeCorrected(writer, ORIGINAL);
      setupKnowledgeLayer();

      await writeCorrected(writer, CORRECTED);

      const pages = db.prepare('SELECT COUNT(*) AS n FROM knowledge_pages').get() as { n: number };
      const logs = db.prepare('SELECT COUNT(*) AS n FROM knowledge_log').get() as { n: number };
      expect(pages.n).toBe(0);
      expect(logs.n).toBe(0);
      expect(memoryRepo.findById(first.id)!.content).toBe(CORRECTED);
    });

    it('does not touch a page that is already out of active, or duplicate its log row', async () => {
      const { writer } = createWriter(
        createSteeredEmbeddingClient(),
        undefined,
        mergeConfigRewritingContent(),
      );
      const first = await writeCorrected(writer, ORIGINAL);
      const repository = setupKnowledgeLayer();
      const page = citedPage(repository, first.id);
      repository.setStatus(page.id, 'pending', 'user');

      await writeCorrected(writer, CORRECTED);

      // Only the human's own `pending` row exists: the invalidation query is
      // bounded to `active`, so a re-queue cannot stack a second row on the same
      // cause.
      const requeues = logRows(page.id).filter((row) => row.action === 'pending');
      expect(requeues).toEqual([
        expect.objectContaining({ actor: 'user', reason: 'status: active -> pending' }),
      ]);
    });

    it('keeps the memory write when the invalidation itself fails', async () => {
      const { writer } = createWriter(
        createSteeredEmbeddingClient(),
        undefined,
        mergeConfigRewritingContent(),
      );
      const first = await writeCorrected(writer, ORIGINAL);
      const repository = setupKnowledgeLayer();
      const page = citedPage(repository, first.id);
      // The log write is part of the invalidation transaction; losing the table
      // is a real failure of that path and nothing of it may survive — but the
      // memory is what the caller asked for and must still be written.
      db.exec('DROP TABLE knowledge_log');

      const second = await writeCorrected(writer, CORRECTED);

      expect(second.action).toBe('merged');
      expect(memoryRepo.findById(first.id)!.content).toBe(CORRECTED);
      expect(pageStatus(page.id)).toBe('active');
    });

    it('re-queues the page that cites a memory a preference superseded (finding F3)', async () => {
      // Supersede is a correction that keeps the losing row (`status`
      // 'superseded'), so neither the content-changed branch above nor the S2
      // doctor's `NOT EXISTS` check could see it: the page kept `active` while
      // asserting a claim the memory layer had just retracted. It is also the one
      // correction path that only preferences take, i.e. the five topics §3.1
      // keeps `preference`.
      const { writer } = createWriter();
      const older = await writer.writePreference('S', '以后称呼我为大拿');
      const repository = setupKnowledgeLayer();
      const page = citedPage(repository, older.id);
      expect(page.status).toBe('active');

      await writer.writePreference('S', '称呼我为 Boss');

      expect(memoryRepo.findById(older.id)?.status).toBe('superseded');
      expect(pageStatus(page.id)).toBe('pending');
      expect(logRows(page.id).filter((row) => row.action === 'pending')).toEqual([
        expect.objectContaining({
          actor: 'system',
          reason: `memory ${older.id} updated: cited page re-queued for review`,
        }),
      ]);
    });
  });
});
