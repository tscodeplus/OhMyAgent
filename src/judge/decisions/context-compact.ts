/**
 * Decision point `context.compact` (kernel M2, plan §6 point 9, impl doc
 * §4.6): pre-compaction prune. When the auto-compress trigger fires and
 * `features.compact === 'judged'`, the compressible region (older messages
 * below the cut point) is segmented and judged: P(drop) >=
 * {@link COMPACT_DROP_PROBABILITY} → the segment vanishes outright (no summary
 * line, mu's summary-free claim). If the prune alone lowers the watermark below
 * the trigger, the LLM summarization call is SKIPPED; otherwise the remaining
 * messages fall through to the existing LLM compression over the pruned
 * transcript (two-stage linkage, never abandoning the existing path).
 *
 * `features.compact: 'llm'` (default) — AND every shadow/gray/fallback outcome
 * — is the current LLM-summary behavior, byte-identical.
 */

import { defineDecision, noul, type DecisionOutcome, type DecisionSpec } from '../types.js';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

export const CONTEXT_COMPACT_POINT_ID = 'context.compact';

/** Drop a history segment at P(drop) >= this (impl doc §4.6: ≈0.85). */
export const COMPACT_DROP_PROBABILITY = 0.85;
/** Per-segment text cap in the judge state. */
export const COMPACT_SEGMENT_TEXT_MAX = 1500;
/** Segment sizing: accumulate message digests up to this many chars per segment. */
export const COMPACT_SEGMENT_CHARS = 1800;

export interface CompactSegment {
  /** Answer key ("g1".."gN"). */
  key: string;
  /** Index range in the compressible old-message array, [start, end). */
  start: number;
  end: number;
  /** Segment digest text (state keeps at most COMPACT_SEGMENT_TEXT_MAX chars). */
  text: string;
}

export interface ContextCompactState {
  taskHint: string;
  segments: Array<{ key: string; text: string }>;
}

const COMPACT_QUESTION = noul('does the compressed context still need this piece of history?', {
  true: 'contains goals, decisions, names/paths/values, errors, or in-progress state referenced by the remaining work',
  false: 'pure progress chatter, superseded outputs, or filler with nothing to continue from',
});

function compactPolicy(
  answers: Record<string, unknown>,
  ctx: { input: { state: unknown } },
): DecisionOutcome {
  const state = (ctx.input.state ?? {}) as Partial<ContextCompactState>;
  const segments = Array.isArray(state.segments) ? state.segments : [];
  const dropped = new Set<string>();
  for (const segment of segments) {
    const answer = answers[String(segment?.key ?? '')] as
      { type?: string; probability?: number } | undefined;
    if (answer?.type === 'noul' && typeof answer.probability === 'number') {
      if (1 - answer.probability >= COMPACT_DROP_PROBABILITY) dropped.add(String(segment.key));
    }
  }
  if (dropped.size === 0) return { action: 'keep-all' };
  return {
    action: 'keep',
    ids: segments.map((s) => String(s.key)).filter((key) => !dropped.has(key)),
  };
}

/** Fallback: keep-all — the existing LLM compression path runs unchanged. */
const CONTEXT_COMPACT_FALLBACK: DecisionOutcome = { action: 'keep-all' };

/** Per-call spec: one noul per segment keyed "g1".."gN". */
export function createContextCompactSpec(segments: Array<{ key: string }>): DecisionSpec {
  const questions: Record<string, typeof COMPACT_QUESTION> = {};
  for (const segment of segments) questions[segment.key] = COMPACT_QUESTION;
  return defineDecision({
    id: CONTEXT_COMPACT_POINT_ID,
    version: 1,
    questions,
    buildState: (raw: unknown): ContextCompactState => {
      // engine.decide passes the whole DecisionInput — unwrap `state`.
      const call = raw as { state?: unknown } | undefined;
      const input = ((call && typeof call === 'object' && 'state' in call ? call.state : raw) ??
        {}) as Partial<ContextCompactState>;
      return {
        taskHint: typeof input.taskHint === 'string' ? input.taskHint.slice(0, 200) : '',
        segments: (Array.isArray(input.segments) ? input.segments : []).map((s) => ({
          key: String(s?.key ?? ''),
          text: String(s?.text ?? '').slice(0, COMPACT_SEGMENT_TEXT_MAX),
        })),
      };
    },
    policy: compactPolicy as DecisionSpec['policy'],
    fallback: CONTEXT_COMPACT_FALLBACK,
  });
}

/** Canonical registered instance (one-segment template; hooks create per-call specs). */
export const contextCompactSpec: DecisionSpec = createContextCompactSpec([{ key: 'g1' }]);

// ─── Segmentation helper (chunking lives with the spec, as in tool.admission) ──

/** One-line digest of an agent message for the judge state. */
function messageDigest(m: AgentMessage): string {
  let content = '';
  if (typeof m.content === 'string') content = m.content;
  else if (Array.isArray(m.content)) {
    content = (m.content as { type: string; text?: string; name?: string }[])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text!)
      .join('\n');
    if (!content.trim()) {
      const parts = (m.content as { type: string; name?: string }[])
        .filter((b) => b.type === 'toolCall')
        .map((b) => `[Tool: ${b.name}]`);
      content = parts.join(', ');
    }
  }
  return `[${m.role}] ${truncate(content, 400)}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Segment the compressible region into judge-sized pieces (segments never
 * straddle message boundaries).
 */
export function segmentCompressibleMessages(oldMessages: AgentMessage[]): CompactSegment[] {
  const segments: CompactSegment[] = [];
  let start = 0;
  let chars = 0;
  const flush = (end: number): void => {
    if (end <= start) return;
    segments.push({
      key: `g${segments.length + 1}`,
      start,
      end,
      text: oldMessages.slice(start, end).map(messageDigest).join('\n'),
    });
    start = end;
    chars = 0;
  };
  for (let i = 0; i < oldMessages.length; i++) {
    const digest = messageDigest(oldMessages[i]!);
    chars += digest.length + 1;
    if (chars >= COMPACT_SEGMENT_CHARS) flush(i + 1);
  }
  flush(oldMessages.length);
  return segments;
}
