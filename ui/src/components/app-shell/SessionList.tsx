import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { Archive, Trash2 } from 'lucide-react';
import { cn, formatRelativeTime } from '../../lib/utils';
import { apiRequest, deleteSessions, fetchProjectSessions, setArchived } from '../../utils/api';
import { describeSkippedDeletes } from '../../utils/deleteFeedback';
import { useLongPress } from '../../utils/useLongPress';
import { useRowSelection } from '../../utils/useRowSelection';
import { useToast } from '../ui/Toast';
import { useProject } from '../../contexts/ProjectContext';
import ConfirmDialog from '../ui/ConfirmDialog';
import RowCheckbox from '../ui/RowCheckbox';
import SelectionActionBar from './SelectionActionBar';
import type { Session } from '../../types/session';
import Spinner from '../ui/Spinner';
import SessionContextMenu from './SessionContextMenu';

interface SessionListProps {
  projectId: string;
  onSessionSelect: (sessionId: string) => void;
  /** Ask the shell to re-fetch the archive after an archive action. */
  onChanged?: () => void;
}

export default function SessionList({ projectId, onSessionSelect, onChanged }: SessionListProps) {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const { showToast } = useToast();
  const { sessionsRefreshKey } = useProject();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [contextMenu, setContextMenu] = useState<{ session: Session; x: number; y: number } | null>(
    null,
  );
  const [confirmDeleteSession, setConfirmDeleteSession] = useState<Session | null>(null);
  /** Batch delete pending confirmation — null when the dialog is closed. */
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const selection = useRowSelection();
  /** Full-title tooltip, positioned at the title's vertical level. */
  const [tip, setTip] = useState<{ title: string; left: number; top: number } | null>(null);
  const tipHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchSessions = useCallback(
    async (showSpinner = false) => {
      if (!projectId) return;
      try {
        if (showSpinner) setLoading(true);
        const page = await fetchProjectSessions(projectId);
        const fresh = page.items ?? [];
        setSessions((prev) => {
          // Keep rows pulled in with 加载更多 while the first page is unchanged —
          // the poll must not silently undo the operator's paging every 30 s. The
          // moment page one differs (new chat, rename, archived elsewhere) the
          // whole list is replaced, so a row that left the project cannot linger
          // just because it was once loaded past the boundary.
          const unchangedHead =
            prev.length >= fresh.length && fresh.every((row, i) => prev[i]?.id === row.id);
          return unchangedHead && prev.length > fresh.length
            ? [...fresh, ...prev.slice(fresh.length)]
            : fresh;
        });
        setHasMore(page.hasMore ?? false);
      } catch {
        /* silent */
      } finally {
        setLoading(false);
      }
    },
    [projectId],
  );

  /** Next page, continuing after the last row the operator can see. */
  const loadMore = useCallback(async () => {
    const last = sessions[sessions.length - 1];
    if (!last || loadingMore) return;
    setLoadingMore(true);
    try {
      // The cursor is the pair `(updated_at, id)` — see `sessionCursorWhere`.
      const page = await fetchProjectSessions(projectId, {
        before: last.updated_at as number,
        beforeId: last.id,
      });
      setSessions((prev) => {
        const seen = new Set(prev.map((s) => s.id));
        return [...prev, ...(page.items ?? []).filter((s) => !seen.has(s.id))];
      });
      setHasMore(page.hasMore ?? false);
    } catch {
      /* keep the rows we already have */
    } finally {
      setLoadingMore(false);
    }
  }, [projectId, sessions, loadingMore]);

  useEffect(() => {
    fetchSessions(true);
  }, [fetchSessions]);

  // Refetch when a session is created from outside (e.g. ProjectList + button)
  useEffect(() => {
    fetchSessions(false);
  }, [sessionsRefreshKey, fetchSessions]);

  // Poll every 30s to keep relative times accurate and catch new/updated sessions
  useEffect(() => {
    const timer = setInterval(() => {
      fetchSessions(false);
    }, 30000);
    return () => clearInterval(timer);
  }, [fetchSessions]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenu]);

  useEffect(
    () => () => {
      if (tipHideTimer.current) clearTimeout(tipHideTimer.current);
    },
    [],
  );

  const showTip = useCallback((title: string, rect: DOMRect) => {
    if (tipHideTimer.current) {
      clearTimeout(tipHideTimer.current);
      tipHideTimer.current = null;
    }
    // Align with the title text (dot 12px + gap 8px + row padding 8px), same line.
    setTip({ title, left: rect.left + 28, top: rect.top + 2 });
  }, []);

  const hideTip = useCallback(() => {
    if (tipHideTimer.current) clearTimeout(tipHideTimer.current);
    tipHideTimer.current = setTimeout(() => setTip(null), 120);
  }, []);

  const handleNewSession = async () => {
    try {
      const baseTitle = t('chat.newSession');
      const s = await apiRequest<Session>(`/api/projects/${projectId}/sessions`, {
        method: 'POST',
        body: JSON.stringify({ baseTitle }),
      });
      setSessions((prev) => [s, ...prev]);
      onSessionSelect(s.id);
    } catch {
      showToast(t('project.createError'), 'error');
    }
  };

  const handleDelete = (sid: string) => {
    setContextMenu(null);
    const session = sessions.find((s) => s.id === sid);
    if (session) setConfirmDeleteSession(session);
  };

  const doDeleteSession = async () => {
    const s = confirmDeleteSession;
    if (!s) return;
    try {
      await apiRequest(`/api/projects/${projectId}/sessions/${s.id}`, { method: 'DELETE' });
      setSessions((prev) => prev.filter((ss) => ss.id !== s.id));
      if (sessionId === s.id) navigate(`/p/${projectId}`);
      showToast(t('project.deleted'), 'success');
    } catch (err: any) {
      showToast(err?.message || t('project.deleteError'), 'error');
    }
    setConfirmDeleteSession(null);
  };

  const commitRename = async (sid: string) => {
    if (!renameDraft.trim()) {
      setRenamingId(null);
      return;
    }
    try {
      await apiRequest(`/api/projects/${projectId}/sessions/${sid}/title`, {
        method: 'PUT',
        body: JSON.stringify({ title: renameDraft.trim() }),
      });
      fetchSessions();
    } catch {
      /* silent */
    }
    setRenamingId(null);
  };

  const sessionTitle = (s: Session): string => {
    if (s.title) return s.title;
    if (s.metadata && (s.metadata as any).title) return (s.metadata as any).title;
    return t('chat.newSession');
  };

  // Placement (and its viewport clamp) lives in the menu component so the IM
  // inbox gets identical behaviour without copying the arithmetic.
  const openContextMenu = useCallback((s: Session, cx: number, cy: number) => {
    setContextMenu({ session: s, x: cx, y: cy });
  }, []);

  /**
   * Archive one conversation or a batch: the rows leave the project's session
   * list and reappear under 归档, grouped by this project. Nothing about the
   * transcript changes, and the next message sent into it restores it.
   */
  const archive = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      setArchiving(true);
      try {
        const res = await setArchived(ids, true);
        const moved = new Set(ids);
        setSessions((prev) => prev.filter((s) => !moved.has(s.id)));
        showToast(t('archive.archived', { count: res.updated }), 'success');
        selection.exit();
        onChanged?.();
        fetchSessions(false);
      } catch (err) {
        showToast(err instanceof Error ? err.message : t('archive.archiveError'), 'error');
      } finally {
        setArchiving(false);
      }
    },
    [fetchSessions, onChanged, selection, showToast, t],
  );

  /** Delete a selected batch from this project's session list. */
  const deleteBatch = useCallback(
    async (ids: string[]) => {
      setConfirmBatchDelete(false);
      if (ids.length === 0) return;
      setDeleting(true);
      try {
        const res = await deleteSessions(ids);
        const removed = new Set(ids.filter((id) => !res.skipped.some((s) => s.id === id)));
        setSessions((prev) => prev.filter((s) => !removed.has(s.id)));
        showToast(t('selection.deleted', { count: res.deleted }), 'success');
        const partial = describeSkippedDeletes(t, res.skipped);
        if (partial) showToast(partial, 'warning', 4000);
        selection.exit();
        onChanged?.();
        if (sessionId && removed.has(sessionId)) navigate(`/p/${projectId}`);
        fetchSessions(false);
      } catch (err) {
        showToast(err instanceof Error ? err.message : t('selection.deleteError'), 'error');
      } finally {
        setDeleting(false);
      }
    },
    [fetchSessions, navigate, onChanged, projectId, selection, sessionId, showToast, t],
  );

  const loadedIds = useMemo(() => sessions.map((s) => s.id), [sessions]);

  return (
    <div className="mt-2 ml-6 space-y-0.5">
      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={confirmDeleteSession !== null}
        title={t('sidebar.delete')}
        message={t('project.confirmDeleteSession', {
          name: confirmDeleteSession ? sessionTitle(confirmDeleteSession) : '',
        })}
        confirmLabel={t('sidebar.delete')}
        onConfirm={doDeleteSession}
        onCancel={() => setConfirmDeleteSession(null)}
      />
      <ConfirmDialog
        open={confirmBatchDelete}
        title={t('selection.delete')}
        message={t('selection.confirmDelete', { count: selection.count })}
        confirmLabel={t('selection.delete')}
        onConfirm={() => void deleteBatch([...selection.selected])}
        onCancel={() => setConfirmBatchDelete(false)}
      />

      <div className="flex items-center px-2 pb-1">
        <span className="flex-1 text-[11px] font-medium uppercase tracking-[0.04em] text-neutral-500/90 dark:text-neutral-400/80">
          {t('sidebar.sessions')}
        </span>
        <button
          type="button"
          onClick={handleNewSession}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          aria-label={t('sidebar.newSession')}
          title={t('sidebar.newSession')}
        >
          <span className="text-sm leading-none">+</span>
        </button>
      </div>

      {selection.selecting && (
        <SelectionActionBar
          count={selection.count}
          loadedIds={loadedIds}
          selectedIds={selection.selected}
          onSetMany={selection.setMany}
          onExit={selection.exit}
          busy={archiving || deleting}
          actions={[
            {
              label: t('sidebar.archive'),
              icon: Archive,
              onClick: () => void archive([...selection.selected]),
            },
            {
              label: t('selection.delete'),
              icon: Trash2,
              danger: true,
              onClick: () => setConfirmBatchDelete(true),
            },
          ]}
        />
      )}

      {loading ? (
        <div className="px-2 py-3 flex justify-center">
          <Spinner size="sm" />
        </div>
      ) : sessions.length === 0 ? (
        <div className="px-2 py-1 text-[11px] text-neutral-500 dark:text-neutral-400">
          {t('sidebar.noSessions')}
        </div>
      ) : (
        sessions.map((s) => {
          const isActive = sessionId === s.id;
          const isRenaming = renamingId === s.id;
          const title = sessionTitle(s);
          return (
            <SessionRow
              key={s.id}
              session={s}
              isActive={isActive}
              isRenaming={isRenaming}
              title={title}
              renameDraft={isRenaming ? renameDraft : ''}
              selecting={selection.selecting}
              selected={selection.selected.has(s.id)}
              onToggleSelected={() => selection.toggle(s.id)}
              onLongPress={(cx, cy) => openContextMenu(s, cx, cy)}
              onSelect={() =>
                selection.selecting ? selection.toggle(s.id) : onSessionSelect(s.id)
              }
              onDelete={() => handleDelete(s.id)}
              onRenameDraftChange={setRenameDraft}
              onRenameCommit={() => commitRename(s.id)}
              onRenameCancel={() => setRenamingId(null)}
              onTipEnter={showTip}
              onTipLeave={hideTip}
            />
          );
        })
      )}

      {hasMore && sessions.length > 0 && (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className="flex h-6 w-full items-center justify-center rounded-md px-2 text-[11px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          {loadingMore ? t('common.loading') : t('sidebar.loadMore')}
        </button>
      )}

      {contextMenu && (
        <SessionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onRename={() => {
            setRenamingId(contextMenu.session.id);
            setRenameDraft(sessionTitle(contextMenu.session));
            setContextMenu(null);
          }}
          onArchive={() => {
            const id = contextMenu.session.id;
            setContextMenu(null);
            void archive([id]);
          }}
          onSelectMultiple={() => {
            selection.enter(contextMenu.session.id);
            setContextMenu(null);
          }}
          onDelete={() => handleDelete(contextMenu.session.id)}
        />
      )}

      {/* Full-title tooltip — one line at the title's level, theme-aware.
          Fixed so it escapes the sidebar scroll container's clipping. */}
      {tip && (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-[70] whitespace-nowrap rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-[12.5px] leading-snug text-neutral-900 shadow-lg dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100"
          style={{ left: tip.left, top: tip.top }}
        >
          {tip.title}
        </div>
      )}
    </div>
  );
}

// ── Session row with long-press support ──

function SessionRow({
  session,
  isActive,
  isRenaming,
  title,
  renameDraft,
  selecting,
  selected,
  onToggleSelected,
  onLongPress,
  onSelect,
  onDelete,
  onRenameDraftChange,
  onRenameCommit,
  onRenameCancel,
  onTipEnter,
  onTipLeave,
}: {
  session: Session;
  isActive: boolean;
  isRenaming: boolean;
  title: string;
  renameDraft: string;
  selecting: boolean;
  selected: boolean;
  onToggleSelected: () => void;
  onLongPress: (cx: number, cy: number) => void;
  onSelect: () => void;
  onDelete: () => void;
  onRenameDraftChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onTipEnter: (title: string, rect: DOMRect) => void;
  onTipLeave: () => void;
}) {
  const longPressProps = useLongPress((e) => {
    const cx =
      'touches' in e
        ? (e.touches[0]?.clientX ?? (e as any).changedTouches?.[0]?.clientX ?? 100)
        : (e as React.MouseEvent).clientX;
    const cy =
      'touches' in e
        ? (e.touches[0]?.clientY ?? (e as any).changedTouches?.[0]?.clientY ?? 100)
        : (e as React.MouseEvent).clientY;
    onLongPress(cx, cy);
  });
  const titleRef = useRef<HTMLDivElement>(null);

  return (
    <div
      {...longPressProps}
      onMouseEnter={(e) => {
        if (isRenaming) return;
        // Only show the full-title tooltip when the title is actually
        // truncated (ends with "…") — short titles are fully visible.
        const el = titleRef.current;
        if (el && el.scrollWidth > el.clientWidth) {
          onTipEnter(title, e.currentTarget.getBoundingClientRect());
        }
      }}
      onMouseLeave={onTipLeave}
      className={cn(
        // sidebar-row opts out of the iOS/Android callout menu that appears on
        // long press — it would sit on top of the menu this press opens.
        'sidebar-row group/session relative w-full rounded-md transition-colors',
        isActive || selected
          ? 'bg-neutral-200/70 dark:bg-neutral-800'
          : 'hover:bg-neutral-100 dark:hover:bg-neutral-800',
      )}
    >
      {isRenaming ? (
        <div className="flex items-center px-2 py-1">
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
            className="w-full rounded-sm border border-neutral-300 bg-white px-1.5 py-0.5 text-[12.5px] text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={onSelect}
          className="flex w-full items-start gap-2 px-2 py-1 text-left"
        >
          <span className="flex h-[18px] w-3 shrink-0 items-center justify-center pt-[3px]">
            {selecting ? (
              <RowCheckbox checked={selected} onChange={onToggleSelected} />
            ) : (
              <span className="block h-1.5 w-1.5 rounded-full bg-neutral-300 dark:bg-neutral-600" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div
              ref={titleRef}
              className="truncate text-[12.5px] text-neutral-900 dark:text-neutral-100"
            >
              {title}
            </div>
            <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
              {formatRelativeTime(session.updated_at)}
            </div>
          </div>
        </button>
      )}
      {!isRenaming && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className={cn(
            'absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-6 w-6 items-center justify-center rounded-md transition-opacity',
            'text-neutral-500 hover:bg-neutral-200/70 hover:text-red-600 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-red-400',
            // Hidden while picking rows: the row's hit area belongs to the
            // checkbox then, and a delete button next to a multi-select tick is
            // one mis-tap away from a different, destructive outcome.
            selecting
              ? 'hidden'
              : isActive
                ? 'opacity-100'
                : 'opacity-0 group-hover/session:opacity-100',
          )}
        >
          <Trash2 className="h-3 w-3" strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}
