import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import type { UpdateInfo } from 'electron-updater';
import { BrowserWindow, dialog } from 'electron';

export class AppUpdater {
  private mainWindow: BrowserWindow | null = null;
  private updateDownloaded = false;
  private suppressEvents = false;

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
      if (this.suppressEvents) return;
      console.log('[AppUpdater] Update available:', info.version);
      this.mainWindow?.webContents.send('update-available', {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes,
      });
    });

    autoUpdater.on('update-not-available', () => {
      if (this.suppressEvents) return;
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

      let message = error.message;
      if (message.includes('404') || message.includes('latest.yml')) {
        message = '暂无可用更新（尚未发布新版本或更新服务器不可达）';
      }

      if (!this.suppressEvents) {
        this.mainWindow?.webContents.send('update-error', { message });
      }
    });
  }

  /**
   * Check for updates from tray menu — shows a spinner window during the check
   * and displays the result in a native dialog.
   */
  async checkForUpdatesFromTray(): Promise<void> {
    this.suppressEvents = true;

    const spinWin = new BrowserWindow({
      width: 320,
      height: 180,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      backgroundColor: '#1e1e2e',
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    // Center relative to main window or screen
    if (this.mainWindow) {
      const [mx, my] = this.mainWindow.getPosition();
      const [mw, mh] = this.mainWindow.getSize();
      spinWin.setPosition(mx + Math.round((mw - 320) / 2), my + Math.round((mh - 180) / 2));
    } else {
      spinWin.center();
    }

    spinWin.loadURL(`data:text/html;charset=utf-8,
      <!DOCTYPE html>
      <html><head><meta charset="utf-8"><style>
        *{margin:0;padding:0;box-sizing:border-box}
        body{display:flex;flex-direction:column;align-items:center;justify-content:center;
             height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
             background:#1e1e2e;color:#cdd6f4;user-select:none;-webkit-app-region:drag}
        .spinner{width:36px;height:36px;border:3px solid rgba(205,214,244,0.15);
                 border-top-color:#89b4fa;border-radius:50%;
                 animation:spin .7s linear infinite;margin-bottom:18px}
        @keyframes spin{to{transform:rotate(360deg)}}
        .label{font-size:13px;color:#a6adc8}
      </style></head>
      <body>
        <div class="spinner"></div>
        <div class="label">检查更新中...</div>
      </body></html>
    `.replace(/\s+/g, ' '));

    try {
      const result = await autoUpdater.checkForUpdates();
      spinWin.close();

      if (result) {
        this.showUpdateDialogForTray(result.updateInfo);
      } else {
        dialog.showMessageBox({
          type: 'info',
          title: 'OhMyAgent',
          message: '已是最新版本',
          buttons: ['确定'],
        });
      }
    } catch (err: any) {
      spinWin.close();

      let message = err.message || String(err);
      if (message.includes('404') || message.includes('latest.yml')) {
        message = '暂无可用更新（尚未发布新版本或更新服务器不可达）';
      }

      dialog.showErrorBox('更新检查失败', message);
    } finally {
      this.suppressEvents = false;
    }
  }

  /** Native dialog for tray-triggered update available. */
  private showUpdateDialogForTray(info: UpdateInfo): void {
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
