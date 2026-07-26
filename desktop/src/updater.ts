import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import type { UpdateInfo } from 'electron-updater';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, shell } from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDesktopConfig } from './config.js';
import { getT, interpolate, type SupportedLocale } from './i18n.js';

/**
 * Strip a leading "v" from a version string (e.g. "v2.0.0" → "2.0.0").
 */
function stripLeadingV(v: string): string {
  return v.replace(/^[vV]/, '');
}

/**
 * Compare two version strings (simple semver: major.minor.patch[-prerelease]).
 * Returns negative if a < b, 0 if equal, positive if a > b.
 * Handles beta prerelease: 2.0.0-beta3 > 2.0.0-beta2 > 2.0.0-beta > 2.0.0.
 */
function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  // Core versions equal — compare prerelease
  if (!pa.beta && pb.beta) return 1;   // stable > beta
  if (pa.beta && !pb.beta) return -1;  // beta < stable
  if (pa.beta && pb.beta) return pa.betaNum - pb.betaNum;
  return 0;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  beta: boolean;
  betaNum: number;
}

function parseSemver(v: string): ParsedSemver {
  const cleaned = stripLeadingV(v);
  const [core, ...rest] = cleaned.split('-');
  const parts = core.split('.');
  const major = parseInt(parts[0] || '0', 10);
  const minor = parseInt(parts[1] || '0', 10);
  const patch = parseInt(parts[2] || '0', 10);
  const prerelease = rest.join('-');
  const betaMatch = /beta(\d*)/i.exec(prerelease);
  const beta = betaMatch !== null;
  const betaNum = beta ? (betaMatch![1] ? parseInt(betaMatch![1], 10) : 1) : 0;
  return { major, minor, patch, beta, betaNum };
}

/**
 * Minimal YAML parser for latest.yml format (flat key: value + array of objects).
 */
function parseLatestYml(text: string): { version: string; files: Array<{ url: string; sha512: string }>; path: string; sha512: string; releaseDate: string } {
  const result: any = { files: [] };
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line || line.startsWith('#')) { i++; continue; }

    // Top-level key: value
    const kv = /^(\w[\w-]*\w?):\s*(.*)/.exec(line);
    if (kv) {
      const key = kv[1];
      const value = kv[2].trim();
      if (key === 'files') {
        // Start of files array (- url: ...)
        i++;
        while (i < lines.length && /^\s*-/.test(lines[i])) {
          const urlMatch = /url:\s*(\S+)/.exec(lines[i]);
          // sha512 may be on the same line or the next
          let sha = '';
          const shaSameLine = /sha512:\s*(\S+)/.exec(lines[i]);
          if (shaSameLine) {
            sha = shaSameLine[1];
          } else {
            i++;
            if (i < lines.length) {
              const shaNext = /sha512:\s*(\S+)/.exec(lines[i]);
              if (shaNext) sha = shaNext[1];
            }
          }
          if (urlMatch) {
            result.files.push({ url: urlMatch[1], sha512: sha });
          }
          i++;
        }
        continue;
      } else if (value !== '') {
        result[key] = value;
      } else {
        // Value might be quoted or empty
        const quoted = /^['"](.*)['"]$/.exec(value);
        result[key] = quoted ? quoted[1] : value;
      }
    }
    i++;
  }
  return result as any;
}

interface CachedUpdate {
  version: string;
  releaseNotes: string | null;
  releaseUrl: string;
  files: Array<{ url: string; sha512: string }>;
}

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
  /** Cached result of macOS code-signature check. null = not yet checked. */
  private _macOSUnsigned: boolean | null = null;
  /** Cached update info from the last successful check. */
  private pendingUpdate: CachedUpdate | null = null;

  constructor() {
    // Do NOT auto-download — let the user decide
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    // Redirect electron-updater internal logs to our diagnostic log
    autoUpdater.logger = {
      info: (msg: string) => this.diagLog(`[updater:info] ${msg}`),
      warn: (msg: string) => this.diagLog(`[updater:warn] ${msg}`),
      error: (msg: string) => this.diagLog(`[updater:error] ${msg}`),
      debug: (_msg: string) => { /* skip debug */ },
    };

    this.registerListeners();

    // IPC handlers for progress window button actions.
    // The progress window renderer sends these via ipcRenderer.send().
    ipcMain.on('oma:progress-cancel', () => {
      this.cancelDownload();
    });
    ipcMain.on('oma:progress-install', () => {
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

  /**
   * Core update check using the GitHub REST API. Returns the release info if
   * an update is available, null if up-to-date, or throws on error.
   */
  private async checkForUpdateResult(includeBeta: boolean): Promise<{
    release: any;
    latestVersion: string;
    updateInfo: { version: string; files: Array<{ url: string; sha512: string }>; path: string; sha512: string; releaseDate: string };
  } | null> {
    const currentVersion = app.getVersion();

    // Fetch releases from GitHub REST API
    const apiUrl = 'https://api.github.com/repos/tscodeplus/OhMyAgent/releases?per_page=30';
    const resp = await net.fetch(apiUrl, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      throw new Error(`GitHub API returned ${resp.status}`);
    }

    const releases: any[] = await resp.json();
    if (!Array.isArray(releases) || releases.length === 0) {
      return null;
    }

    // Pick the right release
    const release = includeBeta
      ? releases[0]
      : releases.find((r: any) => !/beta/i.test(r.tag_name || ''));
    if (!release) {
      return null;
    }

    const latestVersion = (release.tag_name || '').replace(/^v/, '');
    this.diagLog(`checkForUpdateResult: remote=${latestVersion} current=${currentVersion}`);

    // Compare versions
    if (compareVersions(currentVersion, latestVersion) >= 0) {
      return null;
    }

    // Fetch latest.yml from the release to get file URLs and checksums
    const latestYmlUrl = `https://github.com/tscodeplus/OhMyAgent/releases/download/${release.tag_name}/latest.yml`;
    this.diagLog(`checkForUpdateResult: fetching ${latestYmlUrl}`);
    const ymlResp = await net.fetch(latestYmlUrl, { signal: AbortSignal.timeout(10_000) });
    if (!ymlResp.ok) {
      throw new Error(`latest.yml returned ${ymlResp.status}`);
    }

    const ymlText = await ymlResp.text();
    const updateInfo = parseLatestYml(ymlText);
    this.diagLog(`checkForUpdateResult: parsed version=${updateInfo.version} files=${JSON.stringify(updateInfo.files?.map((f: any) => f.url))}`);

    return { release, latestVersion, updateInfo };
  }

  /**
   * Check for updates (called from WebUI via IPC). Sends events to the
   * main window renderer so the About page can react.
   */
  async checkForUpdates(includeBeta = false): Promise<void> {
    this.downloadCancelled = false;
    this.pendingUpdate = null;
    this.diagLog(`checkForUpdates() called includeBeta=${includeBeta}`);
    await this.runNetworkDiagnostic();

    try {
      const result = await this.checkForUpdateResult(includeBeta);

      if (!result) {
        this.diagLog('checkForUpdates: no update available');
        this.mainWindow?.webContents.send('update-not-available');
        return;
      }

      const { release, latestVersion, updateInfo } = result;

      // Cache for download
      this.pendingUpdate = {
        version: latestVersion,
        releaseNotes: release.body || null,
        releaseUrl: release.html_url || '',
        files: updateInfo.files?.map((f: any) => ({ url: f.url, sha512: f.sha512 })) || [],
      };

      // Send update-available event for the WebUI
      this.mainWindow?.webContents.send('update-available', {
        version: latestVersion,
        releaseDate: release.published_at,
        releaseNotes: release.body,
      });
    } catch (err: any) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        this.diagLog('checkForUpdates: request timed out');
        this.mainWindow?.webContents.send('update-error', {
          message: getT().updater.networkTimeout,
          raw: 'Request timed out',
        });
      } else {
        this.diagLog(`checkForUpdates: error caught — ${err.message || String(err)}`);
        console.error('[AppUpdater] Check for updates failed');
      }
    }
  }

  async downloadUpdate(): Promise<void> {
    this.downloadCancelled = false;
    this.diagLog('downloadUpdate() called');
    this.downloading = true;

    try {
      // Prefer the pending update from our REST API check.
      // Fall back to electron-updater if checkForUpdates was called elsewhere.
      if (this.pendingUpdate) {
        await this.downloadFromPendingUpdate();
      } else {
        await this.runNetworkDiagnostic();
        await autoUpdater.downloadUpdate();
      }
      this.diagLog('downloadUpdate: completed successfully');
    } catch (err: any) {
      this.diagLog(`downloadUpdate: error caught — ${err.message || String(err)}`);
      console.error('[AppUpdater] Download failed');
      // Emit error so the WebUI can show it
      this.mainWindow?.webContents.send('update-error', {
        message: err.message || String(err),
        raw: err.message || String(err),
      });
    } finally {
      this.downloading = false;
    }
  }

  /**
   * Download the installer file via fetch with streaming-to-disk, resume
   * support, and progress reporting matching electron-updater's event format.
   *
   * Resume strategy:
   * 1. Always stream to a `.part` temp file (never buffer entirely in memory).
   * 2. Before fetching, check whether a `.part` file exists from a previous
   *    cancelled download. If it does and its version marker matches, send a
   *    `Range: bytes=<size>-` header to resume. If the version mismatches,
   *    delete the stale `.part` and start fresh.
   * 3. GitHub Releases CDN supports HTTP Range requests (206 Partial Content).
   * 4. After the stream completes, SHA512-verify the full `.part` file, then
   *    atomically rename it to the final installer name.
   * 5. On cancellation the `.part` file is preserved so the next attempt can
   *    resume from where it left off.
   */
  private async downloadFromPendingUpdate(): Promise<void> {
    const update = this.pendingUpdate!;
    const fileInfo = update.files[0];
    if (!fileInfo) {
      throw new Error('No files in update info');
    }
    const downloadUrl = `https://github.com/tscodeplus/OhMyAgent/releases/download/v${update.version}/${fileInfo.url}`;

    const downloadsDir = path.join(app.getPath('userData'), 'downloads');
    fs.mkdirSync(downloadsDir, { recursive: true });
    const installerPath = path.join(downloadsDir, fileInfo.url);
    const partPath = installerPath + '.part';
    const metaPath = installerPath + '.part.meta';

    // ── Resume / stale-cleanup ──
    let existingSize = 0;
    if (fs.existsSync(partPath)) {
      // Read version marker to decide whether to resume or discard
      let partVersion = '';
      try {
        if (fs.existsSync(metaPath)) {
          partVersion = JSON.parse(fs.readFileSync(metaPath, 'utf8')).version || '';
        }
      } catch { /* corrupt meta — treat as unknown version */ }

      if (partVersion === update.version) {
        existingSize = fs.statSync(partPath).size;
        this.diagLog(`downloadFromPendingUpdate: resuming from byte ${existingSize} (version ${update.version})`);
      } else {
        this.diagLog(`downloadFromPendingUpdate: stale .part for v${partVersion}, discarding (wanted v${update.version})`);
        fs.unlinkSync(partPath);
        try { fs.unlinkSync(metaPath); } catch { /* ok */ }
      }
    }

    // ── Fetch (with optional Range header) ──
    const headers: Record<string, string> = {};
    if (existingSize > 0) {
      headers['Range'] = `bytes=${existingSize}-`;
    }

    this.diagLog(`downloadFromPendingUpdate: downloading ${downloadUrl}${existingSize > 0 ? ` (resume at ${existingSize})` : ''}`);
    const resp = await net.fetch(downloadUrl, {
      headers,
      signal: AbortSignal.timeout(300_000),
    });

    if (!resp.ok && (resp.status !== 206)) {
      throw new Error(`Download failed: HTTP ${resp.status}`);
    }

    // Determine total file size.  GitHub CDN returns 206 + Content-Range for
    // range requests; 200 + Content-Length for fresh downloads.
    let totalSize: number;
    if (resp.status === 206) {
      const cr = resp.headers.get('content-range');
      const m = /bytes \d+-\d+\/(\d+)/.exec(cr || '');
      if (m) {
        totalSize = parseInt(m[1], 10);
      } else {
        // Fallback — should not happen with a well-behaved CDN
        const cl = parseInt(resp.headers.get('content-length') || '0', 10);
        totalSize = existingSize + cl;
      }
    } else {
      totalSize = parseInt(resp.headers.get('content-length') || '0', 10);
      // Server ignored Range — reset
      if (existingSize > 0) {
        this.diagLog('downloadFromPendingUpdate: server ignored Range header, restarting');
        existingSize = 0;
      }
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error('No response body');

    // Write version marker so future attempts can detect version changes
    try {
      fs.writeFileSync(metaPath, JSON.stringify({ version: update.version }), 'utf8');
    } catch { /* best effort */ }

    // ── Stream to .part file ──
    const flags = existingSize > 0 ? 'a' : 'w';
    const stream = fs.createWriteStream(partPath, { flags });

    let downloaded = existingSize;
    let lastPercent = existingSize > 0 ? (existingSize / totalSize) * 100 : 0;
    let lastReportTime = Date.now();
    let lastReportSize = existingSize;

    try {
      while (true) {
        if (this.downloadCancelled) {
          reader.cancel();
          this.diagLog(`downloadFromPendingUpdate: cancelled (kept ${downloaded} / ${totalSize} bytes in .part)`);
          return;
        }
        const { done, value } = await reader.read();
        if (done) break;

        stream.write(value);
        downloaded += value.length;

        const now = Date.now();
        const elapsed = now - lastReportTime;
        if (elapsed >= 200) {
          const bytesPerSecond = elapsed > 0 ? ((downloaded - lastReportSize) / elapsed) * 1000 : 0;
          lastReportTime = now;
          lastReportSize = downloaded;

          const percent = totalSize > 0 ? (downloaded / totalSize) * 100 : 50;
          // Never report a lower percentage — prevents the progress bar from jumping backwards
          if (percent >= lastPercent) {
            lastPercent = percent;
            this.sendProgress(Math.round(percent * 10) / 10, bytesPerSecond, totalSize, downloaded);
          }
        }
      }
    } finally {
      // Always close the write stream (even on cancel / error)
      stream.end();
    }

    // Wait for the last write to flush to disk
    await new Promise<void>((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject);
    });

    // Final 100% report
    this.sendProgress(100, 0, totalSize, downloaded);

    // ── SHA512 verification ──
    if (fileInfo.sha512) {
      const fileBuffer = fs.readFileSync(partPath);
      const hash = createHash('sha512').update(fileBuffer).digest('base64');
      if (hash !== fileInfo.sha512) {
        // Corrupt download — discard so the next attempt starts fresh
        fs.unlinkSync(partPath);
        try { fs.unlinkSync(metaPath); } catch { /* ok */ }
        throw new Error(`SHA512 mismatch: expected ${fileInfo.sha512.slice(0, 20)}..., got ${hash.slice(0, 20)}...`);
      }
      this.diagLog('downloadFromPendingUpdate: SHA512 verified');
    }

    // ── Finalize: rename .part → installer ──
    fs.renameSync(partPath, installerPath);
    try { fs.unlinkSync(metaPath); } catch { /* ok */ }
    this.diagLog(`downloadFromPendingUpdate: saved to ${installerPath} (${downloaded} bytes)`);

    // Signal that update is downloaded
    this.updateDownloaded = true;
    const unsigned = this.isMacOSUnsigned();
    this.sendDownloaded(update.version, update.releaseNotes, unsigned);
  }

  /** Send download progress to both the main window and the progress window. */
  private sendProgress(percent: number, bytesPerSecond: number, total: number, transferred: number): void {
    const data = { percent, bytesPerSecond, total, transferred };
    this.mainWindow?.webContents.send('update-download-progress', data);
    if (this.progressWin && !this.progressWin.isDestroyed()) {
      this.progressWin.webContents.send('update-download-progress', data);
    }
  }

  /** Send update-downloaded event to both the main window and the progress window. */
  private sendDownloaded(version: string, releaseNotes: string | null, unsigned: boolean): void {
    const data = { version, releaseNotes, unsigned };
    this.mainWindow?.webContents.send('update-downloaded', data);
    if (this.progressWin && !this.progressWin.isDestroyed()) {
      this.progressWin.webContents.send('update-downloaded', data);
    }
  }

  /** Set to true before quitAndInstall so the main window close handler
   *  knows to allow the close (bypassing closeToTray on macOS). */
  forceQuitting = false;

  /**
   * Check whether the current macOS build lacks a valid Apple code signature.
   * Squirrel.Mac (the Electron update framework on macOS) requires a properly
   * signed app bundle to verify and apply updates.  Unsigned / ad-hoc signed
   * builds can still download updates but cannot auto-install them — users
   * must manually replace the .app bundle from GitHub Releases.
   *
   * The check only runs on darwin and caches the result for the lifetime of
   * the process (the signature cannot change without a reinstall).
   */
  isMacOSUnsigned(): boolean {
    if (this._macOSUnsigned !== null) return this._macOSUnsigned;
    if (process.platform !== 'darwin') {
      this._macOSUnsigned = false;
      return false;
    }
    try {
      // codesign -dv succeeds only when a valid signature is present.
      execFileSync('codesign', ['-dv', process.execPath], {
        stdio: 'ignore',
        timeout: 5_000,
      });
      this._macOSUnsigned = false;
    } catch {
      this._macOSUnsigned = true;
    }
    this.diagLog(`macOS code-signature check: unsigned=${this._macOSUnsigned} (path=${process.execPath})`);
    return this._macOSUnsigned;
  }

  installAndRestart(): void {
    if (!this.updateDownloaded) {
      this.diagLog('installAndRestart: updateDownloaded is false — no-op');
      return;
    }
    // Unsigned macOS builds cannot use Squirrel.Mac — direct the user to
    // GitHub Releases for a manual update instead of silently failing.
    if (this.isMacOSUnsigned()) {
      this.diagLog('installAndRestart: unsigned macOS build — opening GitHub Releases');
      shell.openExternal('https://github.com/tscodeplus/OhMyAgent/releases');
      return;
    }

    // If we have a pending update from our REST API flow, run the downloaded
    // NSIS installer directly (Windows). On other platforms, fall back to
    // electron-updater's quitAndInstall which handles Squirrel.Mac / AppImage.
    if (this.pendingUpdate && process.platform === 'win32') {
      const downloadsDir = path.join(app.getPath('userData'), 'downloads');
      const installerName = this.pendingUpdate.files[0]?.url;
      const installerPath = path.join(downloadsDir, installerName);
      if (installerName && fs.existsSync(installerPath)) {
        this.forceQuitting = true;
        this.diagLog(`installAndRestart: spawning ${installerPath} --updated`);
        spawn(installerPath, ['--updated'], { detached: true, stdio: 'ignore' }).unref();
        app.quit();
        return;
      }
      this.diagLog(`installAndRestart: installer not found at ${installerPath}`);
    }

    this.forceQuitting = true;
    this.diagLog('installAndRestart: calling quitAndInstall');
    autoUpdater.quitAndInstall(false, true);
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
      const unsigned = this.isMacOSUnsigned();
      const data = { version: info.version, releaseNotes: info.releaseNotes, unsigned };
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
      } else if (
        message.includes('code signature') ||
        message.includes('Code sign') ||
        message.includes('codesign')
      ) {
        // macOS unsigned builds: Squirrel.Mac cannot verify or apply updates
        // without a valid Apple Developer ID code signature.
        message = getT().updater.unsignedMacBuild;
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
      const result = await this.checkForUpdateResult(true);
      clearTimeout(safetyTimer);
      closeSpinWin();

      if (result) {
        // Verify the update is actually newer
        const currentVer = app.getVersion();
        if (result.latestVersion === currentVer) {
          this.showUpToDateDialog();
        } else {
          // Cache for later download (e.g., from WebUI About page)
          this.pendingUpdate = {
            version: result.latestVersion,
            releaseNotes: result.release.body || null,
            releaseUrl: result.release.html_url || '',
            files: result.updateInfo.files?.map((f: any) => ({ url: f.url, sha512: f.sha512 })) || [],
          };
          // Build an UpdateInfo-compatible object for the dialog
          this.showUpdateDialogForTray({
            version: result.latestVersion,
            releaseDate: result.release.published_at,
            releaseNotes: result.release.body,
            files: result.updateInfo.files?.map((f: any) => ({ url: f.url, sha512: f.sha512 })) || [],
          } as UpdateInfo);
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
      } else if (
        message.includes('code signature') ||
        message.includes('Code sign') ||
        message.includes('codesign')
      ) {
        message = getT().updater.unsignedMacBuild;
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
        if (this.isMacOSUnsigned()) {
          shell.openExternal('https://github.com/tscodeplus/OhMyAgent/releases');
        } else {
          this.showDownloadProgressWindow();
          this.downloadUpdate();
        }
      } else if (url === 'oma://close-dialog') {
        win.close();
      }
    });

    // Also handle location changes via other means (will-redirect, etc.)
    win.webContents.on('will-redirect', (event, url) => {
      event.preventDefault();
      if (url === 'oma://upgrade') {
        win.close();
        if (this.isMacOSUnsigned()) {
          shell.openExternal('https://github.com/tscodeplus/OhMyAgent/releases');
        } else {
          this.showDownloadProgressWindow();
          this.downloadUpdate();
        }
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
  function fmtSpeed(bps){var s=fmtSize(bps);return s?s+'/s':''}
  var _lastPct=0;
  ipc.on('update-download-progress',function(_e,d){
    var pct=Math.round(d.percent);
    if(pct<_lastPct)return; _lastPct=pct;
    document.getElementById('pct').textContent=pct+'%';
    document.getElementById('bar').style.width=pct+'%';
    document.getElementById('spd').textContent=fmtSpeed(d.bytesPerSecond||0);
  });
  ipc.on('update-downloaded',function(_e,d){
    document.getElementById('pct').textContent='100%';
    document.getElementById('bar').style.width='100%';
    document.getElementById('spd').textContent='';
    if (d && d.unsigned) {
      document.getElementById('st').textContent='${getT().updater.unsignedMacBuild.replace(/'/g, "\\'")}';
      document.getElementById('btn-releases').style.display='';
      document.getElementById('btn-install').style.display='none';
    } else {
      document.getElementById('st').textContent='${getT().updater.downloaded}';
      document.getElementById('btn-install').style.display='';
      document.getElementById('btn-releases').style.display='none';
    }
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
        const proxy = await session.resolveProxy('https://github.com');
        this.diagLog(`[Proxy] resolveProxy result for https://github.com = "${proxy}"`);
      }
    } catch (e: any) {
      this.diagLog(`Failed to resolve proxy: ${e.message}`);
    }

    // ── Connectivity test ──
    // Use GET (not HEAD) so we detect 404s and actually verify file download capability
    const testUrls = [
      { label: 'GitHub API', url: 'https://api.github.com/repos/tscodeplus/OhMyAgent/releases/latest' },
      { label: 'latest.yml (beta3)', url: 'https://github.com/tscodeplus/OhMyAgent/releases/download/v2.0.0-beta3/latest.yml' },
    ];
    for (const { label, url } of testUrls) {
      try {
        const resp = await net.fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
        this.diagLog(`[${label}] OK status=${resp.status} (${resp.headers.get('content-length') || '?'} bytes)`);
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
   * Convert GitHub-flavored Markdown release notes to HTML for the custom dialog.
   * Handles: headings, bold, italic, inline code, code blocks, unordered lists,
   * ordered lists, links, images, and paragraphs.
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
      const sanitized = trimmed
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
        .replace(/<object[\s\S]*?<\/object>/gi, '')
        .replace(/<embed[\s\S]*?>/gi, '')
        .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
        .replace(/\son\w+\s*=\s*'[^']*'/gi, '');
      return sanitized.length > 3000 ? sanitized.slice(0, 3000) + '…' : sanitized;
    }

    // Normalize line endings (GitHub API returns \r\n)
    let html = trimmed.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // ── Code blocks (must come before inline code) ──
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
      const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<pre><code>${escaped}</code></pre>`;
    });

    // ── Inline code ──
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // ── Headings ──
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // ── Bold & italic ──
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
    html = html.replace(/___(.+?)___/g, '<strong><em>$1</em></strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
    html = html.replace(/(?<!_)_([^_\n]+)_(?!_)/g, '<em>$1</em>');

    // ── Links & images ──
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">');

    // ── Horizontal rules ──
    html = html.replace(/^[-*_]{3,}\s*$/gm, '<hr>');

    // ── Unordered list items ──
    // Group adjacent lines starting with "- " or "* " into <ul> blocks
    html = html.replace(/((?:^[-*] .+(?:\n|$))+)/gm, (block) => {
      const items = block.trim().split('\n').map(line => `<li>${line.replace(/^[-*] /, '')}</li>`).join('');
      return `<ul>${items}</ul>`;
    });

    // ── Ordered list items ──
    html = html.replace(/((?:^\d+\. .+(?:\n|$))+)/gm, (block) => {
      const items = block.trim().split('\n').map(line => `<li>${line.replace(/^\d+\. /, '')}</li>`).join('');
      return `<ol>${items}</ol>`;
    });

    // ── Paragraphs: split on double newlines, wrap non-block elements in <p> ──
    const parts = html.split(/\n{2,}/);
    html = parts.map(part => {
      const trimmedPart = part.trim();
      if (!trimmedPart) return '';
      // Don't wrap block elements
      if (/^<(h[1-4]|ul|ol|pre|hr|blockquote)/.test(trimmedPart)) return trimmedPart;
      return `<p>${trimmedPart.replace(/\n/g, '<br>')}</p>`;
    }).filter(Boolean).join('');

    return html.length > 3000 ? html.slice(0, 3000) + '…' : html;
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
