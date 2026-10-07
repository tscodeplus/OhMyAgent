/**
 * intent.classify decision point (phase-1 M1): regex floor + judged choice
 * reconciliation matrix through judgeIntentAtTurnStart (active / shadow / off /
 * no-engine / fallback), plus the shadow zero-behavior invariant.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INTENT_CLASSIFY_POINT_ID,
  intentClassifySpec,
  judgeIntentAtTurnStart,
} from '../../src/judge/decisions/intent-classify.js';
import { JudgeEngine } from '../../src/judge/index.js';
import { JudgeLedger } from '../../src/judge/ledger.js';
import { createMockResolver, createMockTier, mockJudgeConfig, type MockTierSpec } from './mock.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'judge-intent-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Regex floor for this message is 'code' (fix … bug within 8 chars)
const CODE_MESSAGE = 'please fix the bug in the failing build test now';
// Regex floor 'web'
const WEB_MESSAGE = 'search the web for AI news today';

function makeEngine(
  mode: 'active' | 'shadow' | 'off',
  overrides: Partial<MockTierSpec> = {},
): { engine: JudgeEngine; calls: NonNullable<MockTierSpec['calls']> } {
  const calls: NonNullable<MockTierSpec['calls']> = [];
  const tier = createMockTier({ judgeId: 'mock/j1', calls, ...overrides });
  const engine = new JudgeEngine({
    config: mockJudgeConfig(mode === 'active' ? {} : { modes: { default: mode } }),
    resolver: () => ({ tiers: [tier], noKeyRefs: [], unresolvableRefs: [] }),
    ledger: new JudgeLedger({ dir: tmpDir }),
  });
  return { engine, calls };
}

describe('intent.classify reconciliation matrix', () => {
  it('agree (judge === regex): route(regex) — hook override is the regex domain', async () => {
    const { engine } = makeEngine('active', {
      answers: {
        'message.domain': { type: 'choice', choice: 'code', confidence: 0.9 },
        'message.thinkingNeed': { type: 'score', score: 1, confidence: 0.9 },
      },
    });
    const result = await judgeIntentAtTurnStart({ engine, message: CODE_MESSAGE, sessionId: 's1' });
    expect(result.asked).toBe(true);
    expect(result.override).toBe('code'); // narrow with 'code' — same as the regex floor
  });

  it('disagree + high confidence: judge wins over the regex', async () => {
    const { engine } = makeEngine('active', {
      answers: {
        'message.domain': { type: 'choice', choice: 'memory', confidence: 0.9 },
        'message.thinkingNeed': { type: 'score', score: 1, confidence: 0.9 },
      },
    });
    const result = await judgeIntentAtTurnStart({ engine, message: CODE_MESSAGE, sessionId: 's1' });
    expect(result.override).toBe('memory');
  });

  it('disagree + low confidence: regex floor wins', async () => {
    const { engine } = makeEngine('active', {
      answers: {
        'message.domain': { type: 'choice', choice: 'memory', confidence: 0.6 },
        'message.thinkingNeed': { type: 'score', score: 1, confidence: 0.9 },
      },
    });
    const result = await judgeIntentAtTurnStart({ engine, message: CODE_MESSAGE, sessionId: 's1' });
    expect(result.override).toBe('code'); // regex floor kept (low conf < 0.7)
  });

  it('escape hatch: confident `other` disables narrowing (override none)', async () => {
    const { engine } = makeEngine('active', {
      answers: {
        'message.domain': { type: 'choice', choice: 'other', confidence: 0.9 },
        'message.thinkingNeed': { type: 'score', score: 1, confidence: 0.9 },
      },
    });
    const result = await judgeIntentAtTurnStart({ engine, message: WEB_MESSAGE, sessionId: 's1' });
    expect(result.override).toBe('none');
  });

  it('web regex floor also reconciles (agree path on a second domain)', async () => {
    const { engine } = makeEngine('active', {
      answers: {
        'message.domain': { type: 'choice', choice: 'web', confidence: 0.8 },
        'message.thinkingNeed': { type: 'score', score: 2, confidence: 0.9 },
      },
    });
    const result = await judgeIntentAtTurnStart({ engine, message: WEB_MESSAGE, sessionId: 's1' });
    expect(result.override).toBe('web');
  });
});

describe('intent.classify mode matrix + invariants', () => {
  const JUDGED_ANSWERS: MockTierSpec['answers'] = {
    'message.domain': { type: 'choice', choice: 'web', confidence: 0.9 },
    'message.thinkingNeed': { type: 'score', score: 1, confidence: 0.9 },
  };

  it('shadow: asks + ledger line, but ZERO behavior change (override undefined)', async () => {
    const { engine, calls } = makeEngine('shadow', { answers: JUDGED_ANSWERS });
    const result = await judgeIntentAtTurnStart({ engine, message: CODE_MESSAGE, sessionId: 's1' });
    expect(result.asked).toBe(true);
    expect(result.override).toBeUndefined();
    expect(calls).toHaveLength(1);
    const ledgerLines = engine.ledger.recent(5);
    expect(ledgerLines.length).toBe(1);
    expect(ledgerLines[0]!.pointId).toBe('intent.classify');
  });

  it('off: never asked, no mock calls, no ledger line', async () => {
    const { engine, calls } = makeEngine('off', { answers: JUDGED_ANSWERS });
    const result = await judgeIntentAtTurnStart({ engine, message: CODE_MESSAGE, sessionId: 's1' });
    expect(result).toEqual({ asked: false });
    expect(calls).toHaveLength(0);
    expect(engine.ledger.recent(1).length).toBe(0);
  });

  it('no engine (judge undefined): pure current behavior, asked false', async () => {
    const result = await judgeIntentAtTurnStart({ message: CODE_MESSAGE, sessionId: 's1' });
    expect(result).toEqual({ asked: false });
  });

  it('judged service failure falls back to the regex floor (override undefined, ledger has reason)', async () => {
    const { engine } = makeEngine('active', {
      failWith: { stopReason: 'error', errorMessage: 'server exploded' },
    });
    const result = await judgeIntentAtTurnStart({ engine, message: CODE_MESSAGE, sessionId: 's1' });
    expect(result.asked).toBe(true);
    expect(result.override).toBeUndefined();
    const lines = engine.ledger.recent(1);
    expect(lines[0]!.source).toBe('fallback');
    expect(lines[0]!.fallbackReason).toBe('unavailable');
  });

  it('the registered spec asks both questions in ONE call (shared state)', async () => {
    const { engine, calls } = makeEngine('active', { answers: JUDGED_ANSWERS });
    await judgeIntentAtTurnStart({ engine, message: CODE_MESSAGE, sessionId: 's1' });
    expect(calls).toHaveLength(1);
    const questions = calls[0]!.context.questions;
    expect(Object.keys(questions).sort()).toEqual(['message.domain', 'message.thinkingNeed']);
    const state = calls[0]!.context.state as { message: string; regexDomain: string };
    expect(state.regexDomain).toBe('code');
    expect(state.message).toBe(CODE_MESSAGE);
  });

  it('state message is truncated to the impl-doc cap (500 chars)', async () => {
    const { engine, calls } = makeEngine('active', { answers: JUDGED_ANSWERS });
    const long = 'lorem ipsum '.repeat(100); // > 500 chars, still asked (judge path)
    await judgeIntentAtTurnStart({ engine, message: long, sessionId: 's1' });
    const state = calls[0]!.context.state as { message: string };
    expect(state.message.length).toBe(500);
  });

  it('decision id follows the (id, version) ledger contract', () => {
    expect(intentClassifySpec.id).toBe(INTENT_CLASSIFY_POINT_ID);
    expect(intentClassifySpec.version).toBe(1);
    expect(intentClassifySpec.questions['message.domain']!.type).toBe('choice');
    expect(intentClassifySpec.questions['message.thinkingNeed']!.type).toBe('score');
  });

  it('resolver without tiers still falls back safely', async () => {
    const calls: NonNullable<MockTierSpec['calls']> = [];
    const engine = new JudgeEngine({
      config: mockJudgeConfig({}),
      resolver: createMockResolver(),
      ledger: new JudgeLedger({ dir: tmpDir }),
    });
    void calls;
    const result = await judgeIntentAtTurnStart({ engine, message: CODE_MESSAGE, sessionId: 's1' });
    expect(result.asked).toBe(true);
    expect(result.override).toBeUndefined();
  });
});
