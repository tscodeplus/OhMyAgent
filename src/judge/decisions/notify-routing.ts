/**
 * Decision point `notify.routing` (kernel M4, plan §6 point 15, impl doc
 * §4.10): proactive notifications (cron results and completion texts routed
 * through `CronDeliveryRegistry`) get a routing judgment before delivery:
 * choice { now / later / never }.
 *
 * Fallback: 'now' — byte-equal to the current routing (deliver immediately to
 * the job's channel/chat). Applied only in active mode, so mode shadow/off is
 * the current routing by construction.
 */

import { choice, defineDecision, type DecisionSpec } from '../types.js';
import type { JudgeEngine } from '../engine.js';
import { currentJudgeEngine } from '../engine-lookup.js';

export const NOTIFY_ROUTING_POINT_ID = 'notify.routing';

/** Text preview cap carried into the judge state. */
export const NOTIFY_PREVIEW_MAX = 300;

/** 'later' deferral: deliver once, best-effort, after this delay. */
export const NOTIFY_LATER_DELAY_MS = 10 * 60_000;

export interface NotifyRoutingState {
  /** What kind of proactive notification this is (e.g. 'cron-result'). */
  kind: string;
  /** Delivery channel id (feishu/qq/telegram/wechat/...). */
  channel: string;
  /** First 300 chars of the notification text. */
  textPreview: string;
}

const ROUTE_QUESTION = choice('route this proactive notification', {
  now: 'deliver immediately to the target chat — the content is worth surfacing now',
  later: 'the content is valid but not urgent — delay the delivery',
  never: 'the content is not worth delivering to the chat at all',
});

export const notifyRoutingSpec: DecisionSpec = defineDecision({
  id: NOTIFY_ROUTING_POINT_ID,
  version: 1,
  questions: { 'notify.route': ROUTE_QUESTION },
  buildState: (raw: unknown): NotifyRoutingState => {
    // engine.decide passes the whole DecisionInput — unwrap `state`.
    const call = raw as { state?: unknown } | undefined;
    const input = ((call && typeof call === 'object' && 'state' in call ? call.state : raw) ??
      {}) as Partial<NotifyRoutingState>;
    return {
      kind: typeof input.kind === 'string' ? input.kind.slice(0, 60) : '',
      channel: typeof input.channel === 'string' ? input.channel.slice(0, 60) : '',
      textPreview:
        typeof input.textPreview === 'string' ? input.textPreview.slice(0, NOTIFY_PREVIEW_MAX) : '',
    };
  },
  // Applied in active mode only: the judged choice becomes the route.
  policy: ((answers) => {
    const answer = answers['notify.route'] as { type?: string; choice?: string } | undefined;
    if (answer?.type === 'choice' && answer.choice) {
      return { action: 'route', choice: answer.choice };
    }
    return { action: 'none' };
  }) as DecisionSpec['policy'],
  fallback: { action: 'none' },
});

export type NotifyRoute = 'now' | 'later' | 'never';

/**
 * Judge the routing of one proactive notification (hook — called from
 * `JobRunner.deliver`, the CronDeliveryRegistry router). STRICT no-op:
 * engine absent, mode off, shadow, fallback or anything unexpected → 'now'
 * (the pre-judge routing). Never throws.
 */
export async function judgeNotifyRoute(input: {
  engine?: JudgeEngine;
  sessionId?: string;
  kind: string;
  channel: string;
  textPreview: string;
}): Promise<NotifyRoute> {
  const engine = input.engine ?? currentJudgeEngine();
  if (!engine) return 'now';
  if (engine.modeFor(NOTIFY_ROUTING_POINT_ID) === 'off') return 'now';
  try {
    const verdict = await engine.decideMany(notifyRoutingSpec, {
      state: {
        kind: input.kind,
        channel: input.channel,
        textPreview: input.textPreview.slice(0, NOTIFY_PREVIEW_MAX),
      },
      sessionId: input.sessionId,
    });
    if (verdict.source !== 'judge' || verdict.mode !== 'active') return 'now';
    if (verdict.outcome.action === 'route' && verdict.outcome.choice in ROUTE_QUESTION.criteria) {
      return verdict.outcome.choice as NotifyRoute;
    }
    return 'now';
  } catch {
    return 'now';
  }
}
