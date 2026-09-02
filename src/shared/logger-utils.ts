/**
 * Logger utilities — Operation tracking, timing, and structured error logging.
 *
 * Provides higher-order functions that wrap pino loggers with additional
 * context for multi-step operation tracing, performance measurement, and
 * error diagnostics.
 *
 * @module logger-utils
 */

import type pino from 'pino';
import { randomUUID } from 'node:crypto';

// ─── Types ───

export interface OperationLoggerOptions {
  /** Human-readable operation name (e.g. "chat:send", "memory:recall") */
  operation: string;
  /** Optional explicit operation ID; auto-generated if omitted */
  operationId?: string;
  /** Arbitrary extra context to bind to every log line */
  extra?: Record<string, unknown>;
}

// ─── createOperationLogger ───

/**
 * Create a child logger bound to a specific operation context.
 *
 * Every log line emitted by the returned logger will carry `operationId`
 * (a UUID v4) and `operation` name, making it possible to correlate all
 * log entries that belong to the same multi-step workflow.
 *
 * @param logger - Parent pino logger instance.
 * @param operation - Short kebab-case or colon-delimited operation name.
 * @param options   - Optional explicit `operationId` and/or `extra` context.
 *
 * @example
 * ```ts
 * const opLog = createOperationLogger(logger, 'memory:recall');
 * opLog.info('starting recall');
 * // => { ..., operation: 'memory:recall', operationId: '...' }
 * ```
 */
export function createOperationLogger(
  logger: pino.Logger,
  operation: string,
  options?: OperationLoggerOptions,
): pino.Logger {
  const operationId = options?.operationId ?? randomUUID();
  const bindings: Record<string, unknown> = {
    operation,
    operationId,
  };
  if (options?.extra) {
    Object.assign(bindings, options.extra);
  }
  return logger.child(bindings);
}

// ─── withTiming ───

export interface TimingResult<T> {
  /** The return value of the wrapped async function. */
  result: T;
  /** Elapsed time in milliseconds (high-resolution). */
  durationMs: number;
  /** High-resolution start time (useful for external diffing). */
  startTime: number;
  /** High-resolution end time. */
  endTime: number;
}

export type TimingLoggerFn = (obj: Record<string, unknown>, msg: string) => void;

/**
 * Wrap an async function with duration logging using `performance.now()`.
 *
 * Returns both the original result and timing metadata. Logs the duration at
 * the `info` level by default; on rejection the error is logged via the
 * supplied `errorLogger` (defaults to `logger.warn`) and re-thrown.
 *
 * @param logger       - Parent pino logger used for timing output.
 * @param label        - Label for the timing log entry (e.g. "LLM call").
 * @param fn           - Async function to wrap and measure.
 * @param errorLogger  - Optional log-level override for failures (default:
 *                       `logger.warn`). Pass `logger.error` to log at error
 *                       severity instead.
 *
 * @example
 * ```ts
 * const { result, durationMs } = await withTiming(logger, 'embed', () =>
 *   embeddingClient.embed(text),
 * );
 * logger.info({ durationMs }, 'embedding done');
 * ```
 */
export async function withTiming<T>(
  logger: pino.Logger,
  label: string,
  fn: () => Promise<T>,
  errorLogger?: TimingLoggerFn,
): Promise<TimingResult<T>> {
  const startTime = performance.now();
  const logFn: TimingLoggerFn = errorLogger ?? ((obj, msg) => logger.warn(obj, msg));

  try {
    const result = await fn();
    const endTime = performance.now();
    const durationMs = endTime - startTime;

    logger.info(
      { label, durationMs, startTime, endTime },
      `${label} completed in ${durationMs.toFixed(2)}ms`,
    );
    return { result, durationMs, startTime, endTime };
  } catch (err) {
    const endTime = performance.now();
    const durationMs = endTime - startTime;

    logFn(
      {
        label,
        durationMs,
        err,
        failed: true,
      },
      `${label} failed after ${durationMs.toFixed(2)}ms`,
    );
    throw err;
  }
}

// ─── logErrorContext ───

export interface ErrorContext {
  /** Arbitrary key-value pairs describing the state at time of error. */
  [key: string]: unknown;
  /** Optional user-facing or internal error code. */
  errorCode?: string;
  /** Optional identifier for the component that raised the error. */
  source?: string;
  /** Optional correlating operation or request ID. */
  requestId?: string;
  /** If true, the stack trace will NOT be included in the log output. */
  sanitize?: boolean;
}

/**
 * Log a structured error record including all available diagnostic context.
 *
 * Extracts `name`, `message`, `stack`, and `cause` from the Error object and
 * merges them with the supplied context map. The result is emitted at the
 * `error` level, consistent with the project's pino error-logging convention
 * (the `err` key is used so pino-pretty renders it).
 *
 * @param logger  - pino logger instance.
 * @param error   - The Error (or unknown value) to log.
 * @param context - Structured context describing the state of the system
 *                  when the error occurred.
 *
 * @example
 * ```ts
 * logErrorContext(logger, err, {
 *   source: 'memory-repository',
 *   requestId: session.id,
 *   query: sanitizedQuery,
 * });
 * ```
 */
export function logErrorContext(
  logger: pino.Logger,
  error: unknown,
  context: ErrorContext = {},
): void {
  const { sanitize, ...userContext } = context;

  const base: Record<string, unknown> = {
    ...userContext,
  };

  if (error instanceof Error) {
    base.err = {
      name: error.name,
      message: error.message,
      ...(sanitize ? {} : { stack: error.stack }),
      ...(error.cause ? { cause: String(error.cause) } : {}),
    };
  } else {
    base.err = {
      name: 'NonErrorThrow',
      message: String(error),
    };
  }

  logger.error(
    base,
    `[${context.source ?? 'unknown'}] ${error instanceof Error ? error.message : String(error)}`,
  );
}
