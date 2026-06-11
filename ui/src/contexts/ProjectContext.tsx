import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { apiRequest } from '../utils/api';
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
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [sessionsRefreshKey, setSessionsRefreshKey] = useState(0);

  const bumpSessionsRefreshKey = useCallback(() => {
    setSessionsRefreshKey(k => k + 1);
  }, []);

  useEffect(() => {
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
    return () => { cancelled = true; };
  }, [t]);

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
