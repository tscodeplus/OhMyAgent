import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface SettingsContextValue {
  settingsOpen: boolean;
  /** Requested tab for the next settings open (null = default tab). */
  settingsTab: string | null;
  /** Requested sub-tab inside the requested tab (e.g. 'providers' in 'models'). */
  settingsSubTab: string | null;
  setSettingsOpen: (open: boolean) => void;
  /** Open settings directly on a tab (and optional sub-tab). */
  openSettings: (tab: string, subTab?: string) => void;
  toggleSettings: () => void;
}

const SettingsContext = createContext<SettingsContextValue>({
  settingsOpen: false,
  settingsTab: null,
  settingsSubTab: null,
  setSettingsOpen: () => {},
  openSettings: () => {},
  toggleSettings: () => {},
});

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settingsOpen, setSettingsOpenState] = useState(false);
  const [settingsTab, setSettingsTab] = useState<string | null>(null);
  const [settingsSubTab, setSettingsSubTab] = useState<string | null>(null);

  const setSettingsOpen = useCallback((open: boolean) => {
    setSettingsOpenState(open);
    // Clear the tab request when closing so the next plain open
    // starts from the default tab instead of a stale one.
    if (!open) {
      setSettingsTab(null);
      setSettingsSubTab(null);
    }
  }, []);

  const openSettings = useCallback((tab: string, subTab?: string) => {
    setSettingsTab(tab);
    setSettingsSubTab(subTab ?? null);
    setSettingsOpenState(true);
  }, []);

  const toggleSettings = useCallback(() => {
    setSettingsOpenState((prev) => !prev);
  }, []);

  return (
    <SettingsContext.Provider value={{ settingsOpen, settingsTab, settingsSubTab, setSettingsOpen, openSettings, toggleSettings }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
