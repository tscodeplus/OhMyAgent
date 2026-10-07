/**
 * Hook for kernel M4 decision point `notify.routing` (impl doc §4.10) — the
 * proactive-notification router. `CronDeliveryRegistry` is the delivery path
 * for everything the agent emits without a same-turn reply: cron job results
 * AND completion texts (task completions delivered through the cron channel
 * adapter). The hook consults the judged route before delivery; fallback =
 * current routing ('now', immediate delivery to the job's channel/chat).
 *
 * Applied only in active mode — shadow/off/unanswered keep the current
 * routing byte-equal.
 */

import {
  judgeNotifyRoute,
  NOTIFY_LATER_DELAY_MS,
  type NotifyRoute,
} from '../decisions/notify-routing.js';

export { NOTIFY_LATER_DELAY_MS } from '../decisions/notify-routing.js';
export { NOTIFY_ROUTING_POINT_ID } from '../decisions/notify-routing.js';

export interface ProactiveNotifyRouteInput {
  sessionId?: string;
  /** Notification kind (e.g. 'cron-result'). */
  kind: string;
  /** Delivery channel id as registered on CronDeliveryRegistry. */
  channel: string;
  chatId?: string;
  textPreview: string;
  logger?: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
  };
}

/** Consult the judged routing of one proactive notification. Never throws. */
export async function judgeProactiveNotifyRoute(
  input: ProactiveNotifyRouteInput,
): Promise<NotifyRoute> {
  try {
    const route = await judgeNotifyRoute({
      sessionId: input.sessionId,
      kind: input.kind,
      channel: input.channel,
      textPreview: input.textPreview,
    });
    if (route !== 'now') {
      input.logger?.info(
        { sessionId: input.sessionId, channel: input.channel, route },
        'notify.routing judged — routing proactive notification',
      );
    }
    return route;
  } catch (err) {
    input.logger?.debug({ err }, 'notify.routing consult failed — using current routing');
    return 'now';
  }
}
