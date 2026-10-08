/**
 * `turn.completion` — spec policy fixtures + hook behavior through
 * judgeTurnCompletion (active / shadow / off / no-engine / fallback) and the
 * rule floor: turns without tool calls are never judged.
 */

import { describe, expect, it } from 'vitest';
import {
  NO_VERIFICATION_PROBABILITY,
  TURN_COMPLETION_POINT_ID,
  judgeTurnCompletion,
  lastAssistantTextOf,
  turnCompletionSpec,
} from '../../src/judge/decisions/turn-completion.js';
import { DECISION_SPECS } from '../../src/judge/decisions/registry.js';
import { makeEngine } from './decisions-helpers.js';
import type { JudgeAnswer } from '../../src/judge/types.js';

function noulAnswer(probability: number): Record<string, JudgeAnswer> {
  return { 'completion.verified': { type: 'noul', probability } };
}

describe('turn.completion spec', () => {
  it('is registered under its canonical id', () => {
    expect(DECISION_SPECS['turn.completion']).toBe(turnCompletionSpec);
    expect(TURN_COMPLETION_POINT_ID).toBe('turn.completion');
    expect(Object.keys(turnCompletionSpec.questions)).toEqual(['completion.verified']);
  });

  it('threshold matches impl doc §4.7', () => {
    expect(NO_VERIFICATION_PROBABILITY).toBe(0.8);
  });

  it('buildState truncates the closing text and normalizes hadToolCalls', () => {
    const built = turnCompletionSpec.buildState?.({
      state: {
        lastAssistantText: 'a'.repeat(2000),
        hadToolCalls: 'not-a-boolean',
      },
    }) as { lastAssistantText: string; hadToolCalls: boolean };
    expect(built.lastAssistantText).toHaveLength(800);
    expect(built.hadToolCalls).toBe(false);
  });

  it('policy nudges only when P(no verification) >= 0.8', () => {
    const input = { mode: 'active' as const, input: { state: {} } };
    // Verification cited with confidence → P(no) = 0.1 → no nudge.
    expect(turnCompletionSpec.policy!(noulAnswer(0.9), input)).toEqual({ action: 'none' });
    // Weak claim of verification → P(no) = 0.7 < 0.8 → gray, no nudge.
    expect(turnCompletionSpec.policy!(noulAnswer(0.3), input)).toEqual({ action: 'none' });
    // No verification → P(no) = 0.9 ≥ 0.8 → one nudge.
    const nudge = turnCompletionSpec.policy!(noulAnswer(0.1), input);
    expect(nudge.action).toBe('steer');
    expect(typeof (nudge as { message?: string }).message).toBe('string');
  });
});

describe('turn.completion hook (judgeTurnCompletion)', () => {
  it('judged no-verification in active mode returns the nudge', async () => {
    const { engine } = makeEngine('active', { answers: noulAnswer(0.1) });
    const result = await judgeTurnCompletion({
      engine,
      sessionId: 'c1',
      lastAssistantText: 'All done!',
      hadToolCalls: true,
    });
    expect(result.asked).toBe(true);
    expect(result.nudgedMessage).toContain('completion check');
  });

  it('judged verified closing statement stays behavior-neutral', async () => {
    const { engine } = makeEngine('active', { answers: noulAnswer(0.9) });
    const result = await judgeTurnCompletion({
      engine,
      sessionId: 'c2',
      lastAssistantText: 'Tests pass: 42 green',
      hadToolCalls: true,
    });
    expect(result.asked).toBe(true);
    expect(result.nudgedMessage).toBeUndefined();
  });

  it('shadow mode records but never nudges', async () => {
    const { engine } = makeEngine('shadow', { answers: noulAnswer(0.1) });
    const result = await judgeTurnCompletion({
      engine,
      sessionId: 'c3',
      lastAssistantText: 'All done!',
      hadToolCalls: true,
    });
    expect(result.asked).toBe(true);
    expect(result.nudgedMessage).toBeUndefined();
  });

  it('off mode is a strict no-op', async () => {
    const { engine, calls } = makeEngine('off', { answers: noulAnswer(0.1) });
    const result = await judgeTurnCompletion({
      engine,
      sessionId: 'c4',
      lastAssistantText: 'All done!',
      hadToolCalls: true,
    });
    expect(result.asked).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('no engine is a strict no-op', async () => {
    const result = await judgeTurnCompletion({
      sessionId: 'c5',
      lastAssistantText: 'All done!',
      hadToolCalls: true,
    });
    expect(result.asked).toBe(false);
    expect(result.nudgedMessage).toBeUndefined();
  });

  it('rule floor: a turn with no tool calls is never judged', async () => {
    const { engine, calls } = makeEngine('active', { answers: noulAnswer(0.1) });
    const result = await judgeTurnCompletion({
      engine,
      sessionId: 'c6',
      lastAssistantText: 'Sure, that is a good idea.',
      hadToolCalls: false,
    });
    expect(result.asked).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('empty closing text is never judged', async () => {
    const { engine, calls } = makeEngine('active', { answers: noulAnswer(0.1) });
    const result = await judgeTurnCompletion({
      engine,
      sessionId: 'c7',
      lastAssistantText: '   ',
      hadToolCalls: true,
    });
    expect(result.asked).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('fallback (gray zone, chain exhausted) never nudges', async () => {
    const { engine } = makeEngine('active', { answers: noulAnswer(0.6) });
    const result = await judgeTurnCompletion({
      engine,
      sessionId: 'c8',
      lastAssistantText: 'All done!',
      hadToolCalls: true,
    });
    expect(result.asked).toBe(true);
    expect(result.nudgedMessage).toBeUndefined();
  });
});

describe('lastAssistantTextOf', () => {
  it('extracts text blocks from the last assistant message', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: '1' },
          { type: 'text', text: 'done' },
        ],
      },
    ];
    expect(lastAssistantTextOf(messages)).toBe('done');
  });

  it('string content is returned verbatim; non-assistant tails are skipped', () => {
    const messages = [
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'and then?' },
      { role: 'assistant', content: 'second reply' },
    ];
    expect(lastAssistantTextOf(messages)).toBe('second reply');
  });

  it('returns empty string when there is no assistant text', () => {
    expect(lastAssistantTextOf([{ role: 'user', content: 'hi' }])).toBe('');
    expect(lastAssistantTextOf([])).toBe('');
  });
});
