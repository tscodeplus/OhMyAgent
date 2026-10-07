/**
 * Decision point `memory.worth` (kernel M2, plan §6 point 6, impl doc §4.5).
 *
 * Judges one or more candidate experience texts (candidate lessons produced by
 * the judged capture pipeline) with a single `decideMany` choice per candidate
 * (keys w1..wN, shared state):
 *
 *   useful-again  — a rule/preference the agent should keep following → persists
 *   one-off       — one-time logistics with no reusable lesson → dropped
 *   already-known — restates something the memory layer already holds → dropped
 *
 * Policy: only `useful-again` persists (`route` choice). Fallback =
 * `route('useful-again')` — identical to the pre-judge behavior of keeping
 * every candidate (deviation note: the impl doc's fallback column says
 * 保留 which IS this value).
 */

import { choice, defineDecision, type DecisionOutcome, type DecisionSpec } from '../types.js';

export const MEMORY_WORTH_POINT_ID = 'memory.worth';

export const WORTH_USEFUL_AGAIN = 'useful-again';
export const WORTH_ONE_OFF = 'one-off';
export const WORTH_ALREADY_KNOWN = 'already-known';

export interface MemoryWorthCandidate {
  /** Stable candidate id for the hook to map back. */
  id: string;
  /** Answer key for this candidate ("w1".."wN"). */
  key: string;
  /** Candidate lesson text (typically the judged user message). */
  text: string;
}

export interface MemoryWorthState {
  /** Session scenario excerpt for context (the latest assistant reply). */
  scenario?: string;
  candidates: Array<{ id: string; key: string; text: string }>;
}

/** Lesson text persisted in state for the judge (state minimization). */
export const MEMORY_WORTH_TEXT_MAX = 400;
const SCENARIO_MAX = 200;

const WORTH_QUESTION = choice('Is this candidate memory worth keeping for future reuse?', {
  [WORTH_USEFUL_AGAIN]: 'a durable rule/preference the agent should keep applying later',
  [WORTH_ONE_OFF]: 'one-time logistics tied to a past situation, no reusable lesson',
  [WORTH_ALREADY_KNOWN]: 'restates or duplicates knowledge the agent already has',
});

/** Choice keys that persist (impl doc §4.5: 仅 useful-again 入库). */
export const WORTH_PERSISTING = new Set<string>([WORTH_USEFUL_AGAIN]);

/** Answer keys are positional: w1..wN over the candidate order. */
export function memoryWorthKeys(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `w${i + 1}`);
}

/**
 * Policy: `route` to the per-candidate winner; the hook persists only the
 * `useful-again` ones. The outcome reports whether ANY candidate persists
 * (`keep` ids) for compactness of the hook contract.
 */
function memoryWorthPolicy(
  answers: Record<string, unknown>,
  ctx: { input: { state: unknown } },
): DecisionOutcome {
  const state = (ctx.input.state ?? {}) as Partial<MemoryWorthState>;
  const candidates = Array.isArray(state.candidates) ? state.candidates : [];
  const persistIds: string[] = [];
  for (const candidate of candidates) {
    const answer = answers[String(candidate?.key ?? '')] as
      { type?: string; choice?: string } | undefined;
    if (
      answer &&
      answer.type === 'choice' &&
      typeof answer.choice === 'string' &&
      WORTH_PERSISTING.has(answer.choice)
    ) {
      persistIds.push(String(candidate.id));
    }
  }
  if (persistIds.length === 0) return { action: 'none' };
  return { action: 'keep', ids: persistIds };
}

/** Fallback: keep every candidate — the pre-judge behavior. */
const MEMORY_WORTH_FALLBACK: DecisionOutcome = { action: 'keep-all' };

/**
 * Per-call spec: one choice question per candidate keyed "w1".."wN"; state
 * carries the candidate texts and the session scenario excerpt.
 */
export function createMemoryWorthSpec(
  candidates: Array<{ id: string; key: string }>,
): DecisionSpec {
  const questions: Record<string, typeof WORTH_QUESTION> = {};
  for (const candidate of candidates) questions[candidate.key] = WORTH_QUESTION;
  return defineDecision({
    id: MEMORY_WORTH_POINT_ID,
    version: 1,
    questions,
    buildState: (raw: unknown): MemoryWorthState => {
      // engine.decide passes the whole DecisionInput — unwrap `state`.
      const call = raw as { state?: unknown } | undefined;
      const input = ((call && typeof call === 'object' && 'state' in call ? call.state : raw) ??
        {}) as Partial<MemoryWorthState>;
      return {
        ...(typeof input.scenario === 'string'
          ? { scenario: input.scenario.slice(0, SCENARIO_MAX) }
          : {}),
        candidates: (Array.isArray(input.candidates) ? input.candidates : []).map((c) => ({
          id: String(c?.id ?? ''),
          key: String(c?.key ?? ''),
          text: String(c?.text ?? '').slice(0, MEMORY_WORTH_TEXT_MAX),
        })),
      };
    },
    policy: memoryWorthPolicy as DecisionSpec['policy'],
    fallback: MEMORY_WORTH_FALLBACK,
  });
}

/** Canonical registered instance (one-candidate template; hooks create per-call specs). */
export const memoryWorthSpec: DecisionSpec = createMemoryWorthSpec([{ id: 'template', key: 'w1' }]);

export interface JudgeMemoryWorthResult {
  /** True when a judge call was made (shadow or active — ledger has a line). */
  asked: boolean;
  /**
   * `active` + judged only: candidate ids whose verdict is `useful-again` and
   * that may persist. `undefined` in every other case — the hook then keeps
   * the current behavior (all candidates persist in fallback mode).
   */
  persistIds?: string[];
}
