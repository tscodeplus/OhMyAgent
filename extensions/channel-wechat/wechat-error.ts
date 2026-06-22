import { i18n } from '../../src/i18n/index.js';

/**
 * User-facing error notices for the WeChat channel.
 */

/**
 * Resolve an error to a user-facing notice string.
 */
export function resolveWechatErrorNotice(err: Error): string {
  const message = err?.message ?? String(err);

  // Media download failures
  if (
    /\b(download failed|CDN download|fetch)\b/i.test(message) ||
    /\bdownload\b.*\bfailed\b/i.test(message)
  ) {
    return i18n.t('messages:media.downloadFailed');
  }

  // CDN upload failures
  if (
    /\b(getUploadUrl|CDN upload|upload_param)\b/i.test(message)
  ) {
    return i18n.t('messages:media.uploadFailed');
  }

  // Generic fallback
  const errMsg = message.length > 100 ? message.slice(0, 100) + '...' : message;
  return `⚠️ ${errMsg}`;
}
