/**
 * `memory.capture` — spec buildState/policy fixtures + hook behavior with the
 * mock judge engine (impl doc §4.5): only P(capture) >= 0.7 messages produce
 * judged candidates; shadow/off/fallback never change behavior.
 */

import { describe, expect, it } from 'vitest';
import { makeEngine } from './decisions-helpers.js';
import {
  MEMORY_CAPTURE_POINT_ID,
  MEMORY_CAPTURE_THRESHOLD,
  createMemoryCaptureSpec,
  memoryCaptureKeys,
  memoryCaptureSpec,
  MEMORY_CAPTURE_TEXT_MAX,
  type MemoryCaptureState,
} from '../../src/judge/decisions/memory-capture.js';
import { DECISION_SPECS } from '../../src/judge/decisions/registry.js';
import { judgeExperiences } from '../../src/memory/judge-experience-gate.js';
import type { MemoryWriter } from '../../src/memory/memory-writer.js';

const MESSAGE_A = '以后所有回复请用中文，并且不要自动 commit';
const MESSAGE_B = '帮我看看这个报错';

function stateFor(texts: string[]): MemoryCaptureState {
  const keys = memoryCaptureKeys(texts.length);
  return {
    messages: texts.map((text, index) => ({ id: `u${index + 1}`, key: keys[index]!, text })),
  };
}

describe('memory.capture spec', () => {
  it('is registered with the canonical single-question template', () => {
    expect(DECISION_SPECS['memory.capture']).toBe(memoryCaptureSpec);
    expect(Object.keys(memoryCaptureSpec.questions)).toEqual(['m1']);
    expect(MEMORY_CAPTURE_POINT_ID).toBe('memory.capture');
  });

  it('buildState caps message text and normalizes fields', () => {
    const spec = createMemoryCaptureSpec(stateFor([MESSAGE_A]).messages);
    const built = spec.buildState?.({
      state: {
        assistantScenario: 'x'.repeat(1000),
        messages: [{ id: 'u1', key: 'm1', text: 'y'.repeat(MEMORY_CAPTURE_TEXT_MAX + 5) }],
      },
    }) as MemoryCaptureState;
    expect(built.messages[0]!.text).toHaveLength(MEMORY_CAPTURE_TEXT_MAX);
    expect(built.assistantScenario).toHaveLength(300);
  });

  it('policy keeps only messages at P >= threshold, fallback = none', () => {
    const spec = createMemoryCaptureSpec(stateFor([MESSAGE_A, MESSAGE_B]).messages);
    expect(MEMORY_CAPTURE_THRESHOLD).toBe(0.7);
    // Simulated judged answers: u1 clearly a rule (0.95), u2 clearly not (0.1).
    const answers = {
      m1: { type: 'noul', probability: 0.95 },
      m2: { type: 'noul', probability: 0.1 },
    };
    const outcome = spec.policy!(answers, {
      mode: 'active',
      input: { state: stateFor([MESSAGE_A, MESSAGE_B]) },
    });
    expect(outcome).toEqual({ action: 'keep', ids: ['u1'] });
    expect(spec.fallback).toEqual({ action: 'none' });
  });
});

describe('judgeExperiences hook (with mock judge)', () => {
  const fakeWriter = {
    write: async (input: { content: string }) => ({
      id: 'w1',
      action: 'created' as const,
      isDuplicate: false,
    }),
  } as unknown as MemoryWriter;

  it('active + judged keeps only capture-worthy messages and passes them through worth', async () => {
    const { engine, calls } = makeEngine('active', {
      answers: {
        m1: { type: 'noul', probability: 0.95 }, // capture-worthy
        m2: { type: 'noul', probability: 0.05 }, // not
        w1: { type: 'choice', choice: 'useful-again', confidence: 0.9 },
      },
    });
    const result = await judgeExperiences({
      engine,
      judgeGet: () => engine,
      sessionKey: 's1',
      messages: [
        { role: 'user', content: MESSAGE_A },
        { role: 'user', content: MESSAGE_B },
        { role: 'assistant', content: '好的，已记录' },
      ],
      writer: fakeWriter,
      channel: 'qq',
      logger: console,
    });
    expect(result.asked).toBe(true);
    expect(result.written).toBe(1);
    expect(calls.length).toBe(2); // capture + worth
    expect(calls[1]!.context.questions['w1']).toBeDefined();
  });

  it('shadow asks but writes nothing (byte-identical fallback)', async () => {
    const { engine, calls } = makeEngine('shadow', {
      answers: { m1: { type: 'noul', probability: 0.99 } },
    });
    const result = await judgeExperiences({
      engine,
      judgeGet: () => engine,
      sessionKey: 's1',
      messages: [{ role: 'user', content: MESSAGE_A }],
      writer: fakeWriter,
      channel: null,
      logger: console,
    });
    expect(result.asked).toBe(true);
    expect(result.written).toBe(0);
    expect(calls.length).toBe(1); // capture asked, worth never reached (gate off)
  });

  it('worth fallback after judged capture persists the judged messages', async () => {
    const { engine } = makeEngine('active', {
      answers: {
        m1: { type: 'noul', probability: 0.95 },
        // w1 missing → worth call falls back (parse-rejected) → keep-all semantics
      },
    });
    const result = await judgeExperiences({
      engine,
      judgeGet: () => engine,
      sessionKey: 's1',
      messages: [{ role: 'user', content: MESSAGE_A }],
      writer: fakeWriter,
      channel: null,
      logger: console,
    });
    expect(result.written).toBe(1);
  });
});
