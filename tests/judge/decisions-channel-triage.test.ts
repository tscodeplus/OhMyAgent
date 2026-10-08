/**
 * Decision point `channel.triage` (kernel M4): spec policy + the extension
 * group-gate hook. The REAL engine path runs (deterministic mock judge from
 * ./mock.ts) so mode gating, gray cascade and ledger consistency hold end
 * to end. Contract: shadow/off = current gate behavior (defer), active only
 * overrides, every non-off consult ledgered.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  channelTriageSpec,
  judgeChannelGroupTriage,
  CHANNEL_TRIAGE_POINT_ID,
} from '../../src/judge/decisions/channel-triage.js';
import { DECISION_SPECS } from '../../src/judge/decisions/registry.js';
import { setJudgeEngineResolver } from '../../src/judge/engine-lookup.js';
import { makeEngine } from './decisions-helpers.js';

beforeEach(() => {
  setJudgeEngineResolver(() => undefined);
});
afterEach(() => {
  setJudgeEngineResolver(() => undefined);
});

const ADDRESSED = (p: number) =>
  ({
    'triage.addressed': { type: 'noul', probability: p },
    'triage.action': { type: 'choice', choice: 'respond', confidence: 0.9 },
  }) as const;

describe('channel.triage — registry + spec', () => {
  it('is registered in DECISION_SPECS', () => {
    expect(DECISION_SPECS['channel.triage']).toBe(channelTriageSpec);
    expect(DECISION_SPECS['channel.triage'].id).toBe(CHANNEL_TRIAGE_POINT_ID);
  });
});

describe('channel.triage — judgeChannelGroupTriage (engine-injected)', () => {
  it('active + addressed ≥ 0.85 → respond regardless of the choice', async () => {
    const { engine } = makeEngine('active', {
      judgeId: 'mock/jev',
      answers: {
        'triage.addressed': { type: 'noul', probability: 0.9 },
        'triage.action': { type: 'choice', choice: 'ignore', confidence: 0.9 },
      },
    });
    const decision = await judgeChannelGroupTriage({
      engine,
      sessionId: 'grp-1',
      text: 'hello bot',
      mentionedBot: false,
    });
    expect(decision).toBe('respond');
  });

  it('active + addressed ≤ 0.3 → choice verdict rules (respond/ignore/defer)', async () => {
    const base = {
      'triage.addressed': { type: 'noul', probability: 0.1 },
    } as const;
    const runWith = async (choice: 'respond' | 'ignore' | 'defer', mentioned: boolean) => {
      const { engine } = makeEngine('active', {
        judgeId: 'mock/jev',
        answers: { ...base, 'triage.action': { type: 'choice', choice, confidence: 0.9 } },
      });
      return await judgeChannelGroupTriage({
        engine,
        sessionId: 'grp-1',
        text: 'hello',
        mentionedBot: mentioned,
      });
    };
    await expect(runWith('respond', false)).resolves.toBe('respond');
    await expect(runWith('respond', true)).resolves.toBe('respond');
    await expect(runWith('ignore', true)).resolves.toBe('silent');
    await expect(runWith('defer', false)).resolves.toBe('defer');
  });

  it('active + gray addressed answer → cascade exhausted → defer', async () => {
    const { engine } = makeEngine('active', {
      judgeId: 'mock/jev',
      answers: {
        'triage.addressed': { type: 'noul', probability: 0.5 },
        'triage.action': { type: 'choice', choice: 'respond', confidence: 0.9 },
      },
    });
    const decision = await judgeChannelGroupTriage({
      engine,
      text: 'unclear',
      mentionedBot: false,
    });
    expect(decision).toBe('defer');
    const line = engine.ledger.recent(1)[0];
    expect(line?.fallbackReason).toBe('gray-zone');
  });

  it('shadow mode: judged + ledgered, but gate stays default (defer)', async () => {
    const { engine } = makeEngine('shadow', {
      judgeId: 'mock/jev',
      answers: ADDRESSED(0.9),
    });
    const decision = await judgeChannelGroupTriage({
      engine,
      sessionId: 's1',
      text: 'hello',
      mentionedBot: false,
    });
    expect(decision).toBe('defer');
    // Ledger consistency: the consult IS recorded, as a judged line whose
    // policy was NOT applied.
    const line = engine.ledger.recent(1)[0];
    expect(line?.pointId).toBe('channel.triage');
    expect(line?.mode).toBe('shadow');
    expect(line?.source).toBe('judge');
  });

  it('off mode: no engine call, no ledger line', async () => {
    const { engine, calls } = makeEngine('off', { judgeId: 'mock/jev' });
    const decision = await judgeChannelGroupTriage({
      engine,
      text: 'hello',
      mentionedBot: false,
    });
    expect(decision).toBe('defer');
    expect(calls).toHaveLength(0);
    expect(engine.ledger.recent()).toHaveLength(0);
  });

  it('engine absent → defer (no throw)', async () => {
    const decision = await judgeChannelGroupTriage({
      text: 'hello',
      mentionedBot: false,
    });
    expect(decision).toBe('defer');
  });

  it('both questions are asked in ONE classify call (shared state)', async () => {
    const { engine, calls } = makeEngine('active', {
      judgeId: 'mock/jev',
      answers: ADDRESSED(0.9),
    });
    await judgeChannelGroupTriage({ engine, text: 'x'.repeat(700), mentionedBot: false });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]?.context.questions ?? {}).sort()).toEqual([
      'triage.action',
      'triage.addressed',
    ]);
    // State minimized + text capped.
    const state = calls[0]?.context.state as { text?: string; chatType?: string };
    expect(state.text?.length).toBe(500);
    expect(state.chatType).toBe('group');
  });

  it('latency budget: a hanging judge cannot hold the gate beyond ~1s', async () => {
    const { engine } = makeEngine('active', {
      judgeId: 'mock/jev',
      hangUntilAbort: true,
    });
    const started = Date.now();
    const decision = await judgeChannelGroupTriage({ engine, text: 'hello', mentionedBot: false });
    const elapsed = Date.now() - started;
    expect(decision).toBe('defer');
    expect(elapsed).toBeLessThan(3000);
  }, 10_000);
});

describe('channel.triage — triageGroupGateway (module-level resolver)', async () => {
  const { triageGroupGateway } = await import('../../src/judge/hooks/channel-triage.js');

  it('applies judged silent via the live engine lookup', async () => {
    const { engine } = makeEngine('active', {
      judgeId: 'mock/jev',
      answers: {
        'triage.addressed': { type: 'noul', probability: 0.1 },
        'triage.action': { type: 'choice', choice: 'ignore', confidence: 0.9 },
      },
    });
    setJudgeEngineResolver(() => engine as never);
    const gate = await triageGroupGateway({ sessionId: 's1', text: 'x', mentionedBot: true });
    expect(gate).toBe('silent');
  });

  it('returns default when the resolver has no engine', async () => {
    const gate = await triageGroupGateway({ sessionId: 's1', text: 'x', mentionedBot: true });
    expect(gate).toBe('default');
  });
});
