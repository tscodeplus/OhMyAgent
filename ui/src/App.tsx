import { useEffect } from 'react';
import { Routes, Route, useNavigate } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';
import { useProject } from './contexts/ProjectContext';
import AppShell from './components/app-shell/AppShell';
import LoginPage from './components/auth/LoginPage';
import ConnectionErrorPage from './components/auth/ConnectionErrorPage';
import ChatView from './components/chat/ChatView';
import SkillsView from './components/skills/SkillsView';
import FilesView from './components/files/FilesView';
import DashboardView from './components/dashboard/DashboardView';
import MemoryView from './components/memory/MemoryView';
import CronView from './components/cron/CronView';
import { apiRequest } from './utils/api';
import { syncLanguageToServer } from './utils/syncLanguage';
import type { Session } from './types/session';

function HomePage() {
  const navigate = useNavigate();
  const { selectedProjectId, setSelectedSessionId } = useProject();

  useEffect(() => {
    const pid = selectedProjectId;
    if (!pid) {
      // ProjectProvider's ensure-default should have set this already;
      // only reachable if the backend is unreachable. Re-run when the
      // project id arrives later (e.g. the first ensure-default attempt
      // was 401-rejected with a stale token, then retried successfully) —
      // an empty dependency array here would strand the app on /dashboard.
      navigate('/dashboard', { replace: true });
      return;
    }
    (async () => {
      // Try to find the most recently active session
      try {
        const sessions = await apiRequest<Session[]>(`/api/projects/${pid}/sessions`);
        if (sessions.length > 0) {
          const latest = sessions.reduce((a, b) =>
            new Date(a.updated_at).getTime() > new Date(b.updated_at).getTime() ? a : b,
          );
          setSelectedSessionId(latest.id);
          navigate(`/p/${pid}/s/${latest.id}`, { replace: true });
          return;
        }
      } catch {
        /* fall through to create new session */
      }
      // No sessions exist — create one
      try {
        const session = await apiRequest<Session>(`/api/projects/${pid}/sessions`, {
          method: 'POST',
        });
        setSelectedSessionId(session.id);
        navigate(`/p/${pid}/s/${session.id}`, { replace: true });
      } catch {
        navigate(`/p/${pid}`, { replace: true });
      }
    })();
  }, [selectedProjectId, setSelectedSessionId, navigate]);

  return <div className="flex items-center justify-center h-full text-neutral-500">Loading...</div>;
}

export default function App() {
  const { isAuthenticated, isLoading, connectionError, remoteUrl, retryAuth } = useAuth();
  const { initialized } = useProject();

  // Sync the WebUI's display language to the server once we're authenticated.
  // The server renders slash-command/system text in its own i18n locale, which
  // only updates from config.yaml. The frontend keeps its language in
  // localStorage, so push it to the server on load (covers the case where the
  // language was selected in a previous session and the dropdown's onChange
  // never re-fires on a plain reload).
  useEffect(() => {
    if (isAuthenticated) {
      void syncLanguageToServer();
    }
  }, [isAuthenticated]);

  // Still validating token / establishing connection. Don't gate the login
  // page on project bootstrap: ensure-default only fires once the auth token
  // exists (the desktop shell injects it via IPC after mount), so an
  // unauthenticated user must reach LoginPage without waiting on it.
  if (isLoading || (isAuthenticated && !initialized)) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-neutral-50 dark:bg-neutral-950">
        <div className="flex flex-col items-center gap-3">
          <svg className="h-6 w-6 animate-spin text-neutral-400" viewBox="0 0 24 24" fill="none">
            <circle
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="3"
              className="opacity-25"
            />
            <path
              d="M4 12a8 8 0 018-8"
              stroke="currentColor"
              strokeWidth="3"
              className="opacity-75"
            />
          </svg>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    // Show connection error page when a specific error prevented auth
    // (e.g. remote gateway unreachable), so the user can switch to local
    // or reconfigure instead of staring at a bare login form.
    if (connectionError) {
      return (
        <ConnectionErrorPage error={connectionError} remoteUrl={remoteUrl} onRetry={retryAuth} />
      );
    }
    return <LoginPage />;
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/p/:projectId" element={<ChatView />} />
        <Route path="/p/:projectId/s/:sessionId" element={<ChatView />} />
        <Route path="/skills" element={<SkillsView />} />
        <Route path="/files" element={<FilesView />} />
        <Route path="/dashboard" element={<DashboardView />} />
        <Route path="/memory" element={<MemoryView />} />
        <Route path="/cron" element={<CronView />} />
      </Route>
    </Routes>
  );
}
