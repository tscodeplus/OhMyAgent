import { exec } from 'child_process';
import { Type } from 'typebox';
import { i18n } from '../../i18n/index.js';
import type { AgentTool } from '../../pi-mono/agent/types.js';

export interface ShellToolOptions {
  timeoutMs?: number;
  maxOutputLength?: number;
}

/** @deprecated Use `createShellToolDefinition` from `./shell/definition.js` instead. */
export function createShellTool(options: ShellToolOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 60000;
  const maxOutputLength = options.maxOutputLength ?? 12000;

  return {
    name: 'shell',
    label: 'Shell',
    description: 'Execute a shell command. For file ops, scripts, packages, system inspection. Prefer file_read for file access.',
    parameters: Type.Object({
      command: Type.String({ description: 'The shell command to execute' }),
    }),
    execute: async (_toolCallId: string, params: { command: string }, signal?: AbortSignal) => {
      return new Promise<any>((resolve) => {
        const proc = exec(params.command, {
          timeout: timeoutMs,
          signal,
          maxBuffer: 10 * 1024 * 1024,
        }, (error, stdout, stderr) => {
          if (error) {
            if (error.killed || (error as any).code === 'ABORT_ERR') {
              resolve({ content: [{ type: 'text', text: i18n.t('tools-builtins:shell.timedOut') }] });
              return;
            }
            const output = stderr || error.message;
            resolve({ content: [{ type: 'text', text: i18n.t('tools-builtins:shell.error', { message: truncateOutput(output, maxOutputLength) }) }] });
            return;
          }

          const output = stdout || stderr || i18n.t('tools-builtins:shell.noOutput');
          resolve({ content: [{ type: 'text', text: truncateOutput(output, maxOutputLength) }] });
        });

        if (signal) {
          signal.addEventListener('abort', () => {
            proc.kill('SIGTERM');
          });
        }
      });
    },
  } as AgentTool<any>;
}

function truncateOutput(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const remaining = text.length - maxLength;
  return text.slice(0, maxLength) + '\n\n' + i18n.t('tools-builtins:shell.truncated', { count: remaining });
}
