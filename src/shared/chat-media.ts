/**
 * Chat media extraction policy.
 *
 * The WebUI surfaces markdown images found in assistant content and in tool
 * call outputs as chat image bubbles. Search/web tools return untrusted page
 * snippets that frequently contain image markdown (e.g. `![...](https://…)`
 * inside v2ex thread content); treating every such link as a "sent image"
 * floods the chat with images after a web_search / web_fetch / tool_search
 * turn.
 *
 * Only tools whose outputs are produced by the gateway itself embed real
 * chat media (webui_send_media, computer_use send_screenshot, channel media
 * tools), and only locally-served URLs (or data: URIs) count as chat media.
 */

/** Tool names whose outputs may legitimately embed markdown chat images. */
export const CHAT_MEDIA_TOOL_NAMES: ReadonlySet<string> = new Set([
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
