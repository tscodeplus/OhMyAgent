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

/**
 * Error-message patterns indicating a missing dependency / precondition
 * (file not found, command not found, device unavailable, …).
 */
const DEPENDENCY_ERROR_PATTERNS = [
  /not found/i,
  /no such file/i,
  /command not found/i,
  /enoent/i,
  /does not exist/i,
  /找不到/i,
  /不存在/i,
  /未找到/i,
  /无法找到/i,
];

// ---------------------------------------------------------------------------
// Threshold defaults (used when config does not supply explicit values)
// ---------------------------------------------------------------------------

const DEFAULT_MIN_IDENTICAL_RETRIES = 3;
const DEFAULT_MIN_CONSECUTIVE_ERRORS = 3;
const DEFAULT_MIN_EXPLORATION_STEPS = 8;
const DEFAULT_MIN_DEPENDENCY_ERRORS = 2;

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
 * Serialise a tool call's identity for retry counting — the tool name plus
 * its arguments, so that *different* invocations of the same tool do not
 * count as repeated failures of the same command.
 */
function callIdentity(call: ToolCallRecord): string {
  let argsKey: string;
  try {
    argsKey = JSON.stringify(call.args ?? {});
  } catch {
    argsKey = String(call.args);
  }
  return `${call.name}\u0000${argsKey}`;
}

/**
 * Count how many times the single most-retried *identical* command
 * (same tool name + same args) failed across the entire session.
 */
function countIdenticalFailedCommands(toolCalls: ToolCallRecord[]): number {
  const counts = new Map<string, number>();
  for (const call of toolCalls) {
    if (call.isError) {
      const key = callIdentity(call);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let max = 0;
  for (const count of counts.values()) {
    if (count > max) max = count;
  }
  return max;
}

/**
 * Return the length of the longest run of *consecutive* failed tool calls
 * in the session (interleaved successful calls break the run).
 */
function maxConsecutiveErrors(toolCalls: ToolCallRecord[]): number {
  let longest = 0;
  let current = 0;
  for (const call of toolCalls) {
    if (call.isError) {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

/**
 * Return the length of the longest run of *consecutive* exploration
 * (read-only) tool calls in the session.
 */
function maxConsecutiveExploration(toolCalls: ToolCallRecord[]): number {
  let longest = 0;
  let current = 0;
  for (const call of toolCalls) {
    if (isExploreTool(call.name)) {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

/** Count how many tool calls in the session are classified as change tools. */
function countChangeTools(toolCalls: ToolCallRecord[]): number {
  let count = 0;
  for (const call of toolCalls) {
    if (isChangeTool(call.name)) count++;
  }
  return count;
}

/**
 * Whether a failure matches the "missing dependency / precondition" pattern,
 * i.e. its error message indicates something was not found / not available.
 */
function isDependencyError(message: string): boolean {
  return DEPENDENCY_ERROR_PATTERNS.some((re) => re.test(message));
}

/**
 * Count how many consecutive failed tool calls (in the errors list, which is
 * in occurrence order) have dependency-style error messages, ending at the
 * last error of the session.
 */
function countConsecutiveDependencyErrors(
  errors: Array<{ toolName: string; message: string; timestamp: number }>,
): number {
  let count = 0;
  for (let i = errors.length - 1; i >= 0; i--) {
    if (isDependencyError(errors[i]!.message)) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// FailureDetector class
// ---------------------------------------------------------------------------

export class FailureDetector {
  private config: Partial<HarnessTriggerConfig>;

  constructor(config: Partial<HarnessTriggerConfig> = {}) {
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

    const minIdenticalRetries = this.config.minIdenticalRetries ?? DEFAULT_MIN_IDENTICAL_RETRIES;
    const minConsecutiveErrors = this.config.minConsecutiveErrors ?? DEFAULT_MIN_CONSECUTIVE_ERRORS;
    const minExplorationSteps = this.config.minExplorationSteps ?? DEFAULT_MIN_EXPLORATION_STEPS;
    const minDependencyErrors = this.config.minDependencyErrors ?? DEFAULT_MIN_DEPENDENCY_ERRORS;

    // ── 1. identical_retry_loop ────────────────────────────────────────
    // Same command (name + args) failed repeatedly.
    const identicalRetries = countIdenticalFailedCommands(context.toolCalls);
    if (identicalRetries >= minIdenticalRetries) {
      return this.buildSignal('identical_retry_loop', 'high', {
        count: identicalRetries,
        threshold: minIdenticalRetries,
      });
    }

    // ── 2. dependency_not_checked ──────────────────────────────────────
    // Consecutive failures with "not found" style errors — the agent did not
    // verify a precondition before acting.
    const dependencyErrors = countConsecutiveDependencyErrors(context.errors);
    if (dependencyErrors >= minDependencyErrors) {
      return this.buildSignal('dependency_not_checked', 'medium', {
        count: dependencyErrors,
        threshold: minDependencyErrors,
      });
    }

    // ── 3. tool_error_cascade ──────────────────────────────────────────
    // Consecutive failed tool calls (any cause) back to back.
    const consecutiveErrors = maxConsecutiveErrors(context.toolCalls);
    if (consecutiveErrors >= minConsecutiveErrors) {
      return this.buildSignal('tool_error_cascade', 'high', {
        count: consecutiveErrors,
        threshold: minConsecutiveErrors,
      });
    }

    // ── 4. user_explicit_dissatisfied ──────────────────────────────────
    if (context.userFeedback === 'dissatisfied') {
      return this.buildSignal('user_explicit_dissatisfied', 'high');
    }

    // ── 5. exploration_without_output ──────────────────────────────────
    // Long run of consecutive read-only steps and no change tools at all.
    const exploreCount = maxConsecutiveExploration(context.toolCalls);
    const changeCount = countChangeTools(context.toolCalls);
    if (exploreCount >= minExplorationSteps && changeCount === 0) {
      return this.buildSignal('exploration_without_output', 'medium', {
        exploreCount,
        threshold: minExplorationSteps,
      });
    }

    // ── 6. timeout_or_abort ────────────────────────────────────────────
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
  private formatReason(pattern: FailurePattern, details?: Record<string, unknown>): string {
    switch (pattern) {
      case 'identical_retry_loop':
        return i18n.t('harness:failure.identicalRetryLoop', {
          count: details!.count as number,
          threshold: details!.threshold as number,
        });
      case 'dependency_not_checked':
        return i18n.t('harness:failure.dependencyNotChecked', {
          count: details!.count as number,
          threshold: details!.threshold as number,
        });
      case 'tool_error_cascade':
        return i18n.t('harness:failure.toolErrorCascade', {
          count: details!.count as number,
          threshold: details!.threshold as number,
        });
      case 'user_explicit_dissatisfied':
        return i18n.t('harness:failure.userDissatisfied');
      case 'exploration_without_output':
        return i18n.t('harness:failure.explorationWithoutOutput', {
          count: details!.exploreCount as number,
          threshold: details!.threshold as number,
        });
      case 'timeout_or_abort':
        return i18n.t('harness:failure.timeoutOrAbort');
      default:
        return i18n.t('harness:failure.detected', { pattern });
    }
  }
}
