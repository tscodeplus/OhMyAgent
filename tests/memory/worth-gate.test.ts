/**
 * `judgePreferenceCandidates` — the summarizer's bridge into `memory.worth`
 * (plan §3.3 point 2). The engine below is the real one, driven by the
 * deterministic mock tier, so mode gating and the fail-closed fallback are
 * exercised end-to-end instead of stubbed.
 */

import { describe, expect, it } from 'vitest';
import { makeEngine } from '../judge/decisions-helpers.js';
import { judgePreferenceCandidates } from '../../src/memory/write/worth-gate.js';

const USEFUL = '叫我 Boss';
const ONE_OFF = '这次输出控制在 20 词以内';

describe('judgePreferenceCandidates', () => {
  it('passes candidates through when no judge engine is configured', async () => {
    const kept = await judgePreferenceCandidates({
      candidates: [USEFUL, ONE_OFF],
      judgeGet: () => undefined,
    });
    expect(kept).toEqual([USEFUL, ONE_OFF]);
  });

  it('passes candidates through in shadow mode (behavior-neutral)', async () => {
    const { engine, calls } = makeEngine('shadow', {
      answers: { w1: { type: 'choice', choice: 'useful-again', confidence: 0.9 } },
    });

    const kept = await judgePreferenceCandidates({
      candidates: [USEFUL, ONE_OFF],
      judgeGet: () => engine,
    });

    expect(kept).toEqual([USEFUL, ONE_OFF]);
    expect(calls).toHaveLength(0);
  });

  it('keeps only useful-again candidates when the point is active', async () => {
    const { engine } = makeEngine('active', {
      answers: {
        w1: { type: 'choice', choice: 'useful-again', confidence: 0.9 },
        w2: { type: 'choice', choice: 'one-off', confidence: 0.9 },
      },
    });

    const kept = await judgePreferenceCandidates({
      candidates: [USEFUL, ONE_OFF],
      sessionScenario: 'User asked for a 20-word answer.',
      sessionId: 's1',
      judgeGet: () => engine,
    });

    expect(kept).toEqual([USEFUL]);
  });

  it('drops everything when the judge cannot answer (fail-closed fallback)', async () => {
    // Missing answers → parse-rejected → verdict falls back. The fallback IS
    // `{ action: 'none' }`, so an outage writes nothing rather than everything.
    const { engine } = makeEngine('active', {});

    const kept = await judgePreferenceCandidates({
      candidates: [USEFUL, ONE_OFF],
      sessionId: 's1',
      judgeGet: () => engine,
    });

    expect(kept).toEqual([]);
  });

  it('never throws into the write path', async () => {
    const kept = await judgePreferenceCandidates({
      candidates: [USEFUL],
      judgeGet: () => {
        throw new Error('engine unavailable');
      },
    });
    expect(kept).toEqual([USEFUL]);
  });
});
