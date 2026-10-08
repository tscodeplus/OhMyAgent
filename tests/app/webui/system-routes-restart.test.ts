/**
 * Tests for POST /api/system/restart (system-routes.ts)
 *
 * The restart endpoint must never spawn a real script during tests — the
 * script kills the current process — so node:child_process.spawn is mocked. The
 * fake child emits `exit` so the Windows WMI hand-off / fallback logic runs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

interface FakeSpawnOptions {
  detached?: boolean;
  windowsHide?: boolean;
  stdio?: string | readonly string[];
}

interface FakeChild {
  unref: () => void;
  kill: () => void;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
}

// `exitCodes` lets a test make the launcher fail so the child-process fallback
// runs; anything left over defaults to exit code 0 (hand-off succeeded).
const { mockSpawn, mockExitCodes } = vi.hoisted(() => {
  const exitCodes: number[] = [];
  const spawn = vi.fn((_command: string, _args: string[], _options: FakeSpawnOptions) => {
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const child: FakeChild = {
      unref: () => {},
      kill: () => {},
      on: (event, listener) => {
        (listeners[event] ||= []).push(listener);
      },
    };
    const code = exitCodes.length > 0 ? exitCodes.shift()! : 0;
    process.nextTick(() => {
      for (const listener of listeners.exit ?? []) listener(code, null);
    });
    return child;
  });
  return { mockSpawn: spawn, mockExitCodes: exitCodes };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: FakeSpawnOptions) =>
      mockSpawn(command, args, options),
  };
});

// Import after mocks
import {
  registerSystemRoutes,
  _resetRestartGuardForTests,
} from '../../../src/app/webui/system-routes.js';

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
    // The endpoint branches on process.platform; force the branch under test so
    // this runs (and stays meaningful) on a Windows host too.
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const res = await app.inject({ method: 'POST', url: '/api/system/restart' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const [cmd, args, opts] = mockSpawn.mock.calls[0]!;
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
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const res = await app.inject({ method: 'POST', url: '/api/system/restart' });
    expect(res.statusCode).toBe(200);

    // Restore the real platform before running an external command: Node's
    // child_process picks the shell from process.platform, and a mocked
    // 'linux' on Windows makes execSync look for /bin/sh.
    Object.defineProperty(process, 'platform', { value: prevPlatform, configurable: true });

    const [, args] = mockSpawn.mock.calls[0]!;
    const script = fs.readFileSync(args[0], 'utf-8');
    // Throws on syntax errors — guards the template's escaping (bash ${VAR}
    // vs JS ${interp}) against regressions.
    expect(() =>
      execSync('bash -n', { input: script, stdio: ['pipe', 'ignore', 'pipe'] }),
    ).not.toThrow();
  });

  it('writes a powershell restart script and hands it to the WMI service on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    const res = await app.inject({ method: 'POST', url: '/api/system/restart' });

    expect(res.statusCode).toBe(200);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const [cmd, args, opts] = mockSpawn.mock.calls[0]!;
    expect(cmd).toBe('powershell.exe');
    expect(args).toContain('-NoProfile');
    // Regression: `detached: true` makes Node spawn the child with
    // DETACHED_PROCESS, and Windows PowerShell 5.1 then exits (code 0) without
    // running `-File` at all — the restart silently did nothing and left the
    // script file behind.
    expect(opts.detached).toBeUndefined();
    expect(opts.windowsHide).toBe(true);

    // The script is started through the WMI service so it survives the death
    // of the process tree it is about to stop (job object teardown otherwise
    // killed it mid-run, leaving the service down).
    expect(args[3]).toContain('Invoke-CimMethod');
    expect(args[3]).toContain('Win32_Process');
    expect(args[3]).toContain('Win32_ProcessStartup');
    expect(args[3]).toContain('ShowWindow');
    expect(args[3]).toContain('EnvironmentVariables');
    expect(args[3]).toContain('.restart-script.ps1');

    const script = fs.readFileSync(path.join(repoRoot, '.restart-script.ps1'), 'utf-8');
    expect(script).toContain('schtasks /Query /TN "OhMyAgent"');
    expect(script).toContain('schtasks /Run /TN "OhMyAgent"');
    // Kills tsx's node worker first, and replays the recorded command line.
    expect(script).toContain('function Stop-Server([int]$ServerPid)');
    expect(script).toContain('function Get-ServerArgs([string]$CommandLine)');
    expect(script).toContain('function Start-Server([string]$ExePath, [string]$CommandLine)');
    expect(script).toContain('Get-CimInstance Win32_Process -Filter "ProcessId=$MainPid"');
    // Always cleans itself up, whatever path the restart takes.
    expect(script).toContain('} finally {');
    // Regression: `Start-Process -NoNewWindow pnpm` cannot launch the pnpm.ps1
    // shim ("%1 is not a valid Win32 application"), so the server was never
    // started again. The relaunch has to go through a real executable.
    expect(script).not.toMatch(/Start-Process -NoNewWindow pnpm\b/);
    expect(script).toContain(
      "Start-Process -NoNewWindow -FilePath 'cmd.exe' -ArgumentList '/c pnpm dev'",
    );
    expect(script).toContain('pnpm');
  });

  it('falls back to a plain child process when the WMI hand-off fails', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockExitCodes.push(1); // launcher could not create the helper

    const res = await app.inject({ method: 'POST', url: '/api/system/restart' });

    expect(res.statusCode).toBe(200);
    expect(mockSpawn).toHaveBeenCalledTimes(2);

    const [, fallbackArgs, fallbackOpts] = mockSpawn.mock.calls[1]!;
    expect(fallbackArgs).toContain('-File');
    expect(fallbackArgs.some((a) => a.endsWith('.restart-script.ps1'))).toBe(true);
    expect(fallbackOpts.detached).toBeUndefined();
  });

  it('deduplicates rapid restart requests', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/system/restart' });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: 'POST', url: '/api/system/restart' });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ ok: false, error: 'restart_in_progress' });
  });
});

// The Windows update script embeds the same preamble / relaunch helpers as the
// restart script (and shared the two bugs fixed there), so it is checked here
// too instead of in a separate file.
describe('POST /api/system/perform-update (Windows)', () => {
  let app: ReturnType<typeof Fastify>;
  let prevPlatform: PropertyKey;

  beforeEach(async () => {
    vi.clearAllMocks();
    _resetRestartGuardForTests();
    prevPlatform = Object.getOwnPropertyDescriptor(process, 'platform')?.value ?? process.platform;
    app = Fastify({ logger: false });
    registerSystemRoutes(app);
    await app.ready();
  });

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: prevPlatform });
    fs.rmSync(path.join(repoRoot, '.update-script.ps1'), { force: true });
    await app.close();
  });

  it('writes a powershell update script that relaunches through a real executable', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });

    const res = await app.inject({ method: 'POST', url: '/api/system/perform-update' });
    // A real update already in flight on this machine replies 409.
    if (res.statusCode === 409) return;
    expect(res.statusCode).toBe(200);

    const call = mockSpawn.mock.calls[0];
    expect(call).toBeDefined();
    const args = call![1];
    const opts = call![2];
    expect(opts.detached).toBeUndefined();
    expect(opts.windowsHide).toBe(true);
    // Launched through WMI so the minutes-long update survives the teardown of
    // the process tree that happens when it stops the server at the end.
    expect(args[3]).toContain('Invoke-CimMethod');
    expect(args[3]).toContain('.update-script.ps1');

    const script = fs.readFileSync(path.join(repoRoot, '.update-script.ps1'), 'utf-8');
    expect(script).toContain('function Stop-Server([int]$ServerPid)');
    expect(script).toContain('schtasks /Run /TN "OhMyAgent"');
    expect(script).not.toMatch(/Start-Process -NoNewWindow pnpm\b/);
  });
});
