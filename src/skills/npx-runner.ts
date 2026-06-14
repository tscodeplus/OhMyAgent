/**
 * Safe cross-platform npx runner.
 *
 * On Node.js >= 20.12, execFile/spawn refuse to invoke .cmd/.bat directly
 * (CVE-2024-27980). Instead of going through a shell, we locate the real
 * npx-cli.js bundled with Node and invoke it via the current `node` binary.
 * This works identically on Linux, macOS, Windows, and Termux.
 *
 * Reference: pi-web/lib/npx.ts
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execPath } from 'node:process';

const execFileAsync = promisify(execFile);

/** Strip ANSI escape codes from CLI output. */
const ANSI_RE = /\x1B\[[0-9;]*m/g;

/**
 * Locate npx-cli.js shipped with the running Node.js installation.
 * Returns null on platforms where it cannot be found (fall back to PATH `npx`).
 */
function findNpxCli(): string | null {
  const nodeDir = dirname(execPath);

  const candidates = [
    // Standard npm v10+ layout (all platforms)
    join(nodeDir, 'npx-cli.js'),
    // Alternative npm layouts
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    // Global npm root layout
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

export interface NpxResult {
  stdout: string;
  stderr: string;
}

export interface NpxOptions {
  timeout: number;
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Run an npx command safely across platforms.
 *
 * Attempts to invoke npx-cli.js directly via the current Node binary.
 * Falls back to PATH-based `npx` (via shell on Windows) if the CLI
 * script cannot be located.
 */
export async function runNpx(args: string[], opts: NpxOptions): Promise<NpxResult> {
  const npxCli = findNpxCli();

  let command: string;
  let commandArgs: string[];

  if (npxCli) {
    command = execPath;
    commandArgs = [npxCli, ...args];
  } else {
    command = 'npx';
    commandArgs = args;
  }

  // Strip unknown npm config env vars that cause warnings (and sometimes non-zero exit)
  const env: Record<string, string> = {};
  const npmConfigRe = /^npm_config_/i;
  for (const [key, value] of Object.entries(opts.env ?? process.env)) {
    if (value == null) continue;
    if (npmConfigRe.test(key)) continue;
    env[key] = value;
  }

  try {
    const { stdout, stderr } = await execFileAsync(command, commandArgs, {
      timeout: opts.timeout,
      cwd: opts.cwd,
      env,
      maxBuffer: 1024 * 1024,
    });

    return {
      stdout: stdout.replace(ANSI_RE, ''),
      stderr: stderr.replace(ANSI_RE, ''),
    };
  } catch (err: any) {
    // npx may exit non-zero even on partial success — surface output in the error
    const stdout: string = (err.stdout ?? '').replace(ANSI_RE, '');
    const stderr: string = (err.stderr ?? '').replace(ANSI_RE, '');
    const message = stdout + stderr || err.message || String(err);
    throw new Error(message);
  }
}
