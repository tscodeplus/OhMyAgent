/**
 * Decision point `turn.drift` (kernel M3, plan §6 point 10, impl doc §4.7).
 *
 * Periodically (every {@link DRIFT_CHECK_EVERY_TOOL_CALLS} tool calls, or when
 * the failure streak grows) asks whether the recent work still serves the
 * current turn goal; one noul per check. On P(drift) >=
 * {@link DRIFT_PROBABILITY} the hook injects ONE steering prompt per turn
 * (via the first-party `prepareNextTurnWithContext` hook in
 * `src/agent/agent-factory.ts` — no pi-mono changes).
 *
 * Per-session live state (tool-call counter, recent-step summaries, single-nudge
 * flag) lives in this module, reset at turn start by `resetTurnDrift` (called
 * from AgentService.execute()).
 */

import { defineDecision, noul, type DecisionOutcome, type DecisionSpec } from '../types.js';
import type { JudgeEngine } from '../engine.js';
import { currentJudgeEngine } from '../engine-lookup.js';

export const TURN_DRIFT_POINT_ID = 'turn.drift';

/** One recent step summary (a completed tool call). */
export interface DriftStep {
  index: number;
  tool: string;
  /** Short result/status digest line. */
  digest: string;
}

export interface TurnDriftState {
  /** First 200 chars of the current turn's user message (the goal). */
  taskHint: string;
  /** The last {@link DRIFT_STEP_WINDOW} steps, most recent last. */
  steps: DriftStep[];
}

/** Ask for a drift check every N tool calls (impl doc §4.7: 每 6 个 tool call). */
export const DRIFT_CHECK_EVERY_TOOL_CALLS = 6;
/** Recent-step window carried into the state (impl doc §4.7: 最近 3 步). */
export const DRIFT_STEP_WINDOW = 3;
/** P(drift) at or above which a steering prompt is injected (impl doc §4.7: ≥ 0.8). */
export const DRIFT_PROBABILITY = 0.8;
/** Task hint cap in the state (matches the tool.admission hook convention). */
const TASK_HINT_MAX = 200;

const DRIFT_QUESTION = noul('is the recent work still serving the original turn goal?', {
  true: 'the recent steps are still on the path toward the stated goal',
  false: 'the recent steps have drifted — repeating, wandering, or stuck far from the stated goal',
});

export const turnDriftSpec: DecisionSpec = defineDecision({
  id: TURN_DRIFT_POINT_ID,
  version: 1,
  questions: { 'drift.recent': DRIFT_QUESTION },
  buildState: (raw: unknown): TurnDriftState => {
    // engine.decide passes the whole DecisionInput — unwrap `state`.
    const call = raw as { state?: unknown } | undefined;
    const input = ((call && typeof call === 'object' && 'state' in call ? call.state : raw) ??
      {}) as Partial<TurnDriftState>;
    return {
      taskHint: typeof input.taskHint === 'string' ? input.taskHint.slice(0, TASK_HINT_MAX) : '',
      steps: (Array.isArray(input.steps) ? input.steps : []).map((s) => ({
        index: Number(s?.index ?? 0),
        tool: String(s?.tool ?? '').slice(0, 60),
        digest: String(s?.digest ?? '').slice(0, 160),
      })),
    };
  },
  policy: ((answers) => {
    const answer = answers['drift.recent'] as { type?: string; probability?: number } | undefined;
    if (answer?.type === 'noul' && typeof answer.probability === 'number') {
      // noul "true" = still on-path → P(drift) = 1 - probability.
      if (1 - answer.probability >= DRIFT_PROBABILITY) {
        return {
          action: 'steer',
          message:
            "(steering) DRIFT CHECK: recent work may no longer serve this turn's goal. " +
            'Pause and re-orient: is the current step still required to finish what the user asked? ' +
            'If not, drop back onto the goal path before continuing.',
        } as DecisionOutcome;
      }
    }
    return { action: 'none' } as DecisionOutcome;
  }) as DecisionSpec['policy'],
  // Fallback: no steering — the loop's existing failure-streak steering stays the only mechanism.
  fallback: { action: 'none' },
});

// ─── Per-session live state (turn lifecycle) ──────────────────────────────
// Bounded like the other module-level session maps (agent-context.ts).

interface DriftTurnState {
  toolCalls: number;
  failureStreak: number;
  recentSteps: DriftStep[];
  nudged: boolean;
}

const driftStateBySession = new Map<string, DriftTurnState>();
const MAX_DRIFT_SESSIONS = 500;

function stateFor(sessionId: string): DriftTurnState {
  if (driftStateBySession.size >= MAX_DRIFT_SESSIONS && !driftStateBySession.has(sessionId)) {
    const first = driftStateBySession.keys().next().value;
    if (first !== undefined) driftStateBySession.delete(first);
  }
  let state = driftStateBySession.get(sessionId);
  if (!state) {
    state = { toolCalls: 0, failureStreak: 0, recentSteps: [], nudged: false };
    driftStateBySession.set(sessionId, state);
  }
  return state;
}

/** Reset the per-turn drift counters (call at turn start). */
export function resetTurnDrift(sessionId: string): void {
  driftStateBySession.set(sessionId, {
    toolCalls: 0,
    failureStreak: 0,
    recentSteps: [],
    nudged: false,
  });
}

export function clearTurnDrift(sessionId: string): void {
  driftStateBySession.delete(sessionId);
}

export interface DriftCheckRequest {
  due: boolean;
  reason: 'interval' | 'failure-streak';
}

/**
 * Record one completed tool call. Returns whether a drift check is now due:
 * every {@link DRIFT_CHECK_EVERY_TOOL_CALLS} calls, or whenever the failure
 * streak grew (impl doc §4.7 trigger conditions).
 */
export function noteToolCallForDrift(
  sessionId: string,
  step: { tool: string; isFailure: boolean; digest: string },
): DriftCheckRequest {
  const state = stateFor(sessionId);
  state.toolCalls += 1;
  state.recentSteps = [
    ...state.recentSteps.slice(-(DRIFT_STEP_WINDOW - 1)),
    { index: state.toolCalls, tool: step.tool, digest: step.digest },
  ];
  let reason: DriftCheckRequest['reason'] = 'interval';
  let due = state.toolCalls % DRIFT_CHECK_EVERY_TOOL_CALLS === 0;
  if (step.isFailure) {
    state.failureStreak += 1;
    if (!due) {
      due = true;
      reason = 'failure-streak';
    }
  }
  return { due, reason };
}

/** Number of tool calls recorded since turn start (observability/tests). */
export function turnDriftToolCalls(sessionId: string): number {
  return stateFor(sessionId).toolCalls;
}

export interface JudgeTurnDriftResult {
  asked: boolean;
  /**
   * Active+judged only: the steering prompt to inject (engine applyOutcome).
   * `undefined` in every other case (shadow / fallback / on-track) — current
   * behavior. At most one injection per turn.
   */
  steerMessage?: string;
}

/**
 * Run the drift check (hook, called from `prepareNextTurnWithContext` in
 * `src/agent/agent-factory.ts`). STRICT no-op: engine absent, mode off, check
 * not due, or the turn already received its steering prompt → no call.
 */
export async function judgeTurnDrift(input: {
  engine?: JudgeEngine;
  sessionId: string;
  taskHint?: string;
}): Promise<JudgeTurnDriftResult> {
  const engine = input.engine ?? currentJudgeEngine();
  if (!engine) return { asked: false };
  if (engine.modeFor(TURN_DRIFT_POINT_ID) === 'off') return { asked: false };

  const state = stateFor(input.sessionId);
  if (state.nudged) return { asked: false };

  const verdict = await engine.decideMany(turnDriftSpec, {
    state: {
      taskHint: input.taskHint ?? '',
      steps: state.recentSteps,
    },
    sessionId: input.sessionId,
  });
  if (verdict.source !== 'judge' || verdict.mode !== 'active') return { asked: true };
  if (verdict.outcome.action !== 'steer') return { asked: true };
  state.nudged = true; // at most one steering prompt per turn
  return { asked: true, steerMessage: verdict.outcome.message };
}
