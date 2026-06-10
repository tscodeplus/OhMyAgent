/**
 * Send messages to Telegram via the Bot API.
 *
 * Supports: chunked text with HTML parse mode and plain-text fallback,
 * card-to-text conversion, and media sending (photo, document, audio, video).
 */

import type { MediaResource, ReplyContent, CardData } from '../../src/channel/types.js';
import { markdownToHtml } from './markdown-to-html.js';
import type { TelegramConfig } from './telegram-types.js';

// ---------------------------------------------------------------------------
// Abstractions
// ---------------------------------------------------------------------------

/**
 * Minimal interface for the grammY Bot API methods used by this module.
 * The `bot.api` object passed from the caller satisfies this interface.
 */
interface BotApi {
  sendMessage(
    chatId: number,
    text: string,
    opts?: Record<string, unknown>,
  ): Promise<{ message_id: number }>;
  sendPhoto(
    chatId: number,
    photo: string,
    opts?: Record<string, unknown>,
  ): Promise<{ message_id: number }>;
  sendDocument(
    chatId: number,
    document: string,
    opts?: Record<string, unknown>,
  ): Promise<{ message_id: number }>;
  sendAudio(
    chatId: number,
    audio: string,
    opts?: Record<string, unknown>,
  ): Promise<{ message_id: number }>;
  sendVideo(
    chatId: number,
    video: string,
    opts?: Record<string, unknown>,
  ): Promise<{ message_id: number }>;
}

/** Non-void HTML elements that can be opened/closed and must be tracked. */
const CONTAINER_TAGS = new Set([
  'b', 'i', 'u', 's', 'code', 'pre', 'a',
  'em', 'strong', 'span', 'tg-spoiler', 'blockquote',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a reply to a Telegram chat.
 *
 * Handles text (chunked with HTML formatting), card-to-text conversion,
 * and media attachments. Returns the message IDs of all text/card messages
 * sent (media IDs are not tracked by this function).
 */
export async function sendReply(
  api: BotApi,
  chatId: number,
  reply: ReplyContent,
  config: { textLimit: number },
): Promise<number[]> {
  const ids: number[] = [];

  // Text content — convert Markdown to HTML, then send in chunks
  if (reply.text) {
    const html = markdownToHtml(reply.text);
    ids.push(...(await sendChunkedText(api, chatId, html, config.textLimit)));
  }

  // Cards — convert each card to a text representation and send as HTML
  if (reply.cards) {
    for (const card of reply.cards) {
      ids.push(...(await sendChunkedText(api, chatId, renderCardAsText(card), config.textLimit)));
    }
  }

  // Media — send each resource via the appropriate Bot API method
  if (reply.media && reply.media.length > 0) {
    await sendMedia(api, chatId, reply.media);
  }

  return ids;
}

/**
 * Split long text into chunks at `textLimit` (Telegram: 4096) and send each
 * chunk with HTML parse_mode. If HTML parsing fails, retry as plain text.
 * Returns message IDs of successfully sent chunks.
 */
export async function sendChunkedText(
  api: BotApi,
  chatId: number,
  text: string,
  textLimit: number,
): Promise<number[]> {
  const chunks = splitHtmlText(text, textLimit);
  const ids: number[] = [];

  for (const chunk of chunks) {
    try {
      const msg = await api.sendMessage(chatId, chunk, { parse_mode: 'HTML' });
      ids.push(msg.message_id);
    } catch {
      // HTML parsing failed — retry as plain text
      try {
        const msg = await api.sendMessage(chatId, chunk);
        ids.push(msg.message_id);
      } catch {
        // Silently skip chunks that fail both attempts so a single bad
        // chunk does not prevent subsequent chunks from being delivered.
      }
    }
  }

  return ids;
}

/**
 * Send media resources (photo, document, audio, video) to a Telegram chat.
 * Errors during individual sends are silently skipped.
 */
export async function sendMedia(
  api: BotApi,
  chatId: number,
  media: MediaResource[],
): Promise<void> {
  for (const resource of media) {
    try {
      await sendSingleMedia(api, chatId, resource);
    } catch {
      // Skip failed media item
    }
  }
}

// ---------------------------------------------------------------------------
// HTML-Aware Text Splitting
// ---------------------------------------------------------------------------

/**
 * Split HTML text at `limit` characters, preserving HTML tag integrity.
 *
 * Tracks open tags on a stack. When a split occurs, all currently open tags
 * are closed at the end of the chunk (suffix) and reopened at the start of
 * the next chunk (prefix). Prefers paragraph, line, and word boundaries
 * near the split point. Never splits inside an HTML tag.
 */
export function splitHtmlText(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let splitAt = limit;

    // Prefer splitting at natural boundaries near the limit (last 20%)
    const searchStart = Math.floor(limit * 0.8);
    const paraBreak = remaining.lastIndexOf('\n\n', limit);
    const lineBreak = remaining.lastIndexOf('\n', limit);
    const space = remaining.lastIndexOf(' ', limit);

    if (paraBreak > searchStart) {
      // Split BEFORE the paragraph break so neither chunk keeps partial \n\n
      splitAt = paraBreak;
    } else if (lineBreak > searchStart) {
      splitAt = lineBreak;
    } else if (space > searchStart) {
      splitAt = space;
    }

    // Ensure we are not splitting inside an HTML tag.
    // If the last '<' before splitAt has no matching '>', we are inside a tag.
    const segment = remaining.slice(0, splitAt);
    const lastLt = segment.lastIndexOf('<');
    const lastGt = segment.lastIndexOf('>');
    if (lastLt > lastGt) {
      splitAt = lastLt;
    }

    // Build the current chunk
    let chunk = remaining.slice(0, splitAt);
    const openTags = getOpenTags(chunk);

    // Close all tags that are open at the split point
    for (let i = openTags.length - 1; i >= 0; i--) {
      chunk += `</${openTags[i]}>`;
    }
    chunks.push(chunk);

    // Advance past the split point
    remaining = remaining.slice(splitAt).trimStart();

    // Reopen tags at the start of the next chunk
    if (openTags.length > 0) {
      remaining = openTags.map((t) => `<${t}>`).join('') + remaining;
    }
  }

  // Final chunk (fits within limit)
  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [text];
}

/**
 * Scan text character by character and return all HTML tag names that are
 * opened but not yet closed. Void/self-closing elements are excluded.
 */
function getOpenTags(text: string): string[] {
  const stack: string[] = [];
  let i = 0;

  while (i < text.length) {
    // Look for the next '<'
    const lt = text.indexOf('<', i);
    if (lt === -1) break;

    const gt = text.indexOf('>', lt);
    if (gt === -1) break; // Malformed — no matching '>'

    const inner = text.slice(lt + 1, gt);

    if (inner.startsWith('/')) {
      // Closing tag: </tagname>
      const name = inner.slice(1).split(/\s/)[0]!.toLowerCase();
      const idx = stack.lastIndexOf(name);
      if (idx !== -1) {
        stack.splice(idx, 1);
      }
    } else if (!inner.endsWith('/')) {
      // Opening tag: <tagname ...>  (not self-closing)
      const name = inner.split(/\s/)[0]!.toLowerCase();
      if (CONTAINER_TAGS.has(name)) {
        stack.push(name);
      }
    }
    // Self-closing tags (<br/>, <hr/>, <img/>) are ignored — they do not
    // participate in the open/close pairing.

    i = gt + 1;
  }

  return stack;
}

// ---------------------------------------------------------------------------
// Card-to-Text Conversion
// ---------------------------------------------------------------------------

/**
 * Convert a Feishu CardData structure to a Telegram HTML text representation.
 *
 * Extracts text from the card's header, body, and elements recursively,
 * producing a concise HTML string suitable for sendMessage.
 */
function renderCardAsText(card: CardData): string {
  const parts: string[] = [];

  // Header title
  if (card.header) {
    const title = extractContent(card.header);
    if (title) {
      parts.push(`<b>${escapeHtml(title)}</b>`);
    }
  }

  // Body content
  if (card.body) {
    const bodyText = extractContent(card.body);
    if (bodyText) {
      parts.push(escapeHtml(bodyText));
    }
  }

  // Elements
  if (card.elements) {
    for (const el of card.elements) {
      const text = extractContent(el);
      if (text) {
        parts.push(escapeHtml(text));
      }
    }
  }

  return parts.join('\n') || 'Card';
}

/**
 * Walk a CardKit 2.0 object tree and return the first text content found.
 *
 * Handles these common Feishu card structures:
 *   { "content": "..." }                             — plain_text / lark_md
 *   { "title": { "tag": "plain_text", "content": "..." } }
 *   { "text": { "tag": "lark_md", "content": "..." } }
 *   { "elements": [ { "text": { ... } }, ... ] }
 */
function extractContent(obj: unknown): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;

  const o = obj as Record<string, unknown>;

  // Direct content string (the most common carrier in CardKit blocks)
  if (typeof o.content === 'string' && o.content.length > 0) {
    return o.content;
  }

  // Direct text string (some element structures use this instead)
  if (typeof o.text === 'string' && o.text.length > 0) {
    return o.text;
  }

  // Recurse into known container keys
  for (const key of ['title', 'text', 'fields', 'elements', 'columns', 'column']) {
    const val = o[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        const result = extractContent(item);
        if (result) return result;
      }
    } else if (val && typeof val === 'object') {
      const result = extractContent(val);
      if (result) return result;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send a single media resource via the appropriate Telegram Bot API method.
 */
async function sendSingleMedia(
  api: BotApi,
  chatId: number,
  media: MediaResource,
): Promise<{ message_id: number } | null> {
  switch (media.type) {
    case 'image':
      return api.sendPhoto(chatId, media.url);
    case 'audio':
      return api.sendAudio(chatId, media.url);
    case 'video':
      return api.sendVideo(chatId, media.url);
    default:
      // 'file' and any unknown type fall through to sendDocument
      return api.sendDocument(chatId, media.url);
  }
}

/**
 * Escape HTML special characters for safe inclusion in Telegram HTML messages.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
