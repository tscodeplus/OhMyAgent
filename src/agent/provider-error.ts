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
  if (/404|not found|function .* not found|no such model|unknown model|invalid model|model .* (not|doesn.t) (exist|found)|not supported|unsupported model/i.test(e)) {
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

/** Friendly, channel-safe messages per category, keyed by locale. */
const FRIENDLY_BY_LOCALE: Record<'zh-CN' | 'en', Record<ProviderErrorKind, string>> = {
  'zh-CN': {
    rate_limited: '服务限流，请稍后重试（或检查 API Key / 降低并发）',
    model_not_found: '模型或密钥配置有误：请检查 provider、模型名与 API Key 是否有效',
    auth: '鉴权失败：请检查 API Key 是否有效',
    network: '网络连接异常，请稍后重试',
    unknown: '模型调用失败，请稍后重试或检查配置',
  },
  en: {
    rate_limited: 'Rate limited — please retry later (or check the API key / reduce concurrency)',
    model_not_found: 'Model or API key misconfigured: check the provider, model name, and API key',
    auth: 'Authentication failed: check that the API key is valid',
    network: 'Network error — please retry later',
    unknown: 'Model call failed — please retry later or check the configuration',
  },
};

function currentLocale(): 'zh-CN' | 'en' {
  const loc = (i18n.locale || 'zh-CN').toLowerCase();
  return loc.startsWith('en') ? 'en' : 'zh-CN';
}

/**
 * Build a friendly, channel-safe error message from a raw provider/stream error.
 * Used by non-WebUI channels (Feishu/Telegram/WeChat/QQ) whose reply dispatchers
 * render `error.message` directly. Unlike the WebUI bubble (which keeps the raw
 * error in a collapsible "details" section), channels have no collapse, so the
 * failed model and the raw error are appended as separate lines.
 */
export function formatProviderError(rawError: string, modelRef?: string): string {
  const kind = classifyProviderError(rawError);
  const locale = currentLocale();
  const friendly = FRIENDLY_BY_LOCALE[locale][kind];
  const sep = locale === 'en' ? ': ' : '：';
  const detailLabel = locale === 'en' ? 'Raw error' : '原始错误';
  const lines = [friendly];
  if (modelRef) lines.push(locale === 'en' ? `(${modelRef})` : `（${modelRef}）`);
  lines.push(`${detailLabel}${sep}${rawError}`);
  return lines.join('\n');
}
