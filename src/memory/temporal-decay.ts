// src/memory/temporal-decay.ts

import type { MergedResult } from './rrf-merge.js';

export interface DecayConfig {
  /** Half-life in days. Default 30. Set to 0 to disable decay. */
  halfLifeDays: number;
  /** Current timestamp in ms (injectable for testing). */
  nowMs?: number;
}

const DEFAULT_HALF_LIFE_DAYS = 30;

/**
 * Apply exponential temporal decay to retrieval results.
 *
 * Formula: finalScore *= exp(-lambda * ageDays)
 * where lambda = ln(2) / halfLifeDays
 *
 * Core memories (identified by kind in coreKinds) are exempt from decay.
 * Entries with unknown timestamps (createdAt <= 0) are also exempt.
 *
 * @param results   Results from RRF merge (or any ranked list).
 * @param config    Decay configuration.
 * @param coreKinds Memory kinds that are exempt from decay. Default ['preference'].
 * @returns New array with decayed scores (does NOT mutate input).
 */
export function applyTemporalDecay(
  results: MergedResult[],
  config: Partial<DecayConfig> = {},
  coreKinds: string[] = ['preference'],
): MergedResult[] {
  const halfLifeDays = config.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  if (halfLifeDays <= 0) return results;

  const now = config.nowMs ?? Date.now();
  const lambda = Math.log(2) / halfLifeDays;
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  return results.map(r => {
    // Core memories: no decay
    if (coreKinds.includes(r.kind)) return { ...r };

    // Unknown timestamp: no decay
    if (!r.createdAt || r.createdAt <= 0) return { ...r };

    const ageDays = Math.max(0, (now - r.createdAt) / MS_PER_DAY);
    const decay = Math.exp(-lambda * ageDays);

    return { ...r, score: r.score * decay };
  });
}
