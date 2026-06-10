/**
 * Builds a normalized FeishuMessageContext from a raw Feishu event.
 */

import type { ResourceDescriptor } from './feishu-types.js';
import { i18n } from '../../src/i18n/index.js';

export interface FeishuMessageContext {
  chatId: string;
  threadId?: string;
  messageId: string;
  senderId: string;
  text: string;
  chatType: 'p2p' | 'group';
  sessionKey: string;
  createTimeMs?: number;
  rawEvent: any;
  /** Original message_type from Feishu (e.g. 'text', 'image', 'file'). */
  messageType: string;
  /** Raw content JSON string from the Feishu message. */
  rawContent: string;
  /** Parsed media resources (non-empty for image/file/audio/video/sticker messages). */
  resources: ResourceDescriptor[];
}

// ─── Post (rich text) element types ───

interface PostElement {
  tag: string;
  text?: string;
  image_key?: string;
  href?: string;
  user_id?: string;
  user_name?: string;
}

interface PostContent {
  title?: string;
  content?: PostElement[][];
}

/**
 * Extract text content from the message's content JSON string.
 *
 * Handled message types:
 * - text:       {"text": "..."}
 * - post:       rich text with content paragraphs containing text/img/at/a elements
 * - image/file/audio/media/sticker: no text content
 */
function extractText(content: string, messageType: string): string {
  if (messageType === 'text') {
    try {
      const parsed = JSON.parse(content) as { text?: string };
      return parsed.text ?? '';
    } catch {
      return '';
    }
  }

  if (messageType === 'post') {
    try {
      const parsed = JSON.parse(content) as PostContent;
      const paragraphs = parsed.content;
      if (!paragraphs || !Array.isArray(paragraphs)) return '';

      return paragraphs
        .map((elements) => {
          if (!Array.isArray(elements)) return '';
          return elements
            .map((el) => {
              if (el.tag === 'text' && el.text) return el.text;
              if (el.tag === 'a' && el.text) return el.text;
              if (el.tag === 'at' && el.user_name) return `@${el.user_name}`;
              if (el.tag === 'at' && el.user_id) return `@${el.user_id}`;
              if (el.tag === 'img') return i18n.t('messages:media.imagePlaceholder');
              return '';
            })
            .filter(Boolean)
            .join('');
        })
        .filter(Boolean)
        .join('\n');
    } catch {
      return '';
    }
  }

  return '';
}

/**
 * Parse media resources from the message content based on message type.
 *
 * Feishu content JSON formats:
 * - image:  {"image_key": "img_xxx"}
 * - file:   {"file_key": "file_xxx", "file_name": "doc.pdf"}
 * - audio:  {"file_key": "file_xxx", "duration": 15000}
 * - media:  {"file_key": "file_xxx", "file_name": "vid.mp4", "duration": 60000, "image_key": "img_xxx"}
 * - sticker: {"file_key": "file_xxx"}
 * - post:   {"content": [[{"tag":"text",...},{"tag":"img","image_key":"..."}]]}
 */
function parseContent(content: string, messageType: string): ResourceDescriptor[] {
  if (messageType === 'text' || messageType === 'interactive') {
    return [];
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }

  switch (messageType) {
    case 'image': {
      const imageKey = typeof parsed.image_key === 'string' ? parsed.image_key : undefined;
      return imageKey ? [{ type: 'image', fileKey: imageKey }] : [];
    }
    case 'file': {
      const fileKey = typeof parsed.file_key === 'string' ? parsed.file_key : undefined;
      const fileName = typeof parsed.file_name === 'string' ? parsed.file_name : undefined;
      return fileKey ? [{ type: 'file', fileKey, fileName }] : [];
    }
    case 'audio': {
      const fileKey = typeof parsed.file_key === 'string' ? parsed.file_key : undefined;
      const duration = typeof parsed.duration === 'number' ? parsed.duration : undefined;
      return fileKey ? [{ type: 'audio', fileKey, duration }] : [];
    }
    case 'media': {
      const fileKey = typeof parsed.file_key === 'string' ? parsed.file_key : undefined;
      const fileName = typeof parsed.file_name === 'string' ? parsed.file_name : undefined;
      const duration = typeof parsed.duration === 'number' ? parsed.duration : undefined;
      const coverImageKey = typeof parsed.image_key === 'string' ? parsed.image_key : undefined;
      return fileKey ? [{ type: 'video', fileKey, fileName, duration, coverImageKey }] : [];
    }
    case 'sticker': {
      const fileKey = typeof parsed.file_key === 'string' ? parsed.file_key : undefined;
      return fileKey ? [{ type: 'sticker', fileKey }] : [];
    }
    case 'post': {
      const postContent = parsed as PostContent;
      const paragraphs = postContent.content;
      if (!paragraphs || !Array.isArray(paragraphs)) return [];

      const resources: ResourceDescriptor[] = [];
      for (const elements of paragraphs) {
        if (!Array.isArray(elements)) continue;
        for (const el of elements) {
          if (el.tag === 'img' && el.image_key) {
            resources.push({ type: 'image', fileKey: el.image_key });
          }
        }
      }
      return resources;
    }
    default:
      return [];
  }
}

/**
 * Derive a session key from chatId, threadId, and chatType.
 *
 * - P2P chat: `chatId`
 * - Group chat (no thread): `chatId`
 * - Group chat with thread: `chatId:threadId`
 */
function deriveSessionKey(
  chatId: string,
  threadId: string | undefined,
  chatType: 'p2p' | 'group',
): string {
  if (chatType === 'group' && threadId) {
    return `${chatId}:${threadId}`;
  }
  return chatId;
}

function parseCreateTime(createTime: unknown): number | undefined {
  if (typeof createTime === 'number' && Number.isFinite(createTime)) {
    return createTime < 1e12 ? createTime * 1000 : createTime;
  }

  if (typeof createTime === 'string') {
    const trimmed = createTime.trim();
    if (!trimmed) return undefined;

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return numeric < 1e12 ? numeric * 1000 : numeric;
    }

    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? undefined : parsed;
  }

  return undefined;
}

/**
 * Build a normalized FeishuMessageContext from a raw Feishu event.
 *
 * Expects the `im.message.receive_v1` event structure:
 * ```
 * {
 *   event: {
 *     message: {
 *       chat_id, chat_type, message_id, message_type, content, thread_id?
 *     },
 *     sender: {
 *       sender_id: { open_id, user_id, union_id }
 *     }
 *   }
 * }
 * ```
 */
export function buildMessageContext(event: any): FeishuMessageContext {
  const msg = event.event.message;
  const sender = event.event.sender;

  const chatId: string = msg.chat_id;
  const threadId: string | undefined = msg.thread_id || undefined;
  const chatType: 'p2p' | 'group' = msg.chat_type;
  const messageId: string = msg.message_id;
  const senderId: string = sender.sender_id.open_id;
  const messageType: string = msg.message_type;
  const rawContent: string = msg.content;
  const text: string = extractText(rawContent, messageType);
  const resources: ResourceDescriptor[] = parseContent(rawContent, messageType);
  const sessionKey: string = deriveSessionKey(chatId, threadId, chatType);
  const createTimeMs = parseCreateTime(msg.create_time);

  return {
    chatId,
    threadId,
    messageId,
    senderId,
    text,
    chatType,
    sessionKey,
    createTimeMs,
    rawEvent: event,
    messageType,
    rawContent,
    resources,
  };
}
