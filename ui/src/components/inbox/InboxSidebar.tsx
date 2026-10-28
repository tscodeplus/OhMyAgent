import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, Inbox as InboxIcon } from 'lucide-react';
import { cn, formatRelativeTime } from '../../lib/utils';
import { apiRequest, fetchInbox } from '../../utils/api';
import { useLongPress } from '../../utils/useLongPress';
import Spinner from '../ui/Spinner';
import ConfirmDialog from '../ui/ConfirmDialog';
import SessionContextMenu from '../app-shell/SessionContextMenu';
import { useToast } from '../ui/Toast';
import type { InboxChannel, InboxChannelCount, InboxSessionSummary } from '../../types/inbox';
import { channelLabel, groupInboxItems, inboxItemLabel, normalizeInboxChannel } from './inboxModel';

/** Rows per inbox page (the endpoint accepts 1..200). */
const PAGE_SIZE = 50;
/** Sidebar refresh cadence — keeps relative times honest and catches new chats. */
const POLL_MS = 30_000;
/** Inbox rows live on the `/inbox/:sessionId` route. */
const INBOX_PATH = '/inbox/';

interface InboxSidebarProps {
  /** Bumped by the shell when projects/sessions change. */
  refreshKey?: number;
}

export default function InboxSidebar({ refreshKey }: InboxSidebarProps) {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const location = useLocation();
  const [items, setItems] = useState<InboxSessionSummary[]>([]);
  const [channels, setChannels] = useState<InboxChannelCount[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  // The section and its channel groups default to expanded; we persist the
  // collapsed sets instead so channels that appear later open by themselves.
  const [sectionOpen, setSectionOpen] = useState(() => {
    try {
      return localStorage.getItem('oma-sidebar-inbox-open') !== 'false';
    } catch {
      return true;
    }
  });
  const [collapsedChannels, setCollapsedChannels] = useState<Set<InboxChannel>>(() => new Set());
  const { showToast } = useToast();
  const [contextMenu, setContextMenu] = useState<{
    item: InboxSessionSummary;
    x: number;
    y: number;
  } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<InboxSessionSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const toggleSection = useCallback(() => {
    setSectionOpen((open) => {
      const next = !open;
      try {
        localStorage.setItem('oma-sidebar-inbox-open', String(next));
      } catch {
        /* noop */
      }
      return next;
    });
  }, []);

  const toggleChannel = useCallback((channel: InboxChannel) => {
    setCollapsedChannels((prev) => {
      const next = new Set(prev);
      if (next.has(channel)) next.delete(channel);
      else next.add(channel);
      return next;
    });
  }, []);

  const fetchFirstPage = useCallback(async (showSpinner = false) => {
    try {
      if (showSpinner) setLoading(true);
      const page = await fetchInbox({ limit: PAGE_SIZE });
      setItems(page.items ?? []);
      setChannels(page.channels ?? []);
      setHasMore(page.hasMore ?? false);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchFirstPage(true);
  }, [fetchFirstPage]);

  useEffect(() => {
    void fetchFirstPage(false);
  }, [refreshKey, fetchFirstPage]);

  useEffect(() => {
    const timer = setInterval(() => {
      void fetchFirstPage(false);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [fetchFirstPage]);

  const loadMore = useCallback(async () => {
    const oldest = items[items.length - 1]?.updated_at;
    if (oldest === undefined || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchInbox({ limit: PAGE_SIZE, before: oldest });
      setItems((prev) => {
        // Cursor paging over a live table can repeat a row — dedupe by id.
        const seen = new Set(prev.map((item) => item.id));
        return [...prev, ...(page.items ?? []).filter((item) => !seen.has(item.id))];
      });
      setHasMore(page.hasMore ?? false);
    } catch {
      /* keep the rows we already have */
    } finally {
      setLoadingMore(false);
    }
  }, [items, loadingMore]);

  const activeId = location.pathname.startsWith(INBOX_PATH)
    ? decodeURIComponent(location.pathname.slice(INBOX_PATH.length))
    : null;

  // Close the row menu on any click elsewhere (and after scrolling the sidebar,
  // which would otherwise leave the menu pinned over a different row).
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextMenu]);

  const commitRename = useCallback(
    async (item: InboxSessionSummary) => {
      const title = renameDraft.trim();
      setRenamingId(null);
      if (!title || title === (item.title ?? '')) return;
      setBusyId(item.id);
      try {
        const res = await apiRequest<{ ok: boolean; title: string }>(
          '/api/inbox/' + encodeURIComponent(item.id) + '/title',
          { method: 'PUT', body: JSON.stringify({ title }) },
        );
        setItems((prev) =>
          prev.map((row) => (row.id === item.id ? { ...row, title: res.title } : row)),
        );
        showToast(t('inbox.renamed'), 'success');
      } catch (err) {
        showToast(err instanceof Error ? err.message : t('inbox.renameError'), 'error');
      } finally {
        setBusyId(null);
      }
    },
    [renameDraft, showToast, t],
  );

  const doDelete = useCallback(
    async (item: InboxSessionSummary) => {
      setConfirmDelete(null);
      setBusyId(item.id);
      try {
        const res = await apiRequest<{ ok: boolean; replacement_id: string | null }>(
          '/api/inbox/' + encodeURIComponent(item.id),
          { method: 'DELETE' },
        );
        setItems((prev) => prev.filter((row) => row.id !== item.id));
        showToast(t('inbox.deleted'), 'success');
        if (activeId === item.id) {
          // The server may have opened the chat's next conversation; otherwise
          // fall back to the newest remaining row so the pane is never blank.
          const next =
            res.replacement_id ?? items.find((row) => row.id !== item.id)?.id ?? undefined;
          navigate(next ? INBOX_PATH + encodeURIComponent(next) : '/');
        }
        void fetchFirstPage(false);
      } catch (err) {
        // 409 (a turn is running) carries an operator-readable reason.
        showToast(err instanceof Error ? err.message : t('inbox.deleteError'), 'error');
      } finally {
        setBusyId(null);
      }
    },
    [activeId, fetchFirstPage, items, navigate, showToast, t],
  );

  const openContextMenu = useCallback((item: InboxSessionSummary, x: number, y: number) => {
    setContextMenu({ item, x, y });
  }, []);

  const groups = useMemo(() => groupInboxItems(items), [items]);

  // channel -> bot display name, straight from the API's per-channel counts.
  const botNames = useMemo(() => {
    const map = new Map<InboxChannel, string>();
    for (const entry of channels) {
      if (entry.bot_name) map.set(normalizeInboxChannel(entry.channel), entry.bot_name);
    }
    return map;
  }, [channels]);

  // Total comes from the server-side counts so a paged list still shows the
  // real number of IM conversations.
  const total = useMemo(() => {
    if (channels.length > 0) return channels.reduce((sum, c) => sum + c.count, 0);
    return items.length;
  }, [channels, items]);

  return (
    <section className="mt-2 border-t border-neutral-200/70 pt-1 dark:border-neutral-800/70">
      {contextMenu && (
        <SessionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onRename={() => {
            setRenamingId(contextMenu.item.id);
            setRenameDraft(contextMenu.item.title ?? '');
            setContextMenu(null);
          }}
          onDelete={() => {
            setConfirmDelete(contextMenu.item);
            setContextMenu(null);
          }}
        />
      )}
      <ConfirmDialog
        open={confirmDelete !== null}
        title={t('sidebar.delete')}
        message={t('inbox.confirmDelete', {
          name: confirmDelete ? inboxItemLabel(confirmDelete, t('inbox.emptySession')) : '',
        })}
        confirmLabel={t('sidebar.delete')}
        onConfirm={() => {
          if (confirmDelete) void doDelete(confirmDelete);
        }}
        onCancel={() => setConfirmDelete(null)}
      />
      <div className="flex items-center gap-1.5 px-2">
        <InboxIcon
          className="h-3.5 w-3.5 shrink-0 text-neutral-500/90 dark:text-neutral-400/80"
          strokeWidth={1.75}
        />
        <button
          type="button"
          onClick={toggleSection}
          aria-expanded={sectionOpen}
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md text-left text-[13px] font-medium uppercase tracking-[0.04em] text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          <span className="truncate">{t('inbox.title')}</span>
          {total > 0 && (
            <span className="shrink-0 rounded-full bg-neutral-200/70 px-1.5 text-[10px] font-medium tabular-nums text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
              {total}
            </span>
          )}
          <ChevronDown
            className={cn(
              'ml-auto h-3.5 w-3.5 shrink-0 transition-transform duration-200',
              sectionOpen ? '' : '-rotate-90',
            )}
            strokeWidth={1.75}
          />
        </button>
      </div>

      {sectionOpen && (
        <div className="pb-1">
          {loading && items.length === 0 ? (
            <div className="flex justify-center px-2 py-2">
              <Spinner size="sm" />
            </div>
          ) : items.length === 0 ? (
            <div className="px-3 py-1 text-[11px] text-neutral-500 dark:text-neutral-400">
              {failed ? t('inbox.loadError') : t('inbox.empty')}
            </div>
          ) : (
            <div className="space-y-0.5">
              {groups.map((group) => {
                const collapsed = collapsedChannels.has(group.channel);
                const botName = botNames.get(group.channel);
                const label = channelLabel(t, group.channel, botName);
                return (
                  <div key={group.channel}>
                    <button
                      type="button"
                      onClick={() => toggleChannel(group.channel)}
                      aria-expanded={!collapsed}
                      title={group.channel === 'unknown' ? t('inbox.channels.unknownHint') : label}
                      className="flex h-6 w-full items-center gap-1 rounded-md px-2 text-[11px] font-medium text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                    >
                      <ChevronDown
                        className={cn(
                          'h-3 w-3 shrink-0 transition-transform duration-200',
                          collapsed ? '-rotate-90' : '',
                        )}
                        strokeWidth={1.75}
                      />
                      <span className="truncate">{label}</span>
                      <span className="ml-auto shrink-0 tabular-nums">{group.items.length}</span>
                    </button>

                    {!collapsed &&
                      group.items.map((item) => (
                        <InboxRow
                          key={item.id}
                          item={item}
                          label={inboxItemLabel(item, t('inbox.emptySession'))}
                          active={item.id === activeId}
                          busy={busyId === item.id}
                          renaming={renamingId === item.id}
                          renameDraft={renamingId === item.id ? renameDraft : ''}
                          onRenameDraftChange={setRenameDraft}
                          onRenameCommit={() => void commitRename(item)}
                          onRenameCancel={() => setRenamingId(null)}
                          onOpenMenu={(x, y) => openContextMenu(item, x, y)}
                          onSelect={() => navigate(INBOX_PATH + encodeURIComponent(item.id))}
                        />
                      ))}
                  </div>
                );
              })}
              {hasMore && (
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className="flex h-6 w-full items-center justify-center rounded-md px-2 text-[11px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                >
                  {loadingMore ? t('common.loading') : t('inbox.loadMore')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * One inbox conversation.
 *
 * Right-click on desktop, long press on a phone: the same gesture the project
 * session list uses, so the two lists behave alike. The click that ends a long
 * press is swallowed by useLongPress, otherwise opening the menu would also
 * navigate into the conversation underneath it.
 */
function InboxRow({
  item,
  label,
  active,
  busy,
  renaming,
  renameDraft,
  onRenameDraftChange,
  onRenameCommit,
  onRenameCancel,
  onOpenMenu,
  onSelect,
}: {
  item: InboxSessionSummary;
  label: string;
  active: boolean;
  busy: boolean;
  renaming: boolean;
  renameDraft: string;
  onRenameDraftChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onOpenMenu: (x: number, y: number) => void;
  onSelect: () => void;
}) {
  const { t } = useTranslation('common');
  const longPressProps = useLongPress((event) => {
    const point =
      'touches' in event
        ? (event.touches[0] ?? (event as unknown as TouchEvent).changedTouches?.[0])
        : (event as React.MouseEvent);
    onOpenMenu(point?.clientX ?? 100, point?.clientY ?? 100);
  });

  if (renaming) {
    return (
      <div className="flex items-center py-1 pl-6 pr-2">
        <input
          autoFocus
          value={renameDraft}
          onChange={(e) => onRenameDraftChange(e.target.value)}
          onBlur={onRenameCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onRenameCommit();
            }
            if (e.key === 'Escape') onRenameCancel();
          }}
          placeholder={t('inbox.renamePlaceholder')}
          className="w-full rounded-sm border border-neutral-300 bg-white px-1.5 py-0.5 text-[12.5px] text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
        />
      </div>
    );
  }

  return (
    <button
      {...longPressProps}
      type="button"
      onClick={onSelect}
      title={label}
      className={cn(
        'sidebar-row flex w-full flex-col gap-0.5 rounded-lg py-1 pl-6 pr-2 text-left transition-colors',
        busy && 'opacity-60',
        active
          ? 'bg-neutral-200/70 dark:bg-neutral-800'
          : 'hover:bg-neutral-100 dark:hover:bg-neutral-800',
      )}
    >
      <span className="flex w-full items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-700 dark:text-neutral-300">
          {label}
        </span>
        <span className="shrink-0 text-[10.5px] text-neutral-400 dark:text-neutral-500">
          {formatRelativeTime(item.updated_at)}
        </span>
      </span>
      <span className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">
        {t('inbox.messageCount', { count: item.message_count })}
      </span>
    </button>
  );
}
