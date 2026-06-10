// ---------------------------------------------------------------------------
// Build a unified ChannelContext from a QQ Bot API v2 message event.
//
// Handles:
// - C2C_MESSAGE_CREATE  (private chat)
// - GROUP_AT_MESSAGE_CREATE (group @-mention)
//   - Strips @-mention prefixes (<@!openid>) from content
// - Attachments → MediaResource (images, files, etc.)
// ---------------------------------------------------------------------------

import type { ChannelContext, MessageEnvelope, MediaResource } from '../../src/channel/types.js';
import type { QQMessageEvent } from './qq-types.js';
import { isGroupMessageEvent, isC2cMessageEvent } from './qq-types.js';

/**
 * Build a ChannelContext from a QQ Bot API v2 message event.
 *
 * Returns null for:
 * - Non-message events (filtered by the type guard)
 * - Empty content after stripping @-mentions
 */
export function buildMessageContext(event: QQMessageEvent, selfId: string): ChannelContext | null {
  const payload = event.d;
  const content = payload.content ?? '';
  const hasAttachments = payload.attachments && payload.attachments.length > 0;

  // Determine message type and extract clean text
  let text: string;
  let chatType: 'c2c' | 'group';
  let groupOpenid: string | undefined;
  let userOpenid: string;

  if (isGroupMessageEvent(event)) {
    chatType = 'group';
    groupOpenid = payload.group_openid ?? payload.group_id ?? '';
    userOpenid = payload.author.user_openid;

    // Strip all @-mentions from the content
    text = content.replace(/<@!([^>]+)>/g, '').trim();
  } else if (isC2cMessageEvent(event)) {
    chatType = 'c2c';
    userOpenid = payload.author.user_openid;
    text = content.trim();
  } else {
    // DIRECT_MESSAGE_CREATE or unknown — fall back to c2c
    chatType = 'c2c';
    userOpenid = payload.author.user_openid;
    text = content.trim();
  }

  // Extract media from attachments
  const media: MediaResource[] = [];
  if (hasAttachments) {
    for (const att of payload.attachments!) {
      const mimeType = (att.content_type ?? '').toLowerCase();
      if (mimeType.startsWith('image/')) {
        media.push({ url: att.url, type: 'image' });
      } else {
        // Treat non-image attachments as generic files
        media.push({ url: att.url, type: 'file' });
      }
    }
  }

  // Empty message after stripping — nothing to process
  if (!text && media.length === 0) {
    return null;
  }

  // Build reply metadata for sending responses
  const replyMeta: Record<string, unknown> = {
    chatType,
    selfId,
    userOpenid,
  };

  if (chatType === 'group' && groupOpenid) {
    replyMeta.groupOpenid = groupOpenid;
  } else {
    replyMeta.openid = userOpenid;
  }

  const channelId = chatType === 'group' ? (groupOpenid ?? '') : userOpenid;

  const envelope: MessageEnvelope = {
    id: payload.id,
    text: text || '',
    senderId: userOpenid,
    media: media.length > 0 ? media : undefined,
    raw: payload,
    replyMeta,
  };

  return {
    channelId,
    channelType: 'qq',
    message: envelope,
  };
}
