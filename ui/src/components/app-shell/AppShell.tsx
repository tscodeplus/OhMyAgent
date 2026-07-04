import React, { useCallback, useEffect, useRef, useState, createContext, useContext, type ReactNode } from 'react';
import { Outlet, useNavigate, useParams, useLocation, NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  PanelLeftOpen, PanelLeftClose, Settings as SettingsIcon,
  Bot, Sparkles, Folder, BarChart3, Database, Clock, MessageSquarePlus,
} from 'lucide-react';
import { useProject } from '../../contexts/ProjectContext';
import { useSettings } from '../../contexts/SettingsContext';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { apiRequest } from '../../utils/api';
import { useToast } from '../ui/Toast';
import ProjectList from './ProjectList';
import SettingsModal from '../settings/SettingsModal';
import SetupWizard from '../setup-wizard/SetupWizard';
import CreateProjectModal from '../project-wizard/CreateProjectModal';
import type { Project } from '../../types/project';
import type { Session } from '../../types/session';

const SIDEBAR_MIN = 200; const SIDEBAR_MAX = 480; const SIDEBAR_DEFAULT = 248;

type Tab = { id: string; path: string; labelKey: string; icon: typeof Bot };

const TABS: Tab[] = [
  { id: 'chat', path: '/', labelKey: 'tabs.chat', icon: Bot },
  { id: 'skills', path: '/skills', labelKey: 'tabs.skills', icon: Sparkles },
  { id: 'files', path: '/files', labelKey: 'tabs.files', icon: Folder },
  { id: 'memory', path: '/memory', labelKey: 'tabs.memory', icon: Database },
  { id: 'cron', path: '/cron', labelKey: 'tabs.cron', icon: Clock },
  { id: 'dashboard', path: '/dashboard', labelKey: 'tabs.dashboard', icon: BarChart3 },
];

export default function AppShell() {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const location = useLocation();
  const { projectId } = useParams();
  const { selectedProjectId, setSelectedProjectId, selectedSessionId, setSelectedSessionId } = useProject();
  const { settingsOpen, setSettingsOpen } = useSettings();
  const { showToast } = useToast();
  const { subscribe } = useWebSocket();

  // Listen for cron delivery notifications via WebSocket
  useEffect(() => {
    return subscribe('cron_delivery', (data: any) => {
      showToast(`${data.title}\n${data.text}\n${data.footer || ''}`, 'info', 8000);
    });
  }, [subscribe, showToast]);

  // Listen for config change notifications (e.g. from file watcher hot-reload).
  // Skip when SettingsModal is open — the modal shows its own restart toast.
  useEffect(() => {
    return subscribe('config_changed', (data: any) => {
      if (settingsOpen) return; // SettingsModal handles its own notification
      if (data.restartRequired && Array.isArray(data.restartReasons) && data.restartReasons.length > 0) {
        const reasonsText = data.restartReasons.join(', ');
        showToast(`Config updated — restart required for: ${reasonsText}`, 'info', 8000);
      }
    });
  }, [subscribe, showToast, settingsOpen]);

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try { const n = Number(localStorage.getItem('oma-sidebar-width')); if (Number.isFinite(n)) return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n)); } catch {}
    return SIDEBAR_DEFAULT;
  });
  const [isResizing, setIsResizing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => { try { return localStorage.getItem('oma-sidebar-collapsed') !== 'true'; } catch { return true; } });
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // ─── Setup Wizard ───
  const [showSetupWizard, setShowSetupWizard] = useState(false);
  const [wizardData, setWizardData] = useState<{
    language: 'zh-CN' | 'en';
    providers: Array<{ id: string; name: string; knownModels: string[] }>;
  } | null>(null);

  useEffect(() => {
    apiRequest<{
      showWizard: boolean;
      currentLanguage: 'zh-CN' | 'en';
      providers: Array<{ id: string; name: string; knownModels: string[] }>;
    }>('/api/config/minimal-check')
      .then((data) => {
        if (data.showWizard) {
          setWizardData({ language: data.currentLanguage, providers: data.providers });
          setShowSetupWizard(true);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (projectId && projectId !== selectedProjectId) setSelectedProjectId(projectId);
  }, [projectId, selectedProjectId, setSelectedProjectId]);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen(v => { const n = !v; try { localStorage.setItem('oma-sidebar-collapsed', String(!n)); } catch {} return n; });
  }, []);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); const sx = e.clientX; const sw = sidebarWidth; setIsResizing(true);
    const mm = (ev: MouseEvent) => setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, sw + ev.clientX - sx)));
    const mu = () => { setIsResizing(false); document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); queueMicrotask(() => { const el = document.querySelector('[data-sidebar]'); const w = (el as HTMLElement)?.offsetWidth; if (w && Number.isFinite(w)) try { localStorage.setItem('oma-sidebar-width', String(Math.round(w))); } catch {} }); };
    document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu);
  }, [sidebarWidth]);

  const handleProjectCreated = useCallback((p: Project) => {
    setShowCreateProject(false); setSelectedProjectId(p.id); setRefreshKey(k => k + 1); navigate(`/p/${p.id}`);
  }, [navigate, setSelectedProjectId]);

  const isChatArea = location.pathname.startsWith('/p/');

  const sidebarEl = (
    <aside data-sidebar
      style={{ width: `${sidebarWidth}px` }}
      className="relative flex h-full shrink-0 flex-col border-r border-neutral-200 bg-neutral-50 text-neutral-900 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100"
    >
      {/* Header — matches PilotDeck: h-16, pl-2 pr-4 */}
      <div className="flex h-16 items-center justify-between pl-2 pr-4 shrink-0">
        <button type="button" onClick={() => navigate('/')} className="flex items-center gap-2 rounded-md p-1 transition hover:opacity-80">
          <span className="text-[15px] font-semibold tracking-tight text-neutral-800 dark:text-neutral-200">OhMyAgent</span>
        </button>
        <button type="button" onClick={toggleSidebar}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          aria-label="Hide sidebar">
          <PanelLeftClose className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        <ProjectList refreshKey={refreshKey} onRefresh={() => setRefreshKey(k => k + 1)} onCreateProject={() => setShowCreateProject(true)} />
      </div>

      <div className="border-t border-neutral-200 px-2 py-2 dark:border-neutral-800 shrink-0">
        <button type="button" onClick={() => setSettingsOpen(true)}
          className="flex h-9 w-full items-center justify-start gap-2 rounded-lg px-6 text-[13px] font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100">
          <SettingsIcon className="h-4 w-4" strokeWidth={1.75} />
          <span>{t('sidebar.settings')}</span>
        </button>
      </div>

      {/* Resize handle */}
      <div role="separator" aria-orientation="vertical" onMouseDown={handleResizeStart}
        onDoubleClick={() => { setSidebarWidth(SIDEBAR_DEFAULT); try { localStorage.setItem('oma-sidebar-width', String(SIDEBAR_DEFAULT)); } catch {} }}
        className={`absolute inset-y-0 right-0 z-10 hidden w-1 cursor-col-resize select-none transition-colors md:block ${isResizing ? 'bg-blue-500/60' : 'hover:bg-neutral-300/70 dark:hover:bg-neutral-700/70'}`} />
      {isResizing && <div className="fixed inset-0 z-[60] cursor-col-resize" style={{ userSelect: 'none' }} />}
    </aside>
  );

  return (
    <div className="fixed inset-0 flex bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      {/* Mobile overlay — closes sidebar after navigation */}
      {mobileSidebar && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setMobileSidebar(false)} />
          <div className="relative h-full w-[85vw] max-w-sm" onClick={e => { e.stopPropagation(); setMobileSidebar(false); }}>{sidebarEl}</div>
        </div>
      )}

      {/* Desktop sidebar */}
      <div className="hidden md:block shrink-0" style={{ width: sidebarOpen ? undefined : 0 }}>
        {sidebarOpen ? sidebarEl : null}
      </div>

      {/* Main */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* Header bar — draggable region for Electron (titleBarStyle: hidden).
            -webkit-app-region: drag allows the user to move the window by
            dragging this area, replacing the hidden native title bar. */}
        <header className="flex h-10 sm:h-12 shrink-0 items-center border-b border-neutral-200 px-3 sm:px-6 dark:border-neutral-800"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
          {/* Sidebar toggle when collapsed */}
          {!sidebarOpen && (
            <button type="button" onClick={toggleSidebar}
              className="mr-2 sm:mr-4 hidden md:inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
              <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} />
            </button>
          )}

          {/* Mobile toggle — always visible on small screens for sidebar access */}
          <button type="button" onClick={() => setMobileSidebar(true)}
            className="mr-2 sm:mr-4 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 md:hidden"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} />
          </button>

          {/* Breadcrumb — compact on mobile, full on desktop */}
          <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-2 text-[12px] sm:text-[13px]">
            {selectedProjectId ? (
              <>
                <span className="min-w-0 truncate max-w-[100px] sm:max-w-[180px] text-neutral-500 dark:text-neutral-400" title={selectedProjectId}>{selectedProjectId}</span>
                <span className="shrink-0 text-neutral-300/60 dark:text-neutral-600/60">/</span>
              </>
            ) : null}
            {projectId && selectedSessionId ? (
              <>
                <span className="shrink-0 font-medium">{t('tabs.chat')}</span>
              </>
            ) : (
              <span className="shrink-0 font-medium">
                {location.pathname.startsWith('/skills') ? t('nav.skills') :
                 location.pathname.startsWith('/files') ? t('nav.files') :
                 location.pathname.startsWith('/dashboard') ? t('nav.dashboard') :
                 location.pathname.startsWith('/memory') ? t('nav.memory') :
                 location.pathname.startsWith('/cron') ? t('nav.cron') :
                 isChatArea ? t('tabs.chat') : 'OhMyAgent'}
              </span>
            )}
          </div>

          {/* Tab switcher — compact on mobile, full labels on desktop */}
          <nav role="tablist" aria-label="Tools" className="ml-2 sm:ml-4 flex h-9 shrink-0 items-center gap-0.5 sm:gap-1.5 overflow-x-auto">
            {TABS.map(tab => {
              const Icon = tab.icon;
              const isActive = tab.path === '/' ? isChatArea || location.pathname === '/' : location.pathname.startsWith(tab.path);
              return (
                <button key={tab.id} type="button" role="tab" aria-selected={isActive}
                  style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                  onClick={async () => {
                    if (tab.path === '/') {
                      const pid = selectedProjectId;
                      if (!pid) {
                        navigate('/dashboard');
                        return;
                      }
                      // Try to find the most recently active session
                      try {
                        const sessions = await apiRequest<Session[]>(`/api/projects/${pid}/sessions`);
                        if (sessions.length > 0) {
                          const latest = sessions.reduce((a, b) =>
                            new Date(a.updated_at).getTime() > new Date(b.updated_at).getTime() ? a : b
                          );
                          setSelectedSessionId(latest.id);
                          navigate(`/p/${pid}/s/${latest.id}`);
                          return;
                        }
                      } catch { /* fall through to create new session */ }
                      // No sessions exist — create one
                      try {
                        const session = await apiRequest<Session>(`/api/projects/${pid}/sessions`, { method: 'POST' });
                        setSelectedSessionId(session.id);
                        navigate(`/p/${pid}/s/${session.id}`);
                      } catch {
                        navigate(`/p/${pid}`);
                      }
                    } else {
                      navigate(tab.path);
                    }
                  }}
                  className={`relative inline-flex h-8 shrink-0 items-center gap-1 sm:gap-1.5 rounded-md px-1.5 sm:px-2.5 text-[12px] sm:text-[13px] transition-colors ${
                    isActive
                      ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
                      : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100'
                  }`}>
                  <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                  <span className="hidden sm:inline">{t(tab.labelKey)}</span>
                </button>
              );
            })}
          </nav>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden"><Outlet /></div>
      </main>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {showSetupWizard && wizardData && (
        <SetupWizard
          initialLanguage={wizardData.language}
          providers={wizardData.providers}
          onComplete={() => setShowSetupWizard(false)}
          onDismiss={() => setShowSetupWizard(false)}
        />
      )}
      {showCreateProject && <CreateProjectModal onClose={() => setShowCreateProject(false)} onCreated={handleProjectCreated} />}
    </div>
  );
}
