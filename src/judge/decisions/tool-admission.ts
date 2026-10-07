/**
 * Decision point `tool.admission` (phase-1 M1, MyDocs/JEV_JUDGE_KERNEL_PLAN.md
 * §6 point 1, impl doc §4.1).
 *
 * Batches ONE `decideMany` call over N chunks of a tool result: one noul per
 * chunk (keys = chunk ids c1..cN), with a shared minimal state that carries the
 * task hint and per-chunk digest + truncated text. The caller (hook) owns
 * chunking, batching, the 24K state cap and the pointer-line format; this
 * module owns the question wording, the state normalization and the policy.
 *
 * Policy (plan §4.1 + the phase-1 experiment risk control):
 *   - a chunk is EVICTED only when P(drop) >= 0.9 (extra-conservative vs the
 *     plan's 0.75 keep-side assertion — gray always keeps);
 *   - P(keep) >= keepThreshold (0.75) keeps — by construction everything not
 *     evicted is kept, so no active eviction can lose a "keep" answer;
 *   - gray never reaches this policy (the engine cascades a gray answer to the
 *     fallback, which is `keep-all`).
 *
 * Outcome: `{ action: 'keep', ids }` listing the KEPT chunk ids when anything
 * was evicted, `keep-all` otherwise. The fallback is `keep-all` — byte-equal to
 * the pre-judge behavior.
 */

import {
  defineDecision,
  noul,
  type DecisionOutcome,
  type DecisionSpec,
  type JudgeSectionConfig,
} from '../types.js';

export const TOOL_ADMISSION_POINT_ID = 'tool.admission';

/** One judged chunk. `text` is truncated in the state by `buildToolAdmissionState`. */
export interface ToolAdmissionChunk {
  /** Answer key for this chunk ("c1".."cN"). */
  id: string;
  /** First line of the chunk, truncated to {@link FIRST_LINE_MAX}. */
  firstLine: string;
  /** Raw chunk size in characters (pre-truncation). */
  sizeChars: number;
  /** Chunk body (pre-truncation; state keeps at most CHUNK_TEXT_MAX chars). */
  text: string;
}

export interface ToolAdmissionState {
  /** First 200 chars of the turn's user message. */
  taskHint: string;
  /** One-line goal/skill frame when one is active. */
  goalHint?: string;
  toolName?: string;
  chunks: ToolAdmissionChunk[];
}

/** Per-chunk text carried into the state (impl doc §4.1: 全文截断 ≤1500 字符). */
export const CHUNK_TEXT_MAX = 1500;
/** taskHint length cap (plan §4.1). */
const TASK_HINT_MAX = 200;
const FIRST_LINE_MAX = 120;

/** noul answer interpreted as P(keep) — "true" = the chunk is still needed. */
const QUESTION_INSTRUCTIONS = 'does the current task still need this part of the tool output?';
const QUESTION_CRITERIA = {
  true: 'contains facts, errors, or results the current task needs',
  false: 'pure repetition, progress spam, or unrelated to the current task',
} as const;

/** Phase-1 experiment risk control: evict only at P(drop) >= 0.9. */
export const EVICTION_DROP_PROBABILITY = 0.9;

function chunkNoul(): DecisionSpec['questions'][string] {
  return noul(QUESTION_INSTRUCTIONS, QUESTION_CRITERIA);
}

/**
 * Slice tool output text into (~chunkSizeChars) line-boundary chunks.
 * Chunks never split mid-line, so `chunks.map(c => c.text).join('\n')`
 * reconstructs the input byte-identically.
 */
export function chunkToolOutputText(text: string, chunkSizeChars: number): ToolAdmissionChunk[] {
  const lines = text.split('\n');
  const chunks: ToolAdmissionChunk[] = [];
  let current: string[] = [];
  let currentSize = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    const id = `c${chunks.length + 1}`;
    chunks.push({
      id,
      firstLine: (current[0] ?? '').slice(0, FIRST_LINE_MAX),
      sizeChars: currentSize,
      text: current.join('\n'),
    });
    current = [];
    currentSize = 0;
  };
  for (const line of lines) {
    current.push(line);
    currentSize += line.length + 1; // +1 reconciles the join('\n') separator
    if (currentSize >= chunkSizeChars) flush();
  }
  flush();
  return chunks;
}

/** Normalize the hook-provided state: caps per plan §7.4 (state minimization). */
export function buildToolAdmissionState(raw: unknown): ToolAdmissionState {
  // engine.decide passes the whole DecisionInput ({ state, sessionId,
  // questionIds }) — unwrap the state member when present.
  const call = raw as { state?: unknown } | undefined;
  const input = ((call && typeof call === 'object' && 'state' in call ? call.state : raw) ??
    {}) as Partial<ToolAdmissionState>;
  return {
    taskHint: typeof input.taskHint === 'string' ? input.taskHint.slice(0, TASK_HINT_MAX) : '',
    ...(input.goalHint !== undefined
      ? { goalHint: String(input.goalHint).slice(0, TASK_HINT_MAX) }
      : {}),
    ...(input.toolName !== undefined
      ? { toolName: String(input.toolName).slice(0, FIRST_LINE_MAX) }
      : {}),
    chunks: (Array.isArray(input.chunks) ? input.chunks : []).map((chunk) => ({
      id: String((chunk as ToolAdmissionChunk)?.id ?? ''),
      firstLine: String((chunk as ToolAdmissionChunk)?.firstLine ?? '').slice(0, FIRST_LINE_MAX),
      sizeChars: Number((chunk as ToolAdmissionChunk)?.sizeChars ?? 0),
      text: String((chunk as ToolAdmissionChunk)?.text ?? '').slice(0, CHUNK_TEXT_MAX),
    })),
  };
}

/**
 * Policy: evict only chunks whose P(drop) >= 0.9; everything else (negatives
 * included — conservative) stays. Requires state.chunks to carry the chunk
 * order; the outcome lists the KEPT ids.
 */
function toolAdmissionPolicy(
  answers: Record<string, unknown>,
  ctx: { input: { state: unknown } },
): DecisionOutcome {
  const chunks = buildToolAdmissionState(ctx.input.state).chunks;
  const evicted = new Set<string>();
  for (const chunk of chunks) {
    const answer = answers[chunk.id] as { type?: string; probability?: number } | undefined;
    if (answer?.type === 'noul' && typeof answer.probability === 'number') {
      if (1 - answer.probability >= EVICTION_DROP_PROBABILITY) evicted.add(chunk.id);
    }
  }
  if (evicted.size === 0) return { action: 'keep-all' };
  return { action: 'keep', ids: chunks.map((c) => c.id).filter((id) => !evicted.has(id)) };
}

const TOOL_ADMISSION_FALLBACK: DecisionOutcome = { action: 'keep-all' };

/**
 * Per-call spec: variable chunk arity is expressed by generating one noul
 * question per chunk id (instructions are chunk-agnostic; chunk identity comes
 * from the state). `toolAdmissionSpec` is the registry-facing canonical
 * instance.
 */
export function createToolAdmissionSpec(chunkIds: string[]): DecisionSpec {
  const questions: Record<string, ReturnType<typeof chunkNoul>> = {};
  for (const id of chunkIds) questions[id] = chunkNoul();
  return defineDecision({
    id: TOOL_ADMISSION_POINT_ID,
    version: 1,
    questions,
    buildState: buildToolAdmissionState,
    // Cast keeps the shared policy over the widened generic answers map.
    policy: toolAdmissionPolicy as DecisionSpec['policy'],
    fallback: TOOL_ADMISSION_FALLBACK,
  });
}

/** Canonical registered instance (one-chunk template; hooks create per-call specs). */
export const toolAdmissionSpec: DecisionSpec = createToolAdmissionSpec(['c1']);

/** Default feature values mirrored from the judge section (hook read helper). */
export function admissionFeatureValues(config: JudgeSectionConfig | undefined): {
  chunkSizeChars: number;
  keepThreshold: number;
} {
  const features = config?.features?.admission;
  return {
    chunkSizeChars: features?.chunkSizeChars ?? 2000,
    keepThreshold: features?.keepThreshold ?? 0.75,
  };
}

/** One marker line for an evicted chunk (format owned by the caller per the
 *  task contract; the hook passes the pointer). */
export function admissionPointerLine(chunkId: string, toolName: string, pointer: string): string {
  return `[admitted-out: chunk ${chunkId} of ${toolName} result, full text at ${pointer}]`;
}

/**
 * Rebuild the admitted text: kept chunks keep their bytes, evicted chunks are
 * replaced by the single pointer line. `outcome.keep.ids` selects the kept
 * chunks; `keep-all` (or anything else) means no change → `undefined`.
 */
export function applyAdmissionChunks(
  chunks: ToolAdmissionChunk[],
  outcome: DecisionOutcome,
  opts: { toolName: string; pointer: string },
): string | undefined {
  if (outcome.action !== 'keep') return undefined;
  const kept = new Set(outcome.ids);
  if (kept.size === chunks.length) return undefined;
  return chunks
    .map((chunk) =>
      kept.has(chunk.id) ? chunk.text : admissionPointerLine(chunk.id, opts.toolName, opts.pointer),
    )
    .join('\n');
}
