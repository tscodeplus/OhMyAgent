import { LRUCache } from 'lru-cache';
import type { RetrievedMemory } from './memory-retriever.js';

export class QueryResultCache {
  private cache: LRUCache<string, RetrievedMemory[]>;

  constructor(maxEntries: number = 500, ttlMs: number = 5 * 60 * 1000) {
    this.cache = new LRUCache({
      max: maxEntries,
      ttl: ttlMs,
    });
  }

  /** Normalize query text as cache key */
  static normalizeKey(
    query: string,
    topK: number,
    scope?: string,
    scopeKey?: string,
    agentId?: string,
    kind?: string | string[],
    minScore?: number,
  ): string {
    const q = query.replace(/\s+/g, ' ').trim().toLowerCase();
    const normalizedKind = Array.isArray(kind) ? [...kind].sort().join(',') : kind;
    return `${q}::k=${topK}::s=${scope ?? ''}::sk=${scopeKey ?? ''}::a=${agentId ?? ''}::kind=${normalizedKind ?? ''}::min=${minScore ?? ''}`;
  }

  get(
    query: string,
    topK: number,
    scope?: string,
    scopeKey?: string,
    agentId?: string,
    kind?: string | string[],
    minScore?: number,
  ): RetrievedMemory[] | undefined {
    const key = QueryResultCache.normalizeKey(query, topK, scope, scopeKey, agentId, kind, minScore);
    return this.cache.get(key);
  }

  set(
    query: string,
    topK: number,
    scope: string | undefined,
    scopeKey: string | undefined,
    results: RetrievedMemory[],
    agentId?: string,
    kind?: string | string[],
    minScore?: number,
  ): void {
    const key = QueryResultCache.normalizeKey(query, topK, scope, scopeKey, agentId, kind, minScore);
    this.cache.set(key, results);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
