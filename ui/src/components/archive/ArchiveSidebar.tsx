import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Archive as ArchiveIcon,
  ArchiveRestore,
  ChevronDown,
  Inbox as InboxIcon,
  MessageSquare,
  Trash2,
} from 'lucide-react';
import { cn, formatRelativeTime } from '../../lib/utils';
import { deleteSessions, fetchArchive, setArchived } from '../../utils/api';
import { describeSkippedDeletes } from '../../utils/deleteFeedback';
import { useLongPress } from '../../utils/useLongPress';
import { useRowSelection } from '../../utils/useRowSelection';
import Spinner from '../ui/Spinner';
import ConfirmDialog from '../ui/ConfirmDialog';
import SessionContextMenu from '../app-shell/SessionContextMenu';
import SelectionActionBar from '../app-shell/SelectionActionBar';
import RowCheckbox from '../ui/RowCheckbox';
import { useToast } from '../ui/Toast';
import type { ArchiveGroup, ArchivedSessionSummary, ArchiveOwnerCount } from '../../types/archive';
import { archivedItemLabel, archivedIds, groupArchivedItems } from './archiveModel';

/** Rows per archive page (the endpoint accepts 1..200). */
const PAGE_SIZE = 50;
/**
 * Refresh cadence. The archive is not churny, but it is not static either: an
 * incoming IM message auto-restores an archived conversation, which has to
 * disappear from here without a manual reload.
 */
const POLL_MS = 60_000;

interface ArchiveSidebarProps {
  /** Bumped by the shell when projects/sessions/inbox change. */
  refreshKey?: number;
  /** Ask the shell to re-fetch the live lists after an archive/restore. */
  onChanged: () => void;
}

/**
 * 归档 — the section below 收件箱 in the sidebar.
 *
 * Contents are grouped by the ownership the conversation had *before* it was
 * archived: project chats stay under their project, IM transcripts stay under
 * their channel (with the bot's name when known). Archiving therefore never
 * forces the user to learn a second filing system — the archive is a shelf, not
 * a new taxonomy.
 *
 * Archived conversations are fully readable: selecting one navigates into the
 * normal transcript view. Sending a new message there un-archives it (a turn
 * means it is active again), which is also what happens when an IM chat receives
 * a message.
 */
export default function ArchiveSidebar({ refreshKey, onChanged }: ArchiveSidebarProps) {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const location = useLocation();
  const { showToast } = useToast();

  const [items, setItems] = useState<ArchivedSessionSummary[]>([]);
  const [owners, setOwners] = useState<ArchiveOwnerCount[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** Batch/row delete awaiting confirmation; `ids` is what will be deleted. */
  const [confirmDelete, setConfirmDelete] = useState<{
    ids: string[];
    label: string | null;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    item: ArchivedSessionSummary;
    x: number;
    y: number;
  } | null>(null);

  const selection = useRowSelection();

  // The section defaults to collapsed: the archive is a shelf you visit on
  // purpose, not a list to scroll past on the way to a live conversation. An
  // explicit toggle (stored as 'true'/'false') wins over the default.
  const [sectionOpen, setSectionOpen] = useState(() => {
    try {
      return localStorage.getItem('oma-sidebar-archive-open') === 'true';
    } catch {
      return false;
    }
  });
  const [collapsedKinds, setCollapsedKinds] = useState<Set<'project' | 'inbox'>>(() => new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());

  const toggleSection = useCallback(() => {
    setSectionOpen((open) => {
      const next = !open;
      try {
        localStorage.setItem('oma-sidebar-archive-open', String(next));
      } catch {
        /* noop */
      }
      return next;
    });
  }, []);

  const toggleKind = useCallback((kind: 'project' | 'inbox') => {
    setCollapsedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }, []);

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const fetchFirstPage = useCallback(async (showSpinner = false) => {
    try {
      if (showSpinner) setLoading(true);
      const page = await fetchArchive({ limit: PAGE_SIZE });
      setItems(page.items ?? []);
      setOwners(page.owners ?? []);
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

  // The shell bumps `refreshKey` whenever a project/session/inbox list changed,
  // which is exactly when the archive may have gained or lost rows.
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
    const last = items[items.length - 1];
    if (last === undefined || loadingMore) return;
    setLoadingMore(true);
    try {
      // Cursor is the pair `(updated_at, id)`, the list's own sort key — a batch
      // archive stamps every row with one timestamp, so the id is what keeps the
      // rest of such a group reachable.
      const page = await fetchArchive({
        limit: PAGE_SIZE,
        before: last.updated_at,
        beforeId: last.id,
      });
      setItems((prev) => {
        // Cursor paging over a live table can repeat a row — dedupe by id.
        const seen = new Set(prev.map((item) => item.id));
        return [...prev, ...(page.items ?? []).filter((item) => !seen.has(item.id))];
      });
      setOwners(page.owners ?? []);
      setHasMore(page.hasMore ?? false);
    } catch {
      /* keep the rows we already have */
    } finally {
      setLoadingMore(false);
    }
  }, [items, loadingMore]);

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

  /** Restore a batch and refresh both this list and the live lists. */
  const restore = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      setBusy(true);
      try {
        const res = await setArchived(ids, false);
        // Drop the rows locally first so the sidebar responds immediately; the
        // refresh below reconciles against the server.
        const restored = new Set(ids);
        setItems((prev) => prev.filter((row) => !restored.has(row.id)));
        showToast(t('archive.restored', { count: res.updated }), 'success');
        selection.exit();
        onChanged();
        void fetchFirstPage(false);
      } catch (err) {
        showToast(err instanceof Error ? err.message : t('archive.restoreError'), 'error');
      } finally {
        setBusy(false);
      }
    },
    [fetchFirstPage, onChanged, selection, showToast, t],
  );

  /**
   * Delete archived conversations outright.
   *
   * Archiving is reversible; deleting is not, which is exactly why the archive
   * needs it: the alternative is "unarchive, hunt the row down in its own list,
   * then delete", which is a detour through a list the operator was trying to
   * stop looking at.
   */
  const remove = useCallback(
    async (ids: string[]) => {
      setConfirmDelete(null);
      if (ids.length === 0) return;
      setDeleting(true);
      try {
        const res = await deleteSessions(ids);
        const gone = new Set(ids.filter((id) => !res.skipped.some((s) => s.id === id)));
        setItems((prev) => prev.filter((row) => !gone.has(row.id)));
        showToast(t('selection.deleted', { count: res.deleted }), 'success');
        const partial = describeSkippedDeletes(t, res.skipped);
        if (partial) showToast(partial, 'warning', 4000);
        selection.exit();
        onChanged();
        void fetchFirstPage(false);
      } catch (err) {
        showToast(err instanceof Error ? err.message : t('selection.deleteError'), 'error');
      } finally {
        setDeleting(false);
      }
    },
    [fetchFirstPage, onChanged, selection, showToast, t],
  );

  /** Row target: archived conversations open in their own normal view. */
  const itemPath = useCallback((item: ArchivedSessionSummary) => {
    return item.project_id === null
      ? '/inbox/' + encodeURIComponent(item.id)
      : '/p/' + encodeURIComponent(item.project_id) + '/s/' + encodeURIComponent(item.id);
  }, []);

  const groups = useMemo(() => groupArchivedItems(t, items, owners), [t, items, owners]);
  const loadedIds = useMemo(() => archivedIds(items), [items]);

  // Total from the server-side owner counts, so a paged list still shows the
  // real number of archived conversations.
  const total = useMemo(() => {
    if (owners.length > 0) return owners.reduce((sum, owner) => sum + owner.count, 0);
    return items.length;
  }, [owners, items]);

  const kindCount = useCallback(
    (kind: 'project' | 'inbox') =>
      owners.filter((owner) => owner.kind === kind).reduce((sum, owner) => sum + owner.count, 0),
    [owners],
  );

  const rowLabel = useCallback(
    (item: ArchivedSessionSummary) => archivedItemLabel(t, item, t('inbox.emptySession')),
    [t],
  );

  const renderRows = (group: ArchiveGroup) => {
    const collapsed = collapsedGroups.has(group.key);
    const ids = archivedIds(group.items);
    const allSelected = selection.allSelected(ids);
    const someSelected = selection.someSelected(ids);
    return (
      <div key={group.key}>
        <button
          type="button"
          onClick={() =>
            selection.selecting ? selection.setMany(ids, !allSelected) : toggleGroup(group.key)
          }
          aria-expanded={!collapsed}
          title={group.label}
          className="flex h-6 w-full items-center gap-1 rounded-md px-2 text-[11px] font-medium text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          {selection.selecting ? (
            <RowCheckbox
              checked={allSelected}
              indeterminate={!allSelected && someSelected}
              onChange={() => selection.setMany(ids, !allSelected)}
            />
          ) : (
            <ChevronDown
              className={cn(
                'h-3 w-3 shrink-0 transition-transform duration-200',
                collapsed ? '-rotate-90' : '',
              )}
              strokeWidth={1.75}
            />
          )}
          <span className="truncate">{group.label}</span>
          <span className="ml-auto shrink-0 tabular-nums">{group.total}</span>
        </button>

        {!collapsed &&
          group.items.map((item) => (
            <ArchiveRow
              key={item.id}
              item={item}
              label={rowLabel(item)}
              active={location.pathname === itemPath(item)}
              selecting={selection.selecting}
              selected={selection.selected.has(item.id)}
              onToggle={() => selection.toggle(item.id)}
              onOpenMenu={(x, y) => setContextMenu({ item, x, y })}
              onSelect={() =>
                selection.selecting ? selection.toggle(item.id) : navigate(itemPath(item))
              }
            />
          ))}
      </div>
    );
  };

  const renderKind = (kind: 'project' | 'inbox', list: ArchiveGroup[]) => {
    if (list.length === 0) return null;
    const collapsed = collapsedKinds.has(kind);
    const ids = list.flatMap((group) => archivedIds(group.items));
    const allSelected = selection.allSelected(ids);
    const someSelected = selection.someSelected(ids);
    const KindIcon = kind === 'project' ? MessageSquare : InboxIcon;
    return (
      <div className="mt-0.5">
        <button
          type="button"
          onClick={() =>
            selection.selecting ? selection.setMany(ids, !allSelected) : toggleKind(kind)
          }
          aria-expanded={!collapsed}
          className="flex h-6 w-full items-center gap-1.5 rounded-md pl-2 pr-2 text-[11px] font-medium text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          {selection.selecting ? (
            <RowCheckbox
              checked={allSelected}
              indeterminate={!allSelected && someSelected}
              onChange={() => selection.setMany(ids, !allSelected)}
            />
          ) : (
            <ChevronDown
              className={cn(
                'h-3 w-3 shrink-0 transition-transform duration-200',
                collapsed ? '-rotate-90' : '',
              )}
              strokeWidth={1.75}
            />
          )}
          <KindIcon className="h-3 w-3 shrink-0 opacity-70" strokeWidth={1.75} />
          <span className="truncate">
            {kind === 'project' ? t('archive.kindProject') : t('archive.kindInbox')}
          </span>
          <span className="ml-auto shrink-0 tabular-nums">{kindCount(kind)}</span>
        </button>
        {!collapsed && <div className="pl-1">{list.map(renderRows)}</div>}
      </div>
    );
  };

  if (!loading && items.length === 0) {
    // Nothing archived yet: the section still renders (so the operator can see
    // that the feature exists and where conversations will land), one line tall.
    return (
      <section className="mt-2 border-t border-neutral-200/70 pt-1 dark:border-neutral-800/70">
        <SectionHeader
          open={sectionOpen}
          total={0}
          onToggle={toggleSection}
          label={t('archive.title')}
        />
        {sectionOpen && (
          <div className="px-3 py-1 text-[11px] text-neutral-500 dark:text-neutral-400">
            {failed ? t('archive.loadError') : t('archive.empty')}
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="mt-2 border-t border-neutral-200/70 pt-1 dark:border-neutral-800/70">
      {contextMenu && (
        <SessionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onRestore={() => {
            const id = contextMenu.item.id;
            setContextMenu(null);
            void restore([id]);
          }}
          onDelete={() => {
            const { item } = contextMenu;
            setContextMenu(null);
            setConfirmDelete({ ids: [item.id], label: rowLabel(item) });
          }}
          onSelectMultiple={() => {
            selection.enter(contextMenu.item.id);
            setContextMenu(null);
          }}
        />
      )}
      <ConfirmDialog
        open={confirmDelete !== null}
        title={t('selection.delete')}
        message={
          confirmDelete && confirmDelete.ids.length === 1
            ? t('inbox.confirmDelete', { name: confirmDelete.label ?? '' })
            : t('selection.confirmDelete', { count: confirmDelete?.ids.length ?? 0 })
        }
        confirmLabel={t('selection.delete')}
        onConfirm={() => {
          if (confirmDelete) void remove(confirmDelete.ids);
        }}
        onCancel={() => setConfirmDelete(null)}
      />
      <SectionHeader
        open={sectionOpen}
        total={total}
        onToggle={toggleSection}
        label={t('archive.title')}
      />

      {sectionOpen && (
        <div className="pb-1">
          {selection.selecting && (
            <SelectionActionBar
              count={selection.count}
              loadedIds={loadedIds}
              selectedIds={selection.selected}
              onSetMany={selection.setMany}
              onExit={selection.exit}
              busy={busy || deleting}
              actions={[
                {
                  label: t('archive.restore'),
                  icon: ArchiveRestore,
                  onClick: () => void restore([...selection.selected]),
                },
                {
                  label: t('selection.delete'),
                  icon: Trash2,
                  danger: true,
                  onClick: () => setConfirmDelete({ ids: [...selection.selected], label: null }),
                },
              ]}
            />
          )}

          {loading && items.length === 0 ? (
            <div className="flex justify-center px-2 py-2">
              <Spinner size="sm" />
            </div>
          ) : (
            <div className="space-y-0.5">
              {renderKind('project', groups.projects)}
              {renderKind('inbox', groups.inbox)}
              {hasMore && (
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className="flex h-6 w-full items-center justify-center rounded-md px-2 text-[11px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                >
                  {loadingMore ? t('common.loading') : t('archive.loadMore')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function SectionHeader({
  open,
  total,
  onToggle,
  label,
}: {
  open: boolean;
  total: number;
  onToggle: () => void;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1.5 px-2">
      <ArchiveIcon
        className="h-3.5 w-3.5 shrink-0 text-neutral-500/90 dark:text-neutral-400/80"
        strokeWidth={1.75}
      />
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md text-left text-[13px] font-medium uppercase tracking-[0.04em] text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
      >
        <span className="truncate">{label}</span>
        {total > 0 && (
          <span className="shrink-0 rounded-full bg-neutral-200/70 px-1.5 text-[10px] font-medium tabular-nums text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
            {total}
          </span>
        )}
        <ChevronDown
          className={cn(
            'ml-auto h-3.5 w-3.5 shrink-0 transition-transform duration-200',
            open ? '' : '-rotate-90',
          )}
          strokeWidth={1.75}
        />
      </button>
    </div>
  );
}

function ArchiveRow({
  item,
  label,
  active,
  selecting,
  selected,
  onToggle,
  onOpenMenu,
  onSelect,
}: {
  item: ArchivedSessionSummary;
  label: string;
  active: boolean;
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
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

  return (
    <button
      {...longPressProps}
      type="button"
      onClick={onSelect}
      title={label}
      className={cn(
        'sidebar-row flex w-full flex-col gap-0.5 rounded-lg py-1 pl-6 pr-2 text-left transition-colors',
        active || selected
          ? 'bg-neutral-200/70 dark:bg-neutral-800'
          : 'hover:bg-neutral-100 dark:hover:bg-neutral-800',
      )}
    >
      <span className="flex w-full items-center gap-1.5">
        {selecting && <RowCheckbox checked={selected} onChange={onToggle} />}
        <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-700 dark:text-neutral-300">
          {label}
        </span>
        <span className="shrink-0 text-[10.5px] text-neutral-400 dark:text-neutral-500">
          {/* Last activity, not `archived_at`: the row's time should answer
              "when was this conversation alive", which is the same question the
              project and inbox rows answer. Archive order is still by
              `archived_at` (the paging cursor). */}
          {formatRelativeTime(item.updated_at)}
        </span>
      </span>
      <span className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">
        {t('inbox.messageCount', { count: item.message_count })}
      </span>
    </button>
  );
}
