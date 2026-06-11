import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
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
}

const ProjectContext = createContext<ProjectContextValue>({
  selectedProjectId: null,
  setSelectedProjectId: () => {},
  selectedSessionId: null,
  setSelectedSessionId: () => {},
  initialized: false,
});

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiRequest<EnsureDefaultResponse>('/api/projects/ensure-default', { method: 'POST' })
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
  }, []);

  return (
    <ProjectContext.Provider
      value={{ selectedProjectId, setSelectedProjectId, selectedSessionId, setSelectedSessionId, initialized }}
    >
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject() {
  return useContext(ProjectContext);
}
