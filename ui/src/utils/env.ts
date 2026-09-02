/**
 * Environment detection utilities.
 */

// Augment the Window interface for our Electron preload API
declare global {
  interface Window {
    electronAPI?: {
      minimize: () => Promise<void>;
      maximize: () => Promise<void>;
      isMaximized: () => Promise<boolean>;
      close: () => Promise<void>;
      getServerStatus: () => Promise<{ running: boolean; port: number }>;
      restartService: () => Promise<{ ok: boolean; error?: string }>;
      getConfig: (key: string) => Promise<unknown>;
      setConfig: (key: string, value: unknown) => Promise<void>;
      openConfigFile: () => Promise<void>;
      openDataDir: () => Promise<void>;
      getAutoStart: () => Promise<boolean>;
      setAutoStart: (enable: boolean) => Promise<void>;
      checkForUpdates: (includeBeta?: boolean) => Promise<void>;
      downloadUpdate: () => Promise<void>;
      installUpdate: () => Promise<void>;
      cancelDownload: () => Promise<void>;
      onUpdateAvailable: (cb: (info: unknown) => void) => void;
      onUpdateDownloaded: (cb: (info: unknown) => void) => void;
      onUpdateNotAvailable: (cb: () => void) => void;
      onUpdateError: (cb: (info: unknown) => void) => void;
      onUpdateDownloadProgress: (cb: (info: { percent: number }) => void) => void;
      removeUpdateListeners: () => void;
      getAppVersion: () => Promise<string>;
      getPlatform: () => Promise<string>;
      getUserDataPath: () => Promise<string>;
      // Gateway
      getGatewayConfig: () => Promise<{ mode: string; remoteUrl: string; remoteToken: string }>;
      setGatewayConfig: (config: unknown) => Promise<{ ok: boolean }>;
      resetGatewayConfig: () => Promise<{ ok: boolean }>;
      /** WebUI gateway token for local mode (injected by the shell, served by the sidecar control API). */
      getWebUIToken: () => Promise<string>;
      /** Local-mode web access info: { token, port, addresses } (LAN reachability + persisted token). */
      getWebAccessInfo: () => Promise<{ token: string; port: number; addresses: string[] }>;
      // Gateway chooser (remote-connection retry): open the chooser window with
      // the given error banner text; reload the WebUI after it saves.
      openGatewayChooser: (error?: string) => Promise<void>;
      reloadMainWindow: () => Promise<void>;
      // Language
      setDesktopLanguage: (lang: string) => Promise<boolean>;
      // File operations
      // `path` is the chosen save location when ok is true
      saveFileFromUrl: (
        url: string,
        filename: string,
      ) => Promise<{ ok: boolean; error?: string; path?: string }>;
      saveLocalFile: (
        filePath: string,
        fileName: string,
      ) => Promise<{ ok: boolean; error?: string; path?: string }>;
      // Desktop Bridge (remote tool execution on local machine)
      bridgeRegisterSession: (sessionId: string) => Promise<void>;
      bridgeUnregisterSession: (sessionId: string) => Promise<void>;
      getBridgeStatus: () => Promise<string>;
    };
  }
}

/**
 * Returns true if the app is running inside Electron.
 *
 * Detection is three-layered, with sessionStorage caching so SPA route
 * changes that strip query params don't break detection:
 *   1. window.electronAPI — exposed by the preload script via contextBridge
 *   2. sessionStorage 'ohmyagent_electron' — cached from first detection
 *   3. URL param ?electron=1 — set by Electron's main process as a fallback
 */
export function isElectron(): boolean {
  if (typeof window === 'undefined') return false;

  // Primary: preload script exposed the API (most reliable)
  if (window.electronAPI !== undefined) {
    try {
      sessionStorage.setItem('ohmyagent_electron', '1');
    } catch {
      /* noop */
    }
    console.log(
      '[OhMyAgent] isElectron: true (electronAPI detected, keys:',
      Object.keys(window.electronAPI).join(','),
      ')',
    );
    return true;
  }

  // Cached from previous detection (survives SPA route changes)
  try {
    if (sessionStorage.getItem('ohmyagent_electron') === '1') {
      console.log('[OhMyAgent] isElectron: true (sessionStorage cache)');
      return true;
    }
  } catch {
    /* noop */
  }

  // Fallback: URL query parameter set by Electron main process
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('electron') === '1') {
      try {
        sessionStorage.setItem('ohmyagent_electron', '1');
      } catch {
        /* noop */
      }
      console.log('[OhMyAgent] isElectron: true (URL param electron=1)');
      return true;
    }
  } catch {
    // ignore invalid URLs
  }

  console.log('[OhMyAgent] isElectron: false (all checks failed)', {
    hasWindow: typeof window !== 'undefined',
    hasElectronAPI: typeof window !== 'undefined' && window.electronAPI !== undefined,
    url: typeof window !== 'undefined' ? window.location.href : 'N/A',
  });
  return false;
}

/**
 * Get the Electron API if available. Returns null in browser.
 */
export function getElectronAPI() {
  return window.electronAPI ?? null;
}
