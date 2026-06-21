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
    `你已经连续执行了 ${serialCalls} 个串行工具调用（${turns} 轮未 spawn），这在浪费大量 token 和时间。`,
    '当前任务明显可以并行。立即执行：',
    '1. 输出 <plan> 标签拆分可并行的子任务',
    '2. 调用 spawn_agent 并行分派',
    '3. 不要继续串行——停止当前方式，改用 team 模式',
    '</system-reminder>',
  ].join('\n');
}

function burstReflection(thisTurnCalls: number): string {
  return [
    '<system-reminder>',
    `本轮你执行了 ${thisTurnCalls} 次串行工具调用——这完全可以通过 spawn_agent 并行处理。`,
    '不要在单轮中串行读取大量文件——每个子 Agent 可以独立完成自己的那部分。',
    '立即输出 <plan> 分解任务，然后用 spawn_agent 并行分派。',
    '</system-reminder>',
  ].join('\n');
}

function gentleReminder(turns: number): string {
  return [
    '<system-reminder>',
    `已 ${turns} 轮未使用 spawn。评估是否存在可并行的独立子任务。`,
    '如果有，输出 <plan> 并用 spawn_agent 分派；如果不需要，忽略此提醒。',
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
