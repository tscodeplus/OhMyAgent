/**
 * Turn Counter for Agent Team auto-trigger (P3 improved).
 *
 * Tracks serial tool calls and turns-without-spawn per session.
 * Used by prepareNextTurn to inject reflection prompts when the
 * LLM fails to parallelize work that could benefit from it.
 *
 * Conditions (checked in order, debounce 120s):
 *   0. Single-turn burst:  thisTurnToolCalls >= 6  → strong reflection
 *   1. Accumulated serial: serialToolCalls >= 8 && turnsSinceLastSpawn >= 1 → strong
 *   2. Many turns idle:    turnsSinceLastSpawn >= 5  → gentle reminder
 */

export interface TurnCounterState {
  /** Total serial tool calls since last spawn or reset */
  serialToolCalls: number;
  /** Number of consecutive turns without any spawn_agent call */
  turnsSinceLastSpawn: number;
  /** Timestamp of last reflection injection (debounce) */
  lastReflectionAt: number;
}

const store = new Map<string, TurnCounterState>();
const REFLECTION_DEBOUNCE_MS = 120_000; // 2 minutes between injections

function getOrCreate(sessionId: string): TurnCounterState {
  let state = store.get(sessionId);
  if (!state) {
    state = { serialToolCalls: 0, turnsSinceLastSpawn: 0, lastReflectionAt: 0 };
    store.set(sessionId, state);
  }
  return state;
}

function strongReflection(serialCalls: number, turns: number): string {
  return [
    '<system-reminder>',
    `You have executed ${serialCalls} serial tool calls over ${turns} turn(s) without spawning — this wastes significant tokens and time.`,
    'The current task can clearly be parallelized. Act now:',
    '1. Output a <plan> tag to decompose parallel subtasks',
    '2. Call spawn_agent to dispatch them in parallel',
    '3. Stop serial execution — switch to team mode now',
    '</system-reminder>',
  ].join('\n');
}

function burstReflection(thisTurnCalls: number): string {
  return [
    '<system-reminder>',
    `This turn you executed ${thisTurnCalls} serial tool calls — these could all be parallelized via spawn_agent.`,
    'Do not read many files serially in a single turn — each sub-agent can independently complete its own portion.',
    'Immediately output a <plan> to decompose the task, then use spawn_agent to dispatch in parallel.',
    '</system-reminder>',
  ].join('\n');
}

function gentleReminder(turns: number): string {
  return [
    '<system-reminder>',
    `${turns} turns since last spawn. Evaluate whether independent parallel subtasks exist.`,
    'If yes, output a <plan> and dispatch with spawn_agent. If not needed, ignore this reminder.',
    '</system-reminder>',
  ].join('\n');
}

/**
 * Reflection for "plan-only" anti-pattern: the model output a <plan>
 * block as free text but called zero tools — it described what to do
 * but didn't actually do anything.
 */
export function planOnlyReflection(): string {
  return [
    '<system-reminder>',
    'You just output a <plan> block but called zero tools to execute it.',
    'Describing a plan does not equal completing the task — you need to actually execute. Immediately:',
    '1. If the plan has parallel independent subtasks, call spawn_agent to dispatch them',
    '2. If the task is strictly serial, execute each step yourself using tools',
    '3. Do NOT output another <plan> block — take action now',
    'Do not wait, start executing the first subtask now.',
    '</system-reminder>',
  ].join('\n');
}

export const turnCounter = {
  get(sessionId: string): TurnCounterState {
    return getOrCreate(sessionId);
  },

  /**
   * Called after each turn. Increments counters based on turn results.
   * Resets serial counters when a spawn occurred this turn.
   */
  recordTurn(
    sessionId: string,
    result: {
      toolCallCount: number;
      didSpawn: boolean;
    },
  ): void {
    const state = getOrCreate(sessionId);
    state.serialToolCalls += result.toolCallCount;
    state.turnsSinceLastSpawn += 1;
    if (result.didSpawn) {
      state.serialToolCalls = 0;
      state.turnsSinceLastSpawn = 0;
    }
  },

  /** Delete session counters when session ends. */
  delete(sessionId: string): void {
    store.delete(sessionId);
  },

  /**
   * Evaluate whether a reflection prompt should be injected.
   * @param sessionId session identifier
   * @param thisTurnToolCalls number of tool calls in the just-completed turn
   * @returns reflection string if conditions are met, null otherwise
   */
  evaluate(sessionId: string, thisTurnToolCalls: number): string | null {
    const state = getOrCreate(sessionId);
    const now = Date.now();

    // Debounce: don't inject too frequently
    if (now - state.lastReflectionAt < REFLECTION_DEBOUNCE_MS) {
      return null;
    }

    // Condition 0: Single-turn burst (6+ tool calls in one turn)
    // Catches "56 file_read in 1 turn" scenarios — no need to wait for accumulation
    if (thisTurnToolCalls >= 6) {
      state.lastReflectionAt = now;
      state.serialToolCalls = 0; // Reset to avoid immediate Condition 1
      return burstReflection(thisTurnToolCalls);
    }

    // Condition 1: Accumulated serial tool calls + at least 1 turn without spawn
    // Fires after the first non-spawn turn where serial work piles up
    if (state.serialToolCalls >= 8 && state.turnsSinceLastSpawn >= 1) {
      const capturedTools = state.serialToolCalls;
      const capturedTurns = state.turnsSinceLastSpawn;
      state.lastReflectionAt = now;
      state.serialToolCalls = 0; // Reset to avoid spam
      return strongReflection(capturedTools, capturedTurns);
    }

    // Condition 2: Many turns without spawn (gentle fallback)
    if (state.turnsSinceLastSpawn >= 5) {
      const capturedTurns = state.turnsSinceLastSpawn;
      state.lastReflectionAt = now;
      state.turnsSinceLastSpawn = 0; // Reset
      return gentleReminder(capturedTurns);
    }

    return null;
  },
};
