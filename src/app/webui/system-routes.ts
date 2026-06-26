/**
 * System Routes — check for updates, trigger update from GitHub.
 */
import type { FastifyInstance } from 'fastify';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function registerSystemRoutes(app: FastifyInstance): void {
  // ── Check for updates from GitHub ──────────────────────────────────────
  app.get('/api/system/check-update', async (_request, reply) => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);

      let res: Response;
      try {
        res = await fetch(
          'https://api.github.com/repos/tscodeplus/OhMyAgent/releases/latest',
          {
            headers: { 'Accept': 'application/vnd.github.v3+json' },
            signal: controller.signal,
          },
        );
      } catch (err: any) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
          return reply.status(504).send({ ok: false, error: 'github_unreachable', message: 'Cannot connect to GitHub — request timed out' });
        }
        return reply.status(502).send({ ok: false, error: 'github_unreachable', message: 'Cannot connect to GitHub — network error' });
      }
      clearTimeout(timeout);

      if (!res.ok) {
        return reply.status(502).send({ ok: false, error: 'github_error', message: `GitHub API returned ${res.status}` });
      }

      const release = await res.json();
      const latestVersion = (release.tag_name || '').replace(/^v/, '');

      // Read current version from package.json
      const pkgPath = path.join(findProjectRoot(), 'package.json');
      const currentVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version as string;

      return reply.send({
        ok: true,
        currentVersion,
        latestVersion,
        updateAvailable: latestVersion !== currentVersion,
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

function Write-Status($status, $step, $percent) {
  $obj = @{ status = $status; step = $step; percent = $percent } | ConvertTo-Json -Compress
  $dir = Split-Path -Parent '${statusFile.replace(/'/g, "''")}'
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $obj | Out-File -FilePath '${statusFile.replace(/'/g, "''")}' -Encoding utf8
}

Write-Status "preparing" "Preparing update..." 5

Set-Location -Path '${projectRoot.replace(/'/g, "''")}'

Write-Status "pulling" "Pulling latest code..." 10

# Stash local changes so git pull can fast-forward cleanly
git stash --include-untracked 2>$null

$gitOutput = git pull https://github.com/tscodeplus/OhMyAgent.git main 2>&1
if ($LASTEXITCODE -ne 0) {
  $errMsg = "git pull failed: " + ($gitOutput -join ' ').Substring(0, [Math]::Min(200, ($gitOutput -join ' ').Length))
  Write-Status "error" $errMsg 10
  git stash pop 2>$null
  exit 1
}

# Restore local changes on top of pulled code
git stash pop 2>$null

Write-Status "installing" "Installing dependencies..." 30
${hasPnpm ? 'pnpm install' : 'npm install'}
if ($LASTEXITCODE -ne 0) { Write-Status "error" "pnpm install failed" 30; exit 1 }

Write-Status "building" "Building TypeScript..." 60
pnpm build
if ($LASTEXITCODE -ne 0) { Write-Status "error" "pnpm build failed" 60; exit 1 }

Write-Status "building_ui" "Building WebUI..." 80
pnpm build:ui
if ($LASTEXITCODE -ne 0) { Write-Status "error" "WebUI build failed" 80; exit 1 }

Write-Status "restarting" "Restarting service..." 95

# Kill the current server process
try { Stop-Process -Id $MainPid -Force -ErrorAction Stop } catch {}
Start-Sleep -Seconds 1

Start-Process -NoNewWindow pnpm -ArgumentList "dev"

Write-Status "complete" "Update complete — server restarting" 100
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
set -e
sleep 2

# ── Helper: write progress ──
write_status() {
  mkdir -p "$(dirname '${escStatusFile}')" 2>/dev/null || true
  printf '{"status":"%s","step":"%s","percent":%s}\\n' "$1" "$2" "$3" > '${escStatusFile}'
}

write_status "preparing" "Preparing update..." 5

cd '${escProjectRoot}'

# ── Pull latest code via HTTPS (works without SSH keys) ──
write_status "pulling" "Pulling latest code..." 10

# Stash local changes so git pull can fast-forward cleanly
git stash --include-untracked 2>/dev/null || true

set +e  # allow capturing git output without triggering exit-on-error
GIT_ERR=$(git pull https://github.com/tscodeplus/OhMyAgent.git main 2>&1 1>/dev/null)
GIT_EXIT=$?
set -e
if [ $GIT_EXIT -ne 0 ]; then
  write_status "error" "git pull failed: \${GIT_ERR}" 10
  git stash pop 2>/dev/null || true
  exit 1
fi

# Restore local changes on top of pulled code
git stash pop 2>/dev/null || true

# ── Termux / Android environment ──
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY 2>/dev/null || true
if [ -n "\${ANDROID_ROOT:-}" ] || [ -n "\${PREFIX:-}" ]; then
  export ANDROID_NDK_HOME="\${PREFIX:-/data/data/com.termux/files/usr}"
  export npm_config_nodedir="\${PREFIX:-/data/data/com.termux/files/usr}"
fi

# ── Install dependencies ──
write_status "installing" "Installing dependencies..." 30
${hasPnpm ? 'pnpm install' : 'npm install'} 2>&1 || { write_status "error" "pnpm install failed" 30; exit 1; }

# ── Rebuild better-sqlite3 if on Android ──
if [ -n "\${ANDROID_ROOT:-}" ]; then
  if [ -z "$(find node_modules -name better_sqlite3.node -path '*/better-sqlite3/*' 2>/dev/null | head -1)" ]; then
    write_status "installing" "Rebuilding better-sqlite3..." 40
    pnpm rebuild better-sqlite3 2>&1 || true
  fi
fi

# ── Build TypeScript ──
write_status "building" "Building TypeScript..." 60
pnpm build 2>&1 || { write_status "error" "pnpm build failed" 60; exit 1; }

# ── Build WebUI ──
write_status "building_ui" "Building WebUI..." 80
if [ -f ui/package.json ]; then
  cd ui && pnpm install 2>&1 && pnpm build 2>&1 && cd ..
else
  pnpm build:ui 2>&1
fi || { write_status "error" "WebUI build failed" 80; exit 1; }

# ── Restart service ──
write_status "restarting" "Restarting service..." 95

# Try sv (runit) first, fall back to kill + nohup
if command -v sv >/dev/null 2>&1 && [ -d "\${PREFIX:-}/var/service/ohmyagent" ]; then
  sv restart ohmyagent 2>&1 || true
elif command -v sv >/dev/null 2>&1; then
  export SVDIR="\$PREFIX/var/service" 2>/dev/null || true
  sv restart ohmyagent 2>&1 || true
else
  kill ${mainPid} 2>/dev/null || true
  sleep 1
  nohup pnpm dev > /dev/null 2>&1 &
fi

write_status "complete" "Update complete — server restarting" 100
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
