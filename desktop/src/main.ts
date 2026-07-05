import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeTheme, shell } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerManager } from './server-manager.js';
import { createTray, destroyTray, rebuildTrayMenu } from './tray.js';
import { getDesktopConfig, type DesktopConfig } from './config.js';
import { DesktopBridge } from './desktop-bridge.js';
import { getAppUpdater } from './updater.js';
import { getT, interpolate, resolveUILanguage, setDesktopLanguage, type SupportedLocale } from './i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// File logger — main process console.log doesn't show in packaged apps,
// so we mirror diagnostic messages to a log file in the user data directory.
// ---------------------------------------------------------------------------
let diagLogStream: fs.WriteStream | null = null;
function diagLog(message: string): void {
  try {
    if (!diagLogStream) {
      const logsDir = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      diagLogStream = fs.createWriteStream(path.join(logsDir, 'electron-diag.log'), { flags: 'a' });
    }
    const ts = new Date().toISOString();
    diagLogStream.write(`[${ts}] ${message}\n`);
  } catch { /* best effort */ }
  console.log(message);
}

let mainWindow: BrowserWindow | null = null;
let serverManager: ServerManager | null = null;
let desktopBridge: DesktopBridge | null = null;
let trayCreated = false;
/** Remote gateway base URL (e.g. http://192.168.1.100:9191). Set when running in remote mode. */
let remoteGatewayBaseUrl: string | null = null;

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function getPreloadPath(): string {
  // In dev mode (tsx), preload.ts is in src/.
  // In prod, preload.cjs is built by tsconfig.preload.json (CommonJS) —
  // ESM preload scripts inside ASAR can fail silently.
  const isDev = !app.isPackaged;
  const p = path.join(__dirname, isDev ? 'preload.ts' : 'preload.cjs');
  diagLog(`[OhMyAgent] getPreloadPath: ${p} exists=${fs.existsSync(p)} isDev=${isDev} isPackaged=${app.isPackaged}`);
  if (!fs.existsSync(p)) {
    diagLog(`[OhMyAgent] PRELOAD FILE NOT FOUND: ${p}`);
  }
  return p;
}

function createSplashHtml(): string {
  const text = getT().splash.starting;
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    height:100vh;display:flex;flex-direction:column;
    align-items:center;justify-content:center;
    padding-top:18px;
    background:linear-gradient(135deg,#6366f1,#4f46e5);
    color:#fff;user-select:none;-webkit-user-select:none;
    border-radius:12px;overflow:hidden;
  }
  .logo{width:52px;height:52px;margin-bottom:20px;background:rgba(255,255,255,.15);border-radius:14px;display:flex;align-items:center;justify-content:center}
  .spin-o{width:28px;height:28px;border:3.5px solid rgba(255,255,255,.2);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite}
  .text{font-size:17px;font-weight:600;letter-spacing:1px;text-align:center;padding:0 24px;opacity:.9}
  @keyframes spin{to{transform:rotate(360deg)}}
</style></head><body>
  <div class="logo"><div class="spin-o"></div></div>
  <div class="text">${text}</div>
</body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function createSplashWindow(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 340,
    height: 240,
    frame: false,
    resizable: false,
    center: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  splash.loadURL(createSplashHtml());
  splash.once('ready-to-show', () => splash.show());
  return splash;
}

function createWindow(): BrowserWindow {
  const preloadPath = getPreloadPath();
  diagLog(`[OhMyAgent] createWindow: preloadPath=${preloadPath} isPackaged=${app.isPackaged} __dirname=${__dirname}`);

  // Get saved theme to apply matching window chrome from the start.
  // This prevents a bright title-bar flash before the WebUI loads and
  // keeps the native window frame in harmony with the page background.
  const savedTheme = getDesktopConfig().get('theme');
  // For 'system' theme, follow the OS preference; otherwise use the explicit choice.
  const isDark = savedTheme === 'dark'
    || (savedTheme === 'system' && nativeTheme.shouldUseDarkColors);
  // neutral-950 (#0a0a0a) — same as WebUI Tailwind bg-neutral-950
  const DARK_BG = '#0a0a0a';
  const DARK_SYMBOL = '#9ca3af'; // neutral-400 — readable on dark bg
  const LIGHT_BG = '#ffffff';
  const LIGHT_SYMBOL = '#525252'; // neutral-600

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: 'OhMyAgent',
    backgroundColor: isDark ? DARK_BG : LIGHT_BG,
    titleBarOverlay: isDark
      ? { color: DARK_BG, symbolColor: DARK_SYMBOL, height: 40 }
      : { color: LIGHT_BG, symbolColor: LIGHT_SYMBOL, height: 40 },
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Forward renderer/preload console messages to main stdout only.
  // Do NOT write to diagLog — the WebUI emits verbose debug messages
  // (SSE streaming events, React state updates) that would bloat the
  // persistent log file to hundreds of MB within a few hours.
  mainWindow.webContents.on('console-message', (_event, level, message) => {
    const lvl = level === 1 ? 'WARN' : level === 2 ? 'ERROR' : 'INFO';
    console.log(`[renderer:${lvl}] ${message}`);
  });

  // Report preload script status after page load
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.executeJavaScript('typeof window.electronAPI')
      .then((result) => diagLog(`[OhMyAgent] post-load check: typeof window.electronAPI = ${result}`))
      .catch((err) => diagLog(`[OhMyAgent] post-load check error: ${err}`));
  });

  // Main window stays hidden until WebUI loads (splash handles the wait).

  mainWindow.on('close', (event) => {
    // Allow close when updater is about to quitAndInstall — on macOS
    // app.quit() tries to close all windows first, and preventDefault
    // here would cancel the quit (and the update install).
    if (getAppUpdater().forceQuitting) {
      return; // let the window close so the app can quit
    }
    // If tray exists and closeToTray is enabled, hide instead of close
    const config = getDesktopConfig();
    if (trayCreated && config.get('closeToTray') !== false) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}


// ---------------------------------------------------------------------------
// Remote gateway health check result.
// ---------------------------------------------------------------------------
type HealthResult = 'ok' | 'unreachable' | 'invalid_token';

// ---------------------------------------------------------------------------
// Remote gateway health check — quick pre-flight before loadURL so we don't
// hang on a TCP connect that takes 30+ seconds to time out.
// When a token is provided, also verifies it via /api/auth/verify so we can
// distinguish "server offline" from "wrong token".
// ---------------------------------------------------------------------------
function checkRemoteHealth(url: string, token?: string): Promise<HealthResult> {
  return new Promise((resolve) => {
    const u = new URL(url + '/api/health');
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      {
        method: 'GET',
        timeout: 8_000,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        // Health check passed. If we have a token, also verify it.
        res.resume();
        if (!token) {
          resolve('ok');
          return;
        }
        // Verify token via /api/auth/verify
        const verifyUrl = new URL(url + '/api/auth/verify');
        const vmod = verifyUrl.protocol === 'https:' ? https : http;
        const vreq = vmod.request(
          verifyUrl,
          {
            method: 'GET',
            timeout: 5_000,
            headers: { Authorization: `Bearer ${token}` },
          },
          (vres) => {
            const valid = vres.statusCode === 200;
            vres.resume();
            resolve(valid ? 'ok' : 'invalid_token');
          },
        );
        vreq.on('timeout', () => { vreq.destroy(); resolve('invalid_token'); });
        vreq.on('error', () => resolve('invalid_token'));
        vreq.end();
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve('unreachable');
    });
    req.on('error', () => resolve('unreachable'));
    req.end();
  });
}

function setupEnvironment(): { port: number } {
  const userDataPath = app.getPath('userData');
  const port = parseInt(process.env.OHMYAGENT_PORT || '9191', 10);

  // Detect UI language BEFORE setting other vars — used by both Electron and the server.
  // Only auto-detect on FIRST launch (no config file). Once the user has a config,
  // respect whatever is in it. Explicit UI_LANGUAGE env var always wins (config.ts:755).
  const uiLang = resolveUILanguage();
  const configPath = path.join(userDataPath, 'config.yaml');
  if (!fs.existsSync(configPath)) {
    process.env.UI_LANGUAGE = uiLang;
  }

  // Set env vars that bootstrap() reads
  process.env.OHMYAGENT_HOME = userDataPath;
  process.env.OHMYAGENT_PORT = String(port);
  process.env.OHMYAGENT_BIND_ADDRESS = '127.0.0.1';
  process.env.DATABASE_PATH = path.join(userDataPath, 'data', 'app.db');
  process.env.CONFIG_FILE = path.join(userDataPath, 'config.yaml');
  process.env.ELECTRON_RUN = '1';

  // WebUI static root — set here so ServerManager can use it
  const isPackaged = app.isPackaged;
  const resourcesPath = isPackaged ? process.resourcesPath : path.resolve(__dirname, '../../');
  process.env.WEBUI_STATIC_ROOT = path.join(
    resourcesPath,
    isPackaged ? 'webui-dist' : 'ui/dist'
  );

  // Ensure data directories exist
  fs.mkdirSync(path.join(userDataPath, 'data'), { recursive: true });
  fs.mkdirSync(path.join(userDataPath, 'logs'), { recursive: true });

  return { port };
}

// IPC Handlers
function registerIpcHandlers(): void {
  diagLog('[OhMyAgent] registerIpcHandlers called');

  ipcMain.handle('get-server-status', () => ({
    running: serverManager?.getStatus() === 'running',
    port: parseInt(process.env.OHMYAGENT_PORT || '9191', 10),
  }));

  ipcMain.handle('restart-service', () => {
    diagLog('[OhMyAgent] restart-service IPC invoked');
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 200);
    return { ok: true };
  });

  ipcMain.handle('get-app-version', () => app.getVersion());
  ipcMain.handle('get-platform', () => process.platform);
  ipcMain.handle('get-user-data-path', () => app.getPath('userData'));

  ipcMain.handle('open-data-dir', () => {
    shell.openPath(app.getPath('userData'));
  });

  ipcMain.handle('open-config-file', () => {
    const configPath = process.env.CONFIG_FILE || path.join(app.getPath('userData'), 'config.yaml');
    shell.openPath(configPath);
  });

  // Desktop config getter (electron-store backed)
  ipcMain.handle('get-config', (_event, key: string) => {
    try {
      return getDesktopConfig().get(key as keyof DesktopConfig);
    } catch (err) {
      diagLog(`[OhMyAgent] get-config error for key=${key}: ${err}`);
      throw err;
    }
  });

  // Desktop config setter (electron-store backed)
  ipcMain.handle('set-config', (_event, key: string, value: unknown) => {
    try {
      getDesktopConfig().set(key as keyof DesktopConfig, value as never);
      // Sync theme changes to native title bar (Windows/Linux)
      if (key === 'theme') {
        const themeVal = value as string;
        if (themeVal === 'dark' || themeVal === 'light' || themeVal === 'system') {
          nativeTheme.themeSource = themeVal;
          diagLog(`[OhMyAgent] nativeTheme.themeSource updated to "${themeVal}" from WebUI`);

          // Update window chrome to match — backgroundColor for flash
          // prevention, titleBarOverlay for Windows 11 caption buttons.
          if (mainWindow && !mainWindow.isDestroyed()) {
            const isDarkNow = themeVal === 'dark'
              || (themeVal === 'system' && nativeTheme.shouldUseDarkColors);
            const DARK_BG = '#0a0a0a';
            const LIGHT_BG = '#ffffff';
            const bg = isDarkNow ? DARK_BG : LIGHT_BG;
            try {
              mainWindow.setBackgroundColor(bg);
              mainWindow.setTitleBarOverlay({
                color: bg,
                symbolColor: isDarkNow ? '#9ca3af' : '#525252',
                height: 40,
              });
              diagLog(`[OhMyAgent] Window chrome updated — bg=${bg}`);
            } catch (err) {
              diagLog(`[OhMyAgent] Window chrome update error: ${err}`);
            }
          }
        }
      }
      return { ok: true };
    } catch (err) {
      diagLog(`[OhMyAgent] set-config error for key=${key}: ${err}`);
      throw err;
    }
  });

  // Gateway config IPC
  ipcMain.handle('get-gateway-config', () => {
    try {
      return getDesktopConfig().getGatewayConfig();
    } catch (err) {
      diagLog(`[OhMyAgent] get-gateway-config error: ${err}`);
      throw err;
    }
  });

  ipcMain.handle('set-gateway-config', (_event, config: unknown) => {
    try {
      getDesktopConfig().setGatewayConfig(config as Record<string, unknown>);
      return { ok: true };
    } catch (err) {
      diagLog(`[OhMyAgent] set-gateway-config error: ${err}`);
      throw err;
    }
  });

  ipcMain.handle('reset-gateway-config', () => {
    try {
      getDesktopConfig().setGatewayConfig({ mode: 'local', remoteUrl: '', remoteToken: '' });
      return { ok: true };
    } catch (err) {
      diagLog(`[OhMyAgent] reset-gateway-config error: ${err}`);
      throw err;
    }
  });

  ipcMain.handle('quit-app', () => {
    diagLog('[OhMyAgent] quit-app invoked');
    app.exit(0);
  });

  // ── Updater IPC ────────────────────────────────────────────────────
  ipcMain.handle('check-for-updates', async () => {
    diagLog('[OhMyAgent] check-for-updates IPC invoked');
    try {
      await getAppUpdater().checkForUpdates();
    } catch (err) {
      diagLog(`[OhMyAgent] check-for-updates error: ${err}`);
      throw err;
    }
  });

  ipcMain.handle('download-update', async () => {
    diagLog('[OhMyAgent] download-update IPC invoked');
    try {
      await getAppUpdater().downloadUpdate();
    } catch (err) {
      diagLog(`[OhMyAgent] download-update error: ${err}`);
      throw err;
    }
  });

  ipcMain.handle('install-update', () => {
    diagLog('[OhMyAgent] install-update IPC invoked');
    getAppUpdater().installAndRestart();
  });

  ipcMain.handle('cancel-download', () => {
    diagLog('[OhMyAgent] cancel-download IPC invoked');
    getAppUpdater().cancelDownload();
  });

  // ── Desktop Bridge IPC ──────────────────────────────────────────────────
  ipcMain.handle('bridge-register-session', (_event, sessionId: string) => {
    desktopBridge?.registerSession(sessionId);
  });

  ipcMain.handle('bridge-unregister-session', (_event, sessionId: string) => {
    desktopBridge?.unregisterSession(sessionId);
  });

  ipcMain.handle('get-bridge-status', () => {
    return desktopBridge?.getStatus() ?? 'disconnected';
  });

  ipcMain.handle('save-file-from-url', async (_event, params: { url: string; filename: string }) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: params.filename,
      filters: [{ name: 'All Files', extensions: ['*'] }],
    });

    if (result.canceled || !result.filePath) {
      return { ok: false, error: 'cancelled' };
    }

    try {
      const { writeFile } = await import('node:fs/promises');

      // Handle data: URLs (base64) directly
      if (params.url.startsWith('data:')) {
        const match = params.url.match(/^data:([^;]*);base64,(.+)$/);
        if (match) {
          const buf = Buffer.from(match[2], 'base64');
          await writeFile(result.filePath, buf);
        } else {
          // data: URL without base64 — just write the raw content
          const data = params.url.split(',')[1] || '';
          await writeFile(result.filePath, Buffer.from(data));
        }
        return { ok: true };
      }

      // Fetch from local HTTP server
      const http = await import('node:http');
      const { pipeline } = await import('node:stream/promises');
      const { createWriteStream } = await import('node:fs');

      // Use remote gateway URL in remote mode, localhost in local mode
      const fetchUrl = params.url.startsWith('http')
        ? params.url
        : remoteGatewayBaseUrl
          ? `${remoteGatewayBaseUrl}${params.url}`
          : `http://127.0.0.1:${process.env.OHMYAGENT_PORT || '9191'}${params.url}`;

      const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        http.get(fetchUrl, resolve).on('error', reject);
      });

      if (response.statusCode !== 200) {
        return { ok: false, error: `Server returned ${response.statusCode}` };
      }

      await pipeline(response, createWriteStream(result.filePath));
      return { ok: true };
    } catch (err: any) {
      diagLog(`[OhMyAgent] save-file-from-url error: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  // Save a local file (Desktop Bridge) — reads from the local filesystem
  // and presents a "Save As" dialog, without going through the gateway.
  ipcMain.handle('save-local-file', async (_event, params: { filePath: string; fileName: string }) => {
    const resolved = path.resolve(params.filePath);
    try {
      // Verify the file exists and is readable
      await fs.promises.access(resolved, fs.constants.R_OK);
      const stat = await fs.promises.stat(resolved);
      if (!stat.isFile()) {
        return { ok: false, error: 'Not a file' };
      }
    } catch (err: any) {
      return { ok: false, error: `Cannot read file: ${err.message}` };
    }

    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: params.fileName || path.basename(resolved),
      filters: [{ name: 'All Files', extensions: ['*'] }],
    });

    if (result.canceled || !result.filePath) {
      return { ok: false, error: 'cancelled' };
    }

    try {
      await fs.promises.copyFile(resolved, result.filePath);
      return { ok: true };
    } catch (err: any) {
      diagLog(`[OhMyAgent] save-local-file error: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('set-auto-start', (_event, enable: boolean) => {
    app.setLoginItemSettings({
      openAtLogin: enable,
      path: app.getPath('exe'),
      args: ['--hidden'],
    });
  });

  ipcMain.handle('get-auto-start', () => {
    return app.getLoginItemSettings().openAtLogin;
  });

  // Desktop language change (from WebUI settings)
  ipcMain.handle('set-desktop-language', (_event, lang: string) => {
    if (lang === 'zh-CN' || lang === 'en') {
      setDesktopLanguage(lang);
      // Persist to desktop config so it survives restarts
      try {
        getDesktopConfig().set('language', lang as 'en' | 'zh-CN');
      } catch { /* config store may not be writable */ }
      // Keep UI_LANGUAGE env var in sync — the server also reads it
      process.env.UI_LANGUAGE = lang;
      // Rebuild tray menu immediately so labels reflect the new language
      rebuildTrayMenu();
      return true;
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// Gateway chooser — shown on first launch and when remote connection fails.
// ---------------------------------------------------------------------------
function createGatewayChooserHtml(initialMode: 'local' | 'remote' = 'local', initialUrl = '', initialToken = '', errorMessage = ''): string {
  const t = getT().gateway;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    height:100vh;display:flex;flex-direction:column;align-items:center;
    justify-content:center;background:linear-gradient(135deg,#1e1b4b,#312e81);
    color:#e2e8f0;padding:32px;user-select:none;
  }
  .card{
    background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);
    border-radius:16px;padding:32px;max-width:520px;width:100%;
  }
  h1{font-size:20px;font-weight:700;margin-bottom:24px;text-align:center}
  .option{
    display:flex;align-items:flex-start;gap:12px;padding:16px;
    border:2px solid rgba(255,255,255,.1);border-radius:12px;margin-bottom:12px;
    cursor:pointer;transition:border-color .2s,background .2s;
  }
  .option:hover{background:rgba(255,255,255,.04)}
  .option.active{border-color:#818cf8;background:rgba(99,102,241,.15)}
  .radio{
    width:20px;height:20px;border-radius:50%;border:2px solid rgba(255,255,255,.3);
    display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;
  }
  .option.active .radio{border-color:#818cf8}
  .option.active .radio::after{
    content:'';width:10px;height:10px;border-radius:50%;background:#818cf8;
  }
  .opt-title{font-weight:600;font-size:15px;margin-bottom:2px}
  .opt-desc{font-size:13px;color:#94a3b8}
  .remote-config{display:none;margin-top:16px;flex-direction:column;gap:12px}
  .remote-config.show{display:flex}
  input{
    width:100%;padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.15);
    background:rgba(255,255,255,.06);color:#e2e8f0;font-size:14px;outline:none;
    transition:border-color .2s;
  }
  input:focus{border-color:#818cf8}
  input::placeholder{color:#64748b}
  .actions{margin-top:20px;display:flex;gap:10px;justify-content:flex-end}
  button{
    padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600;
    cursor:pointer;border:none;transition:background .2s,opacity .2s;
  }
  button:disabled{opacity:.5;cursor:not-allowed}
  .btn-primary{background:#6366f1;color:#fff}
  .btn-primary:hover:not(:disabled){background:#5558e6}
  .btn-secondary{background:rgba(255,255,255,.08);color:#cbd5e1}
  .btn-secondary:hover:not(:disabled){background:rgba(255,255,255,.14)}
  .test-result{font-size:13px;margin-top:6px}
  .test-result.ok{color:#34d399}
  .test-result.err{color:#f87171}
  .error-banner{display:none;padding:10px 14px;border-radius:8px;margin-bottom:16px;font-size:13px;line-height:1.5}
  .error-banner.show{display:block}
  .error-banner.warn{background:rgba(251,191,36,.15);border:1px solid rgba(251,191,36,.3);color:#fbbf24}
  .error-banner.err{background:rgba(248,113,113,.15);border:1px solid rgba(248,113,113,.3);color:#f87171}
  .pwd-wrap{position:relative;display:flex}
  .pwd-wrap input{flex:1;padding-right:40px}
  .pwd-toggle{position:absolute;right:2px;top:50%;transform:translateY(-50%);width:36px;height:36px;display:flex;align-items:center;justify-content:center;background:none;border:none;cursor:pointer;color:#64748b;font-size:16px;line-height:1;padding:0;border-radius:6px;transition:color .2s}
  .pwd-toggle:hover{color:#e2e8f0}
</style></head><body>
<div class="card">
  <h1>${t.title}</h1>
  <div id="error-banner" class="error-banner err"></div>
  <div id="opt-local" class="option active" onclick="selectMode('local')">
    <div class="radio"></div>
    <div>
      <div class="opt-title">${t.local}</div>
      <div class="opt-desc">${t.localDesc}</div>
    </div>
  </div>
  <div id="opt-remote" class="option" onclick="selectMode('remote')">
    <div class="radio"></div>
    <div>
      <div class="opt-title">${t.remote}</div>
      <div class="opt-desc">${t.remoteDesc}</div>
    </div>
  </div>
  <div id="remote-config" class="remote-config">
    <input id="remote-url" type="text" placeholder="${t.urlPlaceholder}">
    <div class="pwd-wrap">
      <input id="remote-token" type="password" placeholder="${t.tokenPlaceholder}">
      <button class="pwd-toggle" onclick="toggleTokenVisibility()" title="Show/hide token">
        <svg id="eye-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>
        <svg id="eye-off-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>
      </button>
    </div>
    <div style="display:flex;align-items:center;gap:12px">
      <button class="btn-secondary" onclick="testConnection()">${t.testBtn}</button>
      <span id="test-result" class="test-result"></span>
    </div>
  </div>
  <div class="actions">
    <button class="btn-secondary" onclick="window.electronAPI.quitApp()">${t.exitBtn}</button>
    <button class="btn-primary" id="btn-save" onclick="save()">${t.saveBtn}</button>
  </div>
</div>
<script>
  let mode = '${initialMode}';
  (function() {
    if (mode === 'remote') {
      document.getElementById('opt-local').classList.remove('active');
      document.getElementById('opt-remote').classList.add('active');
      document.getElementById('remote-config').classList.add('show');
    }
    var urlEl = document.getElementById('remote-url');
    if ('${initialUrl.replace(/'/g, "\\'")}') urlEl.value = '${initialUrl.replace(/'/g, "\\'")}';
    var tokenEl = document.getElementById('remote-token');
    if ('${initialToken.replace(/'/g, "\\'")}') tokenEl.value = '${initialToken.replace(/'/g, "\\'")}';
    // Show error banner if there's an error message
    var errBanner = document.getElementById('error-banner');
    var errMsg = '${errorMessage.replace(/'/g, "\\'").replace(/\n/g, '<br>')}';
    if (errMsg) {
      errBanner.innerHTML = errMsg;
      errBanner.classList.add('show');
    }
  })();
  function toggleTokenVisibility() {
    var inp = document.getElementById('remote-token');
    var show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    document.getElementById('eye-icon').style.display = show ? 'none' : '';
    document.getElementById('eye-off-icon').style.display = show ? '' : 'none';
  }
  function selectMode(m) {
    mode = m;
    document.getElementById('opt-local').classList.toggle('active', m==='local');
    document.getElementById('opt-remote').classList.toggle('active', m==='remote');
    document.getElementById('remote-config').classList.toggle('show', m==='remote');
  }
  async function testConnection() {
    const rawUrl = document.getElementById('remote-url').value.replace(/\\/+$/,'');
    const token = document.getElementById('remote-token').value;
    const btn = event.target;
    const resultEl = document.getElementById('test-result');
    btn.disabled = true;
    btn.textContent = '${t.testing}';
    resultEl.textContent = '';
    resultEl.className = 'test-result';
    try {
      // Step 1: health check
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      var res = await fetch(rawUrl+'/api/health', {
        headers: token ? {Authorization:'Bearer '+token} : {},
        signal: ctrl.signal
      });
      clearTimeout(t);
      if (!res.ok) {
        resultEl.textContent = '${t.gatewayUnreachable}';
        resultEl.className = 'test-result err';
        btn.disabled = false;
        btn.textContent = '${t.testBtn}';
        return;
      }
      var v = '?';
      try { var d = await res.json(); v = d.version || '?'; } catch {}
      // Step 2: verify token (required for remote gateway)
      if (!token) {
        resultEl.textContent = '${t.serverOnlineTokenInvalid} (v'+v+')';
        resultEl.className = 'test-result err';
      } else {
        var ctrl2 = new AbortController();
        var t2 = setTimeout(function(){ ctrl2.abort(); }, 5000);
        try {
          var vres = await fetch(rawUrl+'/api/auth/verify', {
            headers: {Authorization:'Bearer '+token},
            signal: ctrl2.signal
          });
          clearTimeout(t2);
          if (vres.ok) {
            resultEl.textContent = '${t.connected} (v'+v+')';
            resultEl.className = 'test-result ok';
          } else {
            resultEl.textContent = '${t.serverOnlineTokenInvalid} (v'+v+')';
            resultEl.className = 'test-result err';
          }
        } catch(ve) {
          clearTimeout(t2);
          resultEl.textContent = '${t.serverOnlineTokenInvalid} (v'+v+')';
          resultEl.className = 'test-result err';
        }
      }
    } catch(e) {
      var msg = e.message || '';
      if (msg && msg.indexOf('aborted') !== -1) {
        resultEl.textContent = '${t.gatewayUnreachable}';
      } else {
        resultEl.textContent = '${t.gatewayUnreachable}';
      }
      resultEl.className = 'test-result err';
    } finally {
      btn.disabled = false;
      btn.textContent = '${t.testBtn}';
    }
  }
  function save() {
    const url = document.getElementById('remote-url').value.replace(/\\/+$/,'');
    const token = document.getElementById('remote-token').value;
    window.electronAPI.setGatewayConfig({ mode, remoteUrl: url, remoteToken: token });
    window.electronAPI.setConfig('firstRunDone', true);
    window.close();
  }
</script>
</body></html>`;
}

function showGatewayChooser(initialMode: 'local' | 'remote' = 'local', initialUrl = '', initialToken = '', errorMessage = ''): Promise<void> {
  return new Promise((resolve) => {
    const chooser = new BrowserWindow({
      width: 560,
      height: errorMessage ? 660 : 620,
      frame: false,
      resizable: false,
      center: true,
      show: false,
      skipTaskbar: false,
      alwaysOnTop: false,
      webPreferences: {
        preload: getPreloadPath(),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    chooser.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(createGatewayChooserHtml(initialMode, initialUrl, initialToken, errorMessage))}`);
    chooser.once('ready-to-show', () => chooser.show());
    chooser.on('closed', () => resolve());
  });
}

// ---------------------------------------------------------------------------
// Shared setup — runs for both local and remote modes
// ---------------------------------------------------------------------------

/** Inject hover overlay download button onto images in the WebUI page. */
function setupImageHoverDownload(win: BrowserWindow): void {
  win.webContents.executeJavaScript(`
    (function() {
      if (window.__omaImageDownloadInstalled) return;
      window.__omaImageDownloadInstalled = true;
      console.log('[OhMyAgent] Installing image hover download handler');

      var style = document.createElement('style');
      style.textContent = '.oma-img-wrap{position:relative;display:inline-block;line-height:0}' +
        '.oma-img-wrap img{display:block}' +
        '.oma-img-btn{position:absolute;bottom:6px;right:6px;display:flex;align-items:center;gap:4px;' +
        'padding:4px 8px;border-radius:6px;background:rgba(0,0,0,0.6);color:#fff;font-size:12px;' +
        'font-family:-apple-system,BlinkMacSystemFont,sans-serif;border:none;cursor:pointer;' +
        'opacity:0;transition:opacity .15s}' +
        '.oma-img-wrap:hover .oma-img-btn{opacity:1}' +
        '.oma-img-btn:hover{background:rgba(0,0,0,0.8)}';
      document.head.appendChild(style);

      function wrapImage(img) {
        if (img.closest('.oma-img-wrap')) return;
        if (img.naturalWidth < 40 || img.naturalHeight < 40) return;
        var wrap = document.createElement('span');
        wrap.className = 'oma-img-wrap';
        img.parentNode.insertBefore(wrap, img);
        wrap.appendChild(img);

        var btn = document.createElement('span');
        btn.className = 'oma-img-btn';
        btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>保存';
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          e.stopPropagation();
          var url = img.src;
          var filename = (function() {
            try {
              var u = new URL(url);
              var p = u.searchParams.get('path');
              if (p) return p.split('/').pop();
              var n = u.pathname.split('/').pop();
              if (n && n !== 'serve') return n;
            } catch(e) {}
            return url.split('/').pop().split('?')[0] || 'image.png';
          })();
          window.electronAPI.saveFileFromUrl(url, filename).then(function(r) {
            console.log('[OhMyAgent] saveFileFromUrl result', r);
          }).catch(function(err) {
            console.error('[OhMyAgent] saveFileFromUrl error', err);
          });
        });
        wrap.appendChild(btn);
      }

      // Wrap existing images
      document.querySelectorAll('img').forEach(wrapImage);

      // Watch for dynamically added images
      var observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(m) {
          m.addedNodes.forEach(function(node) {
            if (node.tagName === 'IMG') wrapImage(node);
            if (node.querySelectorAll) node.querySelectorAll('img').forEach(wrapImage);
          });
        });
      });
      observer.observe(document.body, { childList: true, subtree: true });
      console.log('[OhMyAgent] Image hover download handler installed');
    })();
  `).catch(err => diagLog(`[OhMyAgent] inject image hover JS error: ${err}`));
}

/** Register F12 / Ctrl+Shift+I DevTools shortcuts. */
function setupDevTools(win: BrowserWindow): void {
  if (!app.isPackaged) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
  const toggleDevTools = () => {
    if (win.isDestroyed()) return;
    if (win.webContents.isDevToolsOpened()) {
      win.webContents.closeDevTools();
    } else {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  };
  // globalShortcut for F12 (system-wide)
  const f12ok = globalShortcut.register('F12', toggleDevTools);
  diagLog(`[OhMyAgent] globalShortcut F12 registered: ${f12ok}`);
  // Fallback: before-input-event for Ctrl+Shift+I / F12
  win.webContents.on('before-input-event', (_event, input) => {
    if ((input.control && input.shift && input.key === 'I') || input.key === 'F12') {
      toggleDevTools();
    }
  });
}

// App lifecycle
app.whenReady().then(async () => {
  diagLog(`[OhMyAgent] App starting — version=${app.getVersion()} electron=${process.versions.electron} node=${process.versions.node} platform=${process.platform} arch=${process.arch} isPackaged=${app.isPackaged}`);

  const { port } = setupEnvironment();
  registerIpcHandlers();

  // Sync native theme (title bar) with saved user preference
  const savedTheme = getDesktopConfig().get('theme');
  if (savedTheme === 'dark' || savedTheme === 'light' || savedTheme === 'system') {
    nativeTheme.themeSource = savedTheme;
    diagLog(`[OhMyAgent] nativeTheme.themeSource set to "${savedTheme}" from saved config`);
  }

  // Hide the default Electron menu bar (Windows/Linux).
  Menu.setApplicationMenu(null);

  createWindow();

  // Keep window chrome in sync when the OS theme changes (matters for
  // themeSource='system' or when the user toggles dark mode in Windows).
  // Must be registered AFTER createWindow() so mainWindow exists.
  nativeTheme.on('updated', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const shouldUseDark = nativeTheme.shouldUseDarkColors;
      const DARK_BG = '#0a0a0a';
      const LIGHT_BG = '#ffffff';
      const bg = shouldUseDark ? DARK_BG : LIGHT_BG;
      mainWindow.setBackgroundColor(bg);
      mainWindow.setTitleBarOverlay({
        color: bg,
        symbolColor: shouldUseDark ? '#9ca3af' : '#525252',
        height: 40,
      });
      diagLog(`[OhMyAgent] nativeTheme.updated — window chrome sync (dark=${shouldUseDark})`);
    } catch (err) {
      diagLog(`[OhMyAgent] nativeTheme.updated — chrome sync error: ${err}`);
    }
  });

  // Initialize updater and point it at the main window
  getAppUpdater().setWindow(mainWindow!);

  const gatewayConfig = getDesktopConfig().getGatewayConfig();
  const firstRunDone = getDesktopConfig().get('firstRunDone');

  // Show gateway chooser on first launch
  if (!firstRunDone && gatewayConfig.mode === 'local' && !gatewayConfig.remoteUrl) {
    diagLog('[OhMyAgent] First launch — showing gateway chooser');
    await showGatewayChooser();
  }

  // Re-read after chooser may have updated config
  const finalGatewayConfig = getDesktopConfig().getGatewayConfig();

  if (finalGatewayConfig.mode === 'remote' && finalGatewayConfig.remoteUrl) {
    // ── Remote Gateway Mode ──────────────────────────────────────
    diagLog(`[OhMyAgent] Remote gateway mode — loading from ${finalGatewayConfig.remoteUrl}`);

    const remoteBase = finalGatewayConfig.remoteUrl.replace(/\/+$/, '');
    remoteGatewayBaseUrl = remoteBase;
    const remoteWebuiUrl = `${remoteBase}/webui/?electron=1`;

    // Show splash while checking / loading
    const splashWindow = createSplashWindow();

    // Pre-flight health + token check: avoid hanging on a dead remote for 30+ seconds
    // and distinguish "server offline" from "token invalid".
    diagLog(`[OhMyAgent] Pre-flight check to ${remoteBase} ...`);
    const healthResult = await checkRemoteHealth(remoteBase, finalGatewayConfig.remoteToken);
    if (healthResult !== 'ok') {
      const errorMsg = healthResult === 'unreachable'
        ? getT().error.connectionFailed
        : getT().error.tokenInvalid;
      diagLog(`[OhMyAgent] Pre-flight check result: ${healthResult} — showing gateway chooser`);
      splashWindow.close();
      mainWindow?.hide();
      await showGatewayChooser('remote', finalGatewayConfig.remoteUrl, finalGatewayConfig.remoteToken, errorMsg);
      // User made their choice in the chooser — restart to apply
      setTimeout(() => { app.relaunch(); app.exit(0); }, 200);
      return;
    }

    diagLog('[OhMyAgent] Remote gateway health check OK — loading WebUI');
    mainWindow?.loadURL(remoteWebuiUrl);

    // Safety-net timeout: if loadURL somehow hangs despite the health check
    // passing, show the gateway chooser after 15 seconds.
    const loadTimeoutMsg = getT().error.pageLoadTimeout;
    let timedOut = false;
    const loadTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        diagLog('[OhMyAgent] Remote gateway load timed out — showing gateway chooser');
        timedOut = true;
        splashWindow.close();
        mainWindow.hide();
        showGatewayChooser('remote', finalGatewayConfig.remoteUrl, finalGatewayConfig.remoteToken, loadTimeoutMsg).then(() => {
          setTimeout(() => { app.relaunch(); app.exit(0); }, 200);
        });
      }
    }, 15_000);

    mainWindow?.webContents.once('did-finish-load', () => {
      if (timedOut) return;
      clearTimeout(loadTimer);
      splashWindow.close();
      mainWindow?.maximize();
      mainWindow?.show();

      // Shared setup (works in both local and remote mode)
      if (mainWindow) {
        setupImageHoverDownload(mainWindow);
        setupDevTools(mainWindow);
      }

      // Start Desktop Bridge for remote tool execution on the local machine
      try {
        const wsUrl = remoteBase.replace(/^http/, 'ws') + '/desktop/bridge';
        desktopBridge = new DesktopBridge({
          gatewayUrl: wsUrl,
          token: finalGatewayConfig.remoteToken || '',
          logger: { info: diagLog, warn: diagLog, error: diagLog },
        });
        desktopBridge.start().catch((err: Error) => {
          diagLog(`[OhMyAgent] DesktopBridge start failed: ${err.message}`);
        });
      } catch (err) {
        diagLog(`[OhMyAgent] DesktopBridge creation failed: ${(err as Error).message}`);
      }
    });

    // Handle load failure (defense in depth — Chromium-level errors)
    mainWindow?.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      if (timedOut) return;
      clearTimeout(loadTimer);
      splashWindow.close();
      diagLog(`[OhMyAgent] Remote gateway load failed: ${errorDescription} (${errorCode}) url=${validatedURL}`);
      const failMsg = interpolate(getT().error.pageLoadFailed, { error: errorDescription });
      mainWindow?.hide();
      showGatewayChooser('remote', finalGatewayConfig.remoteUrl, finalGatewayConfig.remoteToken, failMsg).then(() => {
        setTimeout(() => { app.relaunch(); app.exit(0); }, 200);
      });
    });

    // Create tray in remote mode (no serverManager)
    try {
      createTray({
        mainWindow: mainWindow!,
        serverManager: null as unknown as ServerManager,
      });
      trayCreated = true;
    } catch (trayErr) {
      console.error('Failed to create tray:', trayErr);
    }
  } else {
    // ── Local Gateway Mode ───────────────────────────────────────
    diagLog('[OhMyAgent] Local gateway mode — starting embedded server');

    const splashWindow = createSplashWindow();

    try {
      const { ServerManager } = await import('./server-manager.js');
      serverManager = new ServerManager({
        port,
        bindAddress: '127.0.0.1',
        configPath: process.env.CONFIG_FILE!,
        dataDir: app.getPath('userData'),
        dbPath: process.env.DATABASE_PATH!,
      });

      await serverManager.start();

      const webuiUrl = `http://127.0.0.1:${port}/webui/?electron=1`;
      mainWindow?.loadURL(webuiUrl);

      mainWindow?.webContents.once('did-finish-load', () => {
        mainWindow?.maximize();
        mainWindow?.show();
        splashWindow.close();

        // Shared setup (works in both local and remote mode)
        if (mainWindow) {
          setupImageHoverDownload(mainWindow);
          setupDevTools(mainWindow);
        }
      });

      // Create system tray
      try {
        createTray({
          mainWindow: mainWindow!,
          serverManager,
        });
        trayCreated = true;
      } catch (trayErr) {
        console.error('Failed to create tray:', trayErr);
      }

      // DevTools: F12 or Ctrl+Shift+I.
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errorStack = err instanceof Error ? err.stack : '';
      diagLog(`[OhMyAgent] Server startup FAILED: ${errorMsg}`);
      if (errorStack) diagLog(`[OhMyAgent] Server startup stack: ${errorStack}`);
      console.error('Failed to start OhMyAgent server:', err);
      const title = getT().error.startupFailed;
      const portHint = errorMsg.includes('EADDRINUSE')
        ? `<p style="color:#e53e3e;margin-top:1rem">${interpolate(getT().error.portInUse, { port })}</p>`
        : '';
      mainWindow?.loadURL(`data:text/html;charset=utf-8,
        <html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;padding:2rem">
        <h2>${title}</h2>
        <p>${errorMsg}</p>${portHint}
        </body></html>`);

      if (mainWindow && serverManager) {
        try {
          createTray({ mainWindow, serverManager });
          trayCreated = true;
        } catch (trayErr) {
          console.error('Failed to create tray:', trayErr);
        }
      }
    }
  }
});

app.on('window-all-closed', () => {
  // On macOS, apps typically stay active until Cmd+Q.
  // On other platforms, keep running if tray exists.
  if (process.platform !== 'darwin' && !trayCreated) {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

app.on('before-quit', async () => {
  destroyTray();
  trayCreated = false;
  if (desktopBridge) {
    diagLog('[OhMyAgent] Stopping DesktopBridge');
    desktopBridge.stop();
    desktopBridge = null;
  }
  if (serverManager) {
    try {
      await serverManager.stop();
    } catch (err) {
      // Worker threads (pino etc.) may already be dead — not fatal during quit
      console.error('[OhMyAgent] Error stopping server manager (non-fatal):', err);
    }
  }
  // Flush and close diagnostic log stream
  if (diagLogStream) {
    try { diagLogStream.end(); } catch { /* ignore */ }
    diagLogStream = null;
  }
});
