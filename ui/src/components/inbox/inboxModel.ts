import type { InboxChannel, InboxSessionSummary } from '../../types/inbox';

/** Channels this build knows how to label, in sidebar display order. */
const KNOWN_CHANNELS: InboxChannel[] = ['feishu', 'telegram', 'wechat', 'qq', 'webui', 'cron'];

/** Fixed order for the sidebar groups (`unknown` last) — stable across refreshes. */
const INBOX_CHANNEL_ORDER: InboxChannel[] = [...KNOWN_CHANNELS, 'unknown'];

/** Narrow the raw `channel` string from the API to a label-able channel. */
export function normalizeInboxChannel(channel: string): InboxChannel {
  return (KNOWN_CHANNELS as string[]).includes(channel) ? (channel as InboxChannel) : 'unknown';
}

/** i18n key of the channel's display name. */
export const INBOX_CHANNEL_LABEL_KEY: Record<InboxChannel, string> = {
  feishu: 'inbox.channels.feishu',
  telegram: 'inbox.channels.telegram',
  wechat: 'inbox.channels.wechat',
  qq: 'inbox.channels.qq',
  webui: 'inbox.channels.webui',
  cron: 'inbox.channels.cron',
  unknown: 'inbox.channels.unknown',
};

/**
 * Label for a channel group or badge.
 *
 * "小书 · 飞书" once the channel has a configured bot name, the plain channel
 * name otherwise. Separator is the middle dot, not a hyphen: the sidebar already
 * uses "-" for "agent - message" labels, and two different separators in one
 * list read as the same thing.
 */
export function channelLabel(
  t: (key: string) => string,
  channel: InboxChannel,
  botName?: string,
): string {
  const plain = t(INBOX_CHANNEL_LABEL_KEY[channel]);
  return botName ? `${botName} · ${plain}` : plain;
}

/** Badge palette for the read-only transcript header. */
export const INBOX_CHANNEL_BADGE_CLASS: Record<InboxChannel, string> = {
  feishu: 'bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300',
  telegram: 'bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300',
  wechat: 'bg-green-50 text-green-700 dark:bg-green-950/50 dark:text-green-300',
  qq: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300',
  webui: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
  cron: 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  unknown: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400',
};

export interface InboxGroup {
  channel: InboxChannel;
  items: InboxSessionSummary[];
}

/**
 * Groups inbox rows per channel. A group only exists when it has items, rows
 * inside a group are newest first, and groups keep a fixed channel order so the
 * sidebar does not reshuffle when the server re-sorts or a channel goes empty.
 */
export function groupInboxItems(items: InboxSessionSummary[]): InboxGroup[] {
  const byChannel = new Map<InboxChannel, InboxSessionSummary[]>();
  for (const item of items) {
    const channel = normalizeInboxChannel(item.channel);
    const bucket = byChannel.get(channel);
    if (bucket) bucket.push(item);
    else byChannel.set(channel, [item]);
  }

  const groups: InboxGroup[] = [];
  for (const channel of INBOX_CHANNEL_ORDER) {
    const bucket = byChannel.get(channel);
    if (!bucket || bucket.length === 0) continue;
    bucket.sort((a, b) => b.updated_at - a.updated_at);
    groups.push({ channel, items: bucket });
  }
  return groups;
}

/** Row label: title, falling back to the last message preview, then the chat id. */
export function inboxItemLabel(item: InboxSessionSummary, emptyLabel?: string): string {
  // A conversation opened with /new but not written to yet has neither title nor
  // preview; falling through to the transport handle would show a raw `oc_…` id.
  return (
    item.title ||
    item.preview ||
    (item.message_count === 0 ? emptyLabel : undefined) ||
    item.external_chat_id ||
    item.id
  );
}

/**
 * Message timestamps are epoch ms in SQLite but may still be legacy TEXT;
 * the inbox paging cursor is always epoch ms.
 */
export function toInboxCursor(timestamp: number | string): number {
  if (typeof timestamp === 'number') return timestamp;
  const numeric = Number(timestamp);
  if (Number.isFinite(numeric)) return numeric;
  return new Date(timestamp).getTime();
}
