/**
 * Hook for kernel M2 decision point `context.compact` (impl doc §4.6):
 * judged pre-compaction prune of history segments.
 *
 * Caller: `src/agent/compress.ts` via the `judgedPrune` callback wired by
 * `src/agent/context-transform.ts` when `features.compact === 'judged'` (the
 * point mode is gated here; default 'llm' never reaches this module). Runs
 * BEFORE the LLM summarization: segments dropped at
 * P(drop) >= COMPACT_DROP_PROBABILITY vanish outright (no summary line, mu's
 * summary-free claim). If the prune alone lowers the watermark below the
 * trigger, the caller skips the LLM summarization entirely; otherwise the LLM
 * compresses the PRUNED transcript (two-stage linkage, never abandoning the
 * existing fallback path).
 *
 * Shadow / gray / fallback are behavior-neutral: no `keptMessages` — the
 * existing LLM compression runs over the unpruned set, byte-equal. Never
 * throws.
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  COMPACT_SEGMENT_TEXT_MAX,
  CONTEXT_COMPACT_POINT_ID,
  createContextCompactSpec,
  segmentCompressibleMessages,
  type CompactSegment,
} from '../decisions/context-compact.js';
import { currentJudgeEngine } from '../engine-lookup.js';
import type { JudgeEngine } from '../engine.js';

/** State-char cap for a single decideMany batch (mirrors the admission hook). */
const STATE_CHAR_CAP = 24_000;

interface SegmentBatch {
  keys: string[];
  indexes: number[];
  infos: Array<{ key: string; text: string }>;
}

function splitSegmentBatches(segments: CompactSegment[]): SegmentBatch[] {
  const batches: SegmentBatch[] = [];
  let current: SegmentBatch = { keys: [], indexes: [], infos: [] };
  let currentChars = 0;
  segments.forEach((segment, index) => {
    const chars = Math.min(segment.text.length, COMPACT_SEGMENT_TEXT_MAX);
    if (currentChars + chars > STATE_CHAR_CAP && current.keys.length > 0) {
      batches.push(current);
      current = { keys: [], indexes: [], infos: [] };
      currentChars = 0;
    }
    current.keys.push(segment.key);
    current.indexes.push(index);
    current.infos.push({ key: segment.key, text: segment.text });
    currentChars += chars;
  });
  if (current.keys.length > 0) batches.push(current);
  return batches;
}

export interface JudgeContextCompactResult {
  asked: boolean;
  /**
   * Present only when judged+active with at least one dropped segment: the
   * old-message sub-array that SURVIVES (pruned). The caller replaces its
   * compressible region with this and re-checks the watermark; if still above
   * the trigger, the LLM summarization runs over the pruned set. `undefined`
   * on shadow / gray / fallback — the existing LLM compression runs unchanged.
   */
  keptMessages?: AgentMessage[];
}

/**
 * Judged pre-compaction prune (hook). Called by the compression path when
 * `features.compact === 'judged'` and the point mode is not 'off'.
 * Never throws.
 */
export async function judgeContextCompactPrune(input: {
  engine?: JudgeEngine;
  judgeGet?: () => JudgeEngine | undefined;
  oldMessages: AgentMessage[];
  messageCount: number;
  taskHint?: string;
  sessionId?: string;
}): Promise<JudgeContextCompactResult> {
  const engine = input.judgeGet?.() ?? currentJudgeEngine() ?? input.engine;
  if (!engine) return { asked: false };
  if (engine.modeFor(CONTEXT_COMPACT_POINT_ID) === 'off') return { asked: false };
  if (input.messageCount < 4) return { asked: false };
  if (input.oldMessages.length === 0) return { asked: false };

  const segments = segmentCompressibleMessages(input.oldMessages);
  if (segments.length === 0) return { asked: false };

  // Every batch must be judged to prune anything — one gray/fallback batch
  // bails out to the existing LLM compression (conservative total behavior).
  // Batches arrive in segment order, and keys inside a batch are ascending, so
  // survivors append in ascending range order without re-sorting.
  const survivors: CompactSegment[] = [];
  for (const batch of splitSegmentBatches(segments)) {
    const verdict = await engine.decideMany(createContextCompactSpec(batch.infos), {
      state: {
        taskHint: input.taskHint ?? '',
        segments: batch.infos,
      },
      sessionId: input.sessionId,
    });
    if (verdict.source !== 'judge' || verdict.mode !== 'active') {
      return { asked: true }; // shadow / gray / fallback → existing LLM path
    }
    if (verdict.outcome.action !== 'keep') {
      // keep-all outcome: nothing dropped by this batch — the batch survives.
      for (const key of batch.keys)
        survivors.push(segments[batch.indexes[batch.keys.indexOf(key)]!]!);
      continue;
    }
    for (let i = 0; i < batch.keys.length; i++) {
      if (verdict.outcome.ids.includes(batch.keys[i])) {
        survivors.push(segments[batch.indexes[i]]!);
      }
    }
  }

  if (survivors.length === segments.length) return { asked: true };

  // Stitch the surviving segments back into messages in ascending order.
  const keptMessages: AgentMessage[] = [];
  for (const segment of survivors) {
    keptMessages.push(...input.oldMessages.slice(segment.start, segment.end));
  }
  return { asked: true, keptMessages };
}
