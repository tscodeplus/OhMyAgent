import { contextBridge, ipcRenderer } from 'electron';

(function initPreload() {
  console.log('[OhMyAgent] preload.ts executing');

  try {
    contextBridge.exposeInMainWorld('electronAPI', {
      // Window controls
      minimize: () => ipcRenderer.invoke('minimize-window'),
      maximize: () => ipcRenderer.invoke('maximize-window'),
      close: () => ipcRenderer.invoke('close-window'),

      // Server status
      getServerStatus: () => ipcRenderer.invoke('get-server-status'),
      restartService: () => ipcRenderer.invoke('restart-service'),

      // Configuration
      getConfig: (key: string) => ipcRenderer.invoke('get-config', key),
      setConfig: (key: string, value: unknown) => ipcRenderer.invoke('set-config', key, value),
      openConfigFile: () => ipcRenderer.invoke('open-config-file'),
      openDataDir: () => ipcRenderer.invoke('open-data-dir'),

      // Auto-start
      getAutoStart: () => ipcRenderer.invoke('get-auto-start'),
      setAutoStart: (enable: boolean) => ipcRenderer.invoke('set-auto-start', enable),

      // Updates
      checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
      downloadUpdate: () => ipcRenderer.invoke('download-update'),
      installUpdate: () => ipcRenderer.invoke('install-update'),
      onUpdateAvailable: (cb: (info: unknown) => void) => {
        ipcRenderer.on('update-available', (_event, info) => cb(info));
      },
      onUpdateDownloaded: (cb: (info: unknown) => void) => {
        ipcRenderer.on('update-downloaded', (_event, info) => cb(info));
      },
      onUpdateNotAvailable: (cb: () => void) => {
        ipcRenderer.on('update-not-available', () => cb());
      },
      onUpdateError: (cb: (info: unknown) => void) => {
        ipcRenderer.on('update-error', (_event, info) => cb(info));
      },
      onUpdateDownloadProgress: (cb: (info: unknown) => void) => {
        ipcRenderer.on('update-download-progress', (_event, info) => cb(info));
      },
      removeUpdateListeners: () => {
        ipcRenderer.removeAllListeners('update-available');
        ipcRenderer.removeAllListeners('update-not-available');
        ipcRenderer.removeAllListeners('update-downloaded');
        ipcRenderer.removeAllListeners('update-error');
        ipcRenderer.removeAllListeners('update-download-progress');
      },

      // Gateway
      getGatewayConfig: () => ipcRenderer.invoke('get-gateway-config'),
      setGatewayConfig: (config: unknown) => ipcRenderer.invoke('set-gateway-config', config),
      resetGatewayConfig: () => ipcRenderer.invoke('reset-gateway-config'),

      // App lifecycle
      quitApp: () => ipcRenderer.invoke('quit-app'),

      // Desktop Bridge (remote tool execution on local machine)
      bridgeRegisterSession: (sessionId: string) => ipcRenderer.invoke('bridge-register-session', sessionId),
      bridgeUnregisterSession: (sessionId: string) => ipcRenderer.invoke('bridge-unregister-session', sessionId),
      getBridgeStatus: () => ipcRenderer.invoke('get-bridge-status'),

      // File operations
      saveFileFromUrl: (url: string, filename: string) =>
        ipcRenderer.invoke('save-file-from-url', { url, filename }),
      saveLocalFile: (filePath: string, fileName: string) =>
        ipcRenderer.invoke('save-local-file', { filePath, fileName }),

      // App info
      getAppVersion: () => ipcRenderer.invoke('get-app-version'),
      getPlatform: () => process.platform,
      getUserDataPath: () => ipcRenderer.invoke('get-user-data-path'),
    });

    console.log('[OhMyAgent] preload.ts: electronAPI exposed successfully, keys:', Object.keys({ minimize: 1, maximize: 1, close: 1, getServerStatus: 1, restartService: 1, getConfig: 1, setConfig: 1, openConfigFile: 1, openDataDir: 1, getAutoStart: 1, setAutoStart: 1, checkForUpdates: 1, downloadUpdate: 1, installUpdate: 1, onUpdateAvailable: 1, onUpdateDownloaded: 1, removeUpdateListeners: 1, bridgeRegisterSession: 1, bridgeUnregisterSession: 1, getBridgeStatus: 1, getAppVersion: 1, getPlatform: 1, getUserDataPath: 1 }));
  } catch (err) {
    console.error('[OhMyAgent] preload.ts FAILED to expose electronAPI:', err);
  }
})();
