/**
 * System Routes — check for updates, trigger update from GitHub.
 */
import type { FastifyInstance } from 'fastify';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAppVersion, isNewerVersion } from '../version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolve the project root directory (walk up from __dirname). */
function findProjectRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

// ── macOS proxy detection ──────────────────────────────────────────────────────
// Node.js undici (used by fetch()) does NOT read macOS system proxy settings.
// It only respects https_proxy / http_proxy env vars. When these aren't set
// (e.g. server started outside the install script), fetch() tries a direct
// connection which may fail through TUN-mode proxies or due to DNS quirks.
// Detect the macOS proxy from System Configuration so fetch() can reach the
// internet regardless of how the server was started.

interface ProxyConfig {
  httpsProxy?: string;
  httpProxy?: string;
}

let cachedMacOSProxy: ProxyConfig | null = null;
let cachedMacOSProxyAt = 0;

function detectMacOSProxy(): ProxyConfig {
  // Cache for 5 minutes — proxy settings don't change often
  const now = Date.now();
  if (cachedMacOSProxy && (now - cachedMacOSProxyAt) < 300_000) {
    return cachedMacOSProxy;
  }

  try {
    if (process.platform !== 'darwin') {
      cachedMacOSProxy = {};
      cachedMacOSProxyAt = now;
      return {};
    }

    const out = execSync('scutil --proxy', { encoding: 'utf8', timeout: 3000 });
    const config: ProxyConfig = {};

    // Prefer HTTPS proxy, fall back to HTTP proxy
    const httpsEnabled = /HTTPSEnable\s*:\s*1/.test(out);
    const httpEnabled = /HTTPEnable\s*:\s*1/.test(out);

    if (httpsEnabled) {
      const host = out.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
      const port = out.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
      if (host && port) config.httpsProxy = `http://${host}:${port}`;
    } else if (httpEnabled) {
      const host = out.match(/HTTPProxy\s*:\s*(\S+)/)?.[1];
      const port = out.match(/HTTPPort\s*:\s*(\d+)/)?.[1];
      if (host && port) config.httpsProxy = `http://${host}:${port}`;
    }

    if (config.httpsProxy) {
      config.httpProxy = config.httpsProxy;
    }

    cachedMacOSProxy = config;
    cachedMacOSProxyAt = now;
    return config;
  } catch {
    return cachedMacOSProxy ?? {};
  }
}

// ── Service restart (WebUI) ──────────────────────────────────────────────────

/** Window during which repeated restart requests are collapsed into one. */
const RESTART_DEDUP_WINDOW_MS = 15_000;
let lastRestartRequestAt = 0;

/** Test hook: clears the restart dedup guard. */
export function _resetRestartGuardForTests(): void {
  lastRestartRequestAt = 0;
}

/**
 * POST /api/system/restart — restart the server from the WebUI, preserving
 * whichever startup mode is in use. Like perform-update, the actual work
 * runs in a detached script so this handler can reply before the process
 * goes down.
 *
 * Startup modes, in the order the restart script handles them:
 *   0. Desktop shell (Tauri sidecar) — rejected with 409. The shell owns the
 *      process lifecycle; a self-kill from inside would surface the shell's
 *      "service crashed" window instead of a restart. The WebUI inside the
 *      shell window restarts via electronAPI.restartService() (Tauri IPC)
 *      instead; browser access to a desktop instance falls back to manual.
 *   1. runit `sv` (Termux service) — `sv force-restart ohmyagent`.
 *   2. launchd (macOS service) — unload + load the LaunchAgent plist.
 *   3. systemd --user (Linux service) — `systemctl --user restart`.
 *   4. Task Scheduler (Windows service) — schtasks /End + /Run.
 *   5. Fallback (pnpm dev, `ohmyagent start`, plain node/nohup) — kill the
 *      process and replay its ORIGINAL command line, so a dev server stays
 *      a dev server and a production start stays production.
 */
export function registerSystemRoutes(app: FastifyInstance): void {
  app.post('/api/system/restart', async (_request, reply) => {
    if (process.env.OMA_SIDECAR_CONTROL_PORT) {
      return reply.status(409).send({ ok: false, error: 'desktop_shell' });
    }

    if (Date.now() - lastRestartRequestAt < RESTART_DEDUP_WINDOW_MS) {
      return reply.status(409).send({ ok: false, error: 'restart_in_progress' });
    }
    lastRestartRequestAt = Date.now();

    const projectRoot = findProjectRoot();
    const mainPid = process.pid;

    if (process.platform === 'win32') {
      // ── Windows: PowerShell script ─────────────────────────────────
      const scriptPath = path.join(projectRoot, '.restart-script.ps1');

      const script = `# OhMyAgent service restart script (Windows)
  param([int]$MainPid)

  Start-Sleep -Seconds 1

  # 1) Task Scheduler service mode — /End + /Run = stop + start
  $task = schtasks /Query /TN "OhMyAgent" 2>$null
  if ($LASTEXITCODE -eq 0 -and ("$task" -match 'OhMyAgent')) {
    schtasks /End /TN "OhMyAgent" 2>$null | Out-Null
    Start-Sleep -Seconds 2
    schtasks /Run /TN "OhMyAgent" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Remove-Item -Force '${scriptPath.replace(/'/g, "''")}'
      exit 0
    }
  }

  # 2) Fallback: kill the process tree, restart pnpm dev
  # Exclude our own pid ($PID) — this script is itself a child of MainPid.
  try {
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$MainPid" -ErrorAction SilentlyContinue |
      Where-Object { $_.ProcessId -ne $PID } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch { }
  try { Stop-Process -Id $MainPid -Force -ErrorAction SilentlyContinue } catch { }
  Start-Sleep -Seconds 2

  Start-Process -NoNewWindow pnpm -ArgumentList "dev"
  Remove-Item -Force '${scriptPath.replace(/'/g, "''")}'
  `;

      try {
        fs.writeFileSync(scriptPath, script, { mode: 0o700 });
      } catch {
        return reply.status(500).send({ ok: false, error: 'failed to write restart script' });
      }

      const child = spawn(
        'powershell.exe',
        ['-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-MainPid', String(mainPid)],
        { detached: true, stdio: 'ignore', cwd: projectRoot },
      );
      child.unref();

      return reply.send({ ok: true });
    }

    // ── Linux / macOS / Termux: bash script ──────────────────────────
    const scriptPath = path.join(projectRoot, '.restart-script.sh');

    // Escape paths for safe interpolation into the bash script
    const escProjectRoot = projectRoot.replace(/'/g, "'\\''");
    const escScriptPath = scriptPath.replace(/'/g, "'\\''");

    const script = `#!/usr/bin/env bash
  # OhMyAgent service restart script (Linux / macOS / Termux)
  MAIN_PID="$1"
  sleep 1

  is_termux() { [ -d /data/data/com.termux ] || [ -n "\${PREFIX:-}" ]; }

  # 1) runit (sv) — Termux service mode
  if command -v sv >/dev/null 2>&1; then
    if [ -d "\${PREFIX:-}/var/service/ohmyagent" ]; then
      sv force-restart ohmyagent >/dev/null 2>&1 && exit 0
    elif is_termux; then
      export SVDIR="\${PREFIX}/var/service"
      sv force-restart ohmyagent >/dev/null 2>&1 && exit 0
    fi
  fi

  # 2) launchd — macOS service mode
  PLIST="$HOME/Library/LaunchAgents/com.ohmyagent.plist"
  if [ "$(uname -s)" = "Darwin" ] && [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" >/dev/null 2>&1
    launchctl load "$PLIST" >/dev/null 2>&1 && exit 0
  fi

  # 3) systemd — Linux service mode (Termux ships only a systemctl shim)
  if command -v systemctl >/dev/null 2>&1 && ! is_termux; then
    if systemctl --user is-enabled ohmyagent >/dev/null 2>&1; then
      systemctl --user restart ohmyagent >/dev/null 2>&1 && exit 0
    fi
  fi

  # 4) Fallback: kill the process and replay its original command line so the
  # startup mode (pnpm dev, ohmyagent start, nohup …) survives the restart.
  CMDLINE=""
  if [ -r "/proc/\$MAIN_PID/cmdline" ]; then
    CMDLINE=$(tr '\\0' ' ' < "/proc/\$MAIN_PID/cmdline")
  elif command -v ps >/dev/null 2>&1; then
    CMDLINE=$(ps -p "\$MAIN_PID" -o args= 2>/dev/null)
  fi

  # Kill children first (e.g. tsx's node worker holds the listening port),
  # then the process itself; wait for exit so the port is released before
  # the new instance binds. NOTE: our own pid MUST be skipped — this script
  # is itself a child of MAIN_PID, and pkill -P would kill the script
  # mid-run (observed: script died at pkill, server never restarted).
  CHILD_PIDS=$(pgrep -P "\$MAIN_PID" 2>/dev/null || true)
  for cpid in \$CHILD_PIDS; do
    if [ "\$cpid" != "\$\$" ]; then
      kill "\$cpid" >/dev/null 2>&1 || true
    fi
  done
  kill "\$MAIN_PID" >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6; do
    kill -0 "\$MAIN_PID" 2>/dev/null || break
    sleep 1
  done
  kill -9 "\$MAIN_PID" >/dev/null 2>&1 || true

  cd '${escProjectRoot}' || exit 1
  if [ -n "\$CMDLINE" ]; then
    # Word splitting is intentional — replay argv.
    # shellcheck disable=SC2086
    nohup \$CMDLINE >/dev/null 2>&1 &
  else
    nohup pnpm dev >/dev/null 2>&1 &
  fi
  rm -f '${escScriptPath}'
  `;

    try {
      fs.writeFileSync(scriptPath, script, { mode: 0o700 });
    } catch {
      return reply.status(500).send({ ok: false, error: 'failed to write restart script' });
    }

    const child = spawn('bash', [scriptPath, String(mainPid)], {
      detached: true,
      stdio: 'ignore',
      cwd: projectRoot,
    });
    child.unref();

    return reply.send({ ok: true });
  });

  // ── Check for updates from GitHub ──────────────────────────────────────
  app.get('/api/system/check-update', async (request, reply) => {
    try {
      // Support includeBeta query param: when true, include releases whose
      // tag_name contains "beta"; when false, skip them and pick the first
      // non-beta release.
      const query = request.query as { includeBeta?: string };
      const includeBeta = query.includeBeta === 'true' || query.includeBeta === '1';
      // Always fetch the releases list so we can filter by beta string
      // client-side. Use per_page=30 to cover recent releases.
      const apiPath = 'https://api.github.com/repos/tscodeplus/OhMyAgent/releases?per_page=30';
      let res: Response | null = null;
      let lastErr: any = null;

      // Try up to 2 strategies: current env, then macOS system proxy
      for (const attempt of [1, 2]) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), attempt === 1 ? 10_000 : 8_000);

        try {
          // On the second attempt, detect macOS system proxy if no env proxy is set
          if (attempt === 2) {
            const macProxy = detectMacOSProxy();
            if (macProxy.httpsProxy) {
              // Set for undici — it checks these env vars at fetch() call time
              process.env.https_proxy = process.env.https_proxy || macProxy.httpsProxy;
              process.env.http_proxy = process.env.http_proxy || macProxy.httpProxy || macProxy.httpsProxy;
              app.log.info({ proxy: macProxy.httpsProxy }, 'check-update: using macOS system proxy');
            } else {
              break; // No proxy found — don't retry
            }
          }

          res = await fetch(
            apiPath,
            {
              headers: { 'Accept': 'application/vnd.github.v3+json' },
              signal: controller.signal,
            },
          );
          clearTimeout(timeout);
          if (res.ok) break; // Success — exit retry loop
          lastErr = new Error(`GitHub API returned ${res.status}`);
        } catch (err: any) {
          clearTimeout(timeout);
          lastErr = err;
          // Only retry if first attempt failed and we haven't tried with proxy
        }
      }

      if (!res || !res.ok) {
        if (lastErr?.name === 'AbortError') {
          return reply.status(504).send({ ok: false, error: 'github_unreachable', message: 'Cannot connect to GitHub — request timed out' });
        }
        app.log.warn({ err: lastErr?.message }, 'check-update: GitHub unreachable');
        return reply.status(502).send({ ok: false, error: 'github_unreachable', message: 'Cannot connect to GitHub — network error' });
      }

      if (!res.ok) {
        return reply.status(502).send({ ok: false, error: 'github_error', message: `GitHub API returned ${res.status}` });
      }

      const releases: any[] = await res.json();
      if (!Array.isArray(releases) || releases.length === 0) {
        return reply.send({ ok: true, currentVersion: getAppVersion() || '0.0.0', latestVersion: '', updateAvailable: false, releaseUrl: '', releaseNotes: '' });
      }

      // Pick the right release: when includeBeta is true, use the first
      // (latest) release; otherwise skip releases whose tag_name contains
      // "beta" (case-insensitive) and pick the first non-beta one.
      const release = includeBeta
        ? releases[0]
        : releases.find((r: any) => !/beta/i.test(r.tag_name || ''));
      if (!release) {
        return reply.send({ ok: true, currentVersion: getAppVersion() || '0.0.0', latestVersion: '', updateAvailable: false, releaseUrl: '', releaseNotes: '' });
      }

      const latestVersion = (release.tag_name || '').replace(/^v/, '');

      // Use cached version — reflects the running code, not whatever
      // git may have written to package.json during an in-flight update.
      const currentVersion = getAppVersion() || '0.0.0';

      return reply.send({
        ok: true,
        currentVersion,
        latestVersion,
        updateAvailable: isNewerVersion(currentVersion, latestVersion),
        releaseUrl: release.html_url || '',
        releaseNotes: release.body || '',
      });
    } catch (err: any) {
      return reply.status(500).send({ ok: false, error: 'internal_error', message: err.message });
    }
  });

  // ── Poll update progress (no auth needed — just reads a local file) ──
  app.get('/api/system/update-status', async (_request, reply) => {
    const projectRoot = findProjectRoot();
    const statusPath = path.join(projectRoot, 'data', 'update-status.json');
    try {
      if (fs.existsSync(statusPath)) {
        const content = fs.readFileSync(statusPath, 'utf-8');
        return reply.send(JSON.parse(content));
      }
      return reply.send({ status: 'idle', step: '', percent: 0 });
    } catch {
      return reply.send({ status: 'idle', step: '', percent: 0 });
    }
  });

  // ── Perform update (WebUI only) ───────────────────────────────────────
  app.post('/api/system/perform-update', async (_request, reply) => {
    const projectRoot = findProjectRoot();

    // Safety: only allow if running from a git repo
    if (!fs.existsSync(path.join(projectRoot, '.git'))) {
      return reply.status(400).send({ ok: false, error: 'not a git repository' });
    }

    // Guard against concurrent updates: check if an update script is
    // already running by reading the status file.
    const statusPath = path.join(projectRoot, 'data', 'update-status.json');
    if (fs.existsSync(statusPath)) {
      try {
        const cur = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
        if (cur.status && cur.status !== 'complete' && cur.status !== 'error') {
          return reply.status(409).send({ ok: false, error: 'Update already in progress' });
        }
      } catch { /* corrupt file — allow retry */ }
    }

    const mainPid = process.pid;
    const hasPnpm = fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'));
    const isWindows = process.platform === 'win32';

    if (isWindows) {
      // ── Windows: PowerShell script ─────────────────────────────────
      const scriptPath = path.join(projectRoot, '.update-script.ps1');
      const statusFile = path.join(projectRoot, 'data', 'update-status.json');

      const script = `# OhMyAgent update script (Windows)
param([int]$MainPid)

Start-Sleep -Seconds 2

# pnpm needs CI=true in non-TTY environments to skip the interactive
# confirmation before purging node_modules.
$env:CI = "true"

function Write-Status($status, $step, $percent) {
  $obj = @{ status = $status; step = $step; percent = $percent } | ConvertTo-Json -Compress
  $dir = Split-Path -Parent '${statusFile.replace(/'/g, "''")}'
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $obj | Out-File -FilePath '${statusFile.replace(/'/g, "''")}' -Encoding utf8
}

Write-Status "preparing" "" 5

Set-Location -Path '${projectRoot.replace(/'/g, "''")}'

Write-Status "pulling" "" 10

# Use fetch+reset to get a clean copy of the latest release
$gitOutput = git fetch https://github.com/tscodeplus/OhMyAgent.git main 2>&1
if ($LASTEXITCODE -ne 0) {
  $errMsg = "git fetch failed: " + ($gitOutput -join ' ').Substring(0, [Math]::Min(200, ($gitOutput -join ' ').Length))
  Write-Status "error" $errMsg 10
  exit 1
}

$gitOutput = git reset --hard FETCH_HEAD 2>&1
if ($LASTEXITCODE -ne 0) {
  $errMsg = "git reset failed: " + ($gitOutput -join ' ').Substring(0, [Math]::Min(200, ($gitOutput -join ' ').Length))
  Write-Status "error" $errMsg 10
  exit 1
}

Write-Status "installing" "" 30
${hasPnpm ? 'pnpm install' : 'npm install'}
if ($LASTEXITCODE -ne 0) { Write-Status "error" "pnpm install failed" 30; exit 1 }

Write-Status "building" "" 60
pnpm build
if ($LASTEXITCODE -ne 0) { Write-Status "error" "pnpm build failed" 60; exit 1 }

Write-Status "building_ui" "" 80
pnpm build:ui
if ($LASTEXITCODE -ne 0) { Write-Status "error" "WebUI build failed" 80; exit 1 }

Write-Status "restarting" "" 95

# Kill the current server process
try { Stop-Process -Id $MainPid -Force -ErrorAction Stop } catch {}
Start-Sleep -Seconds 1

Start-Process -NoNewWindow pnpm -ArgumentList "dev"

Write-Status "complete" "" 100
Remove-Item -Force '${scriptPath.replace(/'/g, "''")}'
`;

      try {
        fs.writeFileSync(scriptPath, script, { mode: 0o700 });
      } catch {
        return reply.status(500).send({ ok: false, error: 'failed to write update script' });
      }

      const child = spawn(
        'powershell.exe',
        ['-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-MainPid', String(mainPid)],
        { detached: true, stdio: 'ignore', cwd: projectRoot },
      );
      child.unref();

      return reply.send({ ok: true, message: 'Update started — server will restart shortly' });
    }

    // ── Linux / macOS / Termux: bash script ──────────────────────────
    const scriptPath = path.join(projectRoot, '.update-script.sh');
    const statusFile = path.join(projectRoot, 'data', 'update-status.json');

    // Escape paths for safe interpolation into the bash script
    const escProjectRoot = projectRoot.replace(/'/g, "'\\''");
    const escStatusFile = statusFile.replace(/'/g, "'\\''");
    const escScriptPath = scriptPath.replace(/'/g, "'\\''");

    const script = `#!/usr/bin/env bash
sleep 2

# pnpm needs CI=true in non-TTY environments (e.g. detached script, crontab,
# systemd) to skip the interactive confirmation before purging node_modules.
export CI=true

# ── Helper: write progress (status codes for frontend i18n) ──
write_status() {
  mkdir -p "$(dirname '${escStatusFile}')" 2>/dev/null || true
  printf '{"status":"%s","step":"%s","percent":%s}\\n' "$1" "$2" "$3" > '${escStatusFile}'
}

write_status "preparing" "" 5

cd '${escProjectRoot}'

# ── Pull latest code via HTTPS ──
write_status "pulling" "" 10

# Use fetch+reset to get a clean copy of the latest release.
# This discards local changes to tracked files but preserves
# untracked files (data/, .env, etc.).
# timeout 120: prevent hanging forever when GitHub is unreachable
GIT_ERR=""
set +e
GIT_ERR=$(timeout 120 git fetch https://github.com/tscodeplus/OhMyAgent.git main 2>&1 1>/dev/null)
GIT_EXIT=$?
set -e
if [ $GIT_EXIT -eq 124 ]; then
  write_status "error" "git fetch timed out after 120s" 10
  exit 1
fi
if [ $GIT_EXIT -ne 0 ]; then
  write_status "error" "git fetch failed: \${GIT_ERR}" 10
  exit 1
fi

set +e
GIT_ERR=$(git reset --hard FETCH_HEAD 2>&1)
GIT_EXIT=$?
set -e
if [ $GIT_EXIT -ne 0 ]; then
  write_status "error" "git reset failed: \${GIT_ERR}" 10
  exit 1
fi

# ── Termux / Android environment ──
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY 2>/dev/null || true
# ANDROID_ROOT is not always set on Termux; the runtime service environment
# (runit run script) does not export PREFIX either, so detect the device by
# its well-known directory too.
is_termux() { [ -d /data/data/com.termux ] || [ -n "\${PREFIX:-}" ]; }
if is_termux; then
  export ANDROID_NDK_HOME="\${PREFIX:-/data/data/com.termux/files/usr}"
  export npm_config_nodedir="\${PREFIX:-/data/data/com.termux/files/usr}"
  # sharp has no prebuilt binary for Termux and its source build (needs
  # libvips + node-addon-api) fails, aborting the whole pnpm install.
  # Drop sharp from the build allow-list on the device (pnpm 11 allowBuilds
  # map / pnpm 10 onlyBuiltDependencies list / .npmrc array entries). It is
  # optional at runtime (nut-js screenshots degrade gracefully) — same
  # workaround as scripts/deploy-termux.sh.
  sed -i '/sharp/d' pnpm-workspace.yaml 2>/dev/null || true
  sed -i '/sharp/d' .npmrc 2>/dev/null || true
fi

# ── Install dependencies ──
write_status "installing" "" 30
# Keep the install log for post-mortem debugging (data/update-install.log).
# Over a detached script there is no TTY; when pnpm decides the existing
# modules dir (e.g. an older pnpm layout) must be purged it can abort with
# ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY. In that case wipe node_modules
# and reinstall from scratch (the pnpm store cache keeps this fast); other
# failures are reported as-is.
INSTALL_LOG="data/update-install.log"
if ! ${hasPnpm ? 'pnpm install' : 'npm install'} > "\$INSTALL_LOG" 2>&1; then
  if grep -q "NO_TTY" "\$INSTALL_LOG" 2>/dev/null; then
    rm -rf node_modules
    if ! ${hasPnpm ? 'pnpm install' : 'npm install'} > "\$INSTALL_LOG" 2>&1; then
      write_status "error" "pnpm install failed" 30
      exit 1
    fi
  else
    write_status "error" "pnpm install failed" 30
    exit 1
  fi
fi
rm -f "\$INSTALL_LOG"

# ── Rebuild better-sqlite3 if on Android ──
if is_termux; then
  if [ -z "$(find node_modules -name better_sqlite3.node -path '*/better-sqlite3/*' 2>/dev/null | head -1)" ]; then
    write_status "installing" "" 40
    pnpm rebuild better-sqlite3 2>&1 || true
  fi
fi

# ── Build TypeScript ──
write_status "building" "" 60
pnpm build 2>&1 || { write_status "error" "pnpm build failed" 60; exit 1; }

# ── Build WebUI ──
write_status "building_ui" "" 80
if [ -f ui/package.json ]; then
  (
    cd ui || exit 1
    # Same no-TTY purge fallback as the root install above.
    if ! pnpm install > ../data/update-ui-install.log 2>&1; then
      if grep -q "NO_TTY" ../data/update-ui-install.log 2>/dev/null; then
        rm -rf node_modules
        pnpm install >> ../data/update-ui-install.log 2>&1 || exit 1
      else
        exit 1
      fi
    fi
    rm -f ../data/update-ui-install.log
    pnpm build 2>&1
  ) || { write_status "error" "WebUI build failed" 80; exit 1; }
else
  pnpm build:ui 2>&1 || { write_status "error" "WebUI build failed" 80; exit 1; }
fi

# ── Restart service ──
write_status "restarting" "" 95

# Try sv (runit) first, fall back to kill + nohup
SV_RESTART_OK=0
if command -v sv >/dev/null 2>&1; then
  if [ -d "\${PREFIX:-}/var/service/ohmyagent" ]; then
    sv force-restart ohmyagent 2>&1 && SV_RESTART_OK=1 || true
  else
    export SVDIR="\$PREFIX/var/service" 2>/dev/null || true
    sv force-restart ohmyagent 2>&1 && SV_RESTART_OK=1 || true
  fi
fi

if [ \$SV_RESTART_OK -eq 0 ]; then
  # sv not available or failed — direct process restart
  kill ${mainPid} 2>/dev/null || true
  sleep 2
  nohup pnpm dev > /dev/null 2>&1 &
fi

write_status "complete" "" 100
rm -f '${escScriptPath}'
`;

    try {
      fs.writeFileSync(scriptPath, script, { mode: 0o700 });
    } catch {
      return reply.status(500).send({ ok: false, error: 'failed to write update script' });
    }

    const child = spawn('bash', [scriptPath], {
      detached: true,
      stdio: 'ignore',
      cwd: projectRoot,
    });
    child.unref();

    return reply.send({ ok: true, message: 'Update started — server will restart shortly' });
  });
}
