import { generateId } from '../shared/ids.js';
import type { MemoryRepository } from './repositories/memory-repository.js';
import type { EmbeddingRepository } from './repositories/embedding-repository.js';
import type { EmbeddingClient } from '../provider/embedding-client.js';
import type { EmbeddingCacheRepo } from './repositories/embedding-cache-repository.js';
import { hashContent, bufferToFloat32Array } from './repositories/embedding-cache-repository.js';
import type { MemoryLinkRepository } from './repositories/memory-link-repository.js';
import { extractMemoryTerms, MemoryTermRepository } from './repositories/memory-term-repository.js';
import { extractEntities, extractEntitiesLLM } from './entity-extractor.js';
import type { LLMExtractionConfig } from './entity-extractor.js';
import { mergeMemory, appendTimeline } from './memory-merge.js';
import type { MergeConfig } from './memory-merge.js';
import { matchesMemoryAccess } from './memory-access-policy.js';
import type { MemoryAccessPolicy } from './memory-access-policy.js';
import { PreferenceConflictResolver } from './write/preference-conflict-resolver.js';
import { errorForObservation, hashForObservation, memoryObservability } from './observability.js';

export interface WriteOptions {
  id?: string;
  content: string;
  scope: string;
  scopeKey?: string;
  kind?: string;
  metadata?: string | Record<string, unknown> | null;
  generateEmbedding?: boolean;
  dedupThreshold?: number;
  visibility?: string;
  agentId?: string | null;
  sourceChannel?: string | null;
  sourceMessageId?: string | null;
  confidence?: number;
}

export type WriteAction =
  | 'created'
  | 'exact_duplicate'
  | 'semantic_duplicate'
  | 'merged'
  | 'superseded';

export interface WriteResult {
  id: string;
  action: WriteAction;
  isDuplicate: boolean;
  duplicateOf?: string;
  mergedInto?: string;
  supersededBy?: string;
  warnings?: string[];
}

export interface SimilarMemoryMatch {
  id: string;
}

export interface MemoryChangeEvent {
  content: string;
  kind: string;
  scope: string;
  scopeKey: string;
  action?: 'write' | 'update' | 'delete';
}

export interface MemoryWriterOptions {
  /** Core dependencies (required). */
  memoryRepository: MemoryRepository;
  embeddingRepository: EmbeddingRepository;
  embeddingClient: EmbeddingClient;
  embeddingCacheRepo: EmbeddingCacheRepo;

  /** Memory merge strategy config. */
  mergeConfig?: MergeConfig;
  /** LLM entity extraction config. */
  extractionConfig?: LLMExtractionConfig;
  /** Current agent ID for memory tagging. */
  agentId?: string;
  /** Repository for entity-based memory links. */
  memoryLinkRepo?: MemoryLinkRepository;
  /** Callback fired on memory write/update/delete. */
  onMemoryChanged?: (event?: MemoryChangeEvent) => void;
  /** Repository for extracted memory terms. */
  memoryTermRepo?: MemoryTermRepository;
}

export class MemoryWriter {
  private _agentId: string | undefined;
  private readonly memoryRepository: MemoryRepository;
  private readonly embeddingRepository: EmbeddingRepository;
  private readonly embeddingClient: EmbeddingClient;
  private readonly embeddingCacheRepo: EmbeddingCacheRepo;
  private readonly mergeConfig: MergeConfig | undefined;
  private readonly extractionConfig: LLMExtractionConfig | undefined;
  private readonly memoryLinkRepo: MemoryLinkRepository | undefined;
  private readonly onMemoryChanged: ((event?: MemoryChangeEvent) => void) | undefined;
  private readonly memoryTermRepo: MemoryTermRepository | undefined;
  private conflictResolver: PreferenceConflictResolver;

  constructor(options: MemoryWriterOptions) {
    this.memoryRepository = options.memoryRepository;
    this.embeddingRepository = options.embeddingRepository;
    this.embeddingClient = options.embeddingClient;
    this.embeddingCacheRepo = options.embeddingCacheRepo;
    this.mergeConfig = options.mergeConfig;
    this.extractionConfig = options.extractionConfig;
    this._agentId = options.agentId;
    this.memoryLinkRepo = options.memoryLinkRepo;
    this.onMemoryChanged = options.onMemoryChanged;
    this.memoryTermRepo = options.memoryTermRepo;
    this.conflictResolver = new PreferenceConflictResolver(this.memoryRepository);
  }

  /** Set the current agent ID for memory tagging. Call before write operations. */
  setAgentId(id: string | undefined): void {
    this._agentId = id;
  }

  /**
   * Write a memory with upsert (exact-match dedup) and optional embedding.
   */
  async write(options: WriteOptions): Promise<WriteResult> {
    const scopeKey = options.scopeKey ?? '';
    const kind = options.kind ?? 'fact';
    const threshold = options.dedupThreshold ?? 0.9;
    const agentId = options.agentId ?? this._agentId ?? null;
    const visibility = options.visibility ?? 'shared';
    const accessPolicy: MemoryAccessPolicy = {
      scope: options.scope,
      scopeKey,
      kind,
      agentId: agentId ?? undefined,
      includeShared: true,
    };
    const warnings: string[] = [];
    let finalAction: WriteAction = 'created';
    let supersededBy: string | undefined;

    // 1. Exact-match dedup: if same scopeKey+kind+content exists, update it
    const existing = this.memoryRepository.findExactMatch(options.scope, scopeKey, kind, options.content);
    if (existing && matchesMemoryAccess(existing, accessPolicy)) {
      this.memoryRepository.update(existing.id, {
        content: options.content,
      });
      this.notifyMemoryChanged(options.content, kind, options.scope, scopeKey);
      return { id: existing.id, action: 'exact_duplicate', isDuplicate: true, duplicateOf: existing.id };
    }

    // 2. Semantic similarity dedup (if embedding enabled)
    let embedding: Float32Array | undefined;
    if (options.generateEmbedding !== false) {
      embedding = await this.getOrCreateEmbedding(options.content);
      if (embedding) {
        const similar = await this.findSimilarMemoryWithScore(options.content, threshold, embedding, accessPolicy);
        if (similar) {
          if (kind === 'preference') {
            const existing = this.memoryRepository.findById(similar.id);
            if (existing?.content === options.content) {
              return { id: existing.id, action: 'semantic_duplicate', isDuplicate: true, duplicateOf: existing.id };
            }
          } else {
            // Try compiled-truth merge if configured
            if (this.mergeConfig) {
              try {
                const existing = this.memoryRepository.findById(similar.id);
                if (existing) {
                  const result = await mergeMemory(existing, options.content, similar.score, this.mergeConfig);
                  if (result) {
                    // Merge succeeded — update existing memory
                    const newMeta = appendTimeline(existing.metadata, result.timelineEntry);
                    this.memoryRepository.update(existing.id, {
                      content: result.mergedContent,
                      metadata: newMeta,
                    });
                    // Content changed → terms + embedding must be recomputed,
                    // otherwise retrieval scores the row against its old text.
                    await this.refreshDerivedData(existing.id, result.mergedContent);
                    this.notifyMemoryChanged(result.mergedContent, kind, options.scope, scopeKey);
                    this.mergeConfig?.logger.info({ memoryId: existing.id, similarity: similar.score }, 'Memory merged via compiled truth');
                    return {
                      id: existing.id,
                      action: 'merged',
                      isDuplicate: true,
                      duplicateOf: existing.id,
                      mergedInto: existing.id,
                    };
                  }
                }
              } catch (err) {
                memoryObservability.record('memory.merge.failed', {
                  duplicateOf: similar.id,
                  contentHash: hashForObservation(options.content),
                  scope: options.scope,
                  kind,
                  agentId: agentId ?? undefined,
                  error: errorForObservation(err),
                });
                // Merge failed — fall through to normal dedup
              }
            }
            return { id: similar.id, action: 'semantic_duplicate', isDuplicate: true, duplicateOf: similar.id };
          }
        }
      }
    }

    // 3. Create memory record
    const memoryId = options.id ?? generateId();
    const metadata = typeof options.metadata === 'string'
      ? options.metadata
      : options.metadata === undefined
        ? null
        : JSON.stringify(options.metadata);
    const metadataObject = typeof options.metadata === 'object' && options.metadata !== null
      ? options.metadata
      : undefined;
    const createInput = {
      id: memoryId,
      content: options.content,
      scope: options.scope,
      scope_key: scopeKey,
      kind,
      metadata,
      agent_id: agentId,
      visibility,
      source_channel: options.sourceChannel ?? null,
      source_message_id: options.sourceMessageId ?? null,
      confidence: options.confidence ?? 1.0,
    };
    // Pre-compute the embedding BEFORE opening the transaction: SQLite
    // transactions are synchronous and cannot span the async embed() call.
    // (Step 2 already computed it for the dedup probe in the common case.)
    let embeddingToStore: Float32Array | undefined;
    if (options.generateEmbedding !== false) {
      embeddingToStore = embedding ?? await this.getOrCreateEmbedding(options.content);
      if (!embeddingToStore) {
        warnings.push('embedding_unavailable');
        memoryObservability.record('memory.write.degraded', {
          stage: 'embedding_unavailable',
          memoryId,
          scope: options.scope,
          kind,
          agentId: agentId ?? undefined,
        });
      }
    }

    // Atomic unit: the memory row, its lexical terms and its embedding must
    // commit together. Previously these were three independent writes, so a
    // crash/throw between them could leave a row with no embedding (permanent
    // recall gap) or stale terms. Entity extraction (async) stays best-effort
    // outside the transaction.
    const memory = this.memoryRepository.runInTransaction(() => {
      const created = this.memoryRepository.create(createInput);
      this.memoryTermRepo?.replaceForMemory(created.id, extractMemoryTerms(created.content, metadataObject));
      if (embeddingToStore) {
        this.embeddingRepository.create({
          id: generateId(),
          memory_id: created.id,
          embedding: embeddingToStore,
          model: this.embeddingClient.model ?? 'default',
          dimension: embeddingToStore.length,
        });
      }
      return created;
    });

    // 3.1. For preferences: resolve topic conflicts with the new resolver.
    // Must happen AFTER creation so the new memory exists in DB.
    // Uses action='update' (not 'delete') for superseded preferences to avoid
    // triggering unnecessary full persona rebuilds that lose fast-preference results.
    if (kind === 'preference') {
      try {
        const resolution = this.conflictResolver.resolve(memoryId, options.content, {
          scope: options.scope,
          scopeKey,
          agentId,
          visibility,
        });
        if (resolution.supersededIds.length > 0) {
          for (const supersededId of resolution.supersededIds) {
            if (supersededId === memoryId) continue;
            const oldMem = this.memoryRepository.findById(supersededId);
            if (oldMem) {
              this.notifyMemoryChanged(oldMem.content, oldMem.kind, oldMem.scope, oldMem.scope_key, 'update');
            }
          }
          this.mergeConfig?.logger.info(
            { winnerId: resolution.winnerId, topic: resolution.topic, supersededCount: resolution.supersededIds.length },
            'Preference conflict resolved',
          );
          if (resolution.winnerId !== memoryId) {
            finalAction = 'superseded';
            supersededBy = resolution.winnerId;
          }
        }
      } catch (err) {
        memoryObservability.record('memory.write.degraded', {
          stage: 'preference_conflict_resolution',
          memoryId,
          scope: options.scope,
          kind,
          agentId: agentId ?? undefined,
          error: errorForObservation(err),
        });
        this.mergeConfig?.logger.warn({ err }, 'Conflict resolver failed (non-fatal)');
      }
    }

    // 3.5. Entity extraction (LLM-first with regex fallback, fire-and-forget)
    if (this.memoryLinkRepo && this.extractionConfig) {
      try {
        const entities = await extractEntitiesLLM(options.content, this.extractionConfig, {
          scope: options.scope,
          kind,
        });
        for (const ent of entities) {
          if (ent.confidence >= this.extractionConfig.minConfidence) {
            this.memoryLinkRepo.create({
              id: generateId(),
              source_memory_id: memory.id,
              target_entity: ent.entity,
              relation_type: ent.relationType,
              confidence: ent.confidence,
            });
          }
        }
      } catch (err) {
        warnings.push('entity_extraction_failed');
        memoryObservability.record('memory.entity.failed', {
          memoryId: memory.id,
          contentHash: hashForObservation(options.content),
          scope: options.scope,
          kind,
          agentId: agentId ?? undefined,
          error: errorForObservation(err),
        });
        // Entity extraction failure should not block memory write
      }
    }

    // 4. Embedding was stored atomically with the row above (see transaction).
    if (embeddingToStore === undefined && options.generateEmbedding !== false) {
      // Already recorded as degraded above; nothing more to store.
    }

    this.notifyMemoryChanged(memory.content, memory.kind, memory.scope, memory.scope_key);
    return {
      id: memory.id,
      action: finalAction,
      isDuplicate: false,
      supersededBy,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  private notifyMemoryChanged(
    content: string,
    kind: string,
    scope: string,
    scopeKey: string,
    action: MemoryChangeEvent['action'] = 'write',
  ): void {
    this.onMemoryChanged?.({ content, kind, scope, scopeKey, action });
  }

  /**
   * Recompute lexical terms and the embedding for a memory whose content
   * changed (merge / in-place rewrite). Without this, `memory_terms` keeps the
   * tokens of the OLD content and the stored vector points at the OLD text, so
   * both term and vector retrieval rank the row against stale data. Best-effort:
   * the row's content is already persisted; failure here only degrades recall.
   */
  private async refreshDerivedData(memoryId: string, newContent: string): Promise<void> {
    try {
      this.memoryTermRepo?.replaceForMemory(memoryId, extractMemoryTerms(newContent));
    } catch (err) {
      memoryObservability.record('memory.write.degraded', {
        stage: 'terms_refresh',
        memoryId,
        error: errorForObservation(err),
      });
    }
    try {
      const emb = await this.getOrCreateEmbedding(newContent);
      if (!emb) return;
      // Replace the canonical row + vec entry atomically so a reader never sees
      // the row gone mid-swap.
      this.memoryRepository.runInTransaction(() => {
        this.embeddingRepository.deleteByMemoryId(memoryId);
        this.embeddingRepository.create({
          id: generateId(),
          memory_id: memoryId,
          embedding: emb,
          model: this.embeddingClient.model ?? 'default',
          dimension: emb.length,
        });
      });
    } catch (err) {
      memoryObservability.record('memory.embedding.failed', {
        memoryId,
        contentHash: hashForObservation(newContent),
        error: errorForObservation(err),
      });
    }
  }

  /**
   * Write multiple memories in sequence.
   */
  async writeBatch(options: WriteOptions[]): Promise<WriteResult[]> {
    const results: WriteResult[] = [];
    for (const opt of options) {
      results.push(await this.write(opt));
    }
    return results;
  }

  /**
   * Write a user preference memory.
   */
  async writePreference(
    scopeKey: string,
    content: string,
    metadata?: Record<string, unknown>,
    sourceChannel?: string | null,
  ): Promise<WriteResult> {
    return this.write({
      content,
      scope: 'user',
      scopeKey,
      kind: 'preference',
      sourceChannel,
    });
  }

  /**
   * Write a fact memory.
   */
  async writeFact(
    scopeKey: string,
    content: string,
    sourceChannel?: string | null,
  ): Promise<WriteResult> {
    return this.write({
      content,
      scope: 'user',
      scopeKey,
      kind: 'fact',
      sourceChannel,
    });
  }

  /**
   * Write a task result memory.
   */
  async writeTaskResult(
    scopeKey: string,
    content: string,
    sourceChannel?: string | null,
  ): Promise<WriteResult> {
    return this.write({
      content,
      scope: 'user',
      scopeKey,
      kind: 'task',
      sourceChannel,
    });
  }

  /**
   * Write a session summary memory.
   */
  async writeSummary(
    scopeKey: string,
    content: string,
    metadata?: Record<string, unknown>,
    sourceChannel?: string | null,
  ): Promise<WriteResult> {
    return this.write({
      content,
      scope: 'session',
      scopeKey,
      kind: 'summary',
      sourceChannel,
    });
  }

  /**
   * Get an embedding for the given content, using the cache if available.
   * Returns undefined if embedding generation fails.
   */
  private async getOrCreateEmbedding(content: string): Promise<Float32Array | undefined> {
    if (!this.embeddingClient.isConfigured()) return undefined;
    const contentHash = hashContent(content, this.embeddingClient.model);
    const cached = this.embeddingCacheRepo.get(contentHash);
    if (cached) {
      return bufferToFloat32Array(cached.embedding);
    }

    try {
      const embedding = await this.embeddingClient.embedOne(content);
      // Best-effort cache: failures should not prevent memory storage
      try {
        this.embeddingCacheRepo.set({
          content_hash: contentHash,
          embedding: Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
          model: this.embeddingClient.model,
          dimension: embedding.length,
          created_at: new Date().toISOString(),
        });
      } catch {
        // Cache write failed — memory is still stored
      }
      return embedding;
    } catch (err) {
      memoryObservability.record('memory.embedding.failed', {
        contentHash,
        contentLength: content.length,
        error: errorForObservation(err),
      });
      // Embedding generation failed
      return undefined;
    }
  }

  /**
   * Check if a similar memory exists via vector search.
   */
  async hasSimilarMemory(
    content: string,
    threshold: number,
    embedding?: Float32Array,
    accessPolicy?: MemoryAccessPolicy,
  ): Promise<SimilarMemoryMatch | null> {
    // If no embedding provided and client isn't configured, skip dedup entirely
    if (!embedding && !this.embeddingClient.isConfigured()) return null;
    try {
      const emb = embedding ?? await this.embeddingClient.embedOne(content);
      const results = this.embeddingRepository.searchSimilar(emb, accessPolicy ? 20 : 1);
      for (const result of results) {
        if (result.score < threshold) continue;
        if (accessPolicy) {
          const memory = this.memoryRepository.findById(result.memory_id);
          if (!memory || !matchesMemoryAccess(memory, accessPolicy)) continue;
        }
        return { id: result.memory_id };
      }
    } catch (err) {
      memoryObservability.record('memory.embedding.failed', {
        contentHash: hashForObservation(content),
        error: errorForObservation(err),
      });
      // Embedding search failed
    }

    return null;
  }

  /**
   * Like hasSimilarMemory but returns the similarity score for merge threshold checks.
   */
  private async findSimilarMemoryWithScore(
    content: string,
    threshold: number,
    embedding?: Float32Array,
    accessPolicy?: MemoryAccessPolicy,
  ): Promise<{ id: string; score: number } | null> {
    if (!embedding && !this.embeddingClient.isConfigured()) return null;
    try {
      const emb = embedding ?? await this.embeddingClient.embedOne(content);
      const results = this.embeddingRepository.searchSimilar(emb, 20);
      // Batch-fetch to avoid N+1 queries during access policy check
      const memoryById = accessPolicy
        ? new Map(
            this.memoryRepository.findByIds(results.map(r => r.memory_id)).map(m => [m.id, m]),
          )
        : null;
      for (const result of results) {
        if (result.score < threshold) continue;
        if (memoryById) {
          const memory = memoryById.get(result.memory_id);
          if (!memory || !matchesMemoryAccess(memory, accessPolicy)) continue;
        }
        return { id: result.memory_id, score: result.score };
      }
    } catch (err) {
      memoryObservability.record('memory.embedding.failed', {
        contentHash: hashForObservation(content),
        error: errorForObservation(err),
      });
      // Embedding search failed
    }
    return null;
  }

  /**
   * After a preference is replaced, delete summary-kind memories that
   * reference the old preference value (stale records that would keep
   * the old value alive in retrieval results).
   *
   * Uses LIKE matching on key tokens from the old content, which is
   * more reliable than cosine similarity for long summary transcripts.
   */
  private async purgeStaleSummaries(oldContent: string): Promise<void> {
    try {
      // Extract key tokens from old preference (skip very short/generic words)
      const tokens = oldContent
        .replace(/[，。！？、；：“”""'（）\s]+/g, ' ')
        .split(' ')
        .filter(t => t.length >= 2)
        .slice(0, 5); // first 5 meaningful tokens

      if (tokens.length === 0) return;

      for (const token of tokens) {
        if (token.length < 2) continue;
        const results = this.memoryRepository.searchByContent(token, undefined, undefined);
        for (const mem of results) {
          if (mem.kind === 'summary' && mem.content.includes(token)) {
            this.memoryRepository.delete(mem.id);
            this.mergeConfig?.logger.info({ memoryId: mem.id, token, content: mem.content.slice(0, 60) }, 'Purged stale summary after preference replacement');
          }
        }
      }
    } catch {
      // Best-effort cleanup
    }
  }
}
