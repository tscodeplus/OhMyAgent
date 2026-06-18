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

  // ── Perform update (WebUI only) ───────────────────────────────────────
  app.post('/api/system/perform-update', async (_request, reply) => {
    const projectRoot = findProjectRoot();

    // Safety: only allow if running from a git repo
    if (!fs.existsSync(path.join(projectRoot, '.git'))) {
      return reply.status(400).send({ ok: false, error: 'not a git repository' });
    }

    // Write update script to a temp file, then spawn it detached.
    // The script waits 2s for the HTTP response to flush, then kills
    // the server, pulls, rebuilds, and restarts.
    const scriptPath = path.join(projectRoot, '.update-script.sh');
    const mainPid = process.pid;

    // Detect package manager
    const hasPnpm = fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'));

    const script = `#!/usr/bin/env bash
set -e
sleep 2

# Kill the current server process
kill ${mainPid} 2>/dev/null || true
sleep 1

cd "${projectRoot}"

echo "[OhMyAgent] Pulling latest code..."
git pull origin main 2>&1 || { echo "git pull failed"; exit 1; }

echo "[OhMyAgent] Installing dependencies..."
${hasPnpm ? 'pnpm install --frozen-lockfile' : 'npm install'} 2>&1 || { echo "install failed"; exit 1; }

echo "[OhMyAgent] Building..."
pnpm build 2>&1 || { echo "build failed"; exit 1; }

echo "[OhMyAgent] Building WebUI..."
pnpm build:ui 2>&1 || { echo "webui build failed"; exit 1; }

echo "[OhMyAgent] Restarting server..."
nohup pnpm dev > /tmp/ohmyagent-restart.log 2>&1 &

echo "[OhMyAgent] Update complete!"
rm -f "${scriptPath}"
`;

    try {
      fs.writeFileSync(scriptPath, script, { mode: 0o700 });
    } catch {
      return reply.status(500).send({ ok: false, error: 'failed to write update script' });
    }

    // Spawn detached — the script will kill us and take over
    const child = spawn('bash', [scriptPath], {
      detached: true,
      stdio: 'ignore',
      cwd: projectRoot,
    });
    child.unref();

    return reply.send({ ok: true, message: 'Update started — server will restart shortly' });
  });
}
