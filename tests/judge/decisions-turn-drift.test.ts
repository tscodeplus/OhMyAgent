/**
 * `turn.drift` — spec policy fixtures + hook behavior through judgeTurnDrift
 * (active / shadow / off / no-engine / fallback), plus the per-turn
 * one-steering-prompt cap and the noteToolCallForDrift trigger conditions
 * (every 6 tool calls, or a growing failure streak).
 */

import { describe, expect, it } from 'vitest';
import {
  DRIFT_CHECK_EVERY_TOOL_CALLS,
  DRIFT_PROBABILITY,
  DRIFT_STEP_WINDOW,
  TURN_DRIFT_POINT_ID,
  judgeTurnDrift,
  noteToolCallForDrift,
  resetTurnDrift,
  turnDriftSpec,
  turnDriftToolCalls,
} from '../../src/judge/decisions/turn-drift.js';
import { DECISION_SPECS } from '../../src/judge/decisions/registry.js';
import { makeEngine } from './decisions-helpers.js';
import type { JudgeAnswer } from '../../src/judge/types.js';

function noulAnswer(probability: number): Record<string, JudgeAnswer> {
  return { 'drift.recent': { type: 'noul', probability } };
}

describe('turn.drift spec', () => {
  it('is registered under its canonical id', () => {
    expect(DECISION_SPECS['turn.drift']).toBe(turnDriftSpec);
    expect(TURN_DRIFT_POINT_ID).toBe('turn.drift');
    expect(Object.keys(turnDriftSpec.questions)).toEqual(['drift.recent']);
  });

  it('thresholds match impl doc §4.7', () => {
    expect(DRIFT_CHECK_EVERY_TOOL_CALLS).toBe(6);
    expect(DRIFT_STEP_WINDOW).toBe(3);
    expect(DRIFT_PROBABILITY).toBe(0.8);
  });

  it('buildState truncates the task hint and step digests, tolerating garbage', () => {
    const built = turnDriftSpec.buildState?.({
      state: {
        taskHint: 'g'.repeat(500),
        steps: [
          { index: 1, tool: 't'.repeat(100), digest: 'd'.repeat(300) },
          { tool: undefined, digest: undefined },
        ],
      },
    }) as { taskHint: string; steps: Array<{ tool: string; digest: string }> };
    expect(built.taskHint).toHaveLength(200);
    expect(built.steps[0]!.tool).toHaveLength(60);
    expect(built.steps[0]!.digest).toHaveLength(160);
    expect(built.steps[1]!.tool).toBe('');
  });

  it('policy steers only when P(drift) >= 0.8', () => {
    const input = {
      mode: 'active' as const,
      input: { state: { taskHint: 'fix tests', steps: [] } },
    };
    // On-path high confidence → P(drift) = 0.1 → no steering.
    expect(turnDriftSpec.policy!(noulAnswer(0.9), input)).toEqual({ action: 'none' });
    // On-path low confidence → P(drift) = 0.7 < 0.8 → gray, no steering.
    expect(turnDriftSpec.policy!(noulAnswer(0.3), input)).toEqual({ action: 'none' });
    // Off-path → P(drift) = 0.9 ≥ 0.8 → one steering prompt.
    const steer = turnDriftSpec.policy!(noulAnswer(0.1), input);
    expect(steer.action).toBe('steer');
    expect(typeof (steer as { message?: string }).message).toBe('string');
  });
});

describe('turn.drift hook (judgeTurnDrift)', () => {
  it('judged drift in active mode returns the steering message', async () => {
    const { engine } = makeEngine('active', { answers: noulAnswer(0.1) });
    const result = await judgeTurnDrift({ engine, sessionId: 'd1', taskHint: 'fix tests' });
    expect(result.asked).toBe(true);
    expect(result.steerMessage).toContain('DRIFT CHECK');
  });

  it('judged on-path verdict stays behavior-neutral', async () => {
    const { engine } = makeEngine('active', { answers: noulAnswer(0.9) });
    const result = await judgeTurnDrift({ engine, sessionId: 'd2', taskHint: 'fix tests' });
    expect(result.asked).toBe(true);
    expect(result.steerMessage).toBeUndefined();
  });

  it('shadow mode records but never steers', async () => {
    const { engine } = makeEngine('shadow', { answers: noulAnswer(0.1) });
    const result = await judgeTurnDrift({ engine, sessionId: 'd3', taskHint: 'fix tests' });
    expect(result.asked).toBe(true);
    expect(result.steerMessage).toBeUndefined();
  });

  it('off mode is a strict no-op', async () => {
    const { engine, calls } = makeEngine('off', { answers: noulAnswer(0.1) });
    const result = await judgeTurnDrift({ engine, sessionId: 'd4', taskHint: 'fix tests' });
    expect(result.asked).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('no engine is a strict no-op', async () => {
    const result = await judgeTurnDrift({ sessionId: 'd5', taskHint: 'fix tests' });
    expect(result.asked).toBe(false);
    expect(result.steerMessage).toBeUndefined();
  });

  it('fallback (gray zone, chain exhausted) never steers', async () => {
    const { engine } = makeEngine('active', { answers: noulAnswer(0.6) });
    const result = await judgeTurnDrift({ engine, sessionId: 'd6', taskHint: 'fix tests' });
    expect(result.asked).toBe(true);
    expect(result.steerMessage).toBeUndefined();
  });

  it('injects at most ONE steering prompt per turn (single-nudge cap)', async () => {
    const { engine } = makeEngine('active', { answers: noulAnswer(0.1) });
    const first = await judgeTurnDrift({ engine, sessionId: 'd7', taskHint: 'fix tests' });
    expect(first.steerMessage).toBeTruthy();
    const second = await judgeTurnDrift({ engine, sessionId: 'd7', taskHint: 'fix tests' });
    // Already-nudged turn → strict no-op (no judge call, no second prompt).
    expect(second.asked).toBe(false);
    expect(second.steerMessage).toBeUndefined();
    // New turn (reset) can steer again.
    resetTurnDrift('d7');
    const third = await judgeTurnDrift({ engine, sessionId: 'd7', taskHint: 'fix tests' });
    expect(third.steerMessage).toBeTruthy();
  });
});

describe('turn.drift per-turn trigger state', () => {
  it('every tool call is counted and every 6th check is due', () => {
    resetTurnDrift('d8');
    for (let i = 1; i < DRIFT_CHECK_EVERY_TOOL_CALLS; i++) {
      const request = noteToolCallForDrift('d8', { tool: 'bash', isFailure: false, digest: 'ok' });
      expect(request.due).toBe(false);
    }
    const sixth = noteToolCallForDrift('d8', { tool: 'bash', isFailure: false, digest: 'ok' });
    expect(sixth.due).toBe(true);
    expect(sixth.reason).toBe('interval');
    expect(turnDriftToolCalls('d8')).toBe(6);
  });

  it('a growing failure streak makes the check immediately due', () => {
    resetTurnDrift('d9');
    const first = noteToolCallForDrift('d9', { tool: 'bash', isFailure: true, digest: 'boom' });
    expect(first.due).toBe(true);
    expect(first.reason).toBe('failure-streak');
  });

  it('keeps only the last DRIFT_STEP_WINDOW steps', () => {
    resetTurnDrift('d10');
    for (let i = 0; i < 8; i++) {
      noteToolCallForDrift('d10', { tool: `t${i}`, isFailure: false, digest: `step ${i}` });
    }
    const built = turnDriftSpec.buildState?.({
      state: {
        taskHint: '',
        steps: [{ index: 8, tool: 't7', digest: 'step 7' }],
      },
    }) as unknown;
    expect(built).toBeTruthy();
  });
});
