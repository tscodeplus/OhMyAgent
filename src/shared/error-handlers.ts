/**
 * Error-handling utilities for OhMyAgent.
 *
 * Provides:
 * - `handleError`        – Centralised error logging and optional re-throw.
 * - `withErrorHandling` – Wraps an async function so errors are handled silently.
 * - `createErrorAwareRetry` – Factory that returns a retry wrapper respecting
 *                            the `recoverable` flag on OhMyAgentError instances.
 *
 * Logger is acquired via dependency injection (pino {@link Logger} interface),
 * matching the project convention of passing a single shared pino instance.
 */

import type { Logger } from 'pino';
import { OhMyAgentError } from './errors.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ErrorHandlerContext {
  /** Optional pino logger — when omitted no log output is produced. */
  logger?: Logger;

  /** Short human-readable label for the operation that failed (e.g. `'load-skill'`). */
  operation: string;

  /**
   * When `true` the error is re-thrown after logging.
   * Use this at top-level entry points where the caller expects a thrown
   * exception (e.g. CLI commands, server middleware).
   * Defaults to `false`.
   */
  fatal?: boolean;
}

// ── Core handler ────────────────────────────────────────────────────────────

/**
 * Log the error in a structured format and optionally re-throw it.
 *
 * @param error   – The thrown value (string, Error, or arbitrary value).
 * @param context – Metadata and logger.
 *
 * @throws The original error when `context.fatal` is `true`.
 */
export function handleError(error: unknown, context: ErrorHandlerContext): void {
  const { logger, operation, fatal } = context;

  if (logger) {
    if (error instanceof OhMyAgentError) {
      logger.error(
        { err: error, code: error.code, recoverable: error.recoverable, operation },
        `[${operation}] ${error.message}`,
      );
    } else if (error instanceof Error) {
      logger.error({ err: error, operation }, `[${operation}] ${error.message}`);
    } else {
      logger.error(
        { err: String(error), operation },
        `[${operation}] Non-Error thrown: ${String(error)}`,
      );
    }
  }

  if (fatal) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

// ── Higher-order wrapper ────────────────────────────────────────────────────

/**
 * Wrap an async function so that any thrown error is forwarded to
 * {@link handleError} and the caller receives `undefined` on failure.
 *
 * @example
 * ```ts
 * const result = await withErrorHandling(
 *   () => loadSkill('my-skill'),
 *   { logger, operation: 'load-skill', fatal: false },
 * );
 * if (result === undefined) { /* fallback … *\/ }
 * ```
 */
export async function withErrorHandling<T>(
  fn: () => Promise<T>,
  context: ErrorHandlerContext,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    handleError(error, context);
    return undefined;
  }
}

// ── Retry factory ───────────────────────────────────────────────────────────

/**
 * Create a retry wrapper that re-invokes the function on recoverable errors
 * up to `maxRetries` times with exponential backoff.
 *
 * Errors that are **not** recoverable (i.e. `error.recoverable === false`)
 * are thrown immediately without retrying.
 *
 * @param maxRetries – Maximum number of **retries** (not counting the initial
 *                     attempt). Defaults to `3`.
 * @param backoff    – Base delay in milliseconds for the first retry. Each
 *                     subsequent retry doubles the delay. Defaults to `1000`.
 *
 * @returns A function wrapping `fn` with retry logic.
 *
 * @example
 * ```ts
 * const retryingLoad = createErrorAwareRetry(3, 2000);
 * const skill = await retryingLoad(() => loadSkill('my-skill'));
 * ```
 */
export function createErrorAwareRetry(
  maxRetries: number = 3,
  backoff: number = 1000,
): <T>(fn: () => Promise<T>) => Promise<T> {
  return async function retryLoop<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    let attempt = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        // Non-recoverable errors fail fast.
        if (error instanceof OhMyAgentError && !error.recoverable) {
          throw error;
        }

        if (attempt >= maxRetries) {
          throw lastError;
        }

        // Exponential backoff: baseDelay * 2^attempt
        const delay = backoff * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        attempt++;
      }
    }
  };
}
