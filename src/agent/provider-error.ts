/**
 * Provider error classification for friendly WebUI surfacing.
 *
 * Raw provider errors like "404 status code (no body)" or "429 Too Many
 * Requests" are opaque to users. This module maps them to a small set of
 * actionable categories so the UI can show guidance ("check model config",
 * "retry later") instead of a raw status string.
 *
 * Design (see chat feedback): surface an error ONLY when the whole turn
 * failed (retry + fallback exhausted). When a fallback model recovered, the
 * raw error stays in server logs but is NOT shown to the user.
 */

export type ProviderErrorKind =
  | 'rate_limited'
  | 'model_not_found'
  | 'auth'
  | 'network'
  | 'unknown';

export interface ChatProviderError {
  kind: ProviderErrorKind;
  /** Raw provider error, e.g. "404 status code (no body)" — shown in a collapsible detail. */
  rawError: string;
  /** Models attempted before failure, e.g. ["nvidia/moonshotai/kimi-k2.6"]. */
  failedModels?: string[];
}

/**
 * Classify a raw provider/stream error string into an actionable category.
 * Order matters: rate-limit / auth are checked before the broader 404/network
 * patterns so e.g. "401 invalid api key" is not misclassified as model_not_found.
 */
export function classifyProviderError(rawError: string): ProviderErrorKind {
  const e = rawError?.toLowerCase() ?? '';
  if (/429|rate[_\s-]?limit|too many requests|529|quota|capacity|overload|busy|slow down/i.test(e)) {
    return 'rate_limited';
  }
  if (/401|403|unauthor|forbidden|invalid api[_\s-]?key|api[_\s-]?key|authentication|not authenticated/i.test(e)) {
    return 'auth';
  }
  if (/404|not found|function .* not found|no such model|unknown model|invalid model|model .* (not|doesn.t) (exist|found)/i.test(e)) {
    return 'model_not_found';
  }
  if (/econnreset|etimedout|timeout|network|enotfound|socket|connection|dns|502|503|504|bad gateway|service unavailable|gateway/i.test(e)) {
    return 'network';
  }
  return 'unknown';
}

/** Build a structured error object from a raw provider error + the failed model ref. */
export function toChatError(rawError: string, modelRef?: string): ChatProviderError {
  return {
    kind: classifyProviderError(rawError),
    rawError,
    failedModels: modelRef ? [modelRef] : undefined,
  };
}
