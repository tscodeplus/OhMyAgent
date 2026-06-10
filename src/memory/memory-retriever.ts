import type Database from 'better-sqlite3';
import type { MemoryRepository } from './repositories/memory-repository.js';
import type { EmbeddingRepository } from './repositories/embedding-repository.js';
import type { EmbeddingClient } from '../provider/embedding-client.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { QueryResultCache } from './query-result-cache.js';
import { EmbeddingCacheRepo, hashContent, bufferToFloat32Array } from './repositories/index.js';
import { expandQuery } from './query-expansion.js';
import type { ExpandedQuery } from './query-expansion.js';
import { withTimeout } from '../shared/with-timeout.js';
import { ftsSearch } from './fts.js';
import type { FtsSearchResult } from './fts.js';
import { rrfMerge } from './rrf-merge.js';
import type { SourceResult, MergedResult } from './rrf-merge.js';
import { applyTemporalDecay } from './temporal-decay.js';
import type { DecayConfig } from './temporal-decay.js';
import type { MemoryLinkRepository } from './repositories/memory-link-repository.js';
import { expandQueryLLM } from './query-expansion-llm.js';
import type { LLMExpansionConfig } from './query-expansion-llm.js';
import { matchesMemoryAccess, policyFromRetrievalOptions } from './memory-access-policy.js';
import type { MemoryAccessPolicy, MemoryPool } from './memory-access-policy.js';
import type { RetrievalPolicy } from './retrieval/retrieval-policy.js';
import { agentAwareRecallPolicy } from './retrieval/retrieval-policy.js';
import { CandidateSelector } from './retrieval/candidate-selector.js';
import { errorForObservation, hashForObservation, memoryObservability } from './observability.js';
import { rerankMemoryResults } from './retrieval/reranker.js';
import type { RerankOptions } from './retrieval/reranker.js';
import { extractQueryTerms } from './repositories/memory-term-repository.js';
import { planStructuredQueries, extractSpeaker, augmentSlotQueries, DEFAULT_PLANNER_CONFIG } from './query-planner.js';
import type { PlannerConfig } from './query-planner.js';
import { coverageMerge } from './coverage-merge.js';
import type { SlotSourceLists } from './coverage-merge.js';

export interface RetrievalOptions {
  query: string;
  topK?: number;  // default 3
  scope?: string;
  scopeKey?: string;
  /** Scene identifier — mapped to scopeKey for scene-scoped retrieval. */
  sceneId?: string;
  minScore?: number;  // default 0.01
  /** Skip vector/cosine search, use text LIKE only (no embedding API call). */
  textOnly?: boolean;
  /** Scope filter applied only to text LIKE fallback (not vector/cosine). When unset, uses `scope`. */
  textScope?: string;
  /** Agent ID used for private/shared memory visibility filtering. */
  agentId?: string;
  /** Optional kind filter. */
  kind?: string | string[];
}

export interface RetrievedMemory {
  id: string;
  content: string;
  scope: string;
  scopeKey?: string;
  kind: string;
  score: number;
  createdAt: number;
  sourcePool?: string;
}

const DEFAULT_TOP_K = 3;
const DEFAULT_MIN_SCORE = 0.01;
const DEFAULT_FULL_SCAN_MAX_EMBEDDINGS = 5000;

/**
 * Recall-depth knobs. Larger values let weak-margin (e.g. semantic) hits enter
 * the candidate pool before reranking pulls the right ones up. Defaults match
 * the pre-tuning behavior, so this is a no-op unless overridden.
 */
export interface RecallConfig {
  /** Per-source prefilter = max(topK * prefilterMultiplier, prefilterMin). */
  prefilterMultiplier: number;
  prefilterMin: number;
  /** Candidates kept after RRF/coverage merge = topK * mergeCandidateMultiplier. */
  mergeCandidateMultiplier: number;
}

export const DEFAULT_RECALL_CONFIG: RecallConfig = {
  prefilterMultiplier: 5,
  prefilterMin: 20,
  mergeCandidateMultiplier: 3,
};

export class MemoryRetriever {
  private queryCache: QueryResultCache;
  private defaultMinScore: number;
  private candidateSelector: CandidateSelector;

  constructor(
    private memoryRepository: MemoryRepository,
    private embeddingRepository: EmbeddingRepository,
    private embeddingClient: EmbeddingClient,
    private embeddingCacheRepo: EmbeddingCacheRepo,
    private db: Database.Database,
    private expansionConfig: LLMExpansionConfig,
    private embeddingBreaker?: CircuitBreaker,
    private decayConfig?: Partial<DecayConfig>,
    defaultMinScore?: number,
    private memoryLinkRepo?: MemoryLinkRepository,
    private fullScanMaxEmbeddings: number = DEFAULT_FULL_SCAN_MAX_EMBEDDINGS,
    private queryEmbeddingTimeoutMs: number = 10_000,
    private plannerConfig: PlannerConfig = DEFAULT_PLANNER_CONFIG,
    private recallConfig: RecallConfig = DEFAULT_RECALL_CONFIG,
  ) {
    this.queryCache = new QueryResultCache();
    this.defaultMinScore = defaultMinScore ?? DEFAULT_MIN_SCORE;
    this.candidateSelector = new CandidateSelector(db);
  }

  async retrieve(options: RetrievalOptions): Promise<RetrievedMemory[]> {
    // sceneId maps to scopeKey for scene-scoped retrieval
    const effectiveOptions = options.sceneId
      ? { ...options, scopeKey: options.sceneId }
      : options;

    const accessPolicy = policyFromRetrievalOptions(effectiveOptions);
    return this.retrieveWithPolicy(effectiveOptions, {
      access: accessPolicy,
      includeEntityExpansion: true,
      includeTemporalDecay: true,
      activeOnly: true,
    }, true);
  }

  private async retrieveWithPolicy(
    effectiveOptions: RetrievalOptions,
    retrievalPolicy: RetrievalPolicy,
    useCache: boolean,
    sourcePool?: MemoryPool,
  ): Promise<RetrievedMemory[]> {
    const { topK, minScore } = this.resolveDefaults(effectiveOptions);

    // Text-only mode: skip vector search entirely
    if (effectiveOptions.textOnly) {
      const results = await this.textFallback(effectiveOptions, retrievalPolicy.access);
      return results;
    }

    // Phase 1: Check result cache
    const cached = useCache ? this.queryCache?.get(
      effectiveOptions.query,
      topK,
      effectiveOptions.scope,
      effectiveOptions.scopeKey,
      effectiveOptions.agentId,
      effectiveOptions.kind,
      minScore,
    ) : undefined;
    if (cached) return cached;

    // Phase 2.5: Multi-query expansion (LLM-driven, score-gated, rule-based fallback).
    // Only runs when expansion is enabled. We first probe the original query with a
    // cheap hybrid recall; if the strongest raw similarity already clears the trigger
    // threshold, recall is good enough and we skip the LLM entirely. This bounds the
    // expansion cost to queries that actually have weak recall (the lexical-gap cases).
    // When disabled, neither the probe nor the LLM runs — the pre-expansion fast path.
    let variants: ExpandedQuery[] = [];
    if (this.expansionConfig?.enabled) {
      try {
        const [probeVec, probeFts, probeTerm] = await Promise.all([
          this.vectorSearch(effectiveOptions, retrievalPolicy, sourcePool),
          this.ftsSearchWrapper(effectiveOptions, retrievalPolicy.access, sourcePool),
          this.termSearchWrapper(effectiveOptions, retrievalPolicy.access, sourcePool),
        ]);
        // Only the vector cosine score is an ABSOLUTE similarity in [0,1]. FTS and
        // term scores are min-max normalized WITHIN their own result set (see
        // fts.ts), so their max is ≈1.0 whenever ≥2 distinct ranks exist —
        // regardless of true relevance. Gating on those would make the trigger fire
        // (i.e. skip expansion) for essentially every query that has any lexical
        // hit, defeating the score-gate. We therefore gate purely on vector recall:
        // weak/absent vector similarity is exactly the lexical-gap case expansion is
        // meant to rescue. No vector hit → initialMaxScore 0 → expansion runs.
        void probeFts;
        void probeTerm;
        const initialMaxScore = Math.max(
          0,
          ...probeVec.map(r => r.score),
        );
        const result = await expandQueryLLM(
          effectiveOptions.query,
          this.expansionConfig,
          initialMaxScore,
        );
        variants = result.variants;
      } catch (err) {
        memoryObservability.record('memory.vector.failed', {
          stage: 'query_expansion',
          queryHash: hashForObservation(effectiveOptions.query),
          error: errorForObservation(err),
        });
        // Expansion failure → proceed with single query
      }
    }

    // Phase 3: Intent-aware planning. Commonality/attribute intents route through
    // coverage merge (per-entity slots); all other intents keep the flat RRF path.
    const plan = planStructuredQueries(effectiveOptions.query, {
      enabled: this.plannerConfig.enabled,
      maxEntities: this.plannerConfig.maxEntities,
    });
    const useCoverage =
      this.plannerConfig.commonalityCoverage &&
      (plan.intent === 'commonality' || plan.intent === 'attribute') &&
      plan.slots.length > 1;

    let merged: MergedResult[];
    let rerankOptions: RerankOptions | undefined;

    if (useCoverage) {
      // Feed LLM-expansion variants into each slot so attribute/commonality
      // lookups also benefit from lexical variants (e.g. martial arts → kickboxing).
      const variantQueries = variants
        .map(v => v.filteredTokens.join(' '))
        .filter(q => q.length > 0);
      const slotLists: SlotSourceLists[] = await Promise.all(
        plan.slots.map(async slot => {
          const slotQueries = augmentSlotQueries(slot, variantQueries);
          const perQuery = await Promise.all(
            slotQueries.map(async q => {
              const opts = { ...effectiveOptions, query: q };
              return Promise.all([
                this.vectorSearch(opts, retrievalPolicy, sourcePool),
                this.ftsSearchWrapper(opts, retrievalPolicy.access, sourcePool),
                this.termSearchWrapper(opts, retrievalPolicy.access, sourcePool),
              ]);
            }),
          );
          return { slotId: slot.slotId, lists: perQuery.flat() };
        }),
      );
      merged = coverageMerge(slotLists, 60, topK * this.recallConfig.mergeCandidateMultiplier, this.plannerConfig.perSlotFloor);
      rerankOptions = { targetSpeakers: plan.entities, speakerBoost: this.plannerConfig.speakerBoost };
    } else {
      // Flat path — identical to pre-planner behavior.
      const plannedQueries = plan.flatQueries
        .filter(item => item.reason !== 'original')
        .map(item => item.query);
      const variantOpts = [
        ...plannedQueries,
        ...variants.map(v => v.filteredTokens.join(' ')),
      ]
        .filter(q => q.length > 0)
        .map(query => ({ ...effectiveOptions, query }));
      const allQueries = [effectiveOptions, ...variantOpts];

      const searchTasks = allQueries.flatMap(opts => [
        this.vectorSearch(opts, retrievalPolicy, sourcePool),
        this.ftsSearchWrapper(opts, retrievalPolicy.access, sourcePool),
        this.termSearchWrapper(opts, retrievalPolicy.access, sourcePool),
      ]);

      const allResults = await Promise.all(searchTasks);
      merged = rrfMerge(allResults, 60, topK * this.recallConfig.mergeCandidateMultiplier);
    }

    // Phase 3: Temporal decay
    const decayed = applyTemporalDecay(merged, this.decayConfig);
    const expandedByMetadata = this.expandByMemoryMetadata(decayed, retrievalPolicy.access, sourcePool);
    const reranked = rerankMemoryResults(effectiveOptions.query, expandedByMetadata, rerankOptions);

    // Filter by minScore and truncate to topK
    const filtered = reranked
      .filter(r => r.score >= minScore)
      .slice(0, topK);

    // Phase 3.5: Entity graph expansion
    const expanded = this.expandByEntityLinks(filtered, retrievalPolicy.access, sourcePool);

    // Enrich with full memory data
    const results = this.enrichResults(expanded);

    // Phase 1: Cache results
    if (useCache) this.queryCache?.set(
      effectiveOptions.query,
      topK,
      effectiveOptions.scope,
      effectiveOptions.scopeKey,
      results,
      effectiveOptions.agentId,
      effectiveOptions.kind,
      minScore,
    );

    return results;
  }

  clearCache(): void {
    this.queryCache?.clear();
  }

  private async vectorSearch(options: RetrievalOptions, policy: RetrievalPolicy, sourcePool?: MemoryPool): Promise<SourceResult[]> {
    try {
      const queryEmbedding = await this.getQueryEmbedding(options.query);
      if (!queryEmbedding) return [];

      const limit = this.prefilterLimit(options.topK ?? DEFAULT_TOP_K);
      const candidateIds = this.candidateSelector.selectIds(policy);
      const embeddingCount = typeof this.embeddingRepository.count === 'function'
        ? this.embeddingRepository.count()
        : 0;
      if (candidateIds === null && embeddingCount > this.fullScanMaxEmbeddings) {
        memoryObservability.record('memory.vector.full_scan_skipped', {
          queryHash: hashForObservation(options.query),
          embeddingCount,
          fullScanMaxEmbeddings: this.fullScanMaxEmbeddings,
          scope: options.scope,
          kind: Array.isArray(options.kind) ? options.kind.join(',') : options.kind,
        });
        return [];
      }

      const vectorResults = this.embeddingRepository.isVecAvailable?.()
        ? this.embeddingRepository.vecSearch(queryEmbedding, limit, candidateIds)
        : [];
      const cosineResults = vectorResults.length > 0
        ? vectorResults
        : this.embeddingRepository.cosineSearch(queryEmbedding, limit, candidateIds);
      return this.toSourceResults(
        cosineResults.map(r => ({ memoryId: r.memory_id, distance: 1 - r.score })),
        vectorResults.length > 0 ? 'vector' : 'cosine',
        policy.access,
        sourcePool,
      );
    } catch (err) {
      memoryObservability.record('memory.vector.failed', {
        queryHash: hashForObservation(options.query),
        scope: options.scope,
        kind: Array.isArray(options.kind) ? options.kind.join(',') : options.kind,
        error: errorForObservation(err),
      });
      return [];  // Vector search failure → empty results, FTS5 still runs
    }
  }

  private async ftsSearchWrapper(options: RetrievalOptions, policy: MemoryAccessPolicy, sourcePool?: MemoryPool): Promise<SourceResult[]> {
    try {
      const expanded = expandQuery(options.query);
      if (!expanded.ftsQuery) return [];

      const limit = this.prefilterLimit(options.topK ?? DEFAULT_TOP_K);
      const textScope = options.textScope ?? options.scope;
      const results = ftsSearch(this.db, expanded.ftsQuery, limit, textScope, options.scopeKey);

      if (results.length > 0) {
        return results
          .flatMap(r => {
            const memory = this.memoryRepository.findById(r.memoryId);
            if (!memory || !matchesMemoryAccess(memory, policy)) return [];
            return [{
              id: r.memoryId,
              content: r.content,
              score: r.normalizedScore,
              source: 'fts5' as const,
              scope: memory.scope,
              scopeKey: memory.scope_key,
              kind: memory.kind,
              createdAt: new Date(memory.created_at).getTime(),
              sourcePool,
              speaker: extractSpeaker(r.content, memory.metadata),
            }];
          });
      }

      // FTS5 no results → legacy LIKE fallback
      return this.legacyLikeSourceResults(options, policy, sourcePool);
    } catch (err) {
      memoryObservability.record('memory.fts.failed', {
        queryHash: hashForObservation(options.query),
        scope: options.scope,
        kind: Array.isArray(options.kind) ? options.kind.join(',') : options.kind,
        error: errorForObservation(err),
      });
      return [];
    }
  }

  private async termSearchWrapper(options: RetrievalOptions, policy: MemoryAccessPolicy, sourcePool?: MemoryPool): Promise<SourceResult[]> {
    try {
      const terms = [...new Set(extractQueryTerms(options.query))].slice(0, 16);
      if (terms.length === 0) return [];
      const placeholders = terms.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT mt.memory_id AS memoryId, SUM(mt.weight) AS score
        FROM memory_terms mt
        JOIN memories m ON m.id = mt.memory_id
        WHERE mt.term IN (${placeholders})
          AND m.status = 'active'
        GROUP BY mt.memory_id
        ORDER BY score DESC
        LIMIT ?
      `).all(...terms, this.prefilterLimit(options.topK ?? DEFAULT_TOP_K)) as Array<{ memoryId: string; score: number }>;

      return rows.flatMap(row => {
        const memory = this.memoryRepository.findById(row.memoryId);
        if (!memory || !matchesMemoryAccess(memory, policy)) return [];
        return [{
          id: row.memoryId,
          content: memory.content,
          score: Math.min(1, row.score / Math.max(1, terms.length)),
          source: 'terms' as const,
          scope: memory.scope,
          scopeKey: memory.scope_key,
          kind: memory.kind,
          createdAt: new Date(memory.created_at).getTime(),
          sourcePool,
          speaker: extractSpeaker(memory.content, memory.metadata),
        }];
      });
    } catch (err) {
      memoryObservability.record('memory.fts.failed', {
        stage: 'term_sidecar',
        queryHash: hashForObservation(options.query),
        error: errorForObservation(err),
      });
      return [];
    }
  }

  private toSourceResults(
    results: Array<{ memoryId: string; distance: number }>,
    source: 'vector' | 'cosine',
    policy: MemoryAccessPolicy,
    sourcePool?: MemoryPool,
  ): SourceResult[] {
    return results.flatMap(r => {
      const memory = this.memoryRepository.findById(r.memoryId);
      if (!memory || !matchesMemoryAccess(memory, policy)) return [];
      const createdAt = memory ? new Date(memory.created_at).getTime() : 0;
      return {
        id: r.memoryId,
        content: memory?.content ?? '',
        // Both 'vector' and 'cosine' inputs arrive as distance = 1 - similarity
        // (see callers), so recover the [0,1] similarity symmetrically. Previously
        // the 'cosine' branch returned the raw distance (1 - similarity), inverting
        // the score. rrfMerge ranks by list position so its output was unaffected,
        // but any reader of the pre-merge score (the expansion probe) saw it flipped.
        score: 1 - r.distance,
        source,
        scope: memory?.scope ?? '',
        scopeKey: memory?.scope_key ?? '',
        kind: memory?.kind ?? '',
        createdAt,
        sourcePool,
        speaker: extractSpeaker(memory?.content ?? '', memory?.metadata),
      };
    });
  }

  /**
   * Expand results via entity graph traversal.
   * Follows memory → entity → memory links to discover related memories
   * that keyword/vector search might have missed.
   */
  private expandByEntityLinks(merged: MergedResult[], policy: MemoryAccessPolicy, sourcePool?: MemoryPool): MergedResult[] {
    if (!this.memoryLinkRepo || merged.length === 0) return merged;

    try {
      const memoryIds = merged.map(r => r.id);
      const entities = this.memoryLinkRepo.findEntitiesByMemoryIds(memoryIds);

      if (entities.length === 0) return merged;

      const relatedIds = new Set<string>(memoryIds);
      const additions: MergedResult[] = [];
      const maxAdditions = 3;
      const decayFactor = 0.8;

      // Get highest score among existing results for decay weighting
      const maxScore = Math.max(...merged.map(r => r.score), 0.1);

      for (const { target_entity, source_memory_id, confidence } of entities) {
        if (confidence < 0.5) continue;
        const related = this.memoryLinkRepo!.findByEntity(target_entity);
        for (const link of related) {
          if (relatedIds.has(link.source_memory_id)) continue;
          if (link.confidence < 0.5) continue;
          const linkedMemory = this.memoryRepository.findById(link.source_memory_id);
          if (!linkedMemory || !matchesMemoryAccess(linkedMemory, policy)) continue;
          if (additions.length >= maxAdditions) break;

          relatedIds.add(link.source_memory_id);
          additions.push({
            id: link.source_memory_id,
            content: '', // filled by enrichResults
            score: maxScore * decayFactor * link.confidence,
              source: 'entity_graph',
            scope: '',
            scopeKey: '',
            kind: '',
            createdAt: 0,
            sourcePool,
          });
        }
        if (additions.length >= maxAdditions) break;
      }

      return [...merged, ...additions];
    } catch (err) {
      memoryObservability.record('memory.entity.failed', {
        stage: 'entity_graph_expansion',
        error: errorForObservation(err),
      });
      return merged;
    }
  }

  private expandByMemoryMetadata(merged: MergedResult[], policy: MemoryAccessPolicy, sourcePool?: MemoryPool): MergedResult[] {
    if (merged.length === 0) return merged;

    const byId = new Map(merged.map(result => [result.id, result]));
    const additions: MergedResult[] = [];
    const addLimit = Math.max(12, merged.length * 2);

    for (const result of merged) {
      const memory = this.memoryRepository.findById(result.id);
      if (!memory?.metadata) continue;
      const childIds = childMemoryIdsFromMetadata(memory.metadata);
      if (childIds.length === 0) continue;

      let addedForParent = 0;
      for (const childId of childIds) {
        if (byId.has(childId)) continue;
        const child = this.memoryRepository.findById(childId);
        if (!child || child.status !== 'active' || !matchesMemoryAccess(child, policy)) continue;
        const childResult: MergedResult = {
          id: child.id,
          content: child.content,
          score: result.score * (addedForParent === 0 ? 1.15 : 0.82),
          source: 'metadata_expansion',
          scope: child.scope,
          scopeKey: child.scope_key,
          kind: child.kind,
          createdAt: new Date(child.created_at).getTime(),
          sourcePool,
          speaker: extractSpeaker(child.content, child.metadata),
        };
        byId.set(child.id, childResult);
        additions.push(childResult);
        addedForParent++;
        if (additions.length >= addLimit || addedForParent >= 8) break;
      }
      if (additions.length >= addLimit) break;
    }

    return additions.length === 0 ? merged : [...merged, ...additions];
  }

  private legacyLikeSourceResults(options: RetrievalOptions, policy: MemoryAccessPolicy, sourcePool?: MemoryPool): SourceResult[] {
    const textScope = options.textScope ?? options.scope;
    const memories = this.memoryRepository.searchByContent(
      options.query, textScope, options.scopeKey,
    );
    return memories.filter(m => matchesMemoryAccess(m, policy)).map(m => ({
      id: m.id,
      content: m.content,
      score: 0.5,
      source: 'fts5' as const,
      scope: m.scope,
      scopeKey: m.scope_key,
      kind: m.kind,
      createdAt: new Date(m.created_at).getTime(),
      sourcePool,
    }));
  }

  private enrichResults(merged: MergedResult[]): RetrievedMemory[] {
    return merged.flatMap(m => {
      const memory = this.memoryRepository.findById(m.id);
      if (!memory) return [];
      // Lifecycle filter: only return active memories
      if (memory.status !== 'active') return [];
      return {
        id: m.id,
        content: memory.content || m.content,
        scope: memory.scope,
        scopeKey: memory.scope_key,
        kind: memory.kind,
        score: m.score,
        createdAt: new Date(memory.created_at).getTime(),
        sourcePool: m.sourcePool,
      };
    });
  }

  private async getQueryEmbedding(query: string): Promise<Float32Array | undefined> {
    if (!this.embeddingClient) return undefined;
    if (!this.embeddingClient.isConfigured()) return undefined;
    const contentHash = hashContent(query, this.embeddingClient.model);

    // Check cache
    const cached = this.embeddingCacheRepo.get(contentHash);
    if (cached) return bufferToFloat32Array(cached.embedding);

    // Circuit breaker check
    if (this.embeddingBreaker && !this.embeddingBreaker.allow()) {
      return undefined;  // breaker open → degrade to text-only search
    }

    // Call API with timeout
    try {
      const embedding = await withTimeout(
        this.embeddingClient.embedOne(query),
        this.queryEmbeddingTimeoutMs,
        'Embedding timeout',
      );
      // Success: record to breaker if we have one
      this.embeddingBreaker?.recordSuccess();

      // Store in cache
      this.embeddingCacheRepo.set({
        content_hash: contentHash,
        embedding: Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
        model: this.embeddingClient.model,
        dimension: embedding.length,
        created_at: new Date().toISOString(),
      });
      return embedding;
    } catch (err) {
      // Failure: record to breaker
      this.embeddingBreaker?.recordFailure();
      memoryObservability.record('memory.embedding.failed', {
        queryHash: hashForObservation(query),
        error: errorForObservation(err),
      });
      return undefined;
    }
  }

  private async textFallback(options: RetrievalOptions, policy = policyFromRetrievalOptions(options)): Promise<RetrievedMemory[]> {
    const { topK, minScore } = this.resolveDefaults(options);

    // 1. Query expansion: remove stopwords, build FTS5 query
    const expanded = expandQuery(options.query);

    // 2. FTS5 search (replaces LIKE)
    const textScope = options.textScope ?? options.scope;
    let ftsResults: FtsSearchResult[] = [];
    if (expanded.ftsQuery) {
      ftsResults = ftsSearch(this.db, expanded.ftsQuery, this.prefilterLimit(topK), textScope, options.scopeKey);
    }

    // 3. FTS5 no results → fallback to LIKE
    if (ftsResults.length === 0) {
      return this.legacyLikeSearch(options, policy);
    }

    // 4. Filter by minScore and map to RetrievedMemory
    const results: RetrievedMemory[] = [];
    for (const r of ftsResults) {
      if (r.normalizedScore < minScore) continue;
      const memory = this.memoryRepository.findById(r.memoryId);
      if (!memory) continue;
      if (!matchesMemoryAccess(memory, policy)) continue;
      results.push({
        id: memory.id,
        content: memory.content,
        scope: memory.scope,
        scopeKey: memory.scope_key,
        kind: memory.kind,
        score: r.normalizedScore,
        createdAt: new Date(memory.created_at).getTime(),
      });
    }

    return results.slice(0, topK);
  }

  private legacyLikeSearch(options: RetrievalOptions, policy = policyFromRetrievalOptions(options)): RetrievedMemory[] {
    const { topK, minScore } = this.resolveDefaults(options);
    const TEXT_FALLBACK_SCORE = 0.5;
    if (TEXT_FALLBACK_SCORE < minScore) return [];

    const textScope = options.textScope ?? options.scope;
    const memories = this.memoryRepository.searchByContent(
      options.query, textScope, options.scopeKey,
    );

    return memories.filter(m => matchesMemoryAccess(m, policy)).slice(0, topK).map(m => ({
      id: m.id,
      content: m.content,
      scope: m.scope,
      scopeKey: m.scope_key,
      kind: m.kind,
      score: TEXT_FALLBACK_SCORE,
      createdAt: new Date(m.created_at).getTime(),
    }));
  }

  /**
   * List available scene documents (kind='scene' memories).
   */
  async listScenes(scope?: string): Promise<{ scopeKey: string; refPath: string; startDate: string; endDate: string }[]> {
    const scenes = this.memoryRepository.findByScopeKind(scope ?? 'user', 'scene');
    return scenes.map(s => {
      let startDate = '';
      let endDate = '';
      try {
        const meta = s.metadata ? JSON.parse(s.metadata) : {};
        startDate = meta.startDate ?? '';
        endDate = meta.endDate ?? '';
      } catch {
        // ignore parse errors
      }
      return {
        scopeKey: s.scope_key,
        refPath: s.content,
        startDate,
        endDate,
      };
    });
  }

  private resolveDefaults(options: RetrievalOptions) {
    return {
      topK: options.topK ?? DEFAULT_TOP_K,
      minScore: options.minScore ?? this.defaultMinScore,
    };
  }

  private prefilterLimit(topK: number): number {
    return Math.max(topK * this.recallConfig.prefilterMultiplier, this.recallConfig.prefilterMin);
  }

  async retrieveGrouped(options: {
    query: string;
    agentId: string;
    topK?: number;
    minScore?: number;
  }): Promise<RetrievedMemory[]> {
    const policy = agentAwareRecallPolicy({
      agentId: options.agentId,
      poolWeights: { current: 1.2, shared: 1.0, otherShared: 0.8 },
    });

    const topK = options.topK ?? DEFAULT_TOP_K;
    const pools: Array<{ pool: MemoryPool; weight: number }> = [
      { pool: 'current', weight: policy.poolWeights?.current ?? 1.2 },
      { pool: 'shared', weight: policy.poolWeights?.shared ?? 1.0 },
      { pool: 'other', weight: policy.poolWeights?.otherShared ?? 0.8 },
    ];

    const poolResults = await Promise.all(pools.map(async ({ pool, weight }) => {
      const access: MemoryAccessPolicy = {
        agentId: options.agentId,
        pool,
        includeShared: true,
      };
      const results = await this.retrieveWithPolicy({
        query: options.query,
        agentId: options.agentId,
        topK: Math.max(topK * 2, 6),
        minScore: options.minScore,
      }, {
        access,
        includeEntityExpansion: true,
        includeTemporalDecay: true,
        activeOnly: true,
      }, false, pool);
      return results.map(result => ({
        ...result,
        score: result.score * weight,
        sourcePool: pool,
      }));
    }));

    const byId = new Map<string, RetrievedMemory>();
    for (const result of poolResults.flat()) {
      const existing = byId.get(result.id);
      if (!existing || result.score > existing.score) {
        byId.set(result.id, result);
      }
    }

    return Array.from(byId.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

}

function childMemoryIdsFromMetadata(metadataJson: string): string[] {
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(metadataJson) as Record<string, unknown>;
  } catch {
    return [];
  }
  const childIds = readStringArray(metadata.childMemoryIds);
  const windowIds = readStringArray(metadata.windowMemoryIds);
  const centerId = typeof metadata.centerMemoryId === 'string' ? [metadata.centerMemoryId] : [];
  const windowTurnIds = readStringArray(metadata.windowTurnIds);
  return [...new Set([...centerId, ...childIds, ...windowIds, ...windowTurnIds])].slice(0, 24);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
