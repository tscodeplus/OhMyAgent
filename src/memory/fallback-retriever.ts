import type { MemoryRepository } from './repositories/memory-repository.js';
import type { RetrievedMemory } from './memory-retriever.js';

const TEXT_FALLBACK_SCORE = 0.5;

/**
 * Simple text-based fallback retriever.
 * Uses memoryRepository.searchByContent with LIKE matching.
 * No embedding generation needed.
 */
export async function textFallbackRetrieve(
  memoryRepository: MemoryRepository,
  query: string,
  topK: number,
  scope?: string,
  scopeKey?: string,
): Promise<RetrievedMemory[]> {
  const memories = memoryRepository.searchByContent(query, scope, scopeKey);

  return memories.slice(0, topK).map(m => ({
    id: m.id,
    content: m.content,
    scope: m.scope,
    scopeKey: m.scope_key,
    kind: m.kind,
    score: TEXT_FALLBACK_SCORE,
    createdAt: new Date(m.created_at).getTime(),
  }));
}
