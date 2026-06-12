// ---------------------------------------------------------------------------
// Send messages to QQ via the Bot API v2 REST interface.
//
// QQ Bot API supports native markdown rendering for bot messages (msg_type: 2).
// No HTML conversion is needed — the content is sent as-is with a plain text
// fallback in the `content` field.
//
// REST endpoints:
//   POST /v2/users/{openid}/messages  — private messages
//   POST /v2/groups/{group_openid}/messages  — group messages
// ---------------------------------------------------------------------------

import type { MediaResource, ReplyContent, CardData } from '../../src/channel/types.js';
import type { QQGateway } from './qq-gateway.js';
import type { QQConfig, QQKeyboard } from './qq-types.js';
import { INLINE_MEDIA_REGEX } from './qq-types.js';
import { buildApprovalKeyboard, parseApprovalCallback } from './qq-keyboard.js';
import { i18n } from '../../src/i18n/index.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a reply to a QQ chat via the REST API.
 *
 * Handles text (split at textLimit, sent as markdown), card-to-text
 * conversion, and media attachments.
 */
export async function sendReply(
  gateway: QQGateway,
  reply: ReplyContent,
  target: { openid?: string; groupOpenid?: string },
  config: QQConfig,
): Promise<void> {
  // Text content — send as markdown
  if (reply.text) {
    await sendChunkedText(gateway, reply.text, target, config.textLimit);
  }

  // Cards — convert each card to a text representation
  if (reply.cards) {
    for (const card of reply.cards) {
      const cardText = renderCardAsText(card);
      if (cardText) {
        await sendChunkedText(gateway, cardText, target, config.textLimit);
      }
    }
  }

  // Media — send each resource (images, files)
  if (reply.media && reply.media.length > 0) {
    await sendMedia(gateway, reply.media, target);
  }
}

/**
 * Split text around inline media tags (<qqimg>, <qqvoice>, <qqvideo>, <qqfile>),
 * returning an ordered array of text and media items.
 *
 * Example:
 *   "Hello <qqimg>https://example.com/img.png</qqimg> world"
 *   → [{ type: 'text', content: 'Hello ' },
 *      { type: 'image', content: 'https://example.com/img.png' },
 *      { type: 'text', content: ' world' }]
 */
export function parseInlineMediaTags(text: string): Array<{
  type: 'text' | 'image' | 'voice' | 'video' | 'file';
  content: string;
}> {
  const items: Array<{ type: 'text' | 'image' | 'voice' | 'video' | 'file'; content: string }> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // Reset regex state
  INLINE_MEDIA_REGEX.lastIndex = 0;

  while ((match = INLINE_MEDIA_REGEX.exec(text)) !== null) {
    // Push any text appearing before this tag
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index);
      if (before) {
        items.push({ type: 'text', content: before });
      }
    }

    const tag = match[1];
    const url = match[2];
    const mediaType = tag === 'qqimg' ? 'image'
      : tag === 'qqvoice' ? 'voice'
      : tag === 'qqvideo' ? 'video'
      : 'file';

    items.push({ type: mediaType, content: url });
    lastIndex = match.index + match[0].length;
  }

  // Remaining text after the last tag
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex);
    if (remaining) {
      items.push({ type: 'text', content: remaining });
    }
  }

  return items;
}

/**
 * Split long text into chunks at `textLimit` and send each chunk
 * as a separate QQ Bot API message with markdown formatting.
 *
 * Inline media tags (<qqimg>, <qqvoice>, <qqvideo>, <qqfile>) are
 * parsed and sent as media messages. When no media tags are present
 * the text is sent as markdown (existing behaviour).
 *
 * Individual chunk/media failures are silently skipped.
 */
export async function sendChunkedText(
  gateway: QQGateway,
  text: string,
  target: { openid?: string; groupOpenid?: string },
  textLimit: number,
  logger?: { warn: (msg: string, err?: unknown) => void },
): Promise<void> {
  if (!text) return;

  // Parse inline media tags
  const items = parseInlineMediaTags(text);

  // Fast path: no media tags — send as markdown text (existing behaviour)
  if (items.length === 1 && items[0].type === 'text') {
    const chunks = splitText(text, textLimit);
    let failed = 0;
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      try {
        await sendSingleMessage(gateway, chunk, target);
      } catch (err) {
        failed++;
        logger?.warn('QQ sendChunkedText: failed to send chunk', err);
      }
    }
    if (failed > 0 && failed === chunks.filter(c => c.trim()).length) {
      throw new Error(`QQ sendChunkedText: all ${failed} chunks failed`);
    }
    return;
  }

  // Process items in sequence (text + media interleaved)
  for (const item of items) {
    try {
      if (item.type === 'text') {
        const chunks = splitText(item.content, textLimit);
        for (const chunk of chunks) {
          if (!chunk.trim()) continue;
          await sendSingleMessage(gateway, chunk, target);
        }
      } else {
        await sendSingleMediaMessage(gateway, item.type, item.content, target);
      }
    } catch {
      // Skip failed item
    }
  }
}

/**
 * Send media resources (image, file) to a QQ chat.
 * Uses the markdown image syntax for image attachments.
 *
 * Note: QQ Bot API requires pre-uploading files via the file upload API
 * before sending as media messages. For simplicity, inline images are
 * sent as markdown image links.
 */
export async function sendMedia(
  gateway: QQGateway,
  media: MediaResource[],
  target: { openid?: string; groupOpenid?: string },
): Promise<void> {
  for (const resource of media) {
    try {
      if (resource.type === 'image') {
        // Send image as a markdown image in a text message
        const markdownImage = `![${resource.name ?? 'image'}](${resource.url})`;
        await sendSingleMessage(gateway, markdownImage, target);
      } else {
        // For files, send a text message with the URL
        const fileText = resource.name
          ? `[${resource.name}](${resource.url})`
          : resource.url;
        await sendSingleMessage(gateway, fileText, target);
      }
    } catch {
      // Skip failed media item
    }
  }
}

// ---------------------------------------------------------------------------
// Keyboard Messages
// ---------------------------------------------------------------------------

/**
 * Send a Markdown message with interactive keyboard buttons.
 */
export async function sendKeyboardMessage(
  gateway: QQGateway,
  params: {
    markdown: string;
    keyboard: QQKeyboard;
    target: { openid?: string; groupOpenid?: string };
    replyToMessageId?: string;
  },
): Promise<string> {
  const { markdown, keyboard, target, replyToMessageId } = params;
  // Always include msg_seq to prevent QQ's duplicate-message rejection
  const body: Record<string, unknown> = {
    content: stripMarkdown(markdown),
    msg_type: 2,
    msg_seq: nextMsgSeq(),
    markdown: { content: markdown },
    keyboard,
  };
  if (replyToMessageId) {
    body.msg_id = replyToMessageId;
  }
  try {
    if (target.groupOpenid) {
      const resp = await gateway.sendRestApi('POST', `/v2/groups/${target.groupOpenid}/messages`, body);
      return resp?.id ?? '';
    }
    if (target.openid) {
      const resp = await gateway.sendRestApi('POST', `/v2/users/${target.openid}/messages`, body);
      return resp?.id ?? '';
    }
    throw new Error('QQ send target must specify either openid or groupOpenid');
  } catch (err) {
    console.error('[QQ sendKeyboardMessage failed]', (err as Error)?.message ?? String(err));
    throw err;
  }
}

/**
 * Create a channelApprovalSender for QQ, capturing the trigger message ID
 * so approval messages stay within the passive reply window.
 */
export function createQQApprovalSender(params: {
  gateway: QQGateway;
  target: { openid?: string; groupOpenid?: string };
  triggerMessageId: string;
}) {
  const { gateway, target, triggerMessageId } = params;

  return {
    async sendApprovalMessage(
      _chatId: string,
      requestId: string,
      command: string,
      risk: 'low' | 'medium' | 'high',
      reason?: string,
    ): Promise<string> {
      const markdown = buildApprovalMarkdown(command, risk, reason);
      const keyboard = buildApprovalKeyboard(requestId, {
        approveOnce:    i18n.t('qq-approval:button.approveOnce'),
        approveSession: i18n.t('qq-approval:button.approveSession'),
        alwaysAllow:    i18n.t('qq-approval:button.alwaysAllow'),
        denyOnce:       i18n.t('qq-approval:button.denyOnce'),
      });
      try {
        return await sendKeyboardMessage(gateway, {
          markdown,
          keyboard,
          target,
          replyToMessageId: triggerMessageId,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[QQ sendApprovalMessage failed]', msg);
        throw err;
      }
    },

    /**
     * Update the approval message after a decision.
     *
     * QQ does not support editing sent messages, so we send a short
     * follow-up message with the result. The original keyboard message
     * stays visible but its buttons become no-ops (re-clicking a resolved
     * approval is silently ignored).
     */
    async updateApprovalResult(
      _chatId: string,
      _messageId: string,
      decision: string,
      command: string,
    ): Promise<void> {
      const isApproved = decision.startsWith('approve');
      const key = isApproved ? 'result.approved' : 'result.rejected';
      const truncated = command.length > 100 ? command.slice(0, 100) + '...' : command;
      const resultText = i18n.t(`qq-approval:${key}`, { command: truncated });
      const emoji = isApproved ? '✅' : '❌';
      try {
        await sendSingleMessage(gateway, `${emoji} ${resultText}`, target);
      } catch (err) {
        console.error('[QQ updateApprovalResult failed]', (err as Error)?.message ?? String(err));
      }
    },
  };
}

function getApprovalTitleKey(command: string): string {
  return command.startsWith('computer_use ')
    ? 'qq-approval:card.computerUseApproval'
    : 'qq-approval:card.shellCommandApproval';
}

function buildApprovalMarkdown(
  command: string,
  risk: 'low' | 'medium' | 'high',
  reason?: string,
): string {
  const riskLabelMap: Record<string, string> = { low: '低', medium: '中', high: '高' };
  const title = i18n.t(getApprovalTitleKey(command));
  const truncated = command.length > 100 ? command.slice(0, 100) + '...' : command;
  let md = `**${title}**\n\n\`${truncated}\`\n\n风险: **${riskLabelMap[risk] ?? risk}**`;
  if (reason) md += `\n原因: ${reason}`;
  return md;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Send a single message via the QQ Bot API REST endpoint.
 *
 * Uses markdown format (msg_type: 2) with a plain text fallback
 * in the `content` field for clients that do not support markdown.
 */
async function sendSingleMessage(
  gateway: QQGateway,
  text: string,
  target: { openid?: string; groupOpenid?: string },
): Promise<void> {
  if (target.groupOpenid) {
    const body: Record<string, unknown> = {
      content: stripMarkdown(text),
      msg_type: 2,
      markdown: { content: text },
      msg_seq: nextMsgSeq(),
    };
    await gateway.sendRestApi('POST', `/v2/groups/${target.groupOpenid}/messages`, body);
  } else if (target.openid) {
    const body: Record<string, unknown> = {
      content: stripMarkdown(text),
      msg_type: 2,
      markdown: { content: text },
    };
    await gateway.sendRestApi('POST', `/v2/users/${target.openid}/messages`, body);
  } else {
    throw new Error('QQ send target must specify either openid or groupOpenid');
  }
}

/**
 * Send a single media item (image / voice / video / file) as a markdown
 * representation via the QQ Bot API.
 *
 * The QQ Bot API v2 requires pre-uploaded file_info for native media
 * messages (msg_type: 7). For simplicity, inline media URLs are sent as
 * markdown links / images so they render inline in supported clients.
 */
async function sendSingleMediaMessage(
  gateway: QQGateway,
  mediaType: 'image' | 'voice' | 'video' | 'file',
  url: string,
  target: { openid?: string; groupOpenid?: string },
): Promise<void> {
  let text: string;
  switch (mediaType) {
    case 'image':
      text = `![image](${url})`;
      break;
    case 'voice':
      text = `[Voice](${url})`;
      break;
    case 'video':
      text = `[Video](${url})`;
      break;
    case 'file':
      text = `[File](${url})`;
      break;
  }
  await sendSingleMessage(gateway, text, target);
}

// ---------------------------------------------------------------------------
// Text Splitting
// ---------------------------------------------------------------------------

/**
 * Split text into chunks no longer than `limit` characters.
 *
 * Prefers splitting at paragraph breaks, line breaks, or spaces near
 * the limit boundary to produce more natural chunk boundaries.
 */
export function splitText(text: string, limit: number): string[] {
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
      splitAt = paraBreak;
    } else if (lineBreak > searchStart) {
      splitAt = lineBreak;
    } else if (space > searchStart) {
      splitAt = space;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  // Final chunk (fits within limit)
  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [text];
}

// ---------------------------------------------------------------------------
// Markdown → Plain Text (for fallback content field)
// ---------------------------------------------------------------------------

/**
 * Strip common Markdown formatting so the text can serve as a plain-text
 * fallback when the client does not support markdown rendering.
 */
export function stripMarkdown(text: string): string {
  return text
    // Remove bold markers **text**
    .replace(/\*\*(.+?)\*\*/g, '$1')
    // Remove italic markers *text* (non-greedy, avoiding double-asterisk overlap)
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '$1')
    // Remove inline code backticks
    .replace(/`([^`]+)`/g, '$1')
    // Remove fenced code block markers (keep the content)
    .replace(/```(\w*)\n?/g, '')
    .replace(/```/g, '')
    // Convert links [text](url) -> text (url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    // Remove heading markers
    .replace(/^#{1,6}\s+/gm, '')
    // Remove horizontal rules
    .replace(/^---+$/gm, '')
    // Remove strikethrough
    .replace(/~~(.+?)~~/g, '$1')
    // Reduce multiple blank lines to at most two
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Message Sequence Counter (for group messages)
// ---------------------------------------------------------------------------

let msgSeq = 0;

/** Get the next monotonically increasing message sequence number. */
function nextMsgSeq(): number {
  return ++msgSeq;
}

// ---------------------------------------------------------------------------
// Card-to-Text Conversion
// ---------------------------------------------------------------------------

/**
 * Convert a Feishu CardData structure to a plain text representation
 * suitable for sending over QQ.
 */
function renderCardAsText(card: CardData): string {
  const parts: string[] = [];

  if (card.header) {
    const title = extractCardContent(card.header);
    if (title) parts.push(title);
  }

  if (card.body) {
    const bodyText = extractCardContent(card.body);
    if (bodyText) parts.push(bodyText);
  }

  if (card.elements) {
    for (const el of card.elements) {
      const text = extractCardContent(el);
      if (text) parts.push(text);
    }
  }

  return parts.join('\n') || '';
}

/**
 * Walk a CardKit 2.0 object tree and return the first text content found.
 */
function extractCardContent(obj: unknown): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;

  if (typeof o.content === 'string' && o.content.length > 0) {
    return o.content;
  }
  if (typeof o.text === 'string' && o.text.length > 0) {
    return o.text;
  }

  for (const key of ['title', 'text', 'fields', 'elements', 'columns', 'column']) {
    const val = o[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        const result = extractCardContent(item);
        if (result) return result;
      }
    } else if (val && typeof val === 'object') {
      const result = extractCardContent(val);
      if (result) return result;
    }
  }

  return undefined;
}
