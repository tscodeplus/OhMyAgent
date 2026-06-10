import { detectCategory } from '../memory-filter.js';
import { detectTopic } from './preference-conflict-resolver.js';

export interface ExtractedMemory {
  kind: string;
  topic: string;
  content: string;
  confidence: number;
}

/**
 * Extract structured memory metadata from content using rule-based fallback.
 * LLM-based extraction can be added later without changing callers.
 */
export function extractMemoryMetadata(content: string): ExtractedMemory {
  const kind = detectCategory(content);
  const topic = kind === 'preference' ? detectTopic(content) : 'generic';

  let confidence = 1.0;
  // Lower confidence when topic detection is ambiguous
  if (topic === 'generic' && kind === 'preference') {
    confidence = 0.7;
  }
  if (kind === 'fact') {
    confidence = 0.8;
  }

  return { kind, topic, content, confidence };
}
