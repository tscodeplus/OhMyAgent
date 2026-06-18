import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import type { UpdateInfo } from 'electron-updater';
import { BrowserWindow, Notification, dialog } from 'electron';

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
    } catch {
      // Error is handled by autoUpdater.on('error') listener — don't duplicate IPC
      console.error('[AppUpdater] Check for updates failed');
    }
  }

  async downloadUpdate(): Promise<void> {
    try {
      await autoUpdater.downloadUpdate();
    } catch {
      // Error is handled by autoUpdater.on('error') listener — don't duplicate IPC
      console.error('[AppUpdater] Download failed');
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

      // Always notify the renderer (About page toast UI)
      this.mainWindow?.webContents.send('update-available', {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes,
      });

      // If window is visible, bring it to front — the About page toast handles interaction
      const winVisible = this.mainWindow?.isVisible() && !this.mainWindow?.isMinimized();
      if (winVisible) {
        this.mainWindow?.focus();
        return;
      }

      // Window is hidden (e.g. tray trigger) — show a native dialog with buttons
      this.showUpdateDialog(info);
    });

    autoUpdater.on('update-not-available', () => {
      console.log('[AppUpdater] Already up to date.');
      this.mainWindow?.webContents.send('update-not-available');

      new Notification({
        title: 'OhMyAgent',
        body: '已是最新版本',
      }).show();
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

      // Show a friendlier message for common cases
      let message = error.message;
      if (message.includes('404') || message.includes('latest.yml')) {
        message = '暂无可用更新（尚未发布新版本或更新服务器不可达）';
      }

      // Notify renderer (About page toast) if window is visible
      if (this.mainWindow?.isVisible() && !this.mainWindow?.isMinimized()) {
        this.mainWindow.webContents.send('update-error', { message });
      } else {
        // Window hidden (tray trigger) — show native dialog instead
        dialog.showErrorBox('更新检查失败', message);
      }
    });
  }

  /** Show a native "update available" dialog (used when window is hidden, e.g. tray trigger). */
  private showUpdateDialog(info: UpdateInfo): void {
    const version = info.version;
    const notes = this.formatReleaseNotes(info.releaseNotes);

    const detail = notes
      ? `发现新版本: v${version}\n\n${notes}`
      : `发现新版本: v${version}`;

    dialog.showMessageBox({
      type: 'info',
      title: 'OhMyAgent - 发现新版本',
      message: `发现新版本: v${version}`,
      detail,
      buttons: ['升级到最新版', '取消'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => {
      if (response === 0) {
        // User clicked "升级到最新版"
        this.downloadUpdate();
      }
    });
  }

  /** Truncate release notes to a dialog-friendly length. */
  private formatReleaseNotes(notes: string | Array<string | { note: string | null }> | null | undefined): string {
    if (!notes) return '';
    const text = Array.isArray(notes)
      ? notes.map(n => typeof n === 'string' ? n : (n.note ?? '')).join('\n')
      : String(notes);
    // Limit to ~500 chars to avoid huge dialogs
    return text.length > 500 ? text.slice(0, 500) + '...' : text;
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
