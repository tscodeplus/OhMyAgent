import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { apiRequest } from '../utils/api';
import { useAuth } from './AuthContext';
import type { Project } from '../types/project';

interface EnsureDefaultResponse {
  project: Project;
  created: boolean;
}

interface ProjectContextValue {
  selectedProjectId: string | null;
  setSelectedProjectId: (id: string | null) => void;
  selectedSessionId: string | null;
  setSelectedSessionId: (id: string | null) => void;
  /** True after the initial ensure-default call completes (or fails safely). */
  initialized: boolean;
  /** Bump this when a session is created from outside SessionList so it refetches. */
  sessionsRefreshKey: number;
  bumpSessionsRefreshKey: () => void;
}

const ProjectContext = createContext<ProjectContextValue>({
  selectedProjectId: null,
  setSelectedProjectId: () => {},
  selectedSessionId: null,
  setSelectedSessionId: () => {},
  initialized: false,
  sessionsRefreshKey: 0,
  bumpSessionsRefreshKey: () => {},
});

export function ProjectProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('common');
  const { token, isLoading } = useAuth();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [sessionsRefreshKey, setSessionsRefreshKey] = useState(0);

  const bumpSessionsRefreshKey = useCallback(() => {
    setSessionsRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    // Wait for auth to settle before ensure-default:
    // - The desktop shell injects the real token via IPC (getWebUIToken)
    //   after mount, but localStorage still holds the PREVIOUS run's token
    //   until then. Firing with that stale token gets 401-rejected, the
    //   catch marks the provider initialized with a null project id, and
    //   HomePage falls back to /dashboard forever.
    // - isLoading is false only once the new token is in place, so gating
    //   on it guarantees the request carries a valid token.
    if (isLoading || !token) return;
    let cancelled = false;
    const defaultName = t('project.defaultName', 'Default Space');
    apiRequest<EnsureDefaultResponse>('/api/projects/ensure-default', {
      method: 'POST',
      body: JSON.stringify({ name: defaultName }),
    })
      .then((res) => {
        if (!cancelled) {
          setSelectedProjectId(res.project.id);
          setInitialized(true);
        }
      })
      .catch(() => {
        if (!cancelled) setInitialized(true);
      });
    return () => {
      cancelled = true;
    };
  }, [t, token, isLoading]);

  return (
    <ProjectContext.Provider
      value={{
        selectedProjectId,
        setSelectedProjectId,
        selectedSessionId,
        setSelectedSessionId,
        initialized,
        sessionsRefreshKey,
        bumpSessionsRefreshKey,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject() {
  return useContext(ProjectContext);
}
