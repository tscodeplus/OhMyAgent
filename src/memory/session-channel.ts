/**
 * Session channel classification.
 *
 * A session row records `chat_id` (the transport-level conversation handle)
 * and, since v9, a `channel` column. Rows written before v9 have no channel,
 * and the IM inbox groups them by channel — so the channel must be derivable
 * from the identifiers those rows do carry.
 */

export type SessionChannel = 'webui' | 'feishu' | 'telegram' | 'wechat' | 'qq' | 'cron' | 'unknown';

/**
 * Channels in inbox display order: IM transports first (the inbox exists for
 * them), then the WebUI/cron sessions, then anything unrecognised.
 */
export const INBOX_CHANNELS: readonly SessionChannel[] = [
  'feishu',
  'telegram',
  'wechat',
  'qq',
  'webui',
  'cron',
  'unknown',
];

export function isInboxChannel(value: string): value is SessionChannel {
  return (INBOX_CHANNELS as readonly string[]).includes(value);
}

/** Feishu session ids are the raw chat_id (`oc_…`) or `chatId:threadId`. */
const FEISHU_ID_PREFIX = /^(oc_|ou_|on_|om_|cli_)/;

/**
 * Derive the channel for a session.
 *
 * `chatId` is checked first because a WebUI session's id is a bare uuid while
 * its chat_id carries the marker (`webui:<projectId>`). IM transports use the
 * chat handle itself as the session id, so their prefixes are matched on `id`.
 */
export function inferChannel(sessionId: string, chatId?: string | null): SessionChannel {
  if (chatId && chatId.startsWith('webui:')) return 'webui';

  if (sessionId.startsWith('webui:')) return 'webui';
  if (sessionId.startsWith('telegram:')) return 'telegram';
  if (sessionId.startsWith('wechat:')) return 'wechat';
  if (sessionId.startsWith('qq:')) return 'qq';
  if (sessionId.startsWith('cron:')) return 'cron';
  if (FEISHU_ID_PREFIX.test(sessionId)) return 'feishu';

  return 'unknown';
}
