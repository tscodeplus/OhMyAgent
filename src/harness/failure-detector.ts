// ---------------------------------------------------------------------------
// Self-Harness System — Failure Detector
// ---------------------------------------------------------------------------
// Scans a FailureContext for known failure patterns and returns the first
// matching signal.  Checks are ordered from most severe / conclusive to
// least; the first match is returned.
// ---------------------------------------------------------------------------

import {
  FailureContext,
  FailureSignal,
  FailurePattern,
  ToolCallRecord,
  HarnessTriggerConfig,
} from './types.js';
import { i18n } from '../i18n/i18n-service.js';

// ---------------------------------------------------------------------------
// Tool classification constants
// ---------------------------------------------------------------------------

const EXPLORE_TOOLS = new Set([
  'file_read',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'ls',
  'find',
  'codegraph_explore',
  'codegraph_search',
  'codegraph_callers',
  'codegraph_callees',
  'codegraph_context',
  'codegraph_node',
  'codegraph_files',
  'codegraph_status',
  'codegraph_impact',
  'cat',
  'head',
  'tail',
]);

const CHANGE_TOOLS = new Set([
  'file_write',
  'write',
  'edit',
  'file_delete',
  'rm',
  'shell',
  'bash',
  'exec',
  'file_create',
]);

// ---------------------------------------------------------------------------
// Threshold defaults (used when config does not supply explicit values)
// ---------------------------------------------------------------------------

const DEFAULT_MIN_IDENTICAL_RETRIES = 3;
const DEFAULT_MIN_CONSECUTIVE_ERRORS = 3;
const DEFAULT_MIN_EXPLORATION_STEPS = 5;

// ---------------------------------------------------------------------------
// Helper functions  (module-level, pure)
// ---------------------------------------------------------------------------

function isExploreTool(name: string): boolean {
  return EXPLORE_TOOLS.has(name);
}

function isChangeTool(name: string): boolean {
  return CHANGE_TOOLS.has(name);
}

/**
 * Count how many times the single most-retried tool name was called with
 * isError === true across the entire session.
 */
function countIdenticalFailedCommands(
  toolCalls: ToolCallRecord[],
  _errors: Array<{ toolName: string; message: string; timestamp: number }>,
): number {
  const counts = new Map<string, number>();
  for (const call of toolCalls) {
    if (call.isError) {
      counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
    }
  }
  let max = 0;
  for (const count of counts.values()) {
    if (count > max) max = count;
  }
  return max;
}

/**
 * Return the number of entries in the flat errors list.
 *
 * Because the errors array is extracted from tool calls in occurrence
 * order, every entry represents one failed tool call.  The returned
 * value is the total error count for the session.
 */
function maxConsecutiveErrors(
  errors: Array<{ toolName: string; message: string; timestamp: number }>,
): number {
  return errors.length;
}

/**
 * Count how many tool calls in the session are classified as exploration
 * (read-only) tools.
 */
function countConsecutiveExploration(toolCalls: ToolCallRecord[]): number {
  let count = 0;
  for (const call of toolCalls) {
    if (isExploreTool(call.name)) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// FailureDetector class
// ---------------------------------------------------------------------------

export class FailureDetector {
  private config: HarnessTriggerConfig;

  constructor(config: HarnessTriggerConfig) {
    this.config = config;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Run every check in priority order against `context` and return the
   * first matching signal, or `null` if no pattern is detected.
   */
  detect(context: FailureContext): FailureSignal | null {
    // ── Guard: nothing to analyse ──────────────────────────────────────
    if (context.toolCalls.length === 0) return null;

    // ── Guard: user is satisfied → no failure ──────────────────────────
    if (context.userFeedback === 'satisfied') return null;

    // ── 1. identical_retry_loop ────────────────────────────────────────
    const minIdenticalRetries: number =
      (this.config as unknown as Record<string, unknown>).minIdenticalRetries as number ??
      DEFAULT_MIN_IDENTICAL_RETRIES;

    const identicalRetries = countIdenticalFailedCommands(
      context.toolCalls,
      context.errors,
    );
    if (identicalRetries >= minIdenticalRetries) {
      return this.buildSignal('identical_retry_loop', 'high', {
        count: identicalRetries,
        threshold: minIdenticalRetries,
      });
    }

    // ── 2. tool_error_cascade ──────────────────────────────────────────
    const minConsecutiveErrors: number =
      (this.config as unknown as Record<string, unknown>).minConsecutiveErrors as number ??
      DEFAULT_MIN_CONSECUTIVE_ERRORS;

    const consecutiveErrors = maxConsecutiveErrors(context.errors);
    if (consecutiveErrors >= minConsecutiveErrors) {
      return this.buildSignal('tool_error_cascade', 'high', {
        count: consecutiveErrors,
        threshold: minConsecutiveErrors,
      });
    }

    // ── 3. user_explicit_dissatisfied ──────────────────────────────────
    if (context.userFeedback === 'dissatisfied') {
      return this.buildSignal('user_explicit_dissatisfied', 'high');
    }

    // ── 4. exploration_without_output ──────────────────────────────────
    const minExplorationSteps: number =
      (this.config as unknown as Record<string, unknown>).minExplorationSteps as number ??
      DEFAULT_MIN_EXPLORATION_STEPS;

    const exploreCount = countConsecutiveExploration(context.toolCalls);
    let changeCount = 0;
    for (const call of context.toolCalls) {
      if (isChangeTool(call.name)) changeCount++;
    }

    if (exploreCount >= minExplorationSteps && changeCount === 0) {
      return this.buildSignal('exploration_without_output', 'medium', {
        exploreCount,
        threshold: minExplorationSteps,
      });
    }

    // ── 5. timeout_or_abort ────────────────────────────────────────────
    if (context.terminatedEarly) {
      return this.buildSignal('timeout_or_abort', 'medium');
    }

    // ── No pattern matched ─────────────────────────────────────────────
    return null;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Build a FailureSignal for the given pattern and severity, with a
   * human-readable reason string.
   */
  private buildSignal(
    pattern: FailurePattern,
    severity: 'low' | 'medium' | 'high',
    details?: Record<string, unknown>,
  ): FailureSignal {
    const reason = this.formatReason(pattern, details);
    return { detected: true, reason, severity, pattern };
  }

  /**
   * Format a human-readable reason string for the given pattern.
   */
  private formatReason(
    pattern: FailurePattern,
    details?: Record<string, unknown>,
  ): string {
    switch (pattern) {
      case 'identical_retry_loop':
        return i18n.t('harness:failure.identicalRetryLoop', { count: details!.count as number, threshold: details!.threshold as number });
      case 'tool_error_cascade':
        return i18n.t('harness:failure.toolErrorCascade', { count: details!.count as number, threshold: details!.threshold as number });
      case 'user_explicit_dissatisfied':
        return i18n.t('harness:failure.userDissatisfied');
      case 'exploration_without_output':
        return i18n.t('harness:failure.explorationWithoutOutput', { count: details!.exploreCount as number, threshold: details!.threshold as number });
      case 'timeout_or_abort':
        return i18n.t('harness:failure.timeoutOrAbort');
      default:
        return i18n.t('harness:failure.detected', { pattern });
    }
  }
}
