import type {
  ArchiveGroup,
  ArchiveOwnerCount,
  ArchivedSessionSummary,
  ArchiveKind,
} from '../../types/archive';
import type { InboxChannel } from '../../types/inbox';
import { channelLabel, normalizeInboxChannel } from '../inbox/inboxModel';

/**
 * Fixed channel order for archived inbox groups — the same order the live inbox
 * uses (`inboxModel.INBOX_CHANNEL_ORDER`), so a channel does not jump around
 * when it moves in or out of the archive.
 */
const ARCHIVE_CHANNEL_ORDER: InboxChannel[] = [
  'feishu',
  'telegram',
  'wechat',
  'qq',
  'webui',
  'cron',
  'unknown',
];

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/** Stable group key for React and for the collapsed-set. */
export function archiveGroupKey(
  kind: ArchiveKind,
  projectId: string | null,
  channel: string | null,
) {
  return kind === 'project'
    ? `project:${projectId ?? ''}`
    : `inbox:${normalizeInboxChannel(channel ?? 'unknown')}`;
}

/**
 * Header label for one owner bucket.
 *
 * A project archived row is labelled with the project it came from (that is the
 * whole point of grouping by pre-archive ownership); an inbox row reuses the
 * live inbox's "<bot> · <channel>" label so the two trees never disagree about
 * what to call a channel.
 */
export function archiveOwnerLabel(
  t: Translate,
  owner: Pick<ArchiveOwnerCount, 'kind' | 'project_id' | 'project_name' | 'channel' | 'bot_name'>,
): string {
  if (owner.kind === 'project') {
    return owner.project_name || owner.project_id || t('archive.unknownProject');
  }
  return channelLabel(t, normalizeInboxChannel(owner.channel ?? 'unknown'), owner.bot_name);
}

/** Row label: title, then last-message preview, then the transport handle. */
export function archivedItemLabel(
  t: Translate,
  item: ArchivedSessionSummary,
  emptyLabel?: string,
): string {
  return (
    item.title ||
    item.preview ||
    (item.message_count === 0 ? emptyLabel : undefined) ||
    item.external_chat_id ||
    item.id
  );
}

/** Ids of every loaded row — the bound of what "全选" can act on locally. */
export function archivedIds(items: ArchivedSessionSummary[]): string[] {
  return items.map((item) => item.id);
}

/**
 * Splits the archived page into the two trees, then into owner buckets.
 *
 * Ordering rules, all chosen so the sidebar does not reshuffle as rows move:
 *   - the two trees always render in the same order (对话, then 收件箱);
 *   - project buckets follow the server's owner order (largest archive first);
 *   - inbox buckets follow the fixed channel order;
 *   - rows inside a bucket are newest-archive-first (the server already sorts
 *     this way; the sort here just keeps it true after a local restore).
 *
 * A bucket that has no loaded row yet (its conversations are on a later page) is
 * omitted rather than rendered empty — the count in the group header would lie
 * otherwise. `total` still comes from the server's owner counts.
 */
export function groupArchivedItems(
  t: Translate,
  items: ArchivedSessionSummary[],
  owners: ArchiveOwnerCount[],
): { projects: ArchiveGroup[]; inbox: ArchiveGroup[] } {
  const counts = new Map<string, ArchiveOwnerCount>();
  for (const owner of owners) {
    counts.set(archiveGroupKey(owner.kind, owner.project_id, owner.channel), owner);
  }

  const buckets = new Map<string, ArchiveGroup>();
  const ensure = (
    kind: ArchiveKind,
    projectId: string | null,
    channel: string | null,
  ): ArchiveGroup => {
    const key = archiveGroupKey(kind, projectId, channel);
    const existing = buckets.get(key);
    if (existing) return existing;
    // Prefer the server's owner row (it carries project_name / bot_name); fall
    // back to the row itself when the owner is not in the counts list — that
    // happens when a page boundary lands mid-bucket.
    const owner = counts.get(key);
    const group: ArchiveGroup = {
      kind,
      key,
      label: owner
        ? archiveOwnerLabel(t, owner)
        : kind === 'project'
          ? projectId || t('archive.unknownProject')
          : archiveOwnerLabel(t, {
              kind,
              project_id: null,
              project_name: null,
              channel,
              bot_name: undefined,
            }),
      channel: kind === 'inbox' ? normalizeInboxChannel(channel ?? 'unknown') : null,
      items: [],
      total: owner?.count ?? 0,
    };
    buckets.set(key, group);
    return group;
  };

  for (const item of items) {
    const kind: ArchiveKind = item.project_id === null ? 'inbox' : 'project';
    const group = ensure(kind, item.project_id, item.channel);
    group.items.push(item);
    group.total = Math.max(group.total, group.items.length);
  }

  for (const group of buckets.values()) {
    group.items.sort((a, b) => b.archived_at - a.archived_at);
  }

  const projectOrder = [...counts.values()]
    .filter((owner) => owner.kind === 'project')
    .map((owner) => archiveGroupKey('project', owner.project_id, null));
  const projects = [...buckets.values()].filter((group) => group.kind === 'project');
  projects.sort((a, b) => {
    const ai = projectOrder.indexOf(a.key);
    const bi = projectOrder.indexOf(b.key);
    // Unknown buckets (not in the counts) go last, alphabetically.
    if (ai === -1 && bi === -1) return a.label.localeCompare(b.label);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  const inbox = [...buckets.values()].filter((group) => group.kind === 'inbox');
  inbox.sort(
    (a, b) =>
      ARCHIVE_CHANNEL_ORDER.indexOf(normalizeInboxChannel(a.channel ?? 'unknown')) -
      ARCHIVE_CHANNEL_ORDER.indexOf(normalizeInboxChannel(b.channel ?? 'unknown')),
  );

  return { projects, inbox };
}
