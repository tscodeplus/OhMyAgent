import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface SettingsContextValue {
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  toggleSettings: () => void;
}

const SettingsContext = createContext<SettingsContextValue>({
  settingsOpen: false,
  setSettingsOpen: () => {},
  toggleSettings: () => {},
});

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  const toggleSettings = useCallback(() => {
    setSettingsOpen((prev) => !prev);
  }, []);

  return (
    <SettingsContext.Provider value={{ settingsOpen, setSettingsOpen, toggleSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
