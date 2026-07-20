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

export function registerSystemRoutes(app: FastifyInstance): void {
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
if [ -n "\${ANDROID_ROOT:-}" ] || [ -n "\${PREFIX:-}" ]; then
  export ANDROID_NDK_HOME="\${PREFIX:-/data/data/com.termux/files/usr}"
  export npm_config_nodedir="\${PREFIX:-/data/data/com.termux/files/usr}"
fi

# ── Install dependencies ──
write_status "installing" "" 30
${hasPnpm ? 'pnpm install' : 'npm install'} 2>&1 || { write_status "error" "pnpm install failed" 30; exit 1; }

# ── Rebuild better-sqlite3 if on Android ──
if [ -n "\${ANDROID_ROOT:-}" ]; then
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
  cd ui && pnpm install 2>&1 && pnpm build 2>&1 && cd ..
else
  pnpm build:ui 2>&1
fi
if [ $? -ne 0 ]; then
  write_status "error" "WebUI build failed" 80
  exit 1
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
