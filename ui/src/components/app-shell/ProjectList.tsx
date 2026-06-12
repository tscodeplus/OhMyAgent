import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Folder,
  MessageSquarePlus,
  Plus,
  Pencil,
  Trash2,
  MoreHorizontal,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { apiRequest } from '../../utils/api';
import { useLongPress } from '../../utils/useLongPress';
import { useProject } from '../../contexts/ProjectContext';
import { useToast } from '../ui/Toast';
import SessionList from './SessionList';
import ConfirmDialog from '../ui/ConfirmDialog';
import type { Project } from '../../types/project';
import type { Session } from '../../types/session';
import Spinner from '../ui/Spinner';

interface ProjectListProps {
  refreshKey?: number;
  onRefresh: () => void;
  onCreateProject: () => void;
}

export default function ProjectList({ refreshKey, onRefresh, onCreateProject }: ProjectListProps) {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const { projectId } = useParams();
  const { selectedProjectId, setSelectedProjectId, setSelectedSessionId, bumpSessionsRefreshKey } = useProject();
  const { showToast } = useToast();

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [contextMenu, setContextMenu] = useState<{ project: Project; x: number; y: number } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteProject, setConfirmDeleteProject] = useState<Project | null>(null);

  // Ref to suppress auto-expand during user-initiated navigation
  const userNavigating = useRef(false);

  const fetchProjects = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiRequest<Project[]>('/api/projects');
      setProjects(data);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchProjects(); }, [fetchProjects, refreshKey]);

  // Auto-expand from URL param (direct navigation / page refresh only)
  useEffect(() => {
    if (userNavigating.current) {
      userNavigating.current = false;
      return;
    }
    if (projectId) {
      setExpandedGroups(prev => {
        if (prev.has(projectId)) return prev;
        const next = new Set(prev);
        next.add(projectId);
        return next;
      });
    }
  }, [projectId]);

  // Close context menu
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', close as any);
    };
  }, [contextMenu]);

  const toggleExpanded = (name: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  };

  const handleSelectProject = (proj: Project) => {
    const isCurrentProject = (projectId || selectedProjectId) === proj.id;

    if (isCurrentProject) {
      // Toggle expansion only — don't navigate (already here)
      toggleExpanded(proj.id);
      return;
    }

    // Different project: toggle its expansion and navigate
    userNavigating.current = true;
    setSelectedProjectId(proj.id);
    setSelectedSessionId(null);
    toggleExpanded(proj.id);
    navigate(`/p/${proj.id}`);
  };

  const handleNewSession = async (e: React.MouseEvent, proj: Project) => {
    e.stopPropagation();
    try {
      const baseTitle = t('chat.newSession');
      const s = await apiRequest<Session>(`/api/projects/${proj.id}/sessions`, {
        method: 'POST',
        body: JSON.stringify({ baseTitle }),
      });
      setSelectedProjectId(proj.id);
      setSelectedSessionId(s.id);
      bumpSessionsRefreshKey();
      navigate(`/p/${proj.id}/s/${s.id}`);
    } catch { /* silent */ }
  };

  const commitRename = async () => {
    if (!renamingId || !renameDraft.trim()) {
      setRenamingId(null);
      return;
    }
    try {
      await apiRequest(`/api/projects/${renamingId}`, {
        method: 'PUT',
        body: JSON.stringify({ name: renameDraft.trim() }),
      });
      fetchProjects();
      onRefresh();
    } catch { showToast(t('project.renameError'), 'error'); }
    setRenamingId(null);
  };

  const handleDelete = (proj: Project) => {
    setContextMenu(null);
    setConfirmDeleteProject(proj);
  };

  const doDeleteProject = async () => {
    const proj = confirmDeleteProject;
    if (!proj) return;
    try {
      await apiRequest(`/api/projects/${proj.id}`, { method: 'DELETE' });
      showToast(t('project.deleted'), 'success');
      if (selectedProjectId === proj.id) {
        setSelectedProjectId(null);
        navigate('/');
      }
      fetchProjects();
    } catch { showToast(t('project.deleteError'), 'error'); }
    setDeletingId(null);
    setConfirmDeleteProject(null);
  };

  const allExpanded = projects.length > 0 && projects.every(p => expandedGroups.has(p.id));

  return (
    <section className="pt-2">
      <div className="flex items-center px-3 pb-1">
        <span className="flex-1 text-[11px] font-medium uppercase tracking-[0.04em] text-neutral-500/90 dark:text-neutral-400/80">
          {t('sidebar.projects')}
        </span>
        <button
          type="button"
          onClick={() => {
            if (allExpanded) {
              setExpandedGroups(new Set());
            } else {
              setExpandedGroups(new Set(projects.map(p => p.id)));
            }
          }}
          disabled={projects.length === 0}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          aria-label={allExpanded ? 'Collapse all' : 'Expand all'}
        >
          {allExpanded ? <ChevronsDownUp className="h-3.5 w-3.5" strokeWidth={1.75} /> : <ChevronsUpDown className="h-3.5 w-3.5" strokeWidth={1.75} />}
        </button>
        <button
          type="button"
          onClick={onCreateProject}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          aria-label={t('sidebar.newProject')}
          title={t('sidebar.newProject')}
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>

      {loading ? (
        <div className="px-3 py-4 flex justify-center"><Spinner size="sm" /></div>
      ) : projects.length === 0 ? (
        <div className="px-3 py-2 text-[11px] text-neutral-500 dark:text-neutral-400">
          {t('sidebar.noProjects')}
        </div>
      ) : (
        <div className="space-y-0.5">
          {projects.map(proj => {
            const isSelected = (projectId || selectedProjectId) === proj.id;
            const isExpanded = expandedGroups.has(proj.id);
            const isRenaming = renamingId === proj.id;

            return (
              <div key={proj.id} className="space-y-0.5">
                <ProjectRow
                  proj={proj}
                  isSelected={isSelected}
                  isExpanded={isExpanded}
                  isRenaming={isRenaming}
                  renameDraft={isRenaming ? renameDraft : ''}
                  onLongPress={(cx, cy) => {
                    if (isRenaming) return;
                    setContextMenu({
                      project: proj,
                      x: Math.min(cx, window.innerWidth - 180),
                      y: Math.min(cy, window.innerHeight - 90),
                    });
                  }}
                  onSelect={() => handleSelectProject(proj)}
                  onNewSession={(e) => handleNewSession(e, proj)}
                  onRenameDraftChange={setRenameDraft}
                  onRenameCommit={commitRename}
                  onRenameCancel={() => setRenamingId(null)}
                  t={t}
                />

                {/* Expanded: render sessions under this project */}
                {isExpanded && (
                  <SessionList
                    projectId={proj.id}
                    onSessionSelect={(sid) => {
                      setSelectedProjectId(proj.id);
                      setSelectedSessionId(sid);
                      navigate(`/p/${proj.id}/s/${sid}`);
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={confirmDeleteProject !== null}
        title={t('sidebar.delete')}
        message={t('project.confirmDelete', { name: confirmDeleteProject?.name || '' })}
        confirmLabel={t('sidebar.delete')}
        onConfirm={doDeleteProject}
        onCancel={() => setConfirmDeleteProject(null)}
      />

      {/* Context menu */}
      {contextMenu && (
        <div
          role="menu"
          onClick={e => e.stopPropagation()}
          className="fixed z-50 w-44 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setRenamingId(contextMenu.project.id);
              setRenameDraft(contextMenu.project.name);
              setContextMenu(null);
            }}
            className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-neutral-800 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800"
          >
            <Pencil className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
            <span>{t('sidebar.rename')}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => handleDelete(contextMenu.project)}
            className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            <span>{t('sidebar.delete')}</span>
          </button>
        </div>
      )}
    </section>
  );
}

// ── Project row with long-press support ──

function ProjectRow({
  proj,
  isSelected,
  isExpanded,
  isRenaming,
  renameDraft,
  onLongPress,
  onSelect,
  onNewSession,
  onRenameDraftChange,
  onRenameCommit,
  onRenameCancel,
  t,
}: {
  proj: Project;
  isSelected: boolean;
  isExpanded: boolean;
  isRenaming: boolean;
  renameDraft: string;
  onLongPress: (cx: number, cy: number) => void;
  onSelect: () => void;
  onNewSession: (e: React.MouseEvent) => void;
  onRenameDraftChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  t: (key: string) => string;
}) {
  const longPressProps = useLongPress((e) => {
    if (isRenaming) return;
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
      className={cn(
        'group/project flex h-8 w-full items-center rounded-lg pr-1 text-[13px] transition-colors',
        isSelected
          ? 'bg-neutral-200/70 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
          : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800',
      )}
    >
      {isRenaming ? (
        <div className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2 pr-1">
          <Folder className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
          <input
            autoFocus
            value={renameDraft}
            onChange={e => onRenameDraftChange(e.target.value)}
            onBlur={onRenameCommit}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); onRenameCommit(); }
              if (e.key === 'Escape') onRenameCancel();
            }}
            onClick={e => e.stopPropagation()}
            className="w-full rounded-sm border border-neutral-300 bg-white px-1.5 py-0.5 text-[12.5px] text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={onSelect}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-lg pl-1.5 pr-1 text-left"
        >
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-neutral-500 transition-transform dark:text-neutral-400',
              isExpanded && 'rotate-90',
            )}
            strokeWidth={1.75}
          />
          <Folder className={cn('h-3.5 w-3.5 shrink-0', isSelected ? 'text-neutral-900 dark:text-neutral-100' : 'text-neutral-500 dark:text-neutral-400')} strokeWidth={1.75} />
          <span className="flex-1 truncate">{proj.name}</span>
        </button>
      )}

      {/* Hover actions */}
      {!isRenaming && (
        <div className={cn(
          'ml-1 flex shrink-0 items-center gap-0.5 transition-opacity',
          isSelected ? 'opacity-100' : 'opacity-0 group-hover/project:opacity-100',
        )}>
          <button
            type="button"
            onClick={onNewSession}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-200/70 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
            aria-label={t('sidebar.newSession')}
          >
            <MessageSquarePlus className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>
      )}
    </div>
  );
}
