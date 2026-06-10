/**
 * Chinese user-facing error notices for the WeChat channel.
 *
 * Maps common iLink / CDN / fetch error messages to human-readable
 * Chinese strings that can be sent back to the user.
 */

/**
 * Resolve an error to a Chinese user-facing notice string.
 *
 * @param err  The error object to inspect.
 * @returns    A Chinese message suitable for sending to the user.
 */
export function resolveWechatErrorNotice(err: Error): string {
  const message = err?.message ?? String(err);

  // Media download failures
  if (
    /\b(download failed|CDN download|fetch)\b/i.test(message) ||
    /\bdownload\b.*\bfailed\b/i.test(message)
  ) {
    return '⚠️ 媒体文件下载失败，请检查链接是否可访问。';
  }

  // CDN upload failures
  if (
    /\b(getUploadUrl|CDN upload|upload_param)\b/i.test(message)
  ) {
    return '⚠️ 媒体文件上传失败，请稍后重试。';
  }

  // Generic fallback
  const errMsg = message.length > 100 ? message.slice(0, 100) + '...' : message;
  return `⚠️ 消息发送失败：${errMsg}`;
}
