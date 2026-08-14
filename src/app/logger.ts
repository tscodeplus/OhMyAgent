import pino from 'pino';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let cachedLogger: pino.Logger | null = null;

/**
 * Resolve the log directory with this priority:
 *   1. `OHMYAGENT_LOG_DIR` env var (explicit override)
 *   2. `$OHMYAGENT_HOME/logs` (when OHMYAGENT_HOME is set)
 *   3. `~/.ohmyagent/logs` (default)
 */
function resolveLogDir(): string {
  if (process.env.OHMYAGENT_LOG_DIR) return process.env.OHMYAGENT_LOG_DIR;
  if (process.env.OHMYAGENT_HOME) return join(process.env.OHMYAGENT_HOME, 'logs');
  return join(homedir(), '.ohmyagent', 'logs');
}

/**
 * Create a pino logger instance.
 *
 * Console output:
 *   - Development: uses pino-pretty for human-readable output.
 *   - Production: raw JSON to stdout.
 *
 * File output:
 *   - Always writes to <logDir>/ohmyagent.log (appended, never truncated).
 *   - Log directory defaults to ~/.ohmyagent/logs; override with
 *     OHMYAGENT_LOG_DIR or OHMYAGENT_HOME.
 *   - The file target is a self-healing transport (src/app/file-self-heal.js):
 *     if the log file is deleted while the server runs, the next write
 *     recreates it instead of silently writing into the unlinked inode.
 *
 * Result is cached — subsequent calls return the same instance.
 */
export function createLogger(level?: string): pino.Logger {
  if (cachedLogger) return cachedLogger;

  const isDev = process.env.NODE_ENV !== 'production';
  const logLevel = level ?? 'info';
  const logDir = resolveLogDir();

  // Build transport targets
  const targets: pino.TransportTargetOptions[] = [];

  if (isDev) {
    targets.push({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname',
      },
      level: logLevel,
    });
  } else {
    // Production: raw JSON to stdout
    targets.push({
      target: 'pino/file',
      options: { destination: 1 }, // stdout
      level: logLevel,
    });
  }

  // File transport: always write logs to disk.
  // Uses the self-healing `file-self-heal.js` worker instead of pino's
  // built-in `pino/file`, so the log file is recreated automatically if it is
  // deleted while the process is running (pino/file holds one fd forever and
  // would keep writing into the unlinked inode, never recreating the file).
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    // Directory might already exist or be unwritable — don't crash
  }
  targets.push({
    target: './file-self-heal.js',
    options: {
      destination: join(logDir, 'ohmyagent.log'),
      mkdir: true,
    },
    level: logLevel,
  });

  cachedLogger = pino({
    level: logLevel,
    transport: { targets },
  });

  return cachedLogger;
}

/**
 * Patch a pino logger in-place so calls never throw when the worker thread
 * has exited (common during Electron app shutdown on Windows).
 *
 * All log methods (trace/debug/info/warn/error/fatal) are replaced with
 * versions that silently swallow "worker has exited" errors. Other errors
 * still propagate. Safe to call multiple times on the same logger.
 *
 * Returns the same logger instance for chaining convenience.
 */
export function safeLogWrapper(logger: pino.Logger): pino.Logger {
  const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];

  for (const level of levels) {
    const original = (logger as any)[level];
    if (typeof original === 'function' && !(original as any).__safeWrapped) {
      (logger as any)[level] = (...args: any[]) => {
        try {
          return original.apply(logger, args);
        } catch (err: any) {
          if (err?.message?.includes('worker has exited')) {
            // pino transport worker already dead — not actionable during shutdown
            return;
          }
          throw err;
        }
      };
      (logger as any)[level].__safeWrapped = true;
    }
  }

  return logger;
}

/**
 * Reset cached logger (for testing).
 */
export function resetLogger(): void {
  cachedLogger = null;
}
