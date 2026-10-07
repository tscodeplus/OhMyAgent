/**
 * Host wiring for the free-Jev daily privacy notice (kernel M4, impl doc
 * §3.3 + §9 row 7): the once-per-user-per-day one-line notice is delivered
 * through the channel delivery clients (the same proactive delivery path the
 * cron clients register — the channel reply path).
 *
 * The notice text carries NO message content (privacy by construction) and
 * comes fully from the i18n `judge` namespace; this module only maps the
 * judged session id onto a channel/chat and hands the one-liner over.
 */

import type { CronDeliveryRegistry } from '../../cron/delivery-registry.js';
import { i18n } from '../../i18n/index.js';

export interface SessionChannelTarget {
  channel: string;
  chatId: string;
}

/**
 * Map a judged session id (the sessionId ledger/hook callers pass — the
 * channel session keys) to its delivery client + chat id.
 *
 * Recognized:
 *   qq:c2c:<openid>  → qq  / "u:<openid>"
 *   qq:group:<id>    → qq  / "g:<id>"
 *   telegram:<id>    → telegram / "<id>"  (numeric)
 *   wechat:<sender>  → wechat / "<sender>"
 *   webui:<id>       → webui / "<id>"
 *   oc_<chat>[:thr]  → feishu / "<chat>" (thread suffix stripped)
 *
 * Everything else (e.g. cron:<job-id> agent-internal sessions) has no
 * user-facing channel — returns undefined, callers keep the log-only fallback.
 */
export function mapSessionToChannel(sessionId: string): SessionChannelTarget | undefined {
  if (!sessionId) return undefined;
  if (sessionId.startsWith('qq:c2c:')) {
    const id = sessionId.slice('qq:c2c:'.length);
    return id ? { channel: 'qq', chatId: `u:${id}` } : undefined;
  }
  if (sessionId.startsWith('qq:group:')) {
    const id = sessionId.slice('qq:group:'.length);
    return id ? { channel: 'qq', chatId: `g:${id}` } : undefined;
  }
  for (const prefix of ['telegram', 'wechat', 'webui'] as const) {
    if (sessionId.startsWith(`${prefix}:`)) {
      const id = sessionId.slice(prefix.length + 1);
      return id ? { channel: prefix, chatId: id } : undefined;
    }
  }
  if (sessionId.startsWith('cron:')) return undefined;
  // Feishu: p2p session key is the chat id (oc_...); group keys are
  // "<chatId>:<threadId>" — strip the thread suffix before delivering.
  const chatId = sessionId.split(':')[0] ?? '';
  if (chatId.startsWith('oc_')) return { channel: 'feishu', chatId };
  return undefined;
}

export interface FreeJevNoticeSenderOptions {
  registry: CronDeliveryRegistry;
  logger?: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}

/**
 * Sender fired by FreeJevMonitor at most once per user per day: resolves the
 * session to a channel client and sends the localized one-line notice via
 * `deliverNotice` (plain text, no model/footer chrome) — falling back to the
 * standard `deliver` when a client has no notice method.
 */
export function createFreeJevNoticeSender(
  options: FreeJevNoticeSenderOptions,
): (sessionId: string) => Promise<void> {
  const fail = (msg: string, extra?: Record<string, unknown>): void => {
    options.logger?.info({ ...extra }, msg);
  };
  return async (sessionId: string): Promise<void> => {
    const target = mapSessionToChannel(sessionId);
    if (!target) {
      options.logger?.debug(
        { sessionId },
        'free-Jev daily notice skipped: session has no user-facing channel',
      );
      return;
    }
    const text = i18n.t('judge:freeJevNotice');
    const client = options.registry.get(target.channel);
    if (!client) {
      options.logger?.debug(
        { sessionId, channel: target.channel },
        'free-Jev daily notice skipped: no delivery client for channel',
      );
      return;
    }
    try {
      if (client.deliverNotice) {
        await client.deliverNotice({ chatId: target.chatId, text });
      } else {
        await client.deliver({
          chatId: target.chatId,
          text,
          modelLabel: '',
          footer: {
            showAgentName: false,
            showModel: false,
            showCompleted: false,
            showElapsed: false,
          },
        });
      }
      fail('free-Jev daily notice delivered', { sessionId, channel: target.channel });
    } catch (err) {
      options.logger?.warn(
        { err, sessionId, channel: target.channel },
        'free-Jev daily notice delivery failed (non-fatal)',
      );
    }
  };
}
