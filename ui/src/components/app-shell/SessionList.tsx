import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { Pencil, Trash2 } from 'lucide-react';
import { cn, formatRelativeTime } from '../../lib/utils';
import { apiRequest } from '../../utils/api';
import { useLongPress } from '../../utils/useLongPress';
import { useToast } from '../ui/Toast';
import ConfirmDialog from '../ui/ConfirmDialog';
import type { Session } from '../../types/session';
import Spinner from '../ui/Spinner';

interface SessionListProps {
  projectId: string;
  onSessionSelect: (sessionId: string) => void;
}

export default function SessionList({ projectId, onSessionSelect }: SessionListProps) {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const { sessionId } = useParams();
  const { showToast } = useToast();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [contextMenu, setContextMenu] = useState<{ session: Session; x: number; y: number } | null>(null);
  const [confirmDeleteSession, setConfirmDeleteSession] = useState<Session | null>(null);

  const fetchSessions = useCallback(async (showSpinner = false) => {
    if (!projectId) return;
    try { if (showSpinner) setLoading(true); const d = await apiRequest<Session[]>(`/api/projects/${projectId}/sessions`); setSessions(d); }
    catch { /* silent */ }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { fetchSessions(true); }, [fetchSessions]);

  // Poll every 30s to keep relative times accurate and catch new/updated sessions
  useEffect(() => {
    const timer = setInterval(() => { fetchSessions(false); }, 30000);
    return () => clearInterval(timer);
  }, [fetchSessions]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenu]);

  const handleNewSession = async () => {
    try {
      const s = await apiRequest<Session>(`/api/projects/${projectId}/sessions`, { method: 'POST' });
      setSessions(prev => [s, ...prev]);
      onSessionSelect(s.id);
    } catch { showToast(t('project.createError'), 'error'); }
  };

  const handleDelete = (sid: string) => {
    setContextMenu(null);
    const session = sessions.find(s => s.id === sid);
    if (session) setConfirmDeleteSession(session);
  };

  const doDeleteSession = async () => {
    const s = confirmDeleteSession;
    if (!s) return;
    try {
      await apiRequest(`/api/projects/${projectId}/sessions/${s.id}`, { method: 'DELETE' });
      setSessions(prev => prev.filter(ss => ss.id !== s.id));
      if (sessionId === s.id) navigate(`/p/${projectId}`);
      showToast(t('project.deleted'), 'success');
    } catch (err: any) {
      showToast(err?.message || t('project.deleteError'), 'error');
    }
    setConfirmDeleteSession(null);
  };

  const commitRename = async (sid: string) => {
    if (!renameDraft.trim()) { setRenamingId(null); return; }
    try { await apiRequest(`/api/projects/${projectId}/sessions/${sid}/title`, { method: 'PUT', body: JSON.stringify({ title: renameDraft.trim() }) }); fetchSessions(); }
    catch { /* silent */ }
    setRenamingId(null);
  };

  const sessionTitle = (s: Session): string => {
    if (s.title) return s.title;
    if (s.metadata && (s.metadata as any).title) return (s.metadata as any).title;
    return t('chat.newSession');
  };

  const openContextMenu = useCallback((s: Session, cx: number, cy: number) => {
    setContextMenu({ session: s, x: Math.min(cx, window.innerWidth - 180), y: Math.min(cy, window.innerHeight - 90) });
  }, []);

  return (
    <div className="mt-2 ml-6 space-y-0.5">
      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={confirmDeleteSession !== null}
        title={t('sidebar.delete')}
        message={t('project.confirmDeleteSession', { name: confirmDeleteSession ? sessionTitle(confirmDeleteSession) : '' })}
        confirmLabel={t('sidebar.delete')}
        onConfirm={doDeleteSession}
        onCancel={() => setConfirmDeleteSession(null)}
      />

      <div className="flex items-center px-2 pb-1">
        <span className="flex-1 text-[11px] font-medium uppercase tracking-[0.04em] text-neutral-500/90 dark:text-neutral-400/80">
          {t('sidebar.sessions')}
        </span>
        <button type="button" onClick={handleNewSession}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          aria-label={t('sidebar.newSession')} title={t('sidebar.newSession')}>
          <span className="text-sm leading-none">+</span>
        </button>
      </div>

      {loading ? (
        <div className="px-2 py-3 flex justify-center"><Spinner size="sm" /></div>
      ) : sessions.length === 0 ? (
        <div className="px-2 py-1 text-[11px] text-neutral-500 dark:text-neutral-400">{t('sidebar.noSessions')}</div>
      ) : (
        sessions.map(s => {
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
              onLongPress={(cx, cy) => openContextMenu(s, cx, cy)}
              onSelect={() => onSessionSelect(s.id)}
              onDelete={() => handleDelete(s.id)}
              onRenameDraftChange={setRenameDraft}
              onRenameCommit={() => commitRename(s.id)}
              onRenameCancel={() => setRenamingId(null)}
            />
          );
        })
      )}

      {contextMenu && (
        <div role="menu" onClick={e => e.stopPropagation()}
          className="fixed z-50 w-44 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
          style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button type="button" role="menuitem" onClick={() => { setRenamingId(contextMenu.session.id); setRenameDraft(sessionTitle(contextMenu.session)); setContextMenu(null); }}
            className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-neutral-800 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800">
            <Pencil className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
            <span>{t('sidebar.rename')}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => handleDelete(contextMenu.session.id)}
            className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40">
            <Trash2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            <span>{t('sidebar.delete')}</span>
          </button>
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
  onLongPress,
  onSelect,
  onDelete,
  onRenameDraftChange,
  onRenameCommit,
  onRenameCancel,
}: {
  session: Session;
  isActive: boolean;
  isRenaming: boolean;
  title: string;
  renameDraft: string;
  onLongPress: (cx: number, cy: number) => void;
  onSelect: () => void;
  onDelete: () => void;
  onRenameDraftChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
}) {
  const longPressProps = useLongPress((e) => {
    const cx = 'touches' in e
      ? (e.touches[0]?.clientX ?? (e as any).changedTouches?.[0]?.clientX ?? 100)
      : (e as React.MouseEvent).clientX;
    const cy = 'touches' in e
      ? (e.touches[0]?.clientY ?? (e as any).changedTouches?.[0]?.clientY ?? 100)
      : (e as React.MouseEvent).clientY;
    onLongPress(cx, cy);
  });

  return (
    <div
      {...longPressProps}
      className={cn('group/session relative w-full rounded-md transition-colors', isActive ? 'bg-neutral-200/70 dark:bg-neutral-800' : 'hover:bg-neutral-100 dark:hover:bg-neutral-800')}>
      {isRenaming ? (
        <div className="flex items-center px-2 py-1">
          <input autoFocus value={renameDraft} onChange={e => onRenameDraftChange(e.target.value)} onBlur={onRenameCommit}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onRenameCommit(); } if (e.key === 'Escape') onRenameCancel(); }}
            className="w-full rounded-sm border border-neutral-300 bg-white px-1.5 py-0.5 text-[12.5px] text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100" />
        </div>
      ) : (
        <button type="button" onClick={onSelect} className="flex w-full items-start gap-2 px-2 py-1 text-left">
          <span className="flex h-[18px] w-3 shrink-0 items-center justify-center pt-[3px]">
            <span className="block h-1.5 w-1.5 rounded-full bg-neutral-300 dark:bg-neutral-600" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] text-neutral-900 dark:text-neutral-100">{title}</div>
            <div className="text-[11px] text-neutral-500 dark:text-neutral-400">{formatRelativeTime(session.updated_at)}</div>
          </div>
        </button>
      )}
      {!isRenaming && (
        <button type="button" onClick={e => { e.stopPropagation(); onDelete(); }}
          className={cn('absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-6 w-6 items-center justify-center rounded-md transition-opacity',
            'text-neutral-500 hover:bg-neutral-200/70 hover:text-red-600 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-red-400',
            isActive ? 'opacity-100' : 'opacity-0 group-hover/session:opacity-100')}>
          <Trash2 className="h-3 w-3" strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}
