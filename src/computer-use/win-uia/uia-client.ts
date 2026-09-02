// src/computer-use/win-uia/uia-client.ts
//
// Node-side client for the resident Windows UIA helper process
// (win-uia-server.ps1). Lifecycle: materialize script → spawn powershell.exe
// → wait for the CUAREADY handshake → FIFO JSON request queue over stdin →
// line-delimited JSON responses on stdout. Crash/timeout handling restarts
// the process with exponential backoff; requests pending at a restart are
// rejected (an in-flight action may have already executed server-side).

import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from 'pino';
import {
  UIA_HANDSHAKE_MARKER,
  UIA_SERVER_SCRIPT_PATH,
  UIA_COMMAND_TIMEOUT_MS,
  UIA_GET_STATE_TIMEOUT_MS,
  UIA_LAUNCH_TIMEOUT_MS,
  UIA_IDLE_EXIT_MS,
  buildWinUiaServerScript,
  writeUiaServerScript,
} from './win-uia-scripts.js';

export interface UiaErrorInfo {
  code: string;
  message: string;
}

export type UiaResult = { ok: true; result: unknown } | { ok: false; error: UiaErrorInfo };

export interface UiaRequestOptions {
  timeoutMs?: number;
}

const MAX_RESTART_DELAY_MS = 10_000;
const INITIAL_RESTART_DELAY_MS = 500;

/**
 * Translate a Windows path (C:\...) to the path a WSL process needs to touch
 * the same file (/mnt/c/...). On native Windows the path is returned as-is.
 */
export function winToWslPath(winPath: string): string {
  const m = /^([A-Za-z]):\\(.*)$/.exec(winPath);
  if (!m) return winPath;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

interface PendingRequest {
  id: number;
  cmd: string;
  timeoutMs: number;
  timer: NodeJS.Timeout;
  resolve: (r: UiaResult) => void;
}

export class UiaClient {
  private readonly logger?: Logger;
  private readonly handshakeTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private child: ChildProcess | null = null;
  private ready = false;
  private nextId = 1;
  private stopped = false;
  /** Set when the server announced its own idle-exit; suppresses auto-restart. */
  private idleExited = false;
  /** Last activity (request start) timestamp — drives client-side idle reclaim. */
  private lastActivity = 0;
  private restartDelay = INITIAL_RESTART_DELAY_MS;
  private restartTimer: NodeJS.Timeout | null = null;
  private pending: PendingRequest[] = [];
  private stdoutBuffer = '';
  /** FIFO chain — each request is queued after the previous one resolves. */
  private chain: Promise<void> = Promise.resolve();

  constructor(options?: { logger?: Logger; handshakeTimeoutMs?: number; idleTimeoutMs?: number }) {
    this.logger = options?.logger;
    this.handshakeTimeoutMs = options?.handshakeTimeoutMs ?? UIA_COMMAND_TIMEOUT_MS;
    this.idleTimeoutMs = options?.idleTimeoutMs ?? UIA_IDLE_EXIT_MS;
    this.lastActivity = Date.now();
  }

  get isRunning(): boolean {
    return this.child !== null && this.ready;
  }

  /**
   * Send one command and await its response. Requests are strictly
   * serialized (the server is single-threaded). A crash or timeout rejects
   * all pending requests; the caller should retry.
   */
  async request(
    cmd: string,
    payload: Record<string, unknown> = {},
    opts: UiaRequestOptions = {},
  ): Promise<UiaResult> {
    const run = async (): Promise<UiaResult> => {
      this._killIfIdle();
      this.lastActivity = Date.now();
      await this._ensureReady();
      if (this.stopped) {
        return { ok: false, error: { code: 'SERVER_STOPPED', message: 'UIA server is stopped' } };
      }
      if (!this.child) {
        // Server died while we waited for the handshake.
        return {
          ok: false,
          error: { code: 'SERVER_CRASHED', message: 'UIA server is not running' },
        };
      }
      return new Promise<UiaResult>((resolve) => {
        const id = this.nextId++;
        const timeoutMs = opts.timeoutMs ?? this._defaultTimeoutFor(cmd);
        const timer = setTimeout(() => {
          this.logger?.warn({ cmd, id }, 'UIA command timed out; restarting server');
          this._restart();
          resolve({
            ok: false,
            error: { code: 'TIMEOUT', message: `UIA command '${cmd}' timed out` },
          });
        }, timeoutMs);
        this.pending.push({ id, cmd, timeoutMs, timer, resolve });
        const line = JSON.stringify({ id, cmd, ...payload });
        this.child!.stdin!.write(line + '\n', 'utf8');
      });
    };
    const queued = this.chain.then(run);
    // Keep the chain alive regardless of individual failures.
    this.chain = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  /** Kill the server process and stop accepting new requests. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this._rejectPending('SERVER_STOPPED', 'UIA server stopped');
    const child = this.child;
    this.child = null;
    this.ready = false;
    if (child && !child.killed) {
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
      child.kill();
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private _defaultTimeoutFor(cmd: string): number {
    if (cmd === 'get-app-state') return UIA_GET_STATE_TIMEOUT_MS;
    // launch-app's server-side worst case (WaitHwnd 20s + AppX cold-start
    // poll 10s) sits exactly on the default 30s timeout - a slow cold start
    // killed the server mid-launch and failed the app open. Give it headroom.
    if (cmd === 'launch-app') return UIA_LAUNCH_TIMEOUT_MS;
    return UIA_COMMAND_TIMEOUT_MS;
  }

  /**
   * Reclaim an idle server: after `idleTimeoutMs` without requests the
   * resident process is killed (no restart scheduled) and the next request
   * spawns a fresh one lazily. This is the client-side replacement for a
   * server-side idle timer — the server's blocking ReadLine loop cannot run
   * one (a Peek() poll loop is broken under WSL interop, where Peek() false-
   * EOFs once the pipe has been read empty).
   */
  private _killIfIdle(): void {
    if (!this.child || !this.ready) return;
    if (Date.now() - this.lastActivity <= this.idleTimeoutMs) return;
    this.logger?.debug('UIA server idle; killing for lazy respawn');
    const child = this.child;
    this.child = null;
    this.ready = false;
    // Reuse the idle-exit marker so the exit handler does not schedule a
    // crash restart — the next request respawns the server.
    this.idleExited = true;
    try {
      child.stdin?.end();
      child.kill();
    } catch {
      /* ignore */
    }
  }

  private async _ensureReady(): Promise<void> {
    if (this.stopped) return;
    if (this.ready && this.child) return;
    if (!this.child) await this._spawn();
    // Wait for the CUAREADY handshake before sending any command. A process
    // that stays alive without handshaking (e.g. a hung PS parse) would
    // otherwise hang every request forever — bound the wait and restart.
    const deadline = Date.now() + this.handshakeTimeoutMs;
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (this.ready || this.stopped || !this.child) resolve();
        else if (Date.now() > deadline) {
          this.logger?.warn('UIA server handshake timed out; restarting');
          this._restart();
          resolve();
        } else setTimeout(check, 5);
      };
      check();
    });
  }

  private async _spawn(): Promise<void> {
    if (this.child) return;
    this.logger?.debug('Starting UIA server process');

    // Materialize the script on the Windows filesystem (path differs under WSL).
    const wslPath = winToWslPath(UIA_SERVER_SCRIPT_PATH);
    try {
      writeUiaServerScript(wslPath);
    } catch (err) {
      this.logger?.error({ err }, 'Failed to write UIA server script');
      this._scheduleRestart();
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          UIA_SERVER_SCRIPT_PATH,
        ],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (err) {
      this.logger?.error({ err }, 'Failed to spawn UIA server');
      this._scheduleRestart();
      return;
    }

    this.child = child;
    this.ready = false;
    this.stdoutBuffer = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = this.stdoutBuffer.indexOf('\n')) !== -1) {
        const line = this.stdoutBuffer.slice(0, nl).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
        if (line) this._onLine(line);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.logger?.debug({ stderr: text.slice(0, 500) }, 'UIA server stderr');
    });
    child.on('exit', (code, signal) => {
      this.logger?.debug({ code, signal }, 'UIA server exited');
      const wasReady = this.ready;
      const idleExit = this.idleExited;
      this.idleExited = false;
      this.child = null;
      this.ready = false;
      if (!this.stopped) {
        if (idleExit) {
          // Normal idle self-exit: respawn lazily on the next request.
          this._rejectPending('SERVER_STOPPED', 'UIA server idle-exited');
        } else {
          this._rejectPending('SERVER_CRASHED', `UIA server exited (code=${code ?? 'unknown'})`);
          if (wasReady) this.restartDelay = INITIAL_RESTART_DELAY_MS;
          this._scheduleRestart();
        }
      }
    });
    child.on('error', (err) => {
      this.logger?.error({ err }, 'UIA server process error');
      this.child = null;
      this.ready = false;
      if (!this.stopped) {
        this._rejectPending('SERVER_CRASHED', `UIA server process error: ${err.message}`);
        this._scheduleRestart();
      }
    });
  }

  private _onLine(line: string): void {
    if (!this.ready && line.startsWith(UIA_HANDSHAKE_MARKER)) {
      this.ready = true;
      this.restartDelay = INITIAL_RESTART_DELAY_MS;
      this.logger?.debug('UIA server ready');
      return;
    }
    if (line === 'EXIT') {
      // Server idle-exited; mark it dead so the next request respawns it
      // (and the exit event does not trigger a restart).
      this.ready = false;
      this.child = null;
      this.idleExited = true;
      return;
    }
    let msg: { id?: number; ok?: boolean; result?: unknown; error?: UiaErrorInfo };
    try {
      msg = JSON.parse(line);
    } catch {
      this.logger?.warn({ line: line.slice(0, 200) }, 'UIA server sent non-JSON line');
      return;
    }
    const idx = this.pending.findIndex((p) => p.id === msg.id);
    if (idx === -1) return;
    const [pending] = this.pending.splice(idx, 1);
    clearTimeout(pending.timer);
    if (msg.ok === true) {
      pending.resolve({ ok: true, result: msg.result });
    } else {
      pending.resolve({
        ok: false,
        error: msg.error ?? { code: 'SERVER_ERROR', message: 'Unknown server error' },
      });
    }
  }

  private _rejectPending(code: string, message: string): void {
    for (const p of this.pending.splice(0)) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: { code, message } });
    }
  }

  private _restart(): void {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this._rejectPending('SERVER_CRASHED', 'UIA server restarted');
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    this._scheduleRestart();
  }

  private _scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(this.restartDelay * 2, MAX_RESTART_DELAY_MS);
    this.logger?.debug({ delay }, 'Scheduling UIA server restart');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopped) return;
      if (!this.child) void this._spawn();
    }, delay);
  }
}
