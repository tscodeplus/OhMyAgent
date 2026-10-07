/**
 * Decision point `memory.capture` (kernel M2, plan §6 point 5, impl doc §4.5).
 *
 * Judges whether a user message corrects the agent or establishes a rule worth
 * entering the memory write pipeline. One noul per message, batched as ONE
 * `decideMany` call (keys m1..mN, shared state) so the whole candidate batch is
 * billed on a single state.
 *
 * Policy: P(capture) >= {@link MEMORY_CAPTURE_THRESHOLD} → the message's
 * candidates enter the write pipeline; otherwise they are dropped.
 *
 * Fallback = { action: 'none' } — with no verdict the messages produce NO
 * judged candidates, which is exactly the pre-judge behavior (the capture
 * pipeline is additive; the summarizer/LLM preference extraction runs on
 * regardless).
 */

import { defineDecision, noul, type DecisionOutcome, type DecisionSpec } from '../types.js';

export const MEMORY_CAPTURE_POINT_ID = 'memory.capture';

export interface MemoryCaptureMessage {
  /** Stable id for the hook to map back ("m1".."mN" = positional answer key). */
  id: string;
  /** Answer key for this message ("m1".."mN"). */
  key: string;
  /** Message text; the state truncates it (impl doc: ≤600 字). */
  text: string;
}

export interface MemoryCaptureState {
  /** First 300 chars of the assistant's latest reply for context.
   *  (Key name must match what `judge-experience-gate.ts` sends.) */
  assistantScenario?: string;
  messages: Array<{ id: string; key: string; text: string }>;
}

/** P(capture) at or above which a message enters the memory write pipeline (impl doc §4.5). */
export const MEMORY_CAPTURE_THRESHOLD = 0.7;

/** Per-message text carried into the state (impl doc §4.5: 600 字). */
export const MEMORY_CAPTURE_TEXT_MAX = 600;
const ASSISTANT_CONTEXT_MAX = 300;

const QUESTION_INSTRUCTIONS =
  'does this message correct the agent or set a rule worth remembering?';
const QUESTION_CRITERIA = {
  true: 'the user corrects how the agent behaved, complaints about behavior to change, or establishes a rule/preference the agent must follow later',
  false:
    'ordinary task request, question, small talk, or transient state with no lasting behavioral lesson',
} as const;

function captureNoul(): DecisionSpec['questions'][string] {
  return noul(QUESTION_INSTRUCTIONS, QUESTION_CRITERIA);
}

/** Answer keys are positional: m1..mN over the candidate order. */
export function memoryCaptureKeys(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `m${i + 1}`);
}

/**
 * Policy: capture (proceed) at P >= 0.7; everything below is dropped. The
 * `keep` outcome lists the message ids whose candidates CONTINUE into the
 * pipeline; gray answers never reach the policy (the engine cascades them to
 * the fallback).
 */
function memoryCapturePolicy(
  answers: Record<string, unknown>,
  ctx: { input: { state: unknown } },
): DecisionOutcome {
  const state = (ctx.input.state ?? {}) as Partial<MemoryCaptureState>;
  const messages = Array.isArray(state.messages) ? state.messages : [];
  const captured: string[] = [];
  for (const message of messages) {
    const answer = answers[String(message?.key ?? '')] as
      { type?: string; probability?: number } | undefined;
    if (answer && answer.type === 'noul' && typeof answer.probability === 'number') {
      if (answer.probability >= MEMORY_CAPTURE_THRESHOLD) {
        captured.push(String(message.id));
      }
    }
  }
  if (captured.length === 0) return { action: 'none' };
  return { action: 'keep', ids: captured };
}

const MEMORY_CAPTURE_FALLBACK: DecisionOutcome = { action: 'none' };

/**
 * Per-call spec: one noul per candidate message, keyed by "m1".."mN", state
 * carries the truncated texts (the question wording is shared).
 */
export function createMemoryCaptureSpec(
  messages: Array<{ id: string; key: string }>,
): DecisionSpec {
  const questions: Record<string, ReturnType<typeof captureNoul>> = {};
  for (const message of messages) questions[message.key] = captureNoul();
  return defineDecision({
    id: MEMORY_CAPTURE_POINT_ID,
    version: 1,
    questions,
    buildState: (raw: unknown): MemoryCaptureState => {
      // engine.decide passes the whole DecisionInput — unwrap `state`.
      const call = raw as { state?: unknown } | undefined;
      const input = ((call && typeof call === 'object' && 'state' in call ? call.state : raw) ??
        {}) as Partial<MemoryCaptureState>;
      return {
        ...(typeof input.assistantScenario === 'string'
          ? { assistantScenario: input.assistantScenario.slice(0, ASSISTANT_CONTEXT_MAX) }
          : {}),
        messages: (Array.isArray(input.messages) ? input.messages : []).map((m) => ({
          id: String(m?.id ?? ''),
          key: String(m?.key ?? ''),
          text: String(m?.text ?? '').slice(0, MEMORY_CAPTURE_TEXT_MAX),
        })),
      };
    },
    policy: memoryCapturePolicy as DecisionSpec['policy'],
    fallback: MEMORY_CAPTURE_FALLBACK,
  });
}

/** Canonical registered instance (one-message template; hooks create per-call specs). */
export const memoryCaptureSpec: DecisionSpec = createMemoryCaptureSpec([
  { id: 'template', key: 'm1' },
]);

export interface JudgeMemoryCaptureResult {
  /** True when a judge call was made (shadow or active — ledger has a line). */
  asked: boolean;
  /**
   * `active` + judged only: message ids whose candidates proceed into the
   * memory write pipeline. `undefined` in every other case (shadow / fallback /
   * skipped) — the candidates are dropped, matching the pre-judge behavior.
   */
  captureIds?: string[];
}
