import React, { useCallback, useEffect, useState } from 'react';
import { Outlet, useNavigate, useParams, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  PanelLeftOpen, PanelLeftClose, Settings as SettingsIcon,
  Bot, Sparkles, Folder, BarChart3, Database, Clock, ChevronDown, LayoutGrid,
} from 'lucide-react';
import { useProject } from '../../contexts/ProjectContext';
import { useSettings } from '../../contexts/SettingsContext';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { apiRequest } from '../../utils/api';
import { useDesktopPlatform } from '../../utils/desktop';
import { useToast } from '../ui/Toast';
import ProjectList from './ProjectList';
import SettingsModal from '../settings/SettingsModal';
import SetupWizard from '../setup-wizard/SetupWizard';
import CreateProjectModal from '../project-wizard/CreateProjectModal';
import DesktopCaption from './DesktopCaption';
import type { Project } from '../../types/project';
import type { Session } from '../../types/session';

const SIDEBAR_MIN = 200; const SIDEBAR_MAX = 480; const SIDEBAR_DEFAULT = 248;
// Collapsed rail geometry (mimics deepseek-harness-desktop): a 24px icon
// column between 10px side paddings — 56px total, 36px controls, 12px rhythm.
const SIDEBAR_COLLAPSED = 56;

type Tab = { id: string; path: string; labelKey: string; icon: typeof Bot };

// The chat shortcut lives outside the tools drawer: expanded, the pinned
// "对话" (chat spaces) section at the bottom of the sidebar replaces it;
// the collapsed rail keeps it as its first icon (the reference project's
// rail shows its workspace icons) so a tool page can jump straight back.
const CHAT_TAB: Tab = { id: 'chat', path: '/', labelKey: 'tabs.chat', icon: Bot };

// Secondary features live in a collapsible drawer above the chat section —
// collapsing it frees the whole remaining sidebar for 对话.
const TOOL_TABS: Tab[] = [
  { id: 'skills', path: '/skills', labelKey: 'tabs.skills', icon: Sparkles },
  { id: 'files', path: '/files', labelKey: 'tabs.files', icon: Folder },
  { id: 'memory', path: '/memory', labelKey: 'tabs.memory', icon: Database },
  { id: 'cron', path: '/cron', labelKey: 'tabs.cron', icon: Clock },
  { id: 'dashboard', path: '/dashboard', labelKey: 'tabs.dashboard', icon: BarChart3 },
];

const RAIL_TABS: Tab[] = [CHAT_TAB, ...TOOL_TABS];

export default function AppShell() {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const location = useLocation();
  const { projectId } = useParams();
  const { selectedProjectId, setSelectedProjectId, setSelectedSessionId } = useProject();
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

  // Desktop platform — the frameless caption differs per OS: macOS keeps its
  // native traffic lights (custom buttons hidden, sidebar clears them), while
  // Windows/Linux draw their own window controls at the top right.
  const platform = useDesktopPlatform();
  const isMac = platform === 'macos';

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try { const n = Number(localStorage.getItem('oma-sidebar-width')); if (Number.isFinite(n)) return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, n)); } catch {}
    return SIDEBAR_DEFAULT;
  });
  const [isResizing, setIsResizing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => { try { return localStorage.getItem('oma-sidebar-collapsed') !== 'true'; } catch { return true; } });
  // Narrow viewports auto-collapse the sidebar to the rail (mimics
  // deepseek-harness-desktop's SIDEBAR_AUTO_COLLAPSE = 1024); a manual toggle
  // while narrow flips this override instead of the wide preference.
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [narrowExpanded, setNarrowExpanded] = useState(false);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  // Tools drawer open/closed (persisted; open by default).
  const [toolsOpen, setToolsOpen] = useState(() => { try { return localStorage.getItem('oma-sidebar-tools-open') !== 'false'; } catch { return true; } });
  const toggleTools = useCallback(() => {
    setToolsOpen(v => { const n = !v; try { localStorage.setItem('oma-sidebar-tools-open', String(n)); } catch {} return n; });
  }, []);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const narrow = viewportWidth < 1024;
  const sidebarVisible = narrow ? narrowExpanded : sidebarOpen;

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
    if (narrow) {
      // Narrow: flip the re-expand override; the wide preference is untouched,
      // so widening the window restores it (reference behavior).
      setNarrowExpanded(v => !v);
      return;
    }
    setSidebarOpen(v => { const n = !v; try { localStorage.setItem('oma-sidebar-collapsed', String(!n)); } catch {} return n; });
  }, [narrow]);

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

  // The "chat" tab opens the most recently active session (or creates one).
  const handleTabClick = useCallback(async (tab: Tab) => {
    if (tab.path !== '/') {
      navigate(tab.path);
      return;
    }
    const pid = selectedProjectId;
    if (!pid) {
      navigate('/dashboard');
      return;
    }
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
    try {
      const session = await apiRequest<Session>(`/api/projects/${pid}/sessions`, { method: 'POST' });
      setSelectedSessionId(session.id);
      navigate(`/p/${pid}/s/${session.id}`);
    } catch {
      navigate(`/p/${pid}`);
    }
  }, [selectedProjectId, navigate, setSelectedSessionId]);

  const isTabActive = (tab: Tab) => tab.path === '/' ? isChatArea || location.pathname === '/' : location.pathname.startsWith(tab.path);

  // Caption strip text (subtle, so the shell still reads as toolbar-free).
  const pageTitle = location.pathname.startsWith('/skills') ? t('nav.skills') :
    location.pathname.startsWith('/files') ? t('nav.files') :
    location.pathname.startsWith('/dashboard') ? t('nav.dashboard') :
    location.pathname.startsWith('/memory') ? t('nav.memory') :
    location.pathname.startsWith('/cron') ? t('nav.cron') :
    isChatArea ? t('tabs.chat') : 'OhMyAgent';
  const captionText = selectedProjectId ? `${selectedProjectId} / ${pageTitle}` : pageTitle;

  const sidebarEl = (
    <aside
      data-sidebar
      className={`relative h-full w-full overflow-hidden border-r border-neutral-200 bg-neutral-50 text-neutral-900 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100 ${isMac ? 'pt-8' : ''}`}
    >
      {/* Expanded content */}
      <div className={`absolute inset-0 flex flex-col transition-opacity duration-200 ${sidebarVisible || mobileSidebar ? 'opacity-100' : 'pointer-events-none opacity-0'}`}>
        {/* Header — brand + collapse toggle */}
        <div className="flex h-16 shrink-0 items-center justify-between pl-2 pr-4">
          <button type="button" onClick={() => navigate('/')} className="flex items-center gap-2 rounded-md p-1 transition hover:opacity-80">
            <BrandMark className="h-6 w-6" />
            <span className="text-[15px] font-semibold tracking-tight text-neutral-800 dark:text-neutral-200">OhMyAgent</span>
          </button>
          <button type="button" onClick={toggleSidebar} title={t('sidebar.collapse')} aria-label={t('sidebar.collapse')}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100">
            <PanelLeftClose className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>

        {/* Collapsible tools drawer — secondary features tuck away so the
            pinned 对话 section below gets the remaining space. */}
        <div className="shrink-0 border-b border-neutral-200/70 px-2 pb-1 dark:border-neutral-800/70">
          {/* Header row mirrors the 对话 section: label on the left, the
              collapse control as a small square icon button on the right. */}
          <div className="flex items-center gap-1.5 px-3 pb-1">
            <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
            <span className="flex-1 text-[13px] font-medium uppercase tracking-[0.04em] text-neutral-600 dark:text-neutral-400">
              {t('sidebar.tools')}
            </span>
            <button type="button" onClick={toggleTools} aria-expanded={toolsOpen} title={t('sidebar.tools')}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100">
              <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ${toolsOpen ? 'rotate-0' : '-rotate-90'}`} strokeWidth={1.75} />
            </button>
          </div>
          {toolsOpen && (
            <nav className="space-y-0.5 pb-1" aria-label="Tools" role="tablist">
              {TOOL_TABS.map(tab => {
                const Icon = tab.icon;
                const active = isTabActive(tab);
                return (
                  <button key={tab.id} type="button" role="tab" aria-selected={active} onClick={() => handleTabClick(tab)}
                    className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-[13px] transition-colors ${
                      active
                        ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
                        : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100'
                    }`}>
                    <Icon className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                    <span className="truncate">{t(tab.labelKey)}</span>
                  </button>
                );
              })}
            </nav>
          )}
        </div>

        {/* Chat spaces — the single, pinned chat entry at the bottom */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
          <ProjectList refreshKey={refreshKey} onRefresh={() => setRefreshKey(k => k + 1)} onCreateProject={() => setShowCreateProject(true)} />
        </div>

        {/* Settings */}
        <div className="shrink-0 border-t border-neutral-200 px-2 py-2 dark:border-neutral-800">
          <button type="button" onClick={() => setSettingsOpen(true)}
            className="flex h-9 w-full items-center justify-start gap-2 rounded-lg px-6 text-[13px] font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100">
            <SettingsIcon className="h-4 w-4" strokeWidth={1.75} />
            <span>{t('sidebar.settings')}</span>
          </button>
        </div>
      </div>

      {/* Collapsed rail — 56px icon column, mimics deepseek-harness-desktop */}
      <div className={`absolute inset-0 flex flex-col items-center px-[10px] pb-2 pt-[18px] transition-opacity duration-200 ${sidebarVisible && !mobileSidebar ? 'pointer-events-none opacity-0' : 'opacity-100'}`}>
        {/* Rail logo: brand mark at rest, expand affordance on hover */}
        <button type="button" onClick={toggleSidebar} title={t('sidebar.expand')} aria-label={t('sidebar.expand')}
          className="group flex h-9 w-9 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800">
          <BrandMark className="h-6 w-6 group-hover:hidden" />
          <PanelLeftOpen className="hidden h-[18px] w-[18px] group-hover:block" strokeWidth={1.75} />
        </button>

        <nav className="mt-3 flex flex-col items-center gap-1" aria-label="Tools" role="tablist">
          {RAIL_TABS.map(tab => {
            const Icon = tab.icon;
            const active = isTabActive(tab);
            return (
              <button key={tab.id} type="button" role="tab" aria-selected={active} onClick={() => handleTabClick(tab)} title={t(tab.labelKey)} aria-label={t(tab.labelKey)}
                className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
                  active
                    ? 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
                    : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100'
                }`}>
                <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
              </button>
            );
          })}
        </nav>

        <div className="flex-1" />

        <button type="button" onClick={() => setSettingsOpen(true)} title={t('sidebar.settings')} aria-label={t('sidebar.settings')}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100">
          <SettingsIcon className="h-[18px] w-[18px]" strokeWidth={1.75} />
        </button>
      </div>

      {/* Resize handle — only while expanded */}
      {sidebarVisible && (
        <div role="separator" aria-orientation="vertical" onMouseDown={handleResizeStart}
          onDoubleClick={() => { setSidebarWidth(SIDEBAR_DEFAULT); try { localStorage.setItem('oma-sidebar-width', String(SIDEBAR_DEFAULT)); } catch {} }}
          className={`absolute inset-y-0 right-0 z-10 hidden w-1 cursor-col-resize select-none transition-colors md:block ${isResizing ? 'bg-blue-500/60' : 'hover:bg-neutral-300/70 dark:hover:bg-neutral-700/70'}`} />
      )}
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

      {/* Mobile floating toggle (no toolbar on small screens anymore) */}
      <button type="button" onClick={() => setMobileSidebar(true)} aria-label={t('sidebar.expand')}
        className="fixed left-3 top-3 z-40 inline-flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-200 bg-white/95 text-neutral-600 shadow-sm hover:bg-neutral-50 md:hidden dark:border-neutral-800 dark:bg-neutral-900/95 dark:text-neutral-300 dark:hover:bg-neutral-800">
        <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} />
      </button>

      {/* Desktop sidebar — the width animates between expanded and the 56px rail */}
      <div
        className="hidden shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out md:block"
        style={{ width: sidebarVisible ? sidebarWidth : SIDEBAR_COLLAPSED }}
      >
        {sidebarEl}
      </div>

      {/* Main — no top toolbar: content starts at the top (browser) or under a
          transparent caption strip that doubles as the window drag region
          (desktop shell) with window controls at the top right. */}
      <main className="flex min-w-0 flex-1 flex-col">
        <DesktopCaption mac={isMac} text={captionText} />
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

// Brand mark — the app icon's indigo rounded square + O ring, inlined so the
// expanded header and the collapsed rail carry the real logo.
function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="oma-brand-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#4f46e5" />
        </linearGradient>
      </defs>
      <rect x="64" y="64" width="896" height="896" rx="224" fill="url(#oma-brand-bg)" />
      <path fill="white" fillRule="evenodd"
        d="M512 302 a210 210 0 1 1 0 420 a210 210 0 1 1 0 -420
           M512 374 a138 138 0 1 0 0 276 a138 138 0 1 0 0 -276" />
    </svg>
  );
}
