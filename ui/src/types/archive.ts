import type { InboxChannel } from './inbox';

/**
 * Which sidebar tree a conversation belongs to. A project chat keeps a
 * `project_id`; an IM transcript has `project_id IS NULL` and carries a
 * `channel` instead.
 */
export type ArchiveKind = 'project' | 'inbox';

/**
 * One row of `GET /api/archive`.
 *
 * An archived conversation is not a copy: it is the same session row with
 * `archived_at` set, so it keeps the owner it had before archiving — that owner
 * is what the archive sidebar groups by, which is why the server sends
 * `project_name` / `channel` inline instead of making the UI join.
 */
export interface ArchivedSessionSummary {
  id: string;
  kind: ArchiveKind;
  /** Set for `kind: 'project'` rows — the sidebar link target. */
  project_id: string | null;
  /** Project display name; `null` once the project itself is deleted. */
  project_name: string | null;
  /** Raw server value for inbox rows — narrow with `normalizeInboxChannel()`. */
  channel: string | null;
  external_chat_id: string | null;
  title: string | null;
  /** Epoch ms; the conversation's own last-activity time. */
  updated_at: number;
  /** Epoch ms; the list is ordered by this, newest archive first. */
  archived_at: number;
  message_count: number;
  preview: string | null;
}

/**
 * One owner bucket (a project, or a channel inside the inbox) with its archived
 * count. Comes from the server so a paged list still shows the real totals.
 */
export interface ArchiveOwnerCount {
  kind: ArchiveKind;
  project_id: string | null;
  project_name: string | null;
  channel: string | null;
  count: number;
  /** Inbox owners only: the channel bot's display name, when it has one. */
  bot_name?: string;
}

export interface ArchivePage {
  items: ArchivedSessionSummary[];
  hasMore: boolean;
  owners: ArchiveOwnerCount[];
}

/** Query for `GET /api/archive`. `before` is an epoch-ms `archived_at` cursor. */
export interface ArchiveQuery {
  kind?: ArchiveKind;
  /** 1..200 */
  limit?: number;
  before?: number;
}

/** Why a selected conversation was not deleted — a key, localized by the UI. */
export type DeleteSkipReason = 'not_found' | 'running' | 'failed';

/**
 * Result of `POST /api/sessions/delete`.
 *
 * A selection can span both trees, and part of it can legitimately fail (a row
 * mid-reply, or one already deleted on another device), so the batch reports the
 * split rather than answering ok/error for the whole thing.
 */
export interface DeleteSessionsResult {
  ok: boolean;
  deleted: number;
  skipped: Array<{ id: string; reason: DeleteSkipReason }>;
  /** Replacement transcript opened for a deleted current IM conversation. */
  replacements: Record<string, string | null>;
}

/** One group of the archive sidebar: an owner plus its archived rows. */
export interface ArchiveGroup {
  kind: ArchiveKind;
  /** Stable key for React and for the collapsed-set: `project:<id>` / `inbox:<channel>`. */
  key: string;
  /** Group header label, already resolved (project name or "小书 · 飞书"). */
  label: string;
  /** Channel for inbox groups — drives the chevron/badge colour. */
  channel: InboxChannel | null;
  items: ArchivedSessionSummary[];
  /** Server-side count, which exceeds `items.length` while the page is partial. */
  total: number;
}
