// src/memory/rrf-merge.ts

export type RetrievalSource = 'vector' | 'fts5' | 'cosine' | 'entity_graph' | 'metadata_expansion' | 'terms';

export interface SourceResult {
  id: string;           // memory_id
  content: string;
  score: number;        // original score (vector similarity / BM25 normalized score)
  source: RetrievalSource;
  scope: string;
  scopeKey: string;
  kind: string;
  createdAt: number;    // unix ms
  sourcePool?: string;
  speaker?: string;     // derived from metadata.speaker or "X said:" prefix
  slot?: string;        // slotId that produced this candidate (coverage merge only)
}

export interface MergedResult {
  id: string;
  content: string;
  score: number;        // RRF fused score
  source: RetrievalSource;
  scope: string;
  scopeKey: string;
  kind: string;
  createdAt: number;
  sourcePool?: string;
  speaker?: string;
  slot?: string;
}

/**
 * Reciprocal Rank Fusion.
 * Formula: score = sum(1 / (rank_i + k)) across source lists.
 *
 * Candidates appearing in multiple source lists get their RRF contributions summed,
 * which boosts their final rank.
 *
 * @param sourceLists  Ranked result lists from different search sources.
 *                     Each list must be sorted by score descending (best first).
 * @param k            Smoothing parameter. Default 60.
 * @param topK         Maximum number of results to return.
 */
export function rrfMerge(
  sourceLists: SourceResult[][],
  k: number = 60,
  topK: number = 5,
): MergedResult[] {
  // Filter out empty lists
  const nonEmpty = sourceLists.filter(l => l.length > 0);
  if (nonEmpty.length === 0) return [];

  // Single source: short-circuit — just apply RRF scoring to the single list
  if (nonEmpty.length === 1) {
    return nonEmpty[0].slice(0, topK).map((item, i) => ({
      ...item,
      score: 1 / (i + 1 + k),
    }));
  }

  // Multi-source: accumulate RRF scores by candidate id
  const scoreMap = new Map<string, { accumulated: number; item: SourceResult }>();

  for (const list of nonEmpty) {
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const rrfContrib = 1 / (i + 1 + k);
      const existing = scoreMap.get(item.id);

      if (existing) {
        existing.accumulated += rrfContrib;
      } else {
        scoreMap.set(item.id, { accumulated: rrfContrib, item });
      }
    }
  }

  // Sort by accumulated RRF score descending
  const merged = Array.from(scoreMap.values())
    .map(({ accumulated, item }) => ({
      id: item.id,
      content: item.content,
      score: accumulated,
      source: item.source,
      scope: item.scope,
      scopeKey: item.scopeKey,
      kind: item.kind,
      createdAt: item.createdAt,
      sourcePool: item.sourcePool,
      speaker: item.speaker,
      slot: item.slot,
    }))
    .sort((a, b) => b.score - a.score);

  return merged.slice(0, topK);
}
