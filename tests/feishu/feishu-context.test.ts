import { describe, it, expect } from 'vitest';
import { buildMessageContext } from '../../extensions/channel-feishu/feishu-context.js';
import type { FeishuMessageContext } from '../../extensions/channel-feishu/feishu-context.js';

// ─── Helpers ───

function makeEvent(overrides: {
  chatType?: 'p2p' | 'group';
  threadId?: string;
  content?: string;
  messageType?: string;
  chatId?: string;
  messageId?: string;
  senderId?: string;
  createTime?: string;
} = {}) {
  const {
    chatType = 'p2p',
    threadId,
    content = '{"text":"hello"}',
    messageType = 'text',
    chatId = 'oc_chat123',
    messageId = 'om_msg456',
    senderId = 'ou_sender789',
    createTime = '1746192000000',
  } = overrides;

  return {
    header: {
      event_type: 'im.message.receive_v1',
    },
    event: {
      message: {
        chat_id: chatId,
        chat_type: chatType,
        message_id: messageId,
        create_time: createTime,
        message_type: messageType,
        content,
        ...(threadId !== undefined ? { thread_id: threadId } : {}),
      },
      sender: {
        sender_id: {
          open_id: senderId,
          user_id: 'uid_123',
          union_id: 'unid_456',
        },
        sender_type: 'user',
        tenant_key: 'tenant1',
      },
    },
  };
}

// ─── sessionKey logic ───

describe('buildMessageContext', () => {
  describe('sessionKey derivation', () => {
    it('P2P chat: sessionKey = chatId', () => {
      const event = makeEvent({ chatType: 'p2p', chatId: 'oc_p2p' });
      const ctx: FeishuMessageContext = buildMessageContext(event);
      expect(ctx.sessionKey).toBe('oc_p2p');
      expect(ctx.chatType).toBe('p2p');
    });

    it('Group chat without thread: sessionKey = chatId', () => {
      const event = makeEvent({ chatType: 'group', chatId: 'oc_grp' });
      const ctx: FeishuMessageContext = buildMessageContext(event);
      expect(ctx.sessionKey).toBe('oc_grp');
      expect(ctx.chatType).toBe('group');
    });

    it('Group chat with thread: sessionKey = chatId:threadId', () => {
      const event = makeEvent({
        chatType: 'group',
        chatId: 'oc_grp',
        threadId: 'ot_thread1',
      });
      const ctx: FeishuMessageContext = buildMessageContext(event);
      expect(ctx.sessionKey).toBe('oc_grp:ot_thread1');
      expect(ctx.threadId).toBe('ot_thread1');
    });

    it('P2P chat ignores threadId if present', () => {
      // P2P should never have a thread, but if it does, sessionKey should still be chatId
      const event = makeEvent({
        chatType: 'p2p',
        chatId: 'oc_p2p',
        threadId: 'ot_thread',
      });
      const ctx: FeishuMessageContext = buildMessageContext(event);
      expect(ctx.sessionKey).toBe('oc_p2p');
    });
  });

  // ─── Text extraction ───

  describe('text extraction', () => {
    it('extracts text from text message content JSON', () => {
      const event = makeEvent({ content: '{"text":"hello world"}' });
      const ctx: FeishuMessageContext = buildMessageContext(event);
      expect(ctx.text).toBe('hello world');
    });

    it('handles empty text in text message', () => {
      const event = makeEvent({ content: '{"text":""}' });
      const ctx: FeishuMessageContext = buildMessageContext(event);
      expect(ctx.text).toBe('');
    });

    it('returns empty string for non-text message type', () => {
      const event = makeEvent({
        messageType: 'image',
        content: '{"image_key":"img_xxx"}',
      });
      const ctx: FeishuMessageContext = buildMessageContext(event);
      expect(ctx.text).toBe('');
    });

    it('returns empty string for malformed content JSON', () => {
      const event = makeEvent({ content: 'not-json' });
      const ctx: FeishuMessageContext = buildMessageContext(event);
      expect(ctx.text).toBe('');
    });

    it('returns empty string when content JSON has no text field', () => {
      const event = makeEvent({ content: '{"title":"no text field"}' });
      const ctx: FeishuMessageContext = buildMessageContext(event);
      expect(ctx.text).toBe('');
    });
  });

  // ─── Field mapping ───

  describe('field mapping', () => {
    it('maps all basic fields correctly', () => {
      const event = makeEvent({
        chatId: 'oc_chat',
        messageId: 'om_msg',
        senderId: 'ou_sender',
        chatType: 'group',
        threadId: 'ot_thread',
      });
      const ctx: FeishuMessageContext = buildMessageContext(event);
      expect(ctx.chatId).toBe('oc_chat');
      expect(ctx.messageId).toBe('om_msg');
      expect(ctx.senderId).toBe('ou_sender');
      expect(ctx.chatType).toBe('group');
      expect(ctx.threadId).toBe('ot_thread');
      expect(ctx.createTimeMs).toBe(1746192000000);
    });

    it('rawEvent references the original event object', () => {
      const event = makeEvent();
      const ctx: FeishuMessageContext = buildMessageContext(event);
      expect(ctx.rawEvent).toBe(event);
    });

    it('threadId is undefined when not present in event', () => {
      const event = makeEvent({ chatType: 'group' });
      const ctx: FeishuMessageContext = buildMessageContext(event);
      expect(ctx.threadId).toBeUndefined();
    });

    it('parses second-based create_time values', () => {
      const event = makeEvent({ createTime: '1746192000' });
      const ctx: FeishuMessageContext = buildMessageContext(event);
      expect(ctx.createTimeMs).toBe(1746192000000);
    });

    it('leaves createTimeMs undefined for invalid create_time values', () => {
      const event = makeEvent({ createTime: 'not-a-time' });
      const ctx: FeishuMessageContext = buildMessageContext(event);
      expect(ctx.createTimeMs).toBeUndefined();
    });
  });
});
