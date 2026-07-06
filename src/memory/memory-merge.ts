/**
 * MemoryMergeService — compiled truth pattern.
 *
 * When a new memory is highly similar to an existing one (cosine >= mergeThreshold),
 * instead of rejecting the write as duplicate, this service uses an LLM to merge
 * the new evidence into the existing memory's "current best understanding."
 *
 * The original content is preserved in metadata.timeline for audit trail.
 *
 * Fallback chain (same pattern as Summary LLM):
 *   modelRef → fallbackRefs → throw → caller falls back to existing dedup behavior.
 */

import type { Logger } from 'pino';
import type { AuxModelConfig } from './aux-llm-client.js';
import { auxLLMCall } from './aux-llm-client.js';
import type { Memory } from './repositories/memory-repository.js';
import { errorForObservation, hashForObservation, memoryObservability } from './observability.js';

export interface MergeConfig {
  /** Aux model config. Unset → no LLM merge, falls back to existing dedup. */
  auxConfig?: AuxModelConfig;
  /** Cosine similarity threshold to trigger merge (0-1). Default 0.85. */
  mergeThreshold: number;
  logger: Logger;
}

export interface TimelineEntry {
  timestamp: number;
  previousContent: string;
  newEvidence: string;
}

const MERGE_SYSTEM_PROMPT =
  'Merge the following existing knowledge with new evidence. Update the current best understanding. Output ONLY JSON: {"mergedContent":"merged text"}.';

/**
 * Attempt to merge new evidence into an existing memory.
 *
 * @returns The merged content string, or null if merge should not proceed.
 * @throws If LLM merge is attempted but fails.
 */
export async function mergeMemory(
  existing: Memory,
  newContent: string,
  similarity: number,
  config: MergeConfig,
): Promise<{ mergedContent: string; timelineEntry: TimelineEntry } | null> {
  // Check if merge should be attempted
  if (similarity < config.mergeThreshold) {
    return null; // Not similar enough — caller should create a new memory
  }

  // Near-exact duplicates: skip LLM, treat as duplicate
  if (similarity >= 0.95) {
    config.logger.debug(
      { memoryId: existing.id, similarity },
      'Near-exact duplicate, skipping LLM merge',
    );
    // Still update the existing memory's updated_at
    return {
      mergedContent: existing.content,
      timelineEntry: {
        timestamp: Date.now(),
        previousContent: existing.content,
        newEvidence: newContent,
      },
    };
  }

  // Check if LLM merge is configured
  const hasModel = config.auxConfig?.modelRef || (config.auxConfig?.fallbackRefs?.length ?? 0) > 0;
  if (!hasModel) {
    // No LLM configured — fall back to existing dedup behavior (reject as duplicate)
    return null;
  }

  // LLM merge
  const userPrompt = `CURRENT:\n${existing.content}\n\nNEW EVIDENCE:\n${newContent}`;

  try {
    const response = await auxLLMCall(config.auxConfig!, {
      systemPrompt: MERGE_SYSTEM_PROMPT,
      userPrompt,
      temperature: 0.3,
      maxTokens: 1000,
      logger: config.logger,
    });
    const mergedContent = parseMergedContent(response);

    if (!mergedContent?.trim()) {
      throw new Error('LLM merge returned empty result');
    }

    const timelineEntry: TimelineEntry = {
      timestamp: Date.now(),
      previousContent: existing.content,
      newEvidence: newContent,
    };

    return { mergedContent: mergedContent.trim(), timelineEntry };
  } catch (err) {
    memoryObservability.record('memory.merge.failed', {
      memoryId: existing.id,
      newContentHash: hashForObservation(newContent),
      error: errorForObservation(err),
    });
    config.logger.info({ err, memoryId: existing.id }, 'LLM merge failed, falling back to dedup');
    return null; // Fall back to existing dedup behavior
  }
}

export function parseMergedContent(response: string): string {
  const trimmed = response.trim();
  try {
    const parsed = JSON.parse(trimmed) as { mergedContent?: unknown };
    if (typeof parsed.mergedContent === 'string') {
      return parsed.mergedContent.trim();
    }
  } catch {
    // Legacy plain-text merge output remains supported.
  }
  return trimmed;
}

/**
 * Append a timeline entry to an existing metadata JSON string.
 */
export function appendTimeline(
  metadataJson: string | null,
  entry: TimelineEntry,
): string {
  let meta: Record<string, unknown>;
  try {
    meta = metadataJson ? JSON.parse(metadataJson) : {};
  } catch {
    meta = {};
  }

  const timeline: TimelineEntry[] = Array.isArray(meta.timeline)
    ? (meta.timeline as TimelineEntry[])
    : [];

  // Keep only the last 20 timeline entries to bound metadata size
  timeline.push(entry);
  if (timeline.length > 20) {
    meta.timeline = timeline.slice(-20);
  }

  return JSON.stringify({ ...meta, timeline: timeline.slice(-20) });
}
