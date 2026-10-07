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
import {
  judgeMemoryMergeRelation,
  MERGE_DUPLICATE,
  MERGE_CONTRADICTS,
  MERGE_MORE_PRECISE,
  MERGE_UNRELATED,
  type MemoryMergeRelation,
} from '../judge/decisions/memory-merge.js';
import { currentJudgeEngine } from '../judge/engine-lookup.js';
import type { JudgeEngine } from '../judge/engine.js';

/**
 * Richer merge result — the judged relations that mean "keep BOTH records":
 *   contradicts → the old record gets a dispute marker + timeline, the new
 *                 one is created with the same marker (impl doc §4.5);
 *   unrelated   → the new record is created, no old-record change.
 * `{ mergedContent, timelineEntry }` keeps the compiled-truth contract used by
 * MemoryWriter; `null` stays "merge did not proceed" (dedup behavior).
 */
export type MemoryMergeOutcome =
  | { mergedContent: string; timelineEntry: TimelineEntry; judgedRelation?: MemoryMergeRelation }
  | { judgedRelation: 'contradicts'; timelineEntry: TimelineEntry }
  | { judgedRelation: 'unrelated' }
  | null;

export interface MergeConfig {
  /** Aux model config. Unset → no LLM merge, falls back to existing dedup. */
  auxConfig?: AuxModelConfig;
  /**
   * Judge engine getter (kernel M2 `memory.merge`): consulted for at-least
   * merge-threshold-similar new content BEFORE the aux chat-LLM merge call.
   * Unset/undeactivatable → current LLM merge behavior untouched.
   */
  judgeGet?: () => JudgeEngine | undefined;
  /** Cosine similarity threshold to trigger merge (0-1). Default 0.85. */
  mergeThreshold: number;
  /** Output language for merged memories. 'Auto'/unset → follow the existing
   * memory's language via prompt instruction (TDAM v0.3.6 language-adaptive
   * prompt pattern; a bare merge prompt let zh memories come back English). */
  outputLanguage?: string;
  logger: Logger;
}

export interface TimelineEntry {
  timestamp: number;
  previousContent: string;
  newEvidence: string;
}

const MERGE_SYSTEM_PROMPT_BASE =
  'Merge the following existing knowledge with new evidence. Update the current best understanding. Output ONLY JSON: {"mergedContent":"merged text"}.';

/**
 * Build the merge system prompt. When a concrete output language is configured,
 * instruct the model to write the merged content in it; 'Auto' defers to the
 * conversation/existing memory language (same semantics as the summarizer).
 */
export function buildMergeSystemPrompt(outputLanguage?: string): string {
  if (outputLanguage && outputLanguage !== 'Auto') {
    return `${MERGE_SYSTEM_PROMPT_BASE} Write the merged content in ${outputLanguage}.`;
  }
  return `${MERGE_SYSTEM_PROMPT_BASE} Write the merged content in the same language as the CURRENT text.`;
}

/**
 * Append the judged-merge dispute marker to an existing metadata JSON string.
 * Metadata-only conflict flag — NO schema migration needed (the metadata
 * column is free-form JSON).
 */
export function appendMemoryDispute(metadataJson: string | null): string {
  let meta: Record<string, unknown>;
  try {
    meta = metadataJson ? JSON.parse(metadataJson) : {};
  } catch {
    meta = {};
  }
  return JSON.stringify({ ...meta, judge_dispute: true });
}

/** Pure mapping from one judged merge relation: the mergeMemory outcome shape. */
export function judgedMergeOutcome(
  existingContent: string,
  newContent: string,
  relation: MemoryMergeRelation,
): MemoryMergeOutcome {
  const timelineEntry: TimelineEntry = {
    timestamp: Date.now(),
    previousContent: existingContent,
    newEvidence: newContent,
  };
  switch (relation) {
    case MERGE_DUPLICATE:
      // Drop the new wording; the old record stays (timeline keeps the attempt
      // for audit) — mirrors the near-exact-duplicate branch.
      return { mergedContent: existingContent, timelineEntry, judgedRelation: relation };
    case MERGE_MORE_PRECISE:
      // Replace the old content with the sharper new wording.
      return { mergedContent: newContent.trim(), timelineEntry, judgedRelation: relation };
    case MERGE_CONTRADICTS:
      return { judgedRelation: 'contradicts', timelineEntry };
    case MERGE_UNRELATED:
      return { judgedRelation: 'unrelated' };
    default:
      return null;
  }
}

/**
 * Attempt to merge new evidence into an existing memory.
 *
 * Judge-first (kernel M2): when `memory.merge` is active+judged, the relation
 * choice REPLACES the aux chat-LLM merge call entirely. Every other mode
 * combination falls through to the previous LLM merge logic verbatim.
 *
 * @returns The merge outcome, or null if merge should not proceed
 *   (caller then applies its existing dedup behavior).
 * @throws If LLM merge is attempted but fails.
 */
export async function mergeMemory(
  existing: Memory,
  newContent: string,
  similarity: number,
  config: MergeConfig,
): Promise<MemoryMergeOutcome> {
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

  // ── Judged merge (kernel M2 `memory.merge`) ──
  // Consulted AFTER the near-exact branch and BEFORE the aux chat-LLM merge:
  // judged + active → the bounded choice replaces the aux-LLM call. Shadow,
  // gray, fallback or mode-off → continue into the existing LLM merge path
  // unchanged (engine failures are logged and ignored by the hook contract).
  if (config.judgeGet) {
    try {
      const judged = await judgeMemoryMergeRelation({
        engine: config.judgeGet(),
        existingContent: existing.content,
        newContent,
      });
      if (judged.relation) {
        return judgedMergeOutcome(existing.content, newContent, judged.relation);
      }
    } catch (err) {
      config.logger.debug(
        { err, memoryId: existing.id },
        'Judge memory.merge failed — falling back to LLM merge',
      );
    }
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
      systemPrompt: buildMergeSystemPrompt(config.outputLanguage),
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
export function appendTimeline(metadataJson: string | null, entry: TimelineEntry): string {
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
