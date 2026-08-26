import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { Type } from 'typebox';
import { i18n } from '../../i18n/index.js';
import type { AgentTool } from '../../pi-mono/agent/types.js';

export interface ShellToolOptions {
  timeoutMs?: number;
  maxOutputLength?: number;
}

/**
 * How many characters of each stream (stdout/stderr) are retained in memory:
 * up to `cap` at the head + `cap` at the tail. Everything in between is
 * discarded as it arrives instead of being buffered (the old exec-based
 * implementation buffered up to 10MB per stream before killing the process).
 */
const STREAM_RETAIN_CHARS = 512 * 1024;

/** Grace period between SIGTERM and SIGKILL on timeout/abort. */
const KILL_GRACE_MS = 5000;

/**
 * Bounded stream capture: retains the first and last `cap` characters and
 * counts everything in between as dropped. UTF-8 safe across chunk
 * boundaries via StringDecoder.
 */
class CappedStreamCapture {
  private decoder = new StringDecoder('utf8');
  private head = '';
  private headFull = false;
  private tail = '';
  /** Characters evicted from the retained window (never held in memory). */
  dropped = 0;

  push(chunk: Buffer): void {
    this.pushText(this.decoder.write(chunk));
  }

  /** Flush any pending multi-byte sequence at end of stream. */
  end(): void {
    this.pushText(this.decoder.end());
    // Free the decoder's internal state.
    this.decoder = new StringDecoder('utf8');
  }

  private pushText(text: string): void {
    if (!text) return;
    if (!this.headFull) {
      const space = STREAM_RETAIN_CHARS - this.head.length;
      if (text.length <= space) {
        this.head += text;
        return;
      }
      const headPart = text.slice(0, space);
      this.head += headPart;
      this.headFull = true;
      this.pushTail(text.slice(space));
      return;
    }
    this.pushTail(text);
  }

  private pushTail(text: string): void {
    const combined = this.tail + text;
    if (combined.length <= STREAM_RETAIN_CHARS) {
      this.tail = combined;
      return;
    }
    const overflow = combined.length - STREAM_RETAIN_CHARS;
    this.dropped += overflow;
    this.tail = combined.slice(overflow);
  }

  /** Assemble head + [dropped marker] + tail. */
  text(): string {
    if (!this.headFull) return this.head;
    if (this.dropped === 0) return this.head + this.tail;
    const marker =
      '\n' + i18n.t('tools-builtins:shell.streamTruncated', { count: this.dropped }) + '\n';
    return this.head + marker + this.tail;
  }
}

/** @deprecated Use `createShellToolDefinition` from `./shell/definition.js` instead. */
export function createShellTool(options: ShellToolOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 60000;
  const maxOutputLength = options.maxOutputLength ?? 12000;

  return {
    name: 'shell',
    label: 'Shell',
    description:
      'Execute a shell command. For file ops, scripts, packages, system inspection. Prefer file_read for file access.',
    parameters: Type.Object({
      command: Type.String({ description: 'The shell command to execute' }),
    }),
    execute: async (_toolCallId: string, params: { command: string }, signal?: AbortSignal) => {
      return new Promise<any>((resolve) => {
        let settled = false;

        const stdout = new CappedStreamCapture();
        const stderr = new CappedStreamCapture();

        let timedOut = false;
        let aborted = false;

        const timedOutResult = () => ({
          content: [{ type: 'text', text: i18n.t('tools-builtins:shell.timedOut') }],
          isError: true,
        });

        // Already aborted before spawn → fail fast without spawning a child.
        if (signal?.aborted) {
          return resolve(timedOutResult());
        }

        // detached (POSIX) gives the child its own process group so we can
        // kill shell + grandchildren together — killing only the shell leaves
        // grandchildren holding the stdio pipes and 'close' never fires.
        const child = spawn(params.command, {
          shell: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        /** Kill the whole process tree (shell + grandchildren). */
        const killTree = (sig: NodeJS.Signals) => {
          try {
            if (process.platform === 'win32') {
              child.kill(sig);
            } else if (child.pid) {
              process.kill(-child.pid, sig);
            }
          } catch {
            // Process group already gone.
            child.kill(sig);
          }
        };

        child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));

        // Hard timeout → SIGTERM, then SIGKILL after a grace period.
        const killTimer = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS);
        killTimer.unref?.();
        const timeoutTimer = setTimeout(() => {
          timedOut = true;
          killTree('SIGTERM');
        }, timeoutMs);
        timeoutTimer.unref?.();

        // Track explicit aborts (/stop) so we can report them like timeouts:
        // killing the tree makes 'close' fire promptly (M2).
        const onAbort = () => {
          aborted = true;
          killTree('SIGTERM');
        };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }

        const finish = (result: any) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutTimer);
          clearTimeout(killTimer);
          // A late abort on a shared run-level signal must not fire killTree
          // against an already-reaped child.
          signal?.removeEventListener('abort', onAbort);
          resolve(result);
        };

        child.on('error', (err: Error) => {
          // Spawn failures (e.g. shell not found) emit 'error' WITHOUT 'close'
          // when the child was never started, so settle here directly. For
          // rare mid-run errors the process is best-effort killed so it cannot
          // outlive the settled promise.
          killTree('SIGKILL');
          finish({
            content: [
              {
                type: 'text',
                text: i18n.t('tools-builtins:shell.error', { message: err.message }),
              },
            ],
            isError: true,
          });
        });

        child.on('close', (code) => {
          stdout.end();
          stderr.end();

          // Aborted or failing commands must surface as an error so the agent
          // loop's failure tracking (tool-cycle guard) can see it.
          if (timedOut || aborted) {
            finish(timedOutResult());
            return;
          }
          if (code !== 0) {
            const output =
              [stdout.text(), stderr.text()].filter(Boolean).join('\n') || `exit code ${code}`;
            finish({
              content: [
                {
                  type: 'text',
                  text: i18n.t('tools-builtins:shell.error', {
                    message: truncateOutput(output, maxOutputLength),
                  }),
                },
              ],
              isError: true,
            });
            return;
          }

          const output = stdout.text() || stderr.text() || i18n.t('tools-builtins:shell.noOutput');
          finish({
            content: [{ type: 'text', text: truncateOutput(output, maxOutputLength) }],
            isError: false,
          });
        });
      });
    },
  } as AgentTool<any>;
}

function truncateOutput(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const remaining = text.length - maxLength;
  return (
    text.slice(0, maxLength) +
    '\n\n' +
    i18n.t('tools-builtins:shell.truncated', { count: remaining })
  );
}
