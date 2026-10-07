/**
 * Decision point `context.forget` (kernel M2, plan §6 point 8, impl doc §4.6).
 *
 * At the capacity watermark, evicts stale tool results from the OUTBOUND
 * request assembly (the session record keeps the originals — eviction happens
 * at request-build time, never in SQLite). One noul per nominated candidate,
 * batched as ONE `decideMany` (keys k1..kN, shared state), batches split by
 * the module's own state cap.
 *
 * Nomination rules (impl doc §4.6, enforced by the hook in
 * `../hooks/context-forget.js`):
 *   - candidates are toolResult messages ≥ {@link MIN_CANDIDATE_TOKENS} tokens;
 *   - errors are never nominated (usually load-bearing for debugging);
 *   - at most {@link MAX_CANDIDATES_PER_CALL} per hook invocation;
 *   - already-evicted messages are never re-nominated (per-session identity set).
 *
 * Policy: P(drop) >= {@link DROP_PROBABILITY} → tombstone; P(drop) <= 0.3 →
 * keep; gray keeps (engine cascades). Fallback keeps everything (current
 * behavior). Only P(drop) >= 0.9 evicts — extra-conservative, mirroring the
 * phase-1 `tool.admission` risk control.
 */

import { defineDecision, noul, type DecisionOutcome, type DecisionSpec } from '../types.js';

export const CONTEXT_FORGET_POINT_ID = 'context.forget';

/** A nominated stale tool result. */
export interface ForgetCandidate {
  /** Answer key for this candidate ("k1".."kN"). */
  key: string;
  /** Tool that produced the result. */
  tool: string;
  /** Token estimate of the result text. */
  sizeTokens: number;
  /** Approximate number of user turns that happened after the candidate. */
  ageTurns: number;
  /** First line of the result text (truncated). */
  firstLine: string;
  /** Result text (state keeps at most CONTEXT_FORGET_TEXT_MAX chars). */
  text: string;
}

export interface ContextForgetState {
  /** First 200 chars of the turn's user message. */
  taskHint: string;
  candidates: ForgetCandidate[];
}

/** Tool results below this token estimate are not nominated (impl doc §4.6: ≥ 400). */
export const MIN_CANDIDATE_TOKENS = 400;
/** At most this many nominees per hook invocation (frequency control). */
export const MAX_CANDIDATES_PER_CALL = 8;
/** Evict at P(drop) >= this value (plan §6 point 8 uses 0.85; we ship the phase-1-conservative 0.9). */
export const DROP_PROBABILITY = 0.9;
/** Per-candidate text carried into the state. */
export const CONTEXT_FORGET_TEXT_MAX = 1200;
const FIRST_LINE_MAX = 120;
const TASK_HINT_MAX = 200;

const QUESTION_INSTRUCTIONS =
  'does the current task still need the FULL text of this old tool result?';
const QUESTION_CRITERIA = {
  true: 'the task still references or depends on the result contents (values, error details, file paths, state)',
  false: 'the step is long finished and its result is no longer needed for the current task',
} as const;

function forgetNoul(): DecisionSpec['questions'][string] {
  return noul(QUESTION_INSTRUCTIONS, QUESTION_CRITERIA);
}

/** Answer keys are positional: k1..kN over the nominee order. */
export function forgetCandidateKeys(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `k${i + 1}`);
}

function contextForgetPolicy(
  answers: Record<string, unknown>,
  ctx: { input: { state: unknown } },
): DecisionOutcome {
  const state = (ctx.input.state ?? {}) as Partial<ContextForgetState>;
  const candidates = Array.isArray(state.candidates) ? state.candidates : [];
  const evicted = new Set<string>();
  for (const candidate of candidates) {
    const answer = answers[String(candidate?.key ?? '')] as
      { type?: string; probability?: number } | undefined;
    if (answer?.type === 'noul' && typeof answer.probability === 'number') {
      if (1 - answer.probability >= DROP_PROBABILITY) evicted.add(String(candidate.key));
    }
  }
  if (evicted.size === 0) return { action: 'keep-all' };
  return {
    action: 'keep',
    ids: candidates.map((c) => String(c.key)).filter((key) => !evicted.has(key)),
  };
}

const CONTEXT_FORGET_FALLBACK: DecisionOutcome = { action: 'keep-all' };

/** Per-call spec: one noul per nominee keyed "k1".."kN". */
export function createContextForgetSpec(candidates: ForgetCandidate[]): DecisionSpec {
  const questions: Record<string, ReturnType<typeof forgetNoul>> = {};
  for (const candidate of candidates) questions[candidate.key] = forgetNoul();
  return defineDecision({
    id: CONTEXT_FORGET_POINT_ID,
    version: 1,
    questions,
    buildState: (raw: unknown): ContextForgetState => {
      // engine.decide passes the whole DecisionInput — unwrap `state`.
      const call = raw as { state?: unknown } | undefined;
      const input = ((call && typeof call === 'object' && 'state' in call ? call.state : raw) ??
        {}) as Partial<ContextForgetState>;
      return {
        taskHint: typeof input.taskHint === 'string' ? input.taskHint.slice(0, TASK_HINT_MAX) : '',
        candidates: (Array.isArray(input.candidates) ? input.candidates : []).map((c) => ({
          key: String((c as ForgetCandidate)?.key ?? ''),
          tool: String((c as ForgetCandidate)?.tool ?? '').slice(0, FIRST_LINE_MAX),
          sizeTokens: Number((c as ForgetCandidate)?.sizeTokens ?? 0),
          ageTurns: Number((c as ForgetCandidate)?.ageTurns ?? 0),
          firstLine: String((c as ForgetCandidate)?.firstLine ?? '').slice(0, FIRST_LINE_MAX),
          text: String((c as ForgetCandidate)?.text ?? '').slice(0, CONTEXT_FORGET_TEXT_MAX),
        })),
      };
    },
    policy: contextForgetPolicy as DecisionSpec['policy'],
    fallback: CONTEXT_FORGET_FALLBACK,
  });
}

/** Canonical registered instance (one-candidate template; hooks create per-call specs). */
export const contextForgetSpec: DecisionSpec = createContextForgetSpec([
  {
    key: 'k1',
    tool: 'template',
    sizeTokens: 0,
    ageTurns: 0,
    firstLine: '',
    text: '',
  },
]);

/** The tombstone line that replaces an evicted tool result in the outbound context. */
export function forgetTombstoneLine(toolName: string, ageTurns: number, firstLine: string): string {
  const digest = firstLine.length > 0 ? ` firstLine: ${truncateForTombstone(firstLine)}` : '';
  return `[evicted: ${toolName} result from ~${ageTurns} turn(s) ago,${digest} full text kept in the session record — recall via memory/session history if needed]`;
}

function truncateForTombstone(line: string): string {
  return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}
