import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, Inbox as InboxIcon } from 'lucide-react';
import { cn, formatRelativeTime } from '../../lib/utils';
import { fetchInbox } from '../../utils/api';
import Spinner from '../ui/Spinner';
import type { InboxChannel, InboxChannelCount, InboxSessionSummary } from '../../types/inbox';
import {
  INBOX_CHANNEL_LABEL_KEY,
  groupInboxItems,
  inboxItemLabel,
  normalizeInboxChannel,
} from './inboxModel';

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

  const groups = useMemo(() => groupInboxItems(items), [items]);

  // Total comes from the server-side counts so a paged list still shows the
  // real number of IM conversations.
  const total = useMemo(() => {
    if (channels.length > 0) return channels.reduce((sum, c) => sum + c.count, 0);
    return items.length;
  }, [channels, items]);

  const activeId = location.pathname.startsWith(INBOX_PATH)
    ? decodeURIComponent(location.pathname.slice(INBOX_PATH.length))
    : null;

  return (
    <section className="mt-2 border-t border-neutral-200/70 pt-1 dark:border-neutral-800/70">
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
                return (
                  <div key={group.channel}>
                    <button
                      type="button"
                      onClick={() => toggleChannel(group.channel)}
                      aria-expanded={!collapsed}
                      className="flex h-6 w-full items-center gap-1 rounded-md px-2 text-[11px] font-medium text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                    >
                      <ChevronDown
                        className={cn(
                          'h-3 w-3 shrink-0 transition-transform duration-200',
                          collapsed ? '-rotate-90' : '',
                        )}
                        strokeWidth={1.75}
                      />
                      <span className="truncate">
                        {t(INBOX_CHANNEL_LABEL_KEY[normalizeInboxChannel(group.channel)])}
                      </span>
                      <span className="ml-auto shrink-0 tabular-nums">{group.items.length}</span>
                    </button>

                    {!collapsed &&
                      group.items.map((item) => {
                        const label = inboxItemLabel(item);
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => navigate(`${INBOX_PATH}${item.id}`)}
                            title={label}
                            className={cn(
                              'flex w-full flex-col gap-0.5 rounded-lg py-1 pl-6 pr-2 text-left transition-colors',
                              item.id === activeId
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
                      })}
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
