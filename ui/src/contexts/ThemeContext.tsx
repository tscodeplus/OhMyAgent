import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';

type ThemeMode = 'system' | 'light' | 'dark';

const THEME_KEY = 'oma-theme-mode';

function getSystemDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

function readInitialMode(): ThemeMode {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {}
  return 'system';
}

interface ThemeContextValue {
  themeMode: ThemeMode;
  isDark: boolean;
  setThemeMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  themeMode: 'system',
  isDark: false,
  setThemeMode: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeMode, setMode] = useState<ThemeMode>(readInitialMode);
  const [isDark, setIsDark] = useState(() => {
    const mode = readInitialMode();
    return mode === 'system' ? getSystemDark() : mode === 'dark';
  });

  const setThemeMode = (mode: ThemeMode) => {
    setMode(mode);
    try { localStorage.setItem(THEME_KEY, mode); } catch {}
  };

  // Apply dark class
  useEffect(() => {
    const dark = themeMode === 'system' ? getSystemDark() : themeMode === 'dark';
    setIsDark(dark);
    if (dark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [themeMode]);

  // Listen for system theme changes when mode is 'system'
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      if (themeMode === 'system') {
        setIsDark(e.matches);
        if (e.matches) {
          document.documentElement.classList.add('dark');
        } else {
          document.documentElement.classList.remove('dark');
        }
      }
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [themeMode]);

  return (
    <ThemeContext.Provider value={{ themeMode, isDark, setThemeMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
