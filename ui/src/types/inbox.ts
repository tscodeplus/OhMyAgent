import type { Message } from './session';

/**
 * Channels the inbox groups sessions by. `unknown` catches anything the server
 * reports that this build does not know yet, so an unrecognised channel still
 * renders instead of disappearing.
 */
export type InboxChannel = 'feishu' | 'telegram' | 'wechat' | 'qq' | 'webui' | 'cron' | 'unknown';

/** One row of `GET /api/inbox`. */
export interface InboxSessionSummary {
  id: string;
  /** Raw server value — narrow it through `normalizeInboxChannel()` to display. */
  channel: string;
  external_chat_id: string | null;
  title: string | null;
  /** Epoch ms; the list is ordered by this, newest first. */
  updated_at: number;
  message_count: number;
  preview: string | null;
}

/** Per-channel item counts returned alongside the page of inbox rows. */
export interface InboxChannelCount {
  channel: string;
  count: number;
}

export interface InboxPage {
  items: InboxSessionSummary[];
  hasMore: boolean;
  channels: InboxChannelCount[];
}

/**
 * `GET /api/inbox/:id/messages` — session header plus one page of the
 * transcript. `messages` uses the same shape as the project-session detail
 * endpoint, so the chat renderer can consume it unchanged.
 */
export interface InboxSessionDetail {
  id: string;
  channel: string;
  external_chat_id: string | null;
  title: string | null;
  created_at: number;
  updated_at: number;
  messages: Message[];
  hasMore: boolean;
}

/** Query for `GET /api/inbox`. `before` is an epoch-ms cursor (exclusive). */
export interface InboxQuery {
  channel?: InboxChannel;
  /** 1..200 */
  limit?: number;
  before?: number;
}

/** Query for `GET /api/inbox/:id/messages`. `before` is an epoch-ms cursor. */
export interface InboxMessagesQuery {
  limit?: number;
  before?: number;
}
