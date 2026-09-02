/**
 * Unified error hierarchy for OhMyAgent.
 *
 * All application errors extend the base {@link OhMyAgentError} class which carries
 * a machine-readable `code`, the original `cause`, and a `recoverable` flag to
 * guide retry / fail-fast decisions.
 *
 * Existing error classes (AppError, ToolError, …) are retained as subclasses of
 * OhMyAgentError for backward compatibility.
 */

// ── Base ────────────────────────────────────────────────────────────────────

/**
 * Base class for all OhMyAgent errors.
 *
 * @property code        – Machine-readable error code (e.g. `'SKILL_LOAD_ERROR'`).
 * @property cause       – The original thrown value, if any.
 * @property recoverable – Whether the operation can reasonably be retried.
 */
export class OhMyAgentError extends Error {
  public readonly code: string;
  public readonly recoverable: boolean;
  public override readonly cause: unknown;

  constructor(message: string, code: string, recoverable: boolean, cause?: unknown) {
    super(message, { cause });
    this.name = 'OhMyAgentError';
    this.code = code;
    this.recoverable = recoverable;
    this.cause = cause;
  }
}

// ── New error types (recoverable: true) ─────────────────────────────────────

/** Skill loading/parsing failure — retryable. */
export class SkillLoadError extends OhMyAgentError {
  constructor(message: string, cause?: unknown) {
    super(message, 'SKILL_LOAD_ERROR', true, cause);
    this.name = 'SkillLoadError';
  }
}

/** Embedding API call failure — retryable. */
export class EmbeddingError extends OhMyAgentError {
  constructor(message: string, cause?: unknown) {
    super(message, 'EMBEDDING_ERROR', true, cause);
    this.name = 'EmbeddingError';
  }
}

/** LLM provider call failure — retryable. */
export class LLMCallError extends OhMyAgentError {
  constructor(message: string, cause?: unknown) {
    super(message, 'LLM_CALL_ERROR', true, cause);
    this.name = 'LLMCallError';
  }
}

// ── Legacy error types (backward compatibility) ────────────────────────────

/**
 * Generic application error.
 *
 * Retained for existing code that depends on the `statusCode` property.
 * New code SHOULD prefer one of the more specific OhMyAgentError subclasses.
 */
export class AppError extends OhMyAgentError {
  public readonly statusCode: number;

  constructor(message: string, code: string, statusCode: number = 500, cause?: unknown) {
    super(message, code, false, cause);
    this.name = 'AppError';
    this.statusCode = statusCode;
  }
}

/** Tool execution error. */
export class ToolError extends AppError {
  constructor(message: string, code: string = 'TOOL_ERROR', cause?: unknown) {
    super(message, code, 500, cause);
    this.name = 'ToolError';
  }
}

/** Tool execution timed out. */
export class ToolTimeoutError extends ToolError {
  constructor(toolName: string, timeoutMs: number) {
    super(`Tool "${toolName}" timed out after ${timeoutMs}ms`, 'TOOL_TIMEOUT');
    this.name = 'ToolTimeoutError';
  }
}

/** Feishu (Lark) API error. */
export class FeishuError extends AppError {
  constructor(message: string, code: string = 'FEISHU_ERROR', cause?: unknown) {
    super(message, code, 502, cause);
    this.name = 'FeishuError';
  }
}

/** Memory system error. */
export class MemoryError extends AppError {
  constructor(message: string, code: string = 'MEMORY_ERROR', cause?: unknown) {
    super(message, code, 500, cause);
    this.name = 'MemoryError';
  }
}

// ── New error types (recoverable: false) ────────────────────────────────────

/** Configuration validation / loading failure — fatal. */
export class ConfigError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'CONFIG_ERROR', 500, cause);
    this.name = 'ConfigError';
  }
}

/** Database / storage failure — fatal. */
export class DatabaseError extends OhMyAgentError {
  constructor(message: string, cause?: unknown) {
    super(message, 'DATABASE_ERROR', false, cause);
    this.name = 'DatabaseError';
  }
}
