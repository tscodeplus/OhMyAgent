/**
 * SSH Connection Pool
 *
 * Manages SSH connections with ControlMaster multiplexing.
 * Completely independent — only depends on node:child_process.
 */

import type { Logger } from 'pino';
import { spawn } from 'node:child_process';
import { unlink } from 'node:fs/promises';
import { mkdirSync, statSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SSHPoolConfig {
  host: string;
  user: string;
  keyPath: string;
  port?: number;
  jumpHost?: string;
  display?: string;
  maxConnections?: number;
  idleTimeoutMs?: number;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  retryCount?: number;
  keepAliveIntervalMs?: number;
  /**
   * Host-key verification policy.
   *   - 'accept-new' (default): TOFU — trust the key on first connect, reject
   *     changes thereafter. Convenient but vulnerable to a first-connect MITM.
   *   - 'strict': require the host key to already be present in knownHostsPath
   *     (StrictHostKeyChecking=yes). Use in untrusted networks.
   */
  hostKeyChecking?: 'accept-new' | 'strict';
  /**
   * Path to the known_hosts file used for verification. Defaults to the user's
   * ~/.ssh/known_hosts. Required to be pre-populated when hostKeyChecking is
   * 'strict'.
   */
  knownHostsPath?: string;
  /**
   * Timeout (ms) for acquiring a connection slot from the pool. 0 disables the
   * timeout (wait forever). Default 30s — prevents callers from hanging
   * indefinitely when all slots are stuck.
   */
  acquireTimeoutMs?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface HealthCheckResult {
  reachable: boolean;
  deps: {
    xdotool: boolean;
    scrot: boolean;
  };
}

export class SSHExitError extends Error {
  public readonly exitCode: number;
  public readonly stderr: string;

  constructor(exitCode: number, stderr: string, message?: string) {
    super(message ?? `SSH command exited with code ${exitCode}`);
    this.name = 'SSHExitError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class SSHTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`SSH command timed out after ${timeoutMs}ms`);
    this.name = 'SSHTimeoutError';
  }
}

const FATAL_EXIT_CODES = new Set([255, 127, 126]);
const DISPLAY_PATTERN = /^:[0-9]+(?:\.[0-9]+)?$/;

/**
 * Resolve a private, user-owned directory (0700) for SSH ControlMaster
 * sockets. A world-writable /tmp path lets any local user pre-create or
 * hijack the socket; isolating it under the user's home (or a 0700 tmp
 * subdir) closes that. Returns the directory path.
 */
function resolveControlDir(logger?: Logger): string {
  const candidates = [
    path.join(os.homedir() || '', '.ohmyagent', 'ssh'),
    path.join(os.tmpdir(), `ohmyagent-ssh-${process.getuid?.() ?? 'u'}`),
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Tighten perms even if the dir already existed with looser mode.
      const st = statSync(dir);
      if ((st.mode & 0o077) !== 0) {
        // Best-effort: chmod to 0700.
        try { chmodSync(dir, 0o700); } catch { /* ignore */ }
      }
      return dir;
    } catch (err) {
      logger?.debug({ err, dir }, 'ssh-pool control dir candidate failed');
    }
  }
  // Last resort: tmpdir root (still better than a fixed predictable name).
  return os.tmpdir();
}

export class SSHPool {
  private readonly config: Required<SSHPoolConfig>;
  private readonly logger?: Logger;
  private readonly controlDir: string;
  private readonly controlPathTemplate: string;
  private destroyed = false;
  private activeConnections = 0;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private consecutiveHeartbeatFailures = 0;
  /**
   * Track active child process PIDs so destroy() can cleanly kill in-flight
   * connections, closing the race window between `destroyed = true` and
   * `clearInterval(heartbeatTimer)`.
   */
  private activeChildren = new Set<ReturnType<typeof spawn>>();
  private readonly pendingQueue: Array<{
    resolve: () => void;
    reject: (err: unknown) => void;
    timer?: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(config: SSHPoolConfig, logger?: Logger) {
    this.config = {
      host: config.host,
      user: config.user,
      keyPath: config.keyPath,
      port: config.port ?? 22,
      jumpHost: config.jumpHost ?? '',
      display: config.display ?? ':0',
      maxConnections: config.maxConnections ?? 3,
      idleTimeoutMs: config.idleTimeoutMs ?? 300_000,
      connectTimeoutMs: config.connectTimeoutMs ?? 10_000,
      commandTimeoutMs: config.commandTimeoutMs ?? 30_000,
      retryCount: config.retryCount ?? 2,
      keepAliveIntervalMs: config.keepAliveIntervalMs ?? 60_000,
      hostKeyChecking: config.hostKeyChecking ?? 'accept-new',
      knownHostsPath: config.knownHostsPath ?? '',
      acquireTimeoutMs: config.acquireTimeoutMs ?? 30_000,
    };
    if (!DISPLAY_PATTERN.test(this.config.display)) {
      throw new Error(`Invalid SSH DISPLAY value: ${this.config.display}`);
    }
    this.logger = logger;
    // Private 0700 directory for the ControlMaster socket. %h/%p/%r keep the
    // socket distinct per host/port/user; the parent dir perms keep other
    // local users out.
    this.controlDir = resolveControlDir(logger);
    this.controlPathTemplate = path.join(this.controlDir, 'cm-%r@%h:%p');
    this.startHeartbeat();
    this.logger?.debug({ host: this.config.host, user: this.config.user }, 'ssh-pool created');
  }

  private get resolvedControlPath(): string {
    return path.join(
      this.controlDir,
      `cm-${this.config.user}@${this.config.host}:${this.config.port}`,
    );
  }

  private buildSSHArgs(commandArg: string | undefined): string[] {
    const { host, user, keyPath, port, jumpHost, connectTimeoutMs, idleTimeoutMs,
            hostKeyChecking, knownHostsPath } = this.config;
    const connectTimeoutSec = Math.ceil(connectTimeoutMs / 1000);
    const persistSec = Math.ceil(idleTimeoutMs / 1000);

    const strict = hostKeyChecking === 'strict' ? 'yes' : 'accept-new';
    const args: string[] = [
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${this.controlPathTemplate}`,
      '-o', `ControlPersist=${persistSec}s`,
      '-o', `ConnectTimeout=${connectTimeoutSec}`,
      '-o', `StrictHostKeyChecking=${strict}`,
      '-i', keyPath,
      '-p', String(port),
    ];

    if (knownHostsPath) {
      args.push('-o', `UserKnownHostsFile=${knownHostsPath}`);
    }

    if (jumpHost) {
      args.push('-J', jumpHost);
    }

    args.push(`${user}@${host}`);

    if (commandArg !== undefined) {
      args.push(commandArg);
    }

    return args;
  }

  /**
   * Execute a command on the remote host via SSH.
   * Automatically reuses SSH connections via ControlMaster.
   * Prepends DISPLAY environment variable to the command.
   * Retries on transient failures up to retryCount times.
   */
  async exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
    if (this.destroyed) {
      throw new Error('SSHPool has been destroyed');
    }

    const timeoutMs = opts?.timeoutMs ?? this.config.commandTimeoutMs;
    const fullCommand = `DISPLAY=${this.config.display} ${command}`;

    await this.acquireConnection();

    try {
      let lastError: Error | undefined;

      for (let attempt = 0; ; attempt++) {
        if (attempt > 0) {
          this.logger?.debug({ attempt, command }, 'ssh-pool retrying command');
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        try {
          return await this.execOnce(fullCommand, timeoutMs);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));

          if (error instanceof SSHExitError && !FATAL_EXIT_CODES.has(error.exitCode)) {
            // Non-fatal exit code — retry if attempts remain
            if (attempt < this.config.retryCount) {
              lastError = error;
              continue;
            }
          }

          // Fatal exit code, timeout, process error, or out of retries
          throw error;
        }
      }
    } finally {
      this.releaseConnection();
    }
  }

  /**
   * Check if the remote host is reachable and has required dependencies.
   * Runs: which xdotool && which scrot && echo OK
   */
  async healthCheck(): Promise<HealthCheckResult> {
    try {
      const result = await this.exec('which xdotool && which scrot && echo OK', { timeoutMs: 15_000 });
      const stdout = result.stdout;
      return {
        reachable: stdout.includes('OK'),
        deps: {
          xdotool: stdout.includes('xdotool'),
          scrot: stdout.includes('scrot'),
        },
      };
    } catch {
      return {
        reachable: false,
        deps: { xdotool: false, scrot: false },
      };
    }
  }

  /**
   * Close all SSH connections and clean up ControlMaster sockets.
   */
  async destroy(): Promise<void> {
    this.destroyed = true;
    this.logger?.debug({ host: this.config.host }, 'ssh-pool destroying');

    // Stop heartbeat
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }

    // Kill all active child processes to close the race window
    // between destroyed = true and clearInterval.
    for (const child of this.activeChildren) {
      try {
        if (!child.killed) child.kill('SIGTERM');
      } catch {
        // Process may already be dead
      }
    }
    this.activeChildren.clear();

    // Reject all queued requests
    const queue = this.pendingQueue.splice(0);
    for (const pending of queue) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(new Error('SSHPool has been destroyed'));
    }

    // Gracefully stop the control master
    try {
      const stopArgs = [
        '-o', `ControlPath=${this.controlPathTemplate}`,
        '-O', 'stop',
        `${this.config.user}@${this.config.host}`,
      ];
      await this.spawnSSH(stopArgs, 5_000);
    } catch (err) {
      this.logger?.debug({ err }, 'ssh-pool error stopping control master');
    }

    // Remove control socket file
    try {
      await unlink(this.resolvedControlPath);
    } catch {
      // File may not exist
    }

    this.logger?.debug({ host: this.config.host }, 'ssh-pool destroyed');
  }

  // ── Private ──

  private async acquireConnection(): Promise<void> {
    if (this.activeConnections < this.config.maxConnections) {
      this.activeConnections++;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const entry: {
        resolve: () => void;
        reject: (err: unknown) => void;
        timer?: ReturnType<typeof setTimeout>;
      } = { resolve, reject };

      const timeoutMs = this.config.acquireTimeoutMs;
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          // Remove this waiter from the queue and reject — prevents callers
          // from hanging forever when all slots are stuck.
          const idx = this.pendingQueue.indexOf(entry);
          if (idx !== -1) this.pendingQueue.splice(idx, 1);
          reject(new Error(`Timed out acquiring SSH connection slot after ${timeoutMs}ms`));
        }, timeoutMs);
        if (typeof entry.timer === 'object' && 'unref' in entry.timer) {
          entry.timer.unref();
        }
      }

      this.pendingQueue.push(entry);
    });
  }

  private releaseConnection(): void {
    const next = this.pendingQueue.shift();
    if (next) {
      // Transfer slot to the next waiting exec
      if (next.timer !== undefined) clearTimeout(next.timer);
      next.resolve();
    } else {
      this.activeConnections--;
    }
  }

  private execOnce(fullCommand: string, timeoutMs: number): Promise<ExecResult> {
    const args = this.buildSSHArgs(fullCommand);
    return this.spawnSSH(args, timeoutMs);
  }

  private spawnSSH(args: string[], timeoutMs: number): Promise<ExecResult> {
    // Fast-fail when the pool has been destroyed
    if (this.destroyed) {
      return Promise.reject(new Error('SSHPool has been destroyed'));
    }

    return new Promise((resolve, reject) => {
      const child = spawn('ssh', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.activeChildren.add(child);

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        this.activeChildren.delete(child);
        clearTimeout(timer);
        if (killTimer !== undefined) clearTimeout(killTimer);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        this.logger?.debug({ args }, 'ssh-pool command timed out');
        child.kill('SIGTERM');

        killTimer = setTimeout(() => {
          try {
            if (!child.killed) child.kill('SIGKILL');
          } catch {
            // Process may already be dead
          }
        }, 500);
      }, timeoutMs);

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new SSHExitError(-1, stderr, `SSH process error: ${err.message}`));
      };

      const onClose = (code: number | null) => {
        if (settled) return;
        settled = true;
        cleanup();

        if (timedOut) {
          reject(new SSHTimeoutError(timeoutMs));
          return;
        }

        if (code === 0) {
          resolve({ stdout, stderr, exitCode: 0 });
        } else {
          reject(new SSHExitError(code ?? -1, stderr));
        }
      };

      child.on('error', onError);
      child.on('close', onClose);
    });
  }

  private startHeartbeat(): void {
    if (this.config.keepAliveIntervalMs <= 0) return;

    this.heartbeatTimer = setInterval(() => {
      this.doHeartbeat().catch(() => { /* handled internally */ });
    }, this.config.keepAliveIntervalMs);

    this.heartbeatTimer.unref();
  }

  private async doHeartbeat(): Promise<void> {
    if (this.destroyed) return;

    try {
      await this.execOnce('echo CUAPING', 10_000);
      this.consecutiveHeartbeatFailures = 0;
    } catch (err) {
      this.consecutiveHeartbeatFailures++;
      this.logger?.debug(
        { consecutiveFailures: this.consecutiveHeartbeatFailures, err },
        'ssh-pool heartbeat failed',
      );

      if (this.consecutiveHeartbeatFailures >= 3) {
        this.logger?.error(
          { consecutiveFailures: this.consecutiveHeartbeatFailures },
          'ssh-pool too many heartbeat failures, resetting connection',
        );
        this.consecutiveHeartbeatFailures = 0;

        // Clean up control socket and check connection status to force reconnection
        try {
          await unlink(this.resolvedControlPath);
        } catch {
          // File may not exist
        }

        // Attempt a fresh connection check to trigger ControlMaster re-init
        try {
          await this.execOnce('echo CUARECONNECT', 10_000);
          this.logger?.info({ host: this.config.host }, 'ssh-pool reconnected after heartbeat failures');
        } catch (reconnectErr) {
          this.logger?.warn(
            { err: reconnectErr, host: this.config.host },
            'ssh-pool reconnection attempt failed, will retry on next heartbeat',
          );
        }
      }
    }
  }
}
