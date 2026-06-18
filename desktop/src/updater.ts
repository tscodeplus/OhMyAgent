import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import type { UpdateInfo } from 'electron-updater';
import { app, BrowserWindow, dialog, nativeTheme } from 'electron';
import { getDesktopConfig } from './config.js';

// ---------------------------------------------------------------------------
// i18n — Electron main process doesn't have access to the server i18n
// service, so we maintain a minimal set of UI strings here.
// ---------------------------------------------------------------------------
type Lang = 'zh-CN' | 'en';

const T = {
  'zh-CN': {
    checking: '检查更新中...',
    upToDate: '已是最新版本',
    newVersion: (v: string) => `发现新版本: v${v}`,
    noReleaseNotes: '暂无更新说明',
    upgrade: '升级到最新版',
    cancel: '取消',
    ok: '确定',
    checkFailed: '更新检查失败',
    noUpdateAvailable: '暂无可用更新（尚未发布新版本或更新服务器不可达）',
  },
  'en': {
    checking: 'Checking for updates...',
    upToDate: 'Already up to date',
    newVersion: (v: string) => `New version available: v${v}`,
    noReleaseNotes: 'No release notes',
    upgrade: 'Upgrade to latest',
    cancel: 'Cancel',
    ok: 'OK',
    checkFailed: 'Update check failed',
    noUpdateAvailable: 'No update available (release not published or server unreachable)',
  },
} as const;

export class AppUpdater {
  private mainWindow: BrowserWindow | null = null;
  private updateDownloaded = false;
  private suppressEvents = false;
  private lang: Lang = 'en';

  constructor() {
    // Do NOT auto-download — let the user decide
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    this.registerListeners();
  }

  setWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  setLanguage(lang: Lang): void {
    this.lang = lang;
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
        message = T[this.lang].noUpdateAvailable;
      }

      if (!this.suppressEvents) {
        this.mainWindow?.webContents.send('update-error', { message });
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
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: primaryBg,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    const spinnerHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;
       height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       background:${primaryBg};color:${textColor};user-select:none;-webkit-app-region:drag}
  .spinner{width:36px;height:36px;border:3px solid ${spinnerTrack};
           border-top-color:${spinnerFill};border-radius:50%;
           animation:spin .7s linear infinite;margin-bottom:18px}
  @keyframes spin{to{transform:rotate(360deg)}}
  .label{font-size:13px;color:${textMuted}}
</style></head>
<body>
  <div class="spinner"></div>
  <div class="label">${T[this.lang].checking}</div>
</body></html>`;

    spinWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(spinnerHtml)}`);

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
      spinWin.close();

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
      spinWin.close();

      let message = err.message || String(err);
      if (message.includes('404') || message.includes('latest.yml')) {
        message = T[this.lang].noUpdateAvailable;
      }

      dialog.showErrorBox(T[this.lang].checkFailed, message);
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
  .footer{position:absolute;bottom:0;left:0;right:0;padding:14px 20px;
          display:flex;justify-content:flex-end;
          border-top:1px solid ${border}}
  button{padding:7px 18px;border-radius:8px;font-size:13px;font-weight:600;
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
  <div class="message">${T[this.lang].upToDate}</div>
  <div class="footer">
    <button class="btn-primary" onclick="window.location.href='oma://close-dialog'">${T[this.lang].ok}</button>
  </div>
</body></html>`;

    const win = new BrowserWindow({
      width: 320,
      height: 220,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
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

    const notesBody = notesHtml
      || `<p style="color:${muted}">${T[this.lang].noReleaseNotes}</p>`;

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
    <h1>${T[this.lang].newVersion(version)}</h1>
  </div>
  <div class="content">${notesBody}</div>
  <div class="footer">
    <button class="btn-secondary" onclick="window.location.href='oma://close-dialog'">${T[this.lang].cancel}</button>
    <button class="btn-primary" onclick="window.location.href='oma://upgrade'">${T[this.lang].upgrade}</button>
  </div>
</body></html>`;

    const win = new BrowserWindow({
      width: 500,
      height: 460,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
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
