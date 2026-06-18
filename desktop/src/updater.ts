import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import type { UpdateInfo } from 'electron-updater';
import { BrowserWindow } from 'electron';

export class AppUpdater {
  private mainWindow: BrowserWindow | null = null;
  private updateDownloaded = false;

  constructor() {
    // Do NOT auto-download — let the user decide
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    this.registerListeners();
  }

  setWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  async checkForUpdates(): Promise<void> {
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result) {
        this.mainWindow?.webContents.send('update-not-available');
      }
    } catch (err) {
      console.error('[AppUpdater] Check for updates failed:', err);
      this.mainWindow?.webContents.send('update-error', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async downloadUpdate(): Promise<void> {
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      console.error('[AppUpdater] Download failed:', err);
      this.mainWindow?.webContents.send('update-error', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  installAndRestart(): void {
    if (this.updateDownloaded) {
      autoUpdater.quitAndInstall(false, true);
    }
  }

  isUpdateDownloaded(): boolean {
    return this.updateDownloaded;
  }

  private registerListeners(): void {
    autoUpdater.on('checking-for-update', () => {
      console.log('[AppUpdater] Checking for updates...');
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      console.log('[AppUpdater] Update available:', info.version);
      this.mainWindow?.webContents.send('update-available', {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes,
      });
    });

    autoUpdater.on('update-not-available', () => {
      console.log('[AppUpdater] Already up to date.');
      this.mainWindow?.webContents.send('update-not-available');
    });

    autoUpdater.on('download-progress', (progress) => {
      this.mainWindow?.webContents.send('update-download-progress', {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        total: progress.total,
        transferred: progress.transferred,
      });
    });

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      console.log('[AppUpdater] Update downloaded:', info.version);
      this.updateDownloaded = true;
      this.mainWindow?.webContents.send('update-downloaded', {
        version: info.version,
        releaseNotes: info.releaseNotes,
      });
    });

    autoUpdater.on('error', (error) => {
      console.error('[AppUpdater] Error:', error);
      this.mainWindow?.webContents.send('update-error', {
        message: error.message,
      });
    });
  }
}

// Singleton
let instance: AppUpdater | null = null;

export function getAppUpdater(): AppUpdater {
  if (!instance) {
    instance = new AppUpdater();
  }
  return instance;
}
