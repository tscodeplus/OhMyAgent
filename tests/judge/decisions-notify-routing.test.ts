/**
 * Decision point `notify.routing` (kernel M4): routing of proactive
 * notifications (cron results / task completions delivered through
 * CronDeliveryRegistry) judged as now/later/never. Contract: fallback =
 * current routing ('now'); shadow/off never changes routing; every non-off
 * consult ledgered.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  judgeNotifyRoute,
  notifyRoutingSpec,
  NOTIFY_ROUTING_POINT_ID,
} from '../../src/judge/decisions/notify-routing.js';
import { judgeProactiveNotifyRoute } from '../../src/judge/hooks/notify-routing.js';
import { DECISION_SPECS } from '../../src/judge/decisions/registry.js';
import { setJudgeEngineResolver } from '../../src/judge/engine-lookup.js';
import { makeEngine } from './decisions-helpers.js';

beforeEach(() => {
  setJudgeEngineResolver(() => undefined);
});
afterEach(() => {
  setJudgeEngineResolver(() => undefined);
});

describe('notify.routing — registry + spec', () => {
  it('is registered in DECISION_SPECS', () => {
    expect(DECISION_SPECS['notify.routing']).toBe(notifyRoutingSpec);
    expect(DECISION_SPECS['notify.routing'].id).toBe(NOTIFY_ROUTING_POINT_ID);
  });
});

describe('notify.routing — judgeNotifyRoute (engine-injected)', () => {
  const runWith = async (
    choice: 'now' | 'later' | 'never',
    confidence = 0.9,
  ): Promise<'now' | 'later' | 'never'> => {
    const { engine } = makeEngine('active', {
      judgeId: 'mock/jev',
      answers: {
        'notify.route': { type: 'choice', choice, confidence },
      },
    });
    return await judgeNotifyRoute({
      engine,
      sessionId: 'cron:j1',
      kind: 'cron-result',
      channel: 'feishu',
      textPreview: 'report...',
    });
  };

  it('active + judged → the choice rules the route', async () => {
    await expect(runWith('now')).resolves.toBe('now');
    await expect(runWith('later')).resolves.toBe('later');
    await expect(runWith('never')).resolves.toBe('never');
  });

  it('active + gray choice (confidence < 0.5) → cascade exhausted → now', async () => {
    const { engine } = makeEngine('active', {
      judgeId: 'mock/jev',
      answers: { 'notify.route': { type: 'choice', choice: 'later', confidence: 0.3 } },
    });
    const route = await judgeNotifyRoute({
      engine,
      kind: 'cron-result',
      channel: 'feishu',
      textPreview: 'x',
    });
    expect(route).toBe('now');
    expect(engine.ledger.recent(1)[0]?.fallbackReason).toBe('gray-zone');
  });

  it('shadow mode: judged + ledgered, routing unchanged', async () => {
    const { engine } = makeEngine('shadow', {
      judgeId: 'mock/jev',
      answers: { 'notify.route': { type: 'choice', choice: 'never', confidence: 0.9 } },
    });
    const route = await judgeNotifyRoute({
      engine,
      kind: 'cron-result',
      channel: 'feishu',
      textPreview: 'x',
    });
    expect(route).toBe('now');
    const line = engine.ledger.recent(1)[0];
    expect(line?.pointId).toBe('notify.routing');
    expect(line?.mode).toBe('shadow');
    expect(line?.source).toBe('judge');
  });

  it('off mode: no engine call, no ledger line', async () => {
    const { engine, calls } = makeEngine('off', { judgeId: 'mock/jev' });
    const route = await judgeNotifyRoute({
      engine,
      kind: 'cron-result',
      channel: 'feishu',
      textPreview: 'x',
    });
    expect(route).toBe('now');
    expect(calls).toHaveLength(0);
    expect(engine.ledger.recent()).toHaveLength(0);
  });

  it('state is minimized (preview capped, no chatId)', async () => {
    const { engine, calls } = makeEngine('active', {
      judgeId: 'mock/jev',
      answers: { 'notify.route': { type: 'choice', choice: 'now', confidence: 0.9 } },
    });
    await judgeNotifyRoute({
      engine,
      kind: 'cron-result',
      channel: 'feishu',
      textPreview: 'y'.repeat(400),
    });
    const state = calls[0]?.context.state as { textPreview?: string; kind?: string };
    expect(state.textPreview?.length).toBe(300);
    expect(Object.keys(state).sort()).toEqual(['channel', 'kind', 'textPreview']);
  });
});

describe('notify.routing — judgeProactiveNotifyRoute (module-level resolver)', () => {
  it('applies judged never via the live engine lookup', async () => {
    const { engine } = makeEngine('active', {
      judgeId: 'mock/jev',
      answers: { 'notify.route': { type: 'choice', choice: 'never', confidence: 0.9 } },
    });
    setJudgeEngineResolver(() => engine as never);
    const route = await judgeProactiveNotifyRoute({
      sessionId: 'cron:j1',
      kind: 'cron-result',
      channel: 'feishu',
      textPreview: 'x',
    });
    expect(route).toBe('never');
  });

  it('fallback = current routing when the resolver has no engine', async () => {
    const route = await judgeProactiveNotifyRoute({
      kind: 'cron-result',
      channel: 'feishu',
      textPreview: 'x',
    });
    expect(route).toBe('now');
  });
});
