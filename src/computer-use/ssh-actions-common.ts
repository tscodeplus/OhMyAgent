// src/computer-use/ssh-actions-common.ts
//
// Shared helpers for the per-platform action modules. The modules were born
// as SSH-only (ssh-actions-linux.ts / ssh-actions-darwin.ts / ssh-actions-win32.ts)
// but every one of their functions depends on nothing more than an
// `exec(cmd, {timeoutMs})` — so the same code drives both the remote (SSHPool)
// and the local accessibility providers (local-linux / local-darwin, which
// run the very same commands through child_process).

import { exec } from 'node:child_process';

/** Result of a single command run (mirrors SSHPool's ExecResult shape). */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Minimal command runner consumed by the per-platform action modules.
 * SSHPool satisfies it structurally; `createLocalExecRunner()` produces the
 * local equivalent.
 */
export interface ExecRunner {
  exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult>;
}

/**
 * Local command runner backed by child_process.exec.
 *
 * Semantics mirror SSHPool.exec: the command runs through the POSIX shell
 * (the action modules already shell-escape every argument via
 * quoteShellArg), a non-zero exit code rejects (like SSHExitError), and
 * timeoutMs kills the process. maxBuffer is raised to 64MB so screenshot
 * base64 (multi-MB) survives.
 *
 * `display` optionally prepends `DISPLAY=<value>` to every command — needed
 * on Linux when OhMyAgent runs outside a desktop session (systemd, SSH)
 * where DISPLAY is not exported; defaulting to ':0' covers the common case.
 */
export function createLocalExecRunner(options?: {
  display?: string;
  maxBufferBytes?: number;
}): ExecRunner {
  const displayPrefix = options?.display ? `DISPLAY=${options.display} ` : '';
  const maxBuffer = options?.maxBufferBytes ?? 64 * 1024 * 1024;
  return {
    exec(command: string, opts?: { timeoutMs?: number }): Promise<ExecResult> {
      return new Promise((resolve, reject) => {
        exec(displayPrefix + command, { timeout: opts?.timeoutMs, maxBuffer }, (err, stdout, stderr) => {
          if (err) {
            const cause = err as Error & { code?: number | string; killed?: boolean };
            const reason = cause.killed
              ? `timed out after ${opts?.timeoutMs ?? 0}ms`
              : cause.code !== undefined
                ? `exit code ${cause.code}`
                : cause.message;
            const detail = (stderr || stdout || '').trim();
            reject(new Error(`local exec failed (${reason})${detail ? `: ${detail}` : ''}`));
            return;
          }
          resolve({ stdout, stderr, exitCode: 0 });
        });
      });
    },
  };
}

/**
 * Wrap a string in single quotes for safe use as one shell argument.
 * Embedded single quotes become '\'' so the argument cannot break out of
 * the quoting (prevents command injection over SSH).
 */
export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Truncate stdout that exceeds 12000 characters, appending a note about the
 * original length.  This is intentionally *not* applied to screenshot base64
 * data which must remain intact.
 */
export function truncateStdout(stdout: string): string {
  if (stdout.length > 12000) {
    return stdout.slice(0, 12000) + `...(truncated, ${stdout.length} chars)`;
  }
  return stdout;
}
