// Updater — port of desktop/src/updater.ts (self-hosted GitHub Releases check,
// .part resumable download, SHA512 verify, installer spawn) without Electron.
//
// Electron dependencies replaced:
//   1. net.fetch            → global fetch (Node 22 stream API identical)
//   2. app.getVersion()     → process.env.OMA_APP_VERSION
//   3. app.getPath(userData)→ process.env.OHMYAGENT_HOME
//   4. webContents.send()   → broadcastEvent() (SSE to compat layer + dialogs)
//   5. spawn(installer --updated) → POST shell /update-install (Rust spawns
//      the installer DETACHED and exits)
//   6. BrowserWindow dialogs → POST shell /show-window; the dialog HTML talks
//      to the compat layer (window.electronAPI) instead of ipcRenderer

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { broadcastEvent, cachePage } from './control-server.js';
import { loadConfig } from './config.js';
import { getT, interpolate } from './i18n.js';
import { fetchWithProxy } from './net.js';

// ---------------------------------------------------------------------------
// Version compare + latest.yml parser (verbatim from desktop/src/updater.ts)
// ---------------------------------------------------------------------------

function stripLeadingV(v: string): string {
  return v.replace(/^[vV]/, '');
}

/** Compare two version strings. Returns negative if a < b, 0 equal, positive if a > b.
 *  Handles beta prerelease: 2.0.0-beta3 > 2.0.0-beta2 > 2.0.0-beta > 2.0.0. */
function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (!pa.beta && pb.beta) return 1; // stable > beta
  if (pa.beta && !pb.beta) return -1; // beta < stable
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

/** Minimal YAML parser for latest.yml format (flat key: value + array of objects). */
function parseLatestYml(
  text: string,
): {
  version: string;
  files: Array<{ url: string; sha512: string }>;
  path: string;
  sha512: string;
  releaseDate: string;
} {
  const result: Record<string, unknown> & { files: Array<{ url: string; sha512: string }> } = {
    files: [],
  };
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line || line.startsWith('#')) {
      i++;
      continue;
    }

    const kv = /^(\w[\w-]*\w?):\s*(.*)/.exec(line);
    if (kv) {
      const key = kv[1];
      const value = kv[2].trim();
      if (key === 'files') {
        i++;
        while (i < lines.length && /^\s*-/.test(lines[i])) {
          const urlMatch = /url:\s*(\S+)/.exec(lines[i]);
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
      }
    }
    i++;
  }
  return result as ReturnType<typeof parseLatestYml>;
}

interface CachedUpdate {
  version: string;
  releaseNotes: string | null;
  releaseUrl: string;
  files: Array<{ url: string; sha512: string }>;
}

// ---------------------------------------------------------------------------
// Shell control API helpers (POST /show-window etc.)
// ---------------------------------------------------------------------------

function shellControlPort(): number {
  return Number(process.env.OMA_DESKTOP_CONTROL_PORT ?? 0);
}

function shellControlToken(): string {
  return process.env.OMA_CONTROL_TOKEN ?? '';
}

async function shellFetch(pathname: string, body?: unknown): Promise<void> {
  const port = shellControlPort();
  if (!port) {
    // Dev mode: no Rust shell control service — dialogs are skipped.
    diagLog(`shellFetch(${pathname}) skipped (no shell control port)`);
    return;
  }
  try {
    await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${shellControlToken()}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : '{}',
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    diagLog(`shellFetch(${pathname}) failed: ${e instanceof Error ? e.message : e}`);
  }
}

function showWindow(kind: string, html: string, width: number, height: number, dark: boolean): void {
  // The Rust shell builds the dialog window against a real http:// page
  // (data: URLs are rejected by the remote-origin ACL), so the HTML is cached
  // here and served from the control API; /show-window only carries geometry.
  cachePage(kind, html);
  void shellFetch('/show-window', { kind, width, height, dark });
}

/** Write an updater diagnostic message to the shared diag log (same path as Electron). */
function diagLog(msg: string): void {
  try {
    const home = process.env.OHMYAGENT_HOME ?? '.';
    const logsDir = path.join(home, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const ts = new Date().toISOString();
    fs.appendFileSync(path.join(logsDir, 'electron-diag.log'), `[${ts}] [AppUpdater] ${msg}\n`);
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// AppUpdater
// ---------------------------------------------------------------------------

export class AppUpdater {
  private updateDownloaded = false;
  /** True while a download is in progress (used to classify errors). */
  private downloading = false;
  /** True when the user has cancelled an in-progress download. */
  private downloadCancelled = false;
  /** Cached result of macOS code-signature check. null = not yet checked. */
  private _macOSUnsigned: boolean | null = null;
  /** Cached update info from the last successful check. */
  private pendingUpdate: CachedUpdate | null = null;

  /** Check for updates (called from WebUI via control API). Sends SSE events. */
  async checkForUpdates(includeBeta = false): Promise<void> {
    this.downloadCancelled = false;
    this.pendingUpdate = null;
    diagLog(`checkForUpdates() called includeBeta=${includeBeta}`);
    await this.runNetworkDiagnostic();

    try {
      const result = await this.checkForUpdateResult(includeBeta);

      if (!result) {
        diagLog('checkForUpdates: no update available');
        broadcastEvent('update-not-available', {});
        return;
      }

      const { release, latestVersion, updateInfo } = result;

      this.pendingUpdate = {
        version: latestVersion,
        releaseNotes: release.body || null,
        releaseUrl: release.html_url || '',
        files: updateInfo.files?.map((f) => ({ url: f.url, sha512: f.sha512 })) || [],
      };

      broadcastEvent('update-available', {
        version: latestVersion,
        releaseDate: release.published_at,
        releaseNotes: release.body,
      });
    } catch (err: unknown) {
      const e = err as { name?: string; message?: string };
      if (e.name === 'AbortError' || e.name === 'TimeoutError') {
        diagLog('checkForUpdates: request timed out');
        broadcastEvent('update-error', {
          message: getT().updater.networkTimeout,
          raw: 'Request timed out',
        });
      } else {
        // Non-timeout failures must also reach the WebUI — without the
        // event the about page stays on "checking" forever (the UI has no
        // polling fallback and compat.js ctlFetch resolved fine).
        diagLog(`checkForUpdates: error caught — ${e.message || String(err)}`);
        console.error('[AppUpdater] Check for updates failed');
        broadcastEvent('update-error', {
          message: getT().updater.checkFailed,
          raw: e.message || String(err),
        });
      }
    }
  }

  private async checkForUpdateResult(includeBeta: boolean): Promise<{
    release: {
      tag_name?: string;
      body?: string | null;
      html_url?: string;
      published_at?: string;
    };
    latestVersion: string;
    updateInfo: ReturnType<typeof parseLatestYml>;
  } | null> {
    const currentVersion = process.env.OMA_APP_VERSION ?? '0.0.0';

    // Fetch releases from GitHub REST API.
    const apiUrl = 'https://api.github.com/repos/tscodeplus/OhMyAgent/releases?per_page=30';
    const resp = await fetchWithProxy(apiUrl, {
      headers: { Accept: 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      throw new Error(`GitHub API returned ${resp.status}`);
    }

    const releases = (await resp.json()) as Array<{
      tag_name?: string;
      body?: string | null;
      html_url?: string;
      published_at?: string;
      prerelease?: boolean;
    }>;
    if (!Array.isArray(releases) || releases.length === 0) {
      return null;
    }

    const release = includeBeta
      ? releases[0]
      : releases.find((r) => !/beta/i.test(r.tag_name || ''));
    if (!release) {
      return null;
    }

    const latestVersion = (release.tag_name || '').replace(/^v/, '');
    diagLog(`checkForUpdateResult: remote=${latestVersion} current=${currentVersion}`);

    if (compareVersions(currentVersion, latestVersion) >= 0) {
      return null;
    }

    // Fetch latest.yml from the release to get file URLs and checksums.
    const latestYmlUrl = `https://github.com/tscodeplus/OhMyAgent/releases/download/${release.tag_name}/latest.yml`;
    diagLog(`checkForUpdateResult: fetching ${latestYmlUrl}`);
    const ymlResp = await fetchWithProxy(latestYmlUrl, { signal: AbortSignal.timeout(10_000) });
    if (!ymlResp.ok) {
      throw new Error(`latest.yml returned ${ymlResp.status}`);
    }

    const ymlText = await ymlResp.text();
    const updateInfo = parseLatestYml(ymlText);
    diagLog(
      `checkForUpdateResult: parsed version=${updateInfo.version} files=${JSON.stringify(updateInfo.files?.map((f) => f.url))}`,
    );

    return { release, latestVersion, updateInfo };
  }

  async downloadUpdate(): Promise<void> {
    this.downloadCancelled = false;
    diagLog('downloadUpdate() called');
    this.downloading = true;

    try {
      if (this.pendingUpdate) {
        await this.downloadFromPendingUpdate();
      } else {
        throw new Error('No pending update — run checkForUpdates first');
      }
      diagLog('downloadUpdate: completed successfully');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      diagLog(`downloadUpdate: error caught — ${msg}`);
      console.error('[AppUpdater] Download failed');
      broadcastEvent('update-error', { message: msg, raw: msg });
    } finally {
      this.downloading = false;
    }
  }

  /**
   * Download the installer via fetch with streaming-to-disk, resume support and
   * progress reporting. Same strategy as the Electron version: stream to a
   * `.part` file, resume with Range when the version marker matches, verify
   * SHA512, atomically rename.
   */
  private async downloadFromPendingUpdate(): Promise<void> {
    const update = this.pendingUpdate!;
    const fileInfo = update.files[0];
    if (!fileInfo) {
      throw new Error('No files in update info');
    }
    const downloadUrl = `https://github.com/tscodeplus/OhMyAgent/releases/download/v${update.version}/${fileInfo.url}`;

    const downloadsDir = path.join(process.env.OHMYAGENT_HOME ?? '.', 'downloads');
    fs.mkdirSync(downloadsDir, { recursive: true });
    const installerPath = path.join(downloadsDir, fileInfo.url);
    const partPath = installerPath + '.part';
    const metaPath = installerPath + '.part.meta';

    // Resume / stale-cleanup.
    let existingSize = 0;
    if (fs.existsSync(partPath)) {
      let partVersion = '';
      try {
        if (fs.existsSync(metaPath)) {
          partVersion = (JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { version?: string }).version ?? '';
        }
      } catch {
        /* corrupt meta — treat as unknown version */
      }

      if (partVersion === update.version) {
        existingSize = fs.statSync(partPath).size;
        diagLog(`downloadFromPendingUpdate: resuming from byte ${existingSize} (version ${update.version})`);
      } else {
        diagLog(`downloadFromPendingUpdate: stale .part for v${partVersion}, discarding (wanted v${update.version})`);
        fs.unlinkSync(partPath);
        try {
          fs.unlinkSync(metaPath);
        } catch {
          /* ok */
        }
      }
    }

    // Fetch (with optional Range header).
    const headers: Record<string, string> = {};
    if (existingSize > 0) {
      headers['Range'] = `bytes=${existingSize}-`;
    }

    diagLog(
      `downloadFromPendingUpdate: downloading ${downloadUrl}${existingSize > 0 ? ` (resume at ${existingSize})` : ''}`,
    );
    const resp = await fetchWithProxy(downloadUrl, {
      headers,
      signal: AbortSignal.timeout(300_000),
    });

    if (!resp.ok && resp.status !== 206) {
      throw new Error(`Download failed: HTTP ${resp.status}`);
    }

    // Determine total file size (206 + Content-Range for resume; 200 for fresh).
    let totalSize: number;
    if (resp.status === 206) {
      const cr = resp.headers.get('content-range');
      const m = /bytes \d+-\d+\/(\d+)/.exec(cr || '');
      if (m) {
        totalSize = parseInt(m[1], 10);
      } else {
        const cl = parseInt(resp.headers.get('content-length') || '0', 10);
        totalSize = existingSize + cl;
      }
    } else {
      totalSize = parseInt(resp.headers.get('content-length') || '0', 10);
      if (existingSize > 0) {
        diagLog('downloadFromPendingUpdate: server ignored Range header, restarting');
        existingSize = 0;
      }
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error('No response body');

    // Write version marker so future attempts can detect version changes.
    try {
      fs.writeFileSync(metaPath, JSON.stringify({ version: update.version }), 'utf8');
    } catch {
      /* best effort */
    }

    // Stream to .part file.
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
          diagLog(`downloadFromPendingUpdate: cancelled (kept ${downloaded} / ${totalSize} bytes in .part)`);
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
          // Never report a lower percentage — prevents the bar jumping backwards.
          if (percent >= lastPercent) {
            lastPercent = percent;
            this.sendProgress(Math.round(percent * 10) / 10, bytesPerSecond, totalSize, downloaded);
          }
        }
      }
    } finally {
      stream.end();
    }

    await new Promise<void>((resolve, reject) => {
      stream.on('finish', resolve);
      stream.on('error', reject);
    });

    this.sendProgress(100, 0, totalSize, downloaded);

    // SHA512 verification.
    if (fileInfo.sha512) {
      const fileBuffer = fs.readFileSync(partPath);
      const hash = createHash('sha512').update(fileBuffer).digest('base64');
      if (hash !== fileInfo.sha512) {
        fs.unlinkSync(partPath);
        try {
          fs.unlinkSync(metaPath);
        } catch {
          /* ok */
        }
        throw new Error(
          `SHA512 mismatch: expected ${fileInfo.sha512.slice(0, 20)}..., got ${hash.slice(0, 20)}...`,
        );
      }
      diagLog('downloadFromPendingUpdate: SHA512 verified');
    }

    // Finalize: rename .part → installer.
    fs.renameSync(partPath, installerPath);
    try {
      fs.unlinkSync(metaPath);
    } catch {
      /* ok */
    }
    diagLog(`downloadFromPendingUpdate: saved to ${installerPath} (${downloaded} bytes)`);

    this.updateDownloaded = true;
    const unsigned = this.isMacOSUnsigned();
    this.sendDownloaded(update.version, update.releaseNotes, unsigned);
  }

  private sendProgress(percent: number, bytesPerSecond: number, total: number, transferred: number): void {
    broadcastEvent('update-download-progress', { percent, bytesPerSecond, total, transferred });
  }

  private sendDownloaded(version: string, releaseNotes: string | null, unsigned: boolean): void {
    broadcastEvent('update-downloaded', { version, releaseNotes, unsigned });
  }

  /**
   * Check whether the current macOS build lacks a valid Apple code signature.
   * Unsigned builds can download updates but cannot auto-install.
   */
  isMacOSUnsigned(): boolean {
    if (this._macOSUnsigned !== null) return this._macOSUnsigned;
    if (process.platform !== 'darwin') {
      this._macOSUnsigned = false;
      return false;
    }
    try {
      execFileSync('codesign', ['-dv', process.execPath], {
        stdio: 'ignore',
        timeout: 5_000,
      });
      this._macOSUnsigned = false;
    } catch {
      this._macOSUnsigned = true;
    }
    diagLog(`macOS code-signature check: unsigned=${this._macOSUnsigned}`);
    return this._macOSUnsigned;
  }

  /** Install the downloaded update: ask the shell to spawn the installer and exit. */
  async installUpdate(): Promise<void> {
    if (!this.updateDownloaded) {
      diagLog('installUpdate: updateDownloaded is false — no-op');
      return;
    }
    if (this.isMacOSUnsigned()) {
      diagLog('installUpdate: unsigned macOS build — opening GitHub Releases');
      void shellFetch('/open-external', { url: 'https://github.com/tscodeplus/OhMyAgent/releases' });
      return;
    }

    if (this.pendingUpdate && process.platform === 'win32') {
      const downloadsDir = path.join(process.env.OHMYAGENT_HOME ?? '.', 'downloads');
      const installerName = this.pendingUpdate.files[0]?.url;
      const installerPath = path.join(downloadsDir, installerName);
      if (installerName && fs.existsSync(installerPath)) {
        diagLog(`installUpdate: shell spawns ${installerPath} --updated`);
        // Rust spawns the installer DETACHED and exits the shell.
        await shellFetch('/update-install', { path: installerPath });
        return;
      }
      diagLog(`installUpdate: installer not found at ${installerPath}`);
    }

    diagLog('installUpdate: no compatible install path (mac non-unsigned not yet supported)');
    // macOS signed builds: future tauri-plugin-updater / manual flow.
    void shellFetch('/open-external', { url: 'https://github.com/tscodeplus/OhMyAgent/releases' });
  }

  cancelDownload(): void {
    diagLog('cancelDownload() called');
    this.downloadCancelled = true;
    this.downloading = false;
  }

  isUpdateDownloaded(): boolean {
    return this.updateDownloaded;
  }

  /**
   * Check for updates from the tray — spinner window during the check, then a
   * dialog with the result. All windows are rendered by the Rust shell via
   * POST /show-window; their buttons talk to the compat layer.
   */
  async checkForUpdatesFromTray(): Promise<void> {
    const isDark = this.isDarkTheme();

    const primaryBg = isDark ? '#1e1e2e' : '#f8fafc';
    const textColor = isDark ? '#cdd6f4' : '#334155';
    const textMuted = isDark ? '#a6adc8' : '#64748b';
    const spinnerTrack = isDark ? 'rgba(205,214,244,0.15)' : 'rgba(51,65,85,0.12)';
    const spinnerFill = isDark ? '#89b4fa' : '#6366f1';

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

    showWindow('spinner', spinnerHtml, 320, 180, isDark);

    try {
      const result = await this.checkForUpdateResult(true);

      if (result) {
        const currentVer = process.env.OMA_APP_VERSION ?? '0.0.0';
        if (result.latestVersion === currentVer) {
          this.showUpToDateDialog();
        } else {
          this.pendingUpdate = {
            version: result.latestVersion,
            releaseNotes: result.release.body || null,
            releaseUrl: result.release.html_url || '',
            files: result.updateInfo.files?.map((f) => ({ url: f.url, sha512: f.sha512 })) || [],
          };
          this.showUpdateDialogForTray({
            version: result.latestVersion,
            releaseNotes: result.release.body,
          });
        }
      } else {
        this.showUpToDateDialog();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.showMessageDialog(getT().updater.checkFailed, msg);
    }
  }

  /** "Already up to date" dialog window. */
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
    <button class="btn-primary" onclick="window.electronAPI.close()">${getT().updater.ok}</button>
  </div>
</body></html>`;

    showWindow('up-to-date', html, 320, 220, isDark);
  }

  /** Error dialog window. */
  private showMessageDialog(title: string, detail: string): void {
    const isDark = this.isDarkTheme();
    const bg = isDark ? '#1e1e2e' : '#ffffff';
    const fg = isDark ? '#cdd6f4' : '#1e293b';

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       background:${bg};color:${fg};padding:24px;display:flex;flex-direction:column;
       align-items:center;justify-content:center;height:100vh;text-align:center}
  h3{margin:0 0 10px;font-size:15px;color:#ef4444}
  p{font-size:13px;color:${fg};opacity:.8;margin:0 0 20px;line-height:1.6;word-break:keep-all}
  button{padding:7px 22px;border-radius:8px;font-size:13px;font-weight:600;
         cursor:pointer;border:none;background:#6366f1;color:#fff}
</style></head>
<body>
  <h3>${title}</h3>
  <p>${detail.replace(/</g, '&lt;')}</p>
  <button onclick="window.electronAPI.close()">${getT().updater.ok}</button>
</body></html>`;

    showWindow('updater-dialog', html, 380, 240, isDark);
  }

  /** Update-available dialog with release notes. */
  private showUpdateDialogForTray(info: { version: string; releaseNotes?: string | null }): void {
    const version = info.version;
    const notesHtml = this.getReleaseNotesHtml(info.releaseNotes);
    const isDark = this.isDarkTheme();

    const bg = isDark ? '#1e1e2e' : '#ffffff';
    const fg = isDark ? '#cdd6f4' : '#1e293b';
    const muted = isDark ? '#94a3b8' : '#64748b';
    const border = isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0';
    const contentBg = isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc';
    const btnPrimary = '#6366f1';
    const btnSecondaryBg = isDark ? 'rgba(255,255,255,0.08)' : '#f1f5f9';
    const btnSecondaryFg = isDark ? '#cbd5e1' : '#475569';
    const btnSecondaryHover = isDark ? 'rgba(255,255,255,0.14)' : '#e2e8f0';
    const scrollThumb = isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)';
    const scrollThumbHover = isDark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.28)';

    const notesBody =
      notesHtml || `<p style="color:${muted}">${getT().updater.noReleaseNotes}</p>`;

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       background:${bg};color:${fg};display:flex;flex-direction:column;height:100vh}
  .header{flex-shrink:0;padding:20px 24px 12px}
  .header h1{font-size:17px;font-weight:700;color:${fg};margin:0}
  .content{flex:1;overflow-y:auto;padding:12px 24px 16px;
           font-size:13px;line-height:1.7;color:${fg};
           background:${contentBg};margin:0 12px;border-radius:8px;
           border:1px solid ${border}}
  .content h2{font-size:14px;font-weight:600;margin:12px 0 6px;color:${fg}}
  .content h3{font-size:13px;font-weight:600;margin:10px 0 4px;color:${fg}}
  .content ul,.content ol{padding-left:20px;margin:6px 0}
  .content li{margin:2px 0}
  .content p{margin:6px 0}
  .content a{color:#6366f1}
  .content code{background:${isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)'};
                padding:1px 5px;border-radius:4px;font-size:12px}
  .content pre{background:${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'};
               padding:10px 14px;border-radius:6px;overflow-x:auto;margin:8px 0;
               font-size:12px;line-height:1.5}
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
  .btn-secondary{background:${btnSecondaryBg};color:${btnSecondaryFg}}
  .btn-secondary:hover{background:${btnSecondaryHover}}
</style></head>
<body>
  <div class="header">
    <h1>${interpolate(getT().updater.newVersion, { version })}</h1>
  </div>
  <div class="content">${notesBody}</div>
  <div class="footer">
    <button class="btn-secondary" onclick="window.electronAPI.close()">${getT().updater.cancel}</button>
    <button class="btn-primary" onclick="window.electronAPI.downloadUpdate();window.electronAPI.close()">${getT().updater.upgrade}</button>
  </div>
</body></html>`;

    showWindow('updater-dialog', html, 500, 460, isDark);
  }

  /** Download progress window — listens to compat-layer events (SSE). */
  private showDownloadProgressWindow(): void {
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
    const unsignedMsg = getT().updater.unsignedMacBuild.replace(/'/g, "\\'");

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
       background:${bg};color:${fg};display:flex;flex-direction:column;
       align-items:center;justify-content:center;height:100vh;
       user-select:none}
  .header{position:absolute;top:0;left:0;right:0;padding:16px 24px 0;
          text-align:center;font-size:14px;font-weight:600}
  .card{display:flex;flex-direction:column;align-items:center;gap:14px;width:320px}
  .label{font-size:13px;color:${muted}}
  .bar-wrap{width:100%;height:6px;border-radius:3px;background:${barBg};overflow:hidden}
  .bar-fill{height:100%;border-radius:3px;background:${barFill};
            width:0%;transition:width .2s ease-out}
  .percent{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}
  .speed{font-size:12px;color:${muted}}
  .status{font-size:13px;font-weight:600;text-align:center;line-height:1.4;
          max-width:320px;word-break:keep-all;overflow-wrap:break-word}
  .footer{position:absolute;bottom:0;left:0;right:0;padding:14px 20px;
          display:flex;justify-content:flex-end;gap:10px;
          border-top:1px solid ${border}}
  button{padding:7px 18px;border-radius:8px;font-size:13px;font-weight:600;
         cursor:pointer;border:none;transition:opacity .15s,background .15s;outline:none}
  .btn-primary{background:${btnPrimary};color:#fff}
  .btn-secondary{background:${btnSecondaryBg};color:${btnSecondaryFg}}
</style></head>
<body>
  <div class="header">${getT().updater.downloading}</div>
  <div class="card">
    <div class="percent" id="pct">0%</div>
    <div class="bar-wrap"><div class="bar-fill" id="bar"></div></div>
    <div class="speed" id="spd">&nbsp;</div>
    <div class="status" id="st"></div>
  </div>
  <div class="footer">
    <button class="btn-secondary" id="btn-releases" style="display:none">${getT().updater.githubRelease}</button>
    <button class="btn-secondary" id="btn-close">${getT().updater.cancel}</button>
    <button class="btn-primary" id="btn-install" style="display:none">${getT().updater.installAndRestart}</button>
  </div>
<script>
  var api = window.electronAPI;
  function fmtSize(b){if(!b||b<=0)return'';var u=['B','KB','MB','GB'];var i=0,v=b;while(v>=1024&&i<u.length-1){v/=1024;i++}return v.toFixed(v<10?1:0)+' '+u[i]}
  function fmtSpeed(bps){var s=fmtSize(bps);return s?s+'/s':''}
  var _lastPct=0;
  document.getElementById('btn-close').addEventListener('click',function(){api.cancelDownload();window.electronAPI.close()});
  document.getElementById('btn-install').addEventListener('click',function(){api.installUpdate()});
  document.getElementById('btn-releases').addEventListener('click',function(){window.open('https://github.com/tscodeplus/OhMyAgent/releases')});
  api.onUpdateDownloadProgress(function(d){
    var pct=Math.round(d.percent);
    if(pct<_lastPct)return; _lastPct=pct;
    document.getElementById('pct').textContent=pct+'%';
    document.getElementById('bar').style.width=pct+'%';
    document.getElementById('spd').textContent=fmtSpeed(d.bytesPerSecond||0);
  });
  api.onUpdateDownloaded(function(d){
    document.getElementById('pct').textContent='100%';
    document.getElementById('bar').style.width='100%';
    document.getElementById('spd').textContent='';
    if(d&&d.unsigned){
      document.getElementById('st').textContent='${unsignedMsg}';
      document.getElementById('btn-releases').style.display='';
      document.getElementById('btn-install').style.display='none';
    }else{
      document.getElementById('st').textContent='${getT().updater.downloaded}';
      document.getElementById('btn-install').style.display='';
      document.getElementById('btn-releases').style.display='none';
    }
  });
  api.onUpdateError(function(d){
    document.getElementById('st').textContent=d.message||'${getT().updater.downloadFailed}';
    document.getElementById('btn-releases').style.display='';
  });
</script>
</body></html>`;

    showWindow('progress', html, 420, 260, isDark);
  }

  /** Theme helper: desktop config theme, falling back to OS dark preference. */
  private isDarkTheme(): boolean {
    try {
      const theme = loadConfig().theme;
      if (theme === 'dark') return true;
      if (theme === 'light') return false;
    } catch {
      /* config not ready */
    }
    const locale = process.env.OMA_OS_LOCALE ?? '';
    // Conservative: no reliable OS dark-mode signal in Node — match Electron's
    // old default window style for 'system' (dark splash/updater chrome).
    return true;
  }

  /** Log proxy / connectivity diagnostics (fetch-based, no Electron session). */
  private async runNetworkDiagnostic(): Promise<void> {
    const testUrls = [
      { label: 'GitHub API', url: 'https://api.github.com/repos/tscodeplus/OhMyAgent/releases/latest' },
      { label: 'latest.yml (beta3)', url: 'https://github.com/tscodeplus/OhMyAgent/releases/download/v2.0.0-beta3/latest.yml' },
    ];
    for (const { label, url } of testUrls) {
      try {
        const resp = await fetchWithProxy(url, {
          method: 'GET',
          redirect: 'follow',
          signal: AbortSignal.timeout(10_000),
        });
        diagLog(`[${label}] OK status=${resp.status} (${resp.headers.get('content-length') || '?'} bytes)`);
      } catch (e: unknown) {
        diagLog(`[${label}] FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * Convert GitHub-flavored Markdown release notes to HTML (verbatim from
   * desktop/src/updater.ts).
   */
  private getReleaseNotesHtml(
    notes: string | Array<string | { note: string | null }> | null | undefined,
  ): string {
    if (!notes) return '';
    const text = Array.isArray(notes)
      ? notes.map((n) => (typeof n === 'string' ? n : (n.note ?? ''))).join('\n')
      : String(notes);
    const trimmed = text.trim();
    if (!trimmed) return '';

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

    let html = trimmed.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
      const escaped = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<pre><code>${escaped}</code></pre>`;
    });
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
    html = html.replace(/___(.+?)___/g, '<strong><em>$1</em></strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
    html = html.replace(/(?<!_)_([^_\n]+)_(?!_)/g, '<em>$1</em>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">');
    html = html.replace(/^[-*_]{3,}\s*$/gm, '<hr>');
    html = html.replace(/((?:^[-*] .+(?:\n|$))+)/gm, (block) => {
      const items = block
        .trim()
        .split('\n')
        .map((line) => `<li>${line.replace(/^[-*] /, '')}</li>`)
        .join('');
      return `<ul>${items}</ul>`;
    });
    html = html.replace(/((?:^\d+\. .+(?:\n|$))+)/gm, (block) => {
      const items = block
        .trim()
        .split('\n')
        .map((line) => `<li>${line.replace(/^\d+\. /, '')}</li>`)
        .join('');
      return `<ol>${items}</ol>`;
    });
    const parts = html.split(/\n{2,}/);
    html = parts
      .map((part) => {
        const trimmedPart = part.trim();
        if (!trimmedPart) return '';
        if (/^<(h[1-4]|ul|ol|pre|hr|blockquote)/.test(trimmedPart)) return trimmedPart;
        return `<p>${trimmedPart.replace(/\n/g, '<br>')}</p>`;
      })
      .filter(Boolean)
      .join('');

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
