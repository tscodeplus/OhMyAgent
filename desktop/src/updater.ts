import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import type { UpdateInfo } from 'electron-updater';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { getDesktopConfig } from './config.js';
import { getT, interpolate, type SupportedLocale } from './i18n.js';

export class AppUpdater {
  private mainWindow: BrowserWindow | null = null;
  private updateDownloaded = false;
  private suppressEvents = false;
  /** Progress window shown during tray-initiated downloads. */
  private progressWin: BrowserWindow | null = null;
  /** True while a download is in progress (used to classify errors). */
  private downloading = false;
  /** True when the user has cancelled an in-progress download. */
  private downloadCancelled = false;

  constructor() {
    // Do NOT auto-download — let the user decide
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    this.registerListeners();

    // IPC handlers for progress window button actions.
    // The progress window renderer sends these via ipcRenderer.send().
    ipcMain.on('oma:progress-cancel', () => {
      this.cancelDownload();
    });
    ipcMain.on('oma:progress-install', () => {
      this.closeProgressWin();
      this.installAndRestart();
    });
    ipcMain.on('oma:progress-releases', () => {
      shell.openExternal('https://github.com/tscodeplus/OhMyAgent/releases');
    });
  }

  setWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  /**
   * Resolve light/dark mode by checking the desktop config's theme setting.
   * Falls back to the OS-level nativeTheme when set to 'system'.
   */
  private isDarkTheme(): boolean {
    try {
      const theme = getDesktopConfig().get('theme');
      if (theme === 'dark') return true;
      if (theme === 'light') return false;
    } catch { /* config store may not be ready yet */ }
    return nativeTheme.shouldUseDarkColors;
  }

  async checkForUpdates(): Promise<void> {
    this.downloadCancelled = false;
    this.diagLog(`checkForUpdates() called — running network diag first`);
    await this.runNetworkDiagnostic();
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result) {
        this.diagLog('checkForUpdates: no update available (null result)');
        this.mainWindow?.webContents.send('update-not-available');
      } else {
        this.diagLog(`checkForUpdates: update found version=${result.updateInfo.version} files=${JSON.stringify(result.updateInfo.files?.map((f: any) => f.url))}`);
      }
    } catch (err: any) {
      this.diagLog(`checkForUpdates: error caught — ${err.message || String(err)}`);
      console.error('[AppUpdater] Check for updates failed');
    }
  }

  async downloadUpdate(): Promise<void> {
    this.downloadCancelled = false;
    this.diagLog(`downloadUpdate() called — running network diag`);
    await this.runNetworkDiagnostic();
    this.downloading = true;
    try {
      await autoUpdater.downloadUpdate();
      this.diagLog('downloadUpdate: completed successfully');
    } catch (err: any) {
      this.diagLog(`downloadUpdate: error caught — ${err.message || String(err)}`);
      console.error('[AppUpdater] Download failed');
    } finally {
      this.downloading = false;
    }
  }

  /** Set to true before quitAndInstall so the main window close handler
   *  knows to allow the close (bypassing closeToTray on macOS). */
  forceQuitting = false;

  installAndRestart(): void {
    if (this.updateDownloaded) {
      this.forceQuitting = true;
      this.diagLog('installAndRestart: calling quitAndInstall');
      autoUpdater.quitAndInstall(false, true);
    } else {
      this.diagLog('installAndRestart: updateDownloaded is false — no-op');
    }
  }

  /**
   * Cancel an in-progress download (from About page or progress window).
   * electron-updater doesn't support true cancellation, so we close the
   * progress window and set a flag to ignore future download events.
   */
  cancelDownload(): void {
    this.diagLog('cancelDownload() called');
    this.downloadCancelled = true;
    this.downloading = false;
    this.closeProgressWin();
  }

  isUpdateDownloaded(): boolean {
    return this.updateDownloaded;
  }

  private registerListeners(): void {
    autoUpdater.on('checking-for-update', () => {
      // silent — checkForUpdates/downloadUpdate already log entry
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      if (this.suppressEvents) {
        this.diagLog(`event: update-available SUPPRESSED version=${info.version}`);
        return;
      }
      const downloadUrls = info.files?.map((f: any) => f.url).join(', ') || 'none';
      this.diagLog(`event: update-available version=${info.version} files=[${downloadUrls}]`);
      this.mainWindow?.webContents.send('update-available', {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes,
      });
    });

    autoUpdater.on('update-not-available', () => {
      if (this.suppressEvents) {
        return;
      }
      this.diagLog('event: update-not-available');
      this.mainWindow?.webContents.send('update-not-available');
    });

    autoUpdater.on('download-progress', (progress) => {
      if (Math.round(progress.percent) % 25 === 0) {
        this.diagLog(`download-progress: ${Math.round(progress.percent)}% (${((progress.bytesPerSecond || 0) / 1024).toFixed(1)} KB/s)`);
      }
      const data = {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        total: progress.total,
        transferred: progress.transferred,
      };
      this.mainWindow?.webContents.send('update-download-progress', data);
      if (this.progressWin && !this.progressWin.isDestroyed()) {
        this.progressWin.webContents.send('update-download-progress', data);
      }
    });

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      if (this.downloadCancelled) {
        this.diagLog(`event: update-downloaded IGNORED (cancelled) version=${info.version}`);
        this.downloadCancelled = false;
        return;
      }
      this.diagLog(`event: update-downloaded version=${info.version}`);
      this.updateDownloaded = true;
      const data = { version: info.version, releaseNotes: info.releaseNotes };
      this.mainWindow?.webContents.send('update-downloaded', data);
      if (this.progressWin && !this.progressWin.isDestroyed()) {
        this.progressWin.webContents.send('update-downloaded', data);
      }
    });

    autoUpdater.on('error', (error) => {
      if (this.downloadCancelled) {
        this.diagLog(`event: error IGNORED (cancelled)`);
        this.downloadCancelled = false;
        return;
      }
      const rawMessage = error.message || String(error);
      this.diagLog(`Error (downloading=${this.downloading}): ${rawMessage}`);

      let message = rawMessage;
      if (message.includes('ENOENT') && message.includes('app-update.yml')) {
        message = getT().updater.noUpdateConfig;
      } else if (message.includes('404') || message.includes('latest.yml')) {
        message = this.downloading
          ? getT().updater.downloadFailed
          : getT().updater.noUpdateAvailable;
      } else if (
        message.includes('ERR_CONNECTION_TIMED_OUT') ||
        message.includes('ETIMEDOUT') ||
        message.includes('ENOTFOUND') ||
        message.includes('ECONNREFUSED') ||
        message.includes('ERR_INTERNET_DISCONNECTED') ||
        message.includes('ERR_NETWORK_CHANGED')
      ) {
        message = getT().updater.networkTimeout;
      }

      if (!this.suppressEvents) {
        this.mainWindow?.webContents.send('update-error', {
          message,
          raw: rawMessage,
        });
        if (this.progressWin && !this.progressWin.isDestroyed()) {
          this.progressWin.webContents.send('update-error', { message });
        }
      }
    });
  }

  /**
   * Check for updates from tray menu — shows a spinner window during the check
   * and displays the result in a dialog.
   */
  async checkForUpdatesFromTray(): Promise<void> {
    this.suppressEvents = true;

    const isDark = this.isDarkTheme();

    // Theme-aware colors
    const primaryBg = isDark ? '#1e1e2e' : '#f8fafc';
    const textColor = isDark ? '#cdd6f4' : '#334155';
    const textMuted = isDark ? '#a6adc8' : '#64748b';
    const spinnerTrack = isDark ? 'rgba(205,214,244,0.15)' : 'rgba(51,65,85,0.12)';
    const spinnerFill = isDark ? '#89b4fa' : '#6366f1';

    const spinWin = new BrowserWindow({
      width: 320,
      height: 180,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      parent: this.mainWindow ?? undefined,
      show: false,
      backgroundColor: primaryBg,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    const spinnerHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;
       height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       background:${primaryBg};color:${textColor};user-select:none}
  .spinner{width:36px;height:36px;border:3px solid ${spinnerTrack};
           border-top-color:${spinnerFill};border-radius:50%;
           animation:spin .7s linear infinite;margin-bottom:18px}
  @keyframes spin{to{transform:rotate(360deg)}}
  .label{font-size:13px;color:${textMuted}}
</style></head>
<body>
  <div class="spinner"></div>
  <div class="label">${getT().updater.checking}</div>
</body></html>`;

    spinWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(spinnerHtml)}`);

    // Helper: safely destroy the spinner window
    const closeSpinWin = () => {
      try {
        if (!spinWin.isDestroyed()) spinWin.destroy();
      } catch { /* window might already be gone */ }
    };

    // Safety timeout: force-close spinner after 30s no matter what
    const safetyTimer = setTimeout(closeSpinWin, 30_000);

    // Show when content is ready
    spinWin.once('ready-to-show', () => {
      if (this.mainWindow) {
        const [mx, my] = this.mainWindow.getPosition();
        const [mw, mh] = this.mainWindow.getSize();
        spinWin.setPosition(mx + Math.round((mw - 320) / 2), my + Math.round((mh - 180) / 2));
      } else {
        spinWin.center();
      }
      spinWin.show();
    });

    try {
      const result = await autoUpdater.checkForUpdates();
      clearTimeout(safetyTimer);
      closeSpinWin();

      if (result) {
        // Safety check: don't show "new version" dialog if the update
        // version matches the currently-installed version.
        const currentVer = app.getVersion();
        if (result.updateInfo.version === currentVer) {
          this.showUpToDateDialog();
        } else {
          this.showUpdateDialogForTray(result.updateInfo);
        }
      } else {
        this.showUpToDateDialog();
      }
    } catch (err: any) {
      clearTimeout(safetyTimer);
      closeSpinWin();

      let message = err.message || String(err);
      if (message.includes('404') || message.includes('latest.yml')) {
        message = getT().updater.noUpdateAvailable;
      } else if (message.includes('ENOENT') && message.includes('app-update.yml')) {
        message = getT().updater.noUpdateConfig;
      } else if (
        message.includes('ERR_CONNECTION_TIMED_OUT') ||
        message.includes('ETIMEDOUT') ||
        message.includes('ENOTFOUND') ||
        message.includes('ECONNREFUSED') ||
        message.includes('ERR_INTERNET_DISCONNECTED') ||
        message.includes('ERR_NETWORK_CHANGED')
      ) {
        message = getT().updater.networkTimeout;
      }

      dialog.showMessageBox({
        type: 'error',
        title: getT().updater.checkFailed,
        message: getT().updater.checkFailed,
        detail: message,
        buttons: [getT().updater.ok],
      });
    } finally {
      this.suppressEvents = false;
    }
  }

  /**
   * Custom window for "already up to date" notification.
   * Replaces the ugly native dialog with a simple, clean window.
   */
  private showUpToDateDialog(): void {
    const isDark = this.isDarkTheme();
    const bg = isDark ? '#1e1e2e' : '#ffffff';
    const fg = isDark ? '#cdd6f4' : '#1e293b';
    const muted = isDark ? '#94a3b8' : '#64748b';
    const border = isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
    const btnPrimary = '#6366f1';

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       background:${bg};color:${fg};display:flex;flex-direction:column;
       align-items:center;justify-content:center;height:100vh}
  .icon{margin-bottom:16px}
  .icon svg{width:40px;height:40px;color:#22c55e}
  .message{font-size:15px;font-weight:600;color:${fg};text-align:center;margin-bottom:24px}
  .footer{position:absolute;-webkit-app-region:no-drag;bottom:0;left:0;right:0;padding:14px 20px;
          display:flex;justify-content:flex-end;
          border-top:1px solid ${border}}
  button{padding:7px 18px;-webkit-app-region:no-drag;border-radius:8px;font-size:13px;font-weight:600;
         cursor:pointer;border:none;transition:opacity .15s;outline:none}
  .btn-primary{background:${btnPrimary};color:#fff}
  .btn-primary:hover{opacity:0.88}
  .btn-primary:active{opacity:0.76}
</style></head>
<body>
  <div class="icon">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
      <polyline points="22 4 12 14.01 9 11.01"/>
    </svg>
  </div>
  <div class="message">${getT().updater.upToDate}</div>
  <div class="footer">
    <button class="btn-primary" onclick="window.location.href='oma://close-dialog'">${getT().updater.ok}</button>
  </div>
</body></html>`;

    const win = new BrowserWindow({
      width: 320,
      height: 220,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      parent: this.mainWindow ?? undefined,
      show: false,
      backgroundColor: bg,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    win.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (url === 'oma://close-dialog') win.close();
    });

    win.once('ready-to-show', () => {
      if (this.mainWindow) {
        const [mx, my] = this.mainWindow.getPosition();
        const [mw, mh] = this.mainWindow.getSize();
        win.setPosition(mx + Math.round((mw - 320) / 2), my + Math.round((mh - 220) / 2));
      } else {
        win.center();
      }
      win.show();
    });
  }
  /**
   * Custom window for tray-triggered update available notification.
   * Renders HTML release notes with proper scrollbar and theme support.
   */
  private showUpdateDialogForTray(info: UpdateInfo): void {
    const version = info.version;
    const notesHtml = this.getReleaseNotesHtml(info.releaseNotes);
    const isDark = this.isDarkTheme();

    // Theme-aware colors
    const bg = isDark ? '#1e1e2e' : '#ffffff';
    const fg = isDark ? '#cdd6f4' : '#1e293b';
    const muted = isDark ? '#94a3b8' : '#64748b';
    const border = isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
    const contentBg = isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc';
    const btnPrimary = '#6366f1';
    const btnSecondaryBg = isDark ? 'rgba(255,255,255,0.08)' : '#f1f5f9';
    const btnSecondaryFg = isDark ? '#cbd5e1' : '#475569';
    const btnSecondaryHover = isDark ? 'rgba(255,255,255,0.14)' : '#e2e8f0';

    // Theme-aware scrollbar colors
    const scrollThumb = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)';
    const scrollThumbHover = isDark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.28)';

    const notesBody = notesHtml
      || `<p style="color:${muted}">${getT().updater.noReleaseNotes}</p>`;

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       background:${bg};color:${fg};display:flex;flex-direction:column;height:100vh}
  .header{flex-shrink:0;padding:20px 24px 12px;-webkit-app-region:drag}
  .header h1{font-size:17px;font-weight:700;color:${fg};margin:0}
  .content{flex:1;overflow-y:auto;padding:12px 24px 16px;
           font-size:13px;line-height:1.7;color:${fg};
           background:${contentBg};margin:0 12px;border-radius:8px;
           border:1px solid ${border}}
  .content h2{font-size:14px;font-weight:600;margin:12px 0 6px;color:${fg}}
  .content h3{font-size:13px;font-weight:600;margin:10px 0 4px;color:${fg}}
  .content h4{font-size:12px;font-weight:600;margin:8px 0 4px;color:${muted}}
  .content ul,.content ol{padding-left:20px;margin:6px 0}
  .content li{margin:2px 0}
  .content p{margin:6px 0}
  .content strong{font-weight:600}
  .content a{color:#6366f1}
  .content code{background:${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)'};
                padding:1px 5px;border-radius:4px;font-size:12px}
  .content pre{background:${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'};
               padding:10px 14px;border-radius:6px;overflow-x:auto;margin:8px 0;
               font-size:12px;line-height:1.5}
  /* Thin theme-aware scrollbar */
  .content::-webkit-scrollbar{width:5px}
  .content::-webkit-scrollbar-track{background:transparent}
  .content::-webkit-scrollbar-thumb{background:${scrollThumb};border-radius:3px}
  .content::-webkit-scrollbar-thumb:hover{background:${scrollThumbHover}}
  .footer{flex-shrink:0;padding:16px 24px 20px;display:flex;
          justify-content:flex-end;gap:10px;
          border-top:1px solid ${border}}
  button{padding:8px 20px;border-radius:8px;font-size:13px;font-weight:600;
         cursor:pointer;border:none;transition:opacity .15s,background .15s;outline:none}
  .btn-primary{background:${btnPrimary};color:#fff}
  .btn-primary:hover{opacity:0.88}
  .btn-primary:active{opacity:0.76}
  .btn-secondary{background:${btnSecondaryBg};color:${btnSecondaryFg}}
  .btn-secondary:hover{background:${btnSecondaryHover}}
</style></head>
<body>
  <div class="header">
    <h1>${interpolate(getT().updater.newVersion, { version })}</h1>
  </div>
  <div class="content">${notesBody}</div>
  <div class="footer">
    <button class="btn-secondary" onclick="window.location.href='oma://close-dialog'">${getT().updater.cancel}</button>
    <button class="btn-primary" onclick="window.location.href='oma://upgrade'">${getT().updater.upgrade}</button>
  </div>
</body></html>`;

    const win = new BrowserWindow({
      width: 500,
      height: 460,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      parent: this.mainWindow ?? undefined,
      show: false,
      backgroundColor: bg,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    // Intercept navigation to handle button clicks
    win.webContents.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (url === 'oma://upgrade') {
        win.close();
        this.showDownloadProgressWindow();
        this.downloadUpdate();
      } else if (url === 'oma://close-dialog') {
        win.close();
      }
    });

    // Also handle location changes via other means (will-redirect, etc.)
    win.webContents.on('will-redirect', (event, url) => {
      event.preventDefault();
      if (url === 'oma://upgrade') {
        win.close();
        this.showDownloadProgressWindow();
        this.downloadUpdate();
      } else if (url === 'oma://close-dialog') {
        win.close();
      }
    });

    win.once('ready-to-show', () => {
      if (this.mainWindow) {
        const [mx, my] = this.mainWindow.getPosition();
        const [mw, mh] = this.mainWindow.getSize();
        win.setPosition(mx + Math.round((mw - 500) / 2), my + Math.round((mh - 460) / 2));
      } else {
        win.center();
      }
      win.show();
    });
  }

  /**
   * Download progress window shown during tray-initiated updates.
   * Listens for download-progress / update-downloaded / update-error IPC
   * events from the main process and updates its UI accordingly.
   */
  private showDownloadProgressWindow(): void {
    // Close any previous progress window
    this.closeProgressWin();

    const isDark = this.isDarkTheme();
    const bg = isDark ? '#1e1e2e' : '#ffffff';
    const fg = isDark ? '#cdd6f4' : '#1e293b';
    const muted = isDark ? '#94a3b8' : '#64748b';
    const border = isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
    const barBg = isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
    const barFill = '#6366f1';
    const btnPrimary = '#6366f1';
    const btnSecondaryBg = isDark ? 'rgba(255,255,255,0.08)' : '#f1f5f9';
    const btnSecondaryFg = isDark ? '#cbd5e1' : '#475569';
    const btnSecondaryHover = isDark ? 'rgba(255,255,255,0.14)' : '#e2e8f0';

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       background:${bg};color:${fg};display:flex;flex-direction:column;
       align-items:center;justify-content:center;height:100vh;
       user-select:none}
  .header{position:absolute;-webkit-app-region:drag;top:0;left:0;right:0;padding:16px 24px 0;
          text-align:center;font-size:14px;font-weight:600}
  .card{display:flex;-webkit-app-region:no-drag;flex-direction:column;align-items:center;gap:14px;width:320px}
  .label{font-size:13px;color:${muted}}
  .bar-wrap{width:100%;height:6px;border-radius:3px;background:${barBg};overflow:hidden}
  .bar-fill{height:100%;border-radius:3px;background:${barFill};
            width:0%;transition:width .2s ease-out}
  .percent{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}
  .speed{font-size:12px;color:${muted}}
  .status{font-size:13px;font-weight:600;text-align:center;line-height:1.4;
          max-width:320px;word-break:keep-all;overflow-wrap:break-word}
  .footer{position:absolute;-webkit-app-region:no-drag;bottom:0;left:0;right:0;padding:14px 20px;
          display:flex;justify-content:flex-end;gap:10px;
          border-top:1px solid ${border}}
  .footer.hidden{display:none}
  button{padding:7px 18px;-webkit-app-region:no-drag;border-radius:8px;font-size:13px;font-weight:600;
         cursor:pointer;border:none;transition:opacity .15s,background .15s;outline:none}
  .btn-primary{background:${btnPrimary};color:#fff}
  .btn-primary:hover{opacity:0.88}
  .btn-primary:active{opacity:0.76}
  .btn-secondary{background:${btnSecondaryBg};color:${btnSecondaryFg}}
  .btn-secondary:hover{background:${btnSecondaryHover}}
</style></head>
<body>
  <div class="header">${getT().updater.downloading}</div>
  <div class="card">
    <div class="percent" id="pct">0%</div>
    <div class="bar-wrap"><div class="bar-fill" id="bar"></div></div>
    <div class="speed" id="spd">&nbsp;</div>
    <div class="status" id="st"></div>
  </div>
  <div class="footer" id="ftr">
    <button class="btn-secondary" id="btn-releases" style="display:none">${getT().updater.githubRelease}</button>
    <button class="btn-secondary" id="btn-close">${getT().updater.cancel}</button>
    <button class="btn-primary" id="btn-install" style="display:none">${getT().updater.installAndRestart}</button>
  </div>
<script>
  var ipc = require('electron').ipcRenderer;

  // ── Button handlers via addEventListener ──
  document.getElementById('btn-close').addEventListener('click', function(e) {
    ipc.send('oma:progress-cancel');
  });
  document.getElementById('btn-install').addEventListener('click', function(e) {
    ipc.send('oma:progress-install');
  });
  document.getElementById('btn-releases').addEventListener('click', function(e) {
    ipc.send('oma:progress-releases');
  });

  // ── Progress events from main process ──
  function fmtSize(b){if(!b||b<=0)return'';const u=['B','KB','MB','GB'];let i=0,v=b;while(v>=1024&&i<u.length-1){v/=1024;i++}return v.toFixed(v<10?1:0)+' '+u[i]}
  ipc.on('update-download-progress',function(_e,d){
    document.getElementById('pct').textContent=Math.round(d.percent)+'%';
    document.getElementById('bar').style.width=d.percent+'%';
    document.getElementById('spd').textContent=fmtSize(d.bytesPerSecond)+'/s';
  });
  ipc.on('update-downloaded',function(_e,d){
    document.getElementById('pct').textContent='100%';
    document.getElementById('bar').style.width='100%';
    document.getElementById('spd').textContent='';
    document.getElementById('st').textContent='${getT().updater.downloaded}';
    document.getElementById('btn-install').style.display='';
    document.getElementById('btn-releases').style.display='none';
  });
  ipc.on('update-error',function(_e,d){
    document.getElementById('st').textContent=d.message||'${getT().updater.downloadFailed}';
    document.getElementById('btn-releases').style.display='';
  });
</script>
</body></html>`;

    const win = new BrowserWindow({
      width: 420,
      height: 260,
      frame: false,
      resizable: false,
      skipTaskbar: true,
      parent: this.mainWindow ?? undefined,
      show: false,
      backgroundColor: bg,
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
    });

    this.progressWin = win;

    // Safety timeout: close after 10 minutes
    const safetyTimer = setTimeout(() => this.closeProgressWin(), 600_000);

    win.once('closed', () => {
      clearTimeout(safetyTimer);
      this.progressWin = null;
    });

    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    // Prevent double-click maximize on frameless window (caused by -webkit-app-region:drag)
    win.on("maximize", () => {
      win.unmaximize();
    });
    win.on("unmaximize", () => {
    });


    win.once('ready-to-show', () => {
      if (this.mainWindow) {
        const [mx, my] = this.mainWindow.getPosition();
        const [mw, mh] = this.mainWindow.getSize();
        win.setPosition(mx + Math.round((mw - 420) / 2), my + Math.round((mh - 260) / 2));
      } else {
        win.center();
      }
      win.show();
    });
  }

  /** Write an updater diagnostic message to the Electron diag log. */
  private diagLog(msg: string): void {
    try {
      const logsDir = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const ts = new Date().toISOString();
      fs.appendFileSync(path.join(logsDir, 'electron-diag.log'), `[${ts}] [AppUpdater] ${msg}\n`);
    } catch { /* best effort */ }
  }

  /** Log Electron proxy settings and test network reachability to key GitHub hosts. */
  private async runNetworkDiagnostic(): Promise<void> {
    // ── Proxy settings ──
    try {

      const session = this.mainWindow?.webContents?.session;
      if (session) {
        await session.resolveProxy('https://github.com');
      }
    } catch (e: any) {
      this.diagLog(`Failed to resolve proxy: ${e.message}`);
    }

    // ── Connectivity test ──
    const testUrls = [
      { label: 'GitHub API', url: 'https://api.github.com/repos/tscodeplus/OhMyAgent/releases/latest' },
      { label: 'GitHub release redirect', url: 'https://github.com/tscodeplus/OhMyAgent/releases/download/v0.5.2/latest.yml' },
    ];
    for (const { label, url } of testUrls) {
      try {
        await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
      } catch (e: any) {
        this.diagLog(`[${label}] FAILED: ${e.message || String(e)}`);
      }
    }
  }

  /** Safely close the download progress window. */
  private closeProgressWin(): void {
    try {
      if (this.progressWin && !this.progressWin.isDestroyed()) {
        this.progressWin.destroy();
      }
    } catch { /* window might already be gone */ }
    this.progressWin = null;
  }

  /**
   * Convert release notes to HTML for the custom dialog.
   * - If notes is a string containing HTML tags, return as-is (with sanitization)
   * - If notes is an array of note objects, convert to HTML
   * - If notes is plain text, wrap in <p> tags
   */
  private getReleaseNotesHtml(notes: string | Array<string | { note: string | null }> | null | undefined): string {
    if (!notes) return '';
    const text = Array.isArray(notes)
      ? notes.map(n => typeof n === 'string' ? n : (n.note ?? '')).join('\n')
      : String(notes);
    const trimmed = text.trim();
    if (!trimmed) return '';

    // If already contains HTML tags, strip dangerous tags and return
    if (/<[a-z][\s\S]*>/i.test(trimmed)) {
      // Strip only potentially dangerous tags/attributes, keep formatting tags
      const sanitized = trimmed
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
        .replace(/<object[\s\S]*?<\/object>/gi, '')
        .replace(/<embed[\s\S]*?>/gi, '')
        .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
        .replace(/\son\w+\s*=\s*'[^']*'/gi, '');
      // Truncate to ~3000 chars to avoid huge windows
      return sanitized.length > 3000 ? sanitized.slice(0, 3000) + '…' : sanitized;
    }

    // Plain text — escape HTML and wrap paragraphs
    const escaped = trimmed
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const paragraphs = escaped.split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
    return paragraphs.length > 3000 ? paragraphs.slice(0, 3000) + '…' : paragraphs;
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
