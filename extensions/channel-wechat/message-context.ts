/**
 * Build a unified ChannelContext from an iLink ILMessage.
 *
 * Extracts text and media from the message's item_list and returns a
 * normalized ChannelContext for the agent pipeline.
 *
 * Handles ref_msg (quoted replies) by formatting them as:
 *   [引用: title]
 *   currentText
 */

import type { ChannelContext, MediaResource, MessageEnvelope } from '../../src/channel/types.js';
import type { ILMessage, ILReferenceMessage } from './wechat-types.js';
import { MessageItemType } from './wechat-types.js';

/**
 * Convert a raw iLink ILMessage into a normalized ChannelContext.
 *
 * Returns null for:
 * - Messages from the bot itself (filtered upstream in the poller)
 * - Messages with neither text nor media items
 */
export function buildMessageContext(msg: ILMessage): ChannelContext | null {
  if (!msg || !msg.item_list || msg.item_list.length === 0) {
    return null;
  }

  const textParts: string[] = [];
  const media: MediaResource[] = [];
  let hasContent = false;

  for (const item of msg.item_list) {
    switch (item.type) {
      case MessageItemType.TEXT: {
        if (item.text_item?.ref_msg) {
          // Quoted reply — format with引用 prefix
          const ref = item.text_item.ref_msg;
          const refTitle = ref.title || '';
          const refText = item.text_item.text || '';

          // Extract quoted message text/type
          const quotedText = extractRefMsgText(ref);

          // Handle media in ref_msg
          const refMediaNote = extractRefMsgMedia(ref);

          const quotedPart = quotedText || refMediaNote || refTitle || '[Quoted message]';
          const formatted = refText
            ? `[引用: ${quotedPart}]\n${refText}`
            : `[引用: ${quotedPart}]`;

          if (formatted) {
            textParts.push(formatted);
          }
        } else if (item.text_item?.text) {
          textParts.push(item.text_item.text);
        }
        hasContent = true;
        break;
      }

      case MessageItemType.IMAGE: {
        if (item.image_item?.media) {
          media.push({
            url: item.image_item.media.encrypt_query_param,
            type: 'image',
            // mid_size is the encrypted file size
          });
        }
        hasContent = true;
        break;
      }

      case MessageItemType.VOICE: {
        // Voice items sometimes have a transcription in voice_item.text
        if (item.voice_item?.text) {
          textParts.push(`[Voice: ${item.voice_item.text}]`);
        } else {
          textParts.push('[Voice]');
        }
        if (item.voice_item?.media) {
          media.push({
            url: item.voice_item.media.encrypt_query_param,
            type: 'file',
            name: 'voice.ogg',
          });
        }
        hasContent = true;
        break;
      }

      case MessageItemType.FILE: {
        if (item.file_item) {
          textParts.push(`[File: ${item.file_item.file_name || 'unknown'}]`);
          if (item.file_item.media) {
            media.push({
              url: item.file_item.media.encrypt_query_param,
              type: 'file',
              name: item.file_item.file_name,
              size: Number(item.file_item.len) || undefined,
            });
          }
        }
        hasContent = true;
        break;
      }

      case MessageItemType.VIDEO: {
        textParts.push('[Video]');
        if (item.video_item?.media) {
          media.push({
            url: item.video_item.media.encrypt_query_param,
            type: 'video',
          });
        }
        hasContent = true;
        break;
      }

      default:
        // Unknown item type — skip
        break;
    }
  }

  if (!hasContent) {
    return null;
  }

  const finalText = textParts.join('\n') || (media.length > 0 ? '[Media]' : '');

  const envelope: MessageEnvelope = {
    id: msg.client_id || String(Date.now()),
    text: finalText,
    senderId: msg.from_user_id,
    raw: msg,
    media: media.length > 0 ? media : undefined,
    replyMeta: {
      contextToken: msg.context_token,
      fromUserId: msg.from_user_id,
      toUserId: msg.to_user_id ?? '',
    },
  };

  return {
    channelId: msg.from_user_id,
    channelType: 'wechat',
    message: envelope,
  };
}

// ---------------------------------------------------------------------------
// Ref message (quote/reply) helpers
// ---------------------------------------------------------------------------

/**
 * Extract the text content from a referenced (quoted) message.
 */
function extractRefMsgText(ref: ILReferenceMessage): string {
  const msgItem = ref.message_item;
  if (!msgItem) return '';

  const type = msgItem.type;
  switch (type) {
    case MessageItemType.TEXT:
      return (msgItem as Record<string, any>).text_item?.text || '';
    case MessageItemType.IMAGE:
      return '[Image]';
    case MessageItemType.VOICE:
      return '[Voice]';
    case MessageItemType.FILE: {
      const fileName = (msgItem as Record<string, any>).file_item?.file_name;
      return fileName ? `[File: ${fileName}]` : '[File]';
    }
    case MessageItemType.VIDEO:
      return '[Video]';
    default:
      return '';
  }
}

/**
 * Detect if the referenced message contains media and return a description.
 * Only returns non-empty when the text extraction alone is insufficient.
 */
function extractRefMsgMedia(ref: ILReferenceMessage): string {
  const msgItem = ref.message_item;
  if (!msgItem) return '';

  const type = msgItem.type;
  if (type === MessageItemType.IMAGE) return '[Image]';
  if (type === MessageItemType.VOICE) return '[Voice]';
  if (type === MessageItemType.VIDEO) return '[Video]';
  if (type === MessageItemType.FILE) {
    const fileName = (msgItem as Record<string, any>).file_item?.file_name;
    return fileName ? `[File: ${fileName}]` : '[File]';
  }
  return '';
}
