/**
 * Reply sending for the WeChat channel.
 *
 * Wraps the raw wechat-sender functions for use with OhMyAgent's
 * ReplyContent format. Handles text, card-to-text conversion, and
 * media upload (image/file).
 */

import type { Logger } from 'pino';
import type { ReplyContent, CardData } from '../../src/channel/types.js';
import type { WechatConfig } from './wechat-types.js';
import { MessageItemType, UploadMediaType } from './wechat-types.js';
import { sendChunkedText, sendMessage } from './wechat-sender.js';
import { uploadMedia } from './wechat-media.js';
import { StreamingMarkdownFilter } from './markdown-filter.js';

/**
 * Send a ReplyContent to a WeChat user.
 *
 * - text: sent as plain text, chunked at textLimit.
 * - cards: converted to plain text and sent as text.
 * - media: uploaded via iLink CDN and sent as encrypted media messages.
 *
 * @param apiBase       iLink API base URL.
 * @param botToken      Bot authentication token.
 * @param reply         The ReplyContent to send.
 * @param contextToken  Context token from the user's last message (24h expiry).
 * @param toUserId      The recipient's from_user_id.
 * @param config        Resolved WechatConfig.
 * @param logger        Logger instance.
 */
export async function sendReply(
  apiBase: string,
  botToken: string,
  reply: ReplyContent,
  contextToken: string,
  toUserId: string,
  config: WechatConfig,
  logger: Logger,
): Promise<void> {
  // ── Text content (pass through StreamingMarkdownFilter) ──
  if (reply.text) {
    const filter = new StreamingMarkdownFilter();
    const filtered = filter.feed(reply.text) + filter.flush();
    await sendChunkedText(
      apiBase,
      botToken,
      toUserId,
      contextToken,
      filtered,
      config.textLimit,
      logger,
    );
  }

  // ── Cards → text conversion ──
  if (reply.cards && reply.cards.length > 0) {
    for (const card of reply.cards) {
      const cardText = renderCardAsText(card);
      if (cardText) {
        await sendChunkedText(
          apiBase,
          botToken,
          toUserId,
          contextToken,
          cardText,
          config.textLimit,
          logger,
        );
      }
    }
  }

  // ── Media ──
  if (reply.media && reply.media.length > 0) {
    for (const mediaItem of reply.media) {
      try {
        const mediaType = mediaTypeForUpload(mediaItem.type);
        const mediaParam = await uploadMedia(
          apiBase,
          botToken,
          mediaItem.url,
          mediaType,
          toUserId,
          config.aesKey,
          logger,
        );

        const msgType = messageTypeForMedia(mediaItem.type);
        const itemList = buildMediaItemList(msgType, mediaParam, mediaItem);

        await sendMessage(apiBase, botToken, {
          toUserId,
          contextToken,
          msgType,          // media message type
          msgContent: '',   // content is in itemList
          itemList,
        });
      } catch (err: unknown) {
        logger.error({ err, mediaType: mediaItem.type }, 'Failed to send WeChat media');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Card-to-text conversion
// ---------------------------------------------------------------------------

/**
 * Convert a Feishu CardData to plain text.
 */
function renderCardAsText(card: CardData): string {
  const parts: string[] = [];

  if (card.header) {
    const title = extractContent(card.header);
    if (title) parts.push(title);
  }

  if (card.body) {
    const bodyText = extractContent(card.body);
    if (bodyText) parts.push(bodyText);
  }

  if (card.elements) {
    for (const el of card.elements) {
      const text = extractContent(el);
      if (text) parts.push(text);
    }
  }

  return parts.join('\n');
}

/**
 * Walk a CardKit 2.0 object and return first text content found.
 */
function extractContent(obj: unknown): string | undefined {
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
 * Map a MediaResource type to an UploadMediaType constant.
 */
function mediaTypeForUpload(type: string): number {
  switch (type) {
    case 'image':
      return UploadMediaType.IMAGE;
    case 'video':
      return UploadMediaType.VIDEO;
    default:
      return UploadMediaType.FILE;
  }
}

/**
 * Map a MediaResource type to the iLink message item type.
 */
function messageTypeForMedia(type: string): number {
  switch (type) {
    case 'image':
      return MessageItemType.IMAGE;
    case 'video':
      return MessageItemType.VIDEO;
    default:
      return MessageItemType.FILE;
  }
}

/**
 * Build an item_list entry for a media message.
 */
function buildMediaItemList(
  msgType: number,
  mediaParam: { encrypt_query_param: string; aes_key: string; encrypt_type: number },
  media: { type: string; name?: string },
): unknown[] {
  switch (msgType) {
    case MessageItemType.IMAGE:
      return [
        {
          type: MessageItemType.IMAGE,
          image_item: {
            media: mediaParam,
          },
        },
      ];
    case MessageItemType.VIDEO:
      return [
        {
          type: MessageItemType.VIDEO,
          video_item: {
            media: mediaParam,
          },
        },
      ];
    default:
      return [
        {
          type: MessageItemType.FILE,
          file_item: {
            media: mediaParam,
            file_name: media.name || 'file',
            len: '0',
          },
        },
      ];
  }
}
