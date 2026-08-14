/**
 * Chat media extraction policy — mirror of server-side src/shared/chat-media.ts
 * (ui/ is a separate package). The WebUI renders markdown images found in
 * assistant content / tool call outputs as chat image bubbles; search tools
 * return untrusted snippets full of image links, so only media-emitting tools
 * and locally-served URLs count as chat media.
 */

/** Tool names whose outputs may legitimately embed markdown chat images. */
export const CHAT_MEDIA_TOOL_NAMES = new Set([
  'webui_send_media',
  'send_media',
  'computer_use',
  'feishu_send_media',
  'wechat_send_media',
  'qq_send_media',
  'telegram_send_media',
]);

/** True when a markdown image URL is gateway-served chat media, not an
 *  arbitrary external URL scraped from a web page. */
export function isChatMediaUrl(url: string): boolean {
  return (
    url.startsWith('/api/files/') ||
    url.startsWith('/dl/') ||
    url.startsWith('/desktop-bridge-download') ||
    url.startsWith('data:')
  );
}
