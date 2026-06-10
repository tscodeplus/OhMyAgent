import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface ProjectContextValue {
  selectedProjectId: string | null;
  setSelectedProjectId: (id: string | null) => void;
  selectedSessionId: string | null;
  setSelectedSessionId: (id: string | null) => void;
}

const ProjectContext = createContext<ProjectContextValue>({
  selectedProjectId: null,
  setSelectedProjectId: () => {},
  selectedSessionId: null,
  setSelectedSessionId: () => {},
});

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  return (
    <ProjectContext.Provider
      value={{ selectedProjectId, setSelectedProjectId, selectedSessionId, setSelectedSessionId }}
    >
      {children}
    </ProjectContext.Provider>
  );
}

export function useProject() {
  return useContext(ProjectContext);
}
