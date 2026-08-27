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

import { i18n } from '../i18n/index.js';

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
 *
 * Order matters:
 *  1. rate limiting (most specific numeric/textual signal)
 *  2. explicit MODEL wording — deliberately BEFORE auth, because OpenAI-compatible
 *     gateways (e.g. opencodezen) reject unavailable models with a 401 status and
 *     a body like "Model ... is not supported"; pi-mono composes those into
 *     messages like "401: Model X is not supported" and surfacing "check your
 *     API key" for them would mislead users
 *  3. plain credentials failures without any model mention → auth
 *  4. generic 404 / "not found" once no stronger signal matched
 *  5. network, then unknown
 */
export function classifyProviderError(rawError: string): ProviderErrorKind {
  const e = rawError?.toLowerCase() ?? '';
  if (/429|rate[_\s-]?limit|too many requests|529|quota|capacity|overload|busy|slow down/i.test(e)) {
    return 'rate_limited';
  }
  if (/no such model|unknown model|invalid model|model .* (not|doesn.t) (exist|found)|not supported|unsupported model/i.test(e)) {
    return 'model_not_found';
  }
  if (/401|403|unauthor|forbidden|invalid api[_\s-]?key|api[_\s-]?key|authentication|not authenticated/i.test(e)) {
    return 'auth';
  }
  if (/404|not found|function .* not found/i.test(e)) {
    return 'model_not_found';
  }
  if (/econnreset|etimedout|timeout|network|enotfound|socket|connection|dns|502|503|504|bad gateway|service unavailable|gateway/i.test(e)) {
    return 'network';
  }
  return 'unknown';
}

/**
 * Prefix a bare model id with its provider slug to form the fully qualified ref
 * used in logs and user-facing error details (e.g. provider="openai",
 * model="gpt-4o" → "openai/gpt-4o"). Already-qualified refs pass through;
 * a missing model yields undefined.
 */
export function qualifyModelRef(
  provider?: string | null,
  model?: string | null,
): string | undefined {
  if (!model) return undefined;
  return provider && !model.startsWith(`${provider}/`) ? `${provider}/${model}` : model;
}

/** Build a structured error object from a raw provider error + the failed model ref. */
export function toChatError(rawError: string, modelRef?: string): ChatProviderError {
  return {
    kind: classifyProviderError(rawError),
    rawError,
    failedModels: modelRef ? [modelRef] : undefined,
  };
}

/** i18n namespace holding the friendly per-category strings (src/locales/*). */
const PROVIDER_ERRORS_NS = 'provider-errors';

/**
 * Build a friendly, channel-safe error message from a raw provider/stream error.
 * Used by non-WebUI channels (Feishu/Telegram/WeChat/QQ) whose reply dispatchers
 * render `error.message` directly. Unlike the WebUI bubble (which keeps the raw
 * error in a collapsible "details" section), channels have no collapse, so the
 * failed model and the raw error are appended as separate lines.
 *
 * Strings live in the `provider-errors` namespace so they follow the configured
 * server locale like all other channel text. Named distinctly from pi-mono's
 * unrelated formatProviderError() in ai/utils/error-body.ts.
 */
export function buildFriendlyErrorMessage(rawError: string, modelRef?: string): string {
  const kind = classifyProviderError(rawError);
  const lines = [i18n.t(`${PROVIDER_ERRORS_NS}:${kind}`)];
  if (modelRef) lines.push(i18n.t(`${PROVIDER_ERRORS_NS}:model_ref`, { model: modelRef }));
  lines.push(`${i18n.t(`${PROVIDER_ERRORS_NS}:raw_error_label`)}${rawError}`);
  return lines.join('\n');
}
