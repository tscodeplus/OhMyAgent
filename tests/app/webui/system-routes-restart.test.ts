/**
 * Tests for POST /api/system/restart (system-routes.ts)
 *
 * The restart endpoint must never spawn a real script during tests — the
 * script kills the current process — so node:child_process.spawn is mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mockSpawn = vi.fn(() => ({ unref: () => {} }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => mockSpawn(...(args as [])),
  };
});

// Import after mocks
import { registerSystemRoutes, _resetRestartGuardForTests } from '../../../src/app/webui/system-routes.js';

// findProjectRoot() walks up from the module's __dirname, so scripts land in
// the repo root during tests — clean them up afterwards.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** bash is available on Linux/macOS/Termux but not on native Windows. */
const bashAvailable = (() => {
  try {
    execSync('bash -c "exit 0"', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('POST /api/system/restart', () => {
  let app: ReturnType<typeof Fastify>;
  let prevSidecarEnv: string | undefined;
  let prevPlatform: PropertyKey;
  let scriptPaths: string[];

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetRestartGuardForTests();

    prevSidecarEnv = process.env.OMA_SIDECAR_CONTROL_PORT;
    delete process.env.OMA_SIDECAR_CONTROL_PORT;

    prevPlatform = Object.getOwnPropertyDescriptor(process, 'platform')?.value ?? process.platform;
    scriptPaths = [
      path.join(repoRoot, '.restart-script.sh'),
      path.join(repoRoot, '.restart-script.ps1'),
    ];

    app = Fastify({ logger: false });
    registerSystemRoutes(app);
    await app.ready();
  });

  afterEach(() => {
    if (prevSidecarEnv !== undefined) process.env.OMA_SIDECAR_CONTROL_PORT = prevSidecarEnv;
    else delete process.env.OMA_SIDECAR_CONTROL_PORT;
    Object.defineProperty(process, 'platform', { value: prevPlatform });
    for (const p of scriptPaths) {
      fs.rmSync(p, { force: true });
    }
  });

  it('rejects with desktop_shell when running under the desktop shell', async () => {
    process.env.OMA_SIDECAR_CONTROL_PORT = '9291';

    const res = await app.inject({ method: 'POST', url: '/api/system/restart' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, error: 'desktop_shell' });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('writes a posix restart script and spawns it detached', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/system/restart' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const [cmd, args, opts] = mockSpawn.mock.calls[0] as [string, string[], { detached: boolean }];
    expect(cmd).toBe('bash');
    expect(opts.detached).toBe(true);
    expect(args[0]).toMatch(/\.restart-script\.sh$/);
    expect(args[1]).toBe(String(process.pid));

    const script = fs.readFileSync(args[0], 'utf-8');
    // Service managers are handled before the command-line replay fallback
    expect(script).toContain('sv force-restart ohmyagent');
    expect(script).toContain('launchctl load');
    expect(script).toContain('systemctl --user restart ohmyagent');
    expect(script).toContain('/proc/');
    expect(script).toContain('nohup');
  });

  it.skipIf(!bashAvailable)('writes a syntactically valid bash script', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/system/restart' });
    expect(res.statusCode).toBe(200);

    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    const script = fs.readFileSync(args[0], 'utf-8');
    // Throws on syntax errors — guards the template's escaping (bash ${VAR}
    // vs JS ${interp}) against regressions.
    expect(() => execSync('bash -n', { input: script, stdio: ['pipe', 'ignore', 'pipe'] })).not.toThrow();
  });

  it('writes a powershell restart script on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    const res = await app.inject({ method: 'POST', url: '/api/system/restart' });

    expect(res.statusCode).toBe(200);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const [cmd, args] = mockSpawn.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('powershell.exe');
    expect(args.some((a) => a.endsWith('.restart-script.ps1'))).toBe(true);

    const scriptPath = args.find((a) => a.endsWith('.restart-script.ps1'))!;
    const script = fs.readFileSync(scriptPath, 'utf-8');
    expect(script).toContain('schtasks /Query /TN "OhMyAgent"');
    expect(script).toContain('schtasks /Run /TN "OhMyAgent"');
    expect(script).toContain('pnpm');
  });

  it('deduplicates rapid restart requests', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/system/restart' });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: 'POST', url: '/api/system/restart' });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ ok: false, error: 'restart_in_progress' });
  });
});
