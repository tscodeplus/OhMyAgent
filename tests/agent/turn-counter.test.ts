import { describe, it, expect, beforeEach } from 'vitest';
import { turnCounter, planOnlyReflection } from '../../src/agent/turn-counter.js';

const SESSION = 'test-session';

describe('P3: TurnCounter — recordTurn', () => {
  beforeEach(() => {
    turnCounter.delete(SESSION);
  });

  it('initializes counters for a new session', () => {
    const state = turnCounter.get(SESSION);
    expect(state.serialToolCalls).toBe(0);
    expect(state.turnsSinceLastSpawn).toBe(0);
  });

  it('increments both counters on non-spawn turn', () => {
    turnCounter.recordTurn(SESSION, { toolCallCount: 3, didSpawn: false });
    const state = turnCounter.get(SESSION);
    expect(state.serialToolCalls).toBe(3);
    expect(state.turnsSinceLastSpawn).toBe(1);
  });

  it('resets counters on spawn turn', () => {
    turnCounter.recordTurn(SESSION, { toolCallCount: 5, didSpawn: false });
    turnCounter.recordTurn(SESSION, { toolCallCount: 2, didSpawn: true });
    const state = turnCounter.get(SESSION);
    expect(state.serialToolCalls).toBe(0);
    expect(state.turnsSinceLastSpawn).toBe(0);
  });
});

// ============================================================================
// Condition 0: Single-turn burst (6+ tool calls in one turn)
// ============================================================================

describe('P3: TurnCounter — Condition 0 (single-turn burst)', () => {
  beforeEach(() => {
    turnCounter.delete(SESSION);
  });

  it('triggers immediately when turn has 6+ tool calls', () => {
    const result = turnCounter.evaluate(SESSION, 6);
    expect(result).not.toBeNull();
    expect(result).toContain('6 次串行工具调用');
    expect(result).toContain('spawn_agent');
  });

  it('triggers for 10 calls in one turn', () => {
    const result = turnCounter.evaluate(SESSION, 10);
    expect(result).not.toBeNull();
    expect(result).toContain('10 次串行');
  });

  it('does NOT trigger when turn has < 6 calls', () => {
    const result = turnCounter.evaluate(SESSION, 5);
    expect(result).toBeNull();
  });

  it('does NOT trigger when turn has 0 calls', () => {
    const result = turnCounter.evaluate(SESSION, 0);
    expect(result).toBeNull();
  });

  it('resets serialToolCalls after firing to prevent Condition 1 double-fire', () => {
    turnCounter.recordTurn(SESSION, { toolCallCount: 7, didSpawn: false });
    turnCounter.evaluate(SESSION, 7); // triggers Condition 0, resets serialToolCalls
    const state = turnCounter.get(SESSION);
    expect(state.serialToolCalls).toBe(0);
  });
});

// ============================================================================
// Condition 1: Accumulated serial (>=8 total, >=1 turn without spawn)
// ============================================================================

describe('P3: TurnCounter — Condition 1 (accumulated serial)', () => {
  beforeEach(() => {
    turnCounter.delete(SESSION);
  });

  it('triggers after turn 1 with 8+ accumulated tool calls', () => {
    turnCounter.recordTurn(SESSION, { toolCallCount: 4, didSpawn: false });
    // After 1 turn: serialToolCalls=4, turnsSinceLastSpawn=1
    // Now turn 2 has 4 more calls
    turnCounter.recordTurn(SESSION, { toolCallCount: 4, didSpawn: false });
    // After 2 turns: serialToolCalls=8, turnsSinceLastSpawn=2
    const result = turnCounter.evaluate(SESSION, 4);
    expect(result).not.toBeNull();
    expect(result).toContain('8 个串行');
    expect(result).toContain('2 轮未 spawn');
    expect(result).toContain('<plan>');
  });

  it('triggers when serial calls accumulate over multiple turns (each < 6)', () => {
    // Turn 1: 5 calls, then evaluate → no trigger (5 < 8)
    turnCounter.recordTurn(SESSION, { toolCallCount: 5, didSpawn: false });
    expect(turnCounter.evaluate(SESSION, 5)).toBeNull();
    // Turn 2: 5 more calls → serialToolCalls=10, turnsSinceLastSpawn=2
    turnCounter.recordTurn(SESSION, { toolCallCount: 5, didSpawn: false });
    const result = turnCounter.evaluate(SESSION, 5);
    expect(result).not.toBeNull();
    expect(result).toContain('10 个串行');
    expect(result).toContain('2 轮未 spawn');
  });

  it('does NOT accumulate after spawn resets', () => {
    turnCounter.recordTurn(SESSION, { toolCallCount: 5, didSpawn: false });
    turnCounter.recordTurn(SESSION, { toolCallCount: 1, didSpawn: true });
    turnCounter.recordTurn(SESSION, { toolCallCount: 5, didSpawn: false });
    // serialToolCalls=5 (accumulated since last spawn), turnsSinceLastSpawn=1
    const result = turnCounter.evaluate(SESSION, 1);
    expect(result).toBeNull(); // 6 < 8
  });

  it('resets serialToolCalls after firing', () => {
    turnCounter.recordTurn(SESSION, { toolCallCount: 5, didSpawn: false });
    turnCounter.recordTurn(SESSION, { toolCallCount: 5, didSpawn: false });
    turnCounter.evaluate(SESSION, 2); // triggers
    const state = turnCounter.get(SESSION);
    expect(state.serialToolCalls).toBe(0);
  });
});

// ============================================================================
// Condition 2: Many turns idle (>=5 turns without spawn)
// ============================================================================

describe('P3: TurnCounter — Condition 2 (gentle reminder)', () => {
  beforeEach(() => {
    turnCounter.delete(SESSION);
  });

  it('triggers after 5 turns without spawn', () => {
    for (let i = 0; i < 5; i++) {
      turnCounter.recordTurn(SESSION, { toolCallCount: 0, didSpawn: false });
    }
    const result = turnCounter.evaluate(SESSION, 0);
    expect(result).not.toBeNull();
    expect(result).toContain('5 轮未使用 spawn');
  });

  it('does NOT trigger at 4 turns', () => {
    for (let i = 0; i < 4; i++) {
      turnCounter.recordTurn(SESSION, { toolCallCount: 0, didSpawn: false });
    }
    const result = turnCounter.evaluate(SESSION, 0);
    expect(result).toBeNull();
  });
});

// ============================================================================
// Condition ordering: Condition 0 fires before Condition 1
// ============================================================================

describe('P3: TurnCounter — condition ordering', () => {
  beforeEach(() => {
    turnCounter.delete(SESSION);
  });

  it('Condition 0 fires instead of Condition 1 when both could trigger', () => {
    // 3 turns, each with 4 calls → serialToolCalls=12, turnsSinceLastSpawn=3
    // Condition 0 checks thisTurnToolCalls=4 < 6 → skip
    // Condition 1 checks serialToolCalls=12 >= 8 && turnsSinceLastSpawn=3 >= 1 → fire
    turnCounter.recordTurn(SESSION, { toolCallCount: 4, didSpawn: false });
    turnCounter.recordTurn(SESSION, { toolCallCount: 4, didSpawn: false });
    turnCounter.recordTurn(SESSION, { toolCallCount: 4, didSpawn: false });
    const result = turnCounter.evaluate(SESSION, 4);
    expect(result).toContain('12 个串行'); // Condition 1
  });

  it('Condition 0 fires when turn has 6+, even with low accumulated serial', () => {
    // First turn: 7 calls → Condition 0 should fire immediately
    const result = turnCounter.evaluate(SESSION, 7);
    expect(result).toContain('7 次串行工具调用');
    expect(result).toContain('立即输出 <plan>');
  });
});

// ============================================================================
// Debounce
// ============================================================================

describe('P3: TurnCounter — debounce', () => {
  beforeEach(() => {
    turnCounter.delete(SESSION);
  });

  it('prevents duplicate injections within 120s', () => {
    turnCounter.evaluate(SESSION, 7); // Condition 0 fires
    const second = turnCounter.evaluate(SESSION, 7); // Immediately after
    expect(second).toBeNull(); // debounced
  });

  it('allows re-injection after debounce period', () => {
    turnCounter.evaluate(SESSION, 7); // fires, sets lastReflectionAt
    const state = turnCounter.get(SESSION);
    state.lastReflectionAt = 0; // simulate elapsed time

    // Build up again
    const second = turnCounter.evaluate(SESSION, 7);
    expect(second).not.toBeNull(); // should fire again
  });
});

// ============================================================================
// Cleanup
// ============================================================================

describe('P3: TurnCounter — delete', () => {
  it('cleans up session state', () => {
    turnCounter.recordTurn(SESSION, { toolCallCount: 5, didSpawn: false });
    turnCounter.delete(SESSION);
    expect(turnCounter.get(SESSION).serialToolCalls).toBe(0);
  });
});

// ============================================================================
// Plan-only reflection (model output <plan> but called 0 tools)
// ============================================================================

describe('P3: planOnlyReflection', () => {
  it('returns a reflection telling the model to execute instead of just describing', () => {
    const reflection = planOnlyReflection();
    expect(reflection).toContain('<system-reminder>');
    expect(reflection).toContain('<plan>');
    expect(reflection).toContain('执行');
    expect(reflection).toContain('spawn_agent');
    expect(reflection).toContain('直接行动');
  });
});
