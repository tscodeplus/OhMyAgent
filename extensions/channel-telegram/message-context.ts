/**
 * Build a unified ChannelContext from a grammY Context object.
 *
 * Handles text, caption, photo, document, audio, voice, video, sticker,
 * media group, and edited message / channel post filtering.
 *
 * Media file_ids are stored directly as MediaResource.url so the caller
 * can resolve them to downloadable URLs via the Bot API's getFile endpoint
 * when a bot token is available.
 */

import type { MediaResource, ChannelContext, MessageEnvelope } from '../../src/channel/types.js';

/**
 * Convert a raw grammY Context into a normalized ChannelContext.
 *
 * Returns null for:
 * - Edited messages (ctx.editedMessage)
 * - Channel posts (ctx.channelPost)
 * - Messages with neither text nor media (empty / unsupported types)
 */
export function buildMessageContext(ctx: any, botUsername: string): ChannelContext | null {
  // Edited messages are ignored — only the latest version matters
  if (ctx.editedMessage) {
    return null;
  }

  // Channel posts are not handled via this pipeline
  if (ctx.channelPost) {
    return null;
  }

  const msg = ctx.message;
  if (!msg) {
    return null;
  }

  // Extract text from either msg.text or msg.caption
  const extractedText: string | undefined = extractText(msg);

  // Extract media resources from the message
  const media: MediaResource[] = extractMedia(msg);

  // Sticker: use placeholder text only, do NOT add to media (the sticker
  // file_id is preserved in the raw message for later access if needed)
  let finalText = extractedText;
  if (msg.sticker) {
    finalText = `[Sticker ${msg.sticker.emoji || ''}]`;
  }

  // Empty message — nothing to process
  if (!finalText && media.length === 0) {
    return null;
  }

  // Build reply metadata with Telegram-specific context
  const replyMeta: Record<string, unknown> = {
    chatId: String(msg.chat.id),
    chatType: msg.chat.type,
    botUsername,
  };

  // Attach media_group_id so the caller can correlate grouped messages
  // across multiple updates (e.g., an album of photos).
  if (msg.media_group_id) {
    replyMeta.mediaGroupId = msg.media_group_id;
  }

  const envelope: MessageEnvelope = {
    id: String(msg.message_id),
    text: finalText || '',
    senderId: String(msg.from?.id ?? 'unknown'),
    threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
    media: media.length > 0 ? media : undefined,
    raw: msg,
    replyMeta,
  };

  return {
    channelId: String(msg.chat.id),
    channelType: 'telegram',
    message: envelope,
  };
}

/**
 * Extract display text from a Telegram message.
 *
 * Prefers the `text` field (plain text messages) over `caption`
 * (media with captions). Returns undefined when neither is present.
 */
function extractText(msg: any): string | undefined {
  if (typeof msg.text === 'string' && msg.text.length > 0) {
    return msg.text;
  }
  if (typeof msg.caption === 'string' && msg.caption.length > 0) {
    return msg.caption;
  }
  return undefined;
}

/**
 * Extract media resources from a Telegram message.
 *
 * Handles photo (highest resolution), document, audio, voice, and video.
 * Each message may carry at most one media item. Media group correlation
 * is handled externally via replyMeta.mediaGroupId.
 */
function extractMedia(msg: any): MediaResource[] {
  const resources: MediaResource[] = [];

  // Photo — the last element in the array has the highest resolution
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];
    resources.push({
      url: photo.file_id,
      type: 'image',
      size: photo.file_size,
    });
  }

  // Document (file attachment)
  if (msg.document) {
    resources.push({
      url: msg.document.file_id,
      type: 'file',
      name: msg.document.file_name ?? undefined,
      size: msg.document.file_size,
    });
  }

  // Audio track
  if (msg.audio) {
    const audioName =
      msg.audio.file_name ??
      (msg.audio.performer && msg.audio.title
        ? `${msg.audio.performer} - ${msg.audio.title}`
        : undefined);

    resources.push({
      url: msg.audio.file_id,
      type: 'audio',
      name: audioName,
      size: msg.audio.file_size,
    });
  }

  // Voice message
  if (msg.voice) {
    resources.push({
      url: msg.voice.file_id,
      type: 'audio',
      name: `Voice (${msg.voice.duration ?? '?'}s)`,
      size: msg.voice.file_size,
    });
  }

  // Video
  if (msg.video) {
    resources.push({
      url: msg.video.file_id,
      type: 'video',
      name: msg.video.file_name ?? undefined,
      size: msg.video.file_size,
    });
  }

  return resources;
}
