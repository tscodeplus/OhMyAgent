/**
 * Tests for Feishu outbound message sending modules.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendTextMessage } from '../../extensions/channel-feishu/outbound/send-message.js';
import { sendCard } from '../../extensions/channel-feishu/outbound/send-card.js';
import { updateCard } from '../../extensions/channel-feishu/outbound/update-card.js';
import { setTypingState } from '../../extensions/channel-feishu/outbound/typing-state.js';

// ─── Mock Client Factory ───

function createMockClient() {
  return {
    sendMessage: vi.fn().mockResolvedValue({
      code: 0,
      msg: 'success',
      data: { message_id: 'msg-123' },
    }),
    replyMessage: vi.fn().mockResolvedValue({
      code: 0,
      msg: 'success',
      data: { message_id: 'msg-reply-123' },
    }),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── sendTextMessage ───

describe('sendTextMessage', () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
  });

  it('should send a text message via client.sendMessage', async () => {
    const result = await sendTextMessage(client, {
      chatId: 'oc-chat-1',
      text: 'Hello, world!',
    });

    expect(client.sendMessage).toHaveBeenCalledOnce();
    expect(client.sendMessage).toHaveBeenCalledWith({
      receive_id_type: 'chat_id',
      receive_id: 'oc-chat-1',
      msg_type: 'text',
      content: JSON.stringify({ text: 'Hello, world!' }),
    });
    expect(client.replyMessage).not.toHaveBeenCalled();
    expect(result.code).toBe(0);
    expect(result.data.message_id).toBe('msg-123');
  });

  it('should reply to a message when replyToMessageId is set', async () => {
    const result = await sendTextMessage(client, {
      chatId: 'oc-chat-1',
      text: 'This is a reply',
      replyToMessageId: 'om-original-msg',
    });

    expect(client.replyMessage).toHaveBeenCalledOnce();
    expect(client.replyMessage).toHaveBeenCalledWith('om-original-msg', {
      receive_id_type: 'chat_id',
      receive_id: 'oc-chat-1',
      msg_type: 'text',
      content: JSON.stringify({ text: 'This is a reply' }),
    });
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(result.data.message_id).toBe('msg-reply-123');
  });

  it('should format content as JSON with text field', async () => {
    await sendTextMessage(client, {
      chatId: 'oc-chat-1',
      text: 'Test message',
    });

    const callArgs = client.sendMessage.mock.calls[0][0];
    const content = JSON.parse(callArgs.content);
    expect(content).toEqual({ text: 'Test message' });
  });
});

// ─── sendCard ───

describe('sendCard', () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
  });

  it('should send an interactive card via client.sendMessage', async () => {
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: 'Test' } },
      elements: [{ tag: 'markdown', content: 'Hello' }],
    };

    const result = await sendCard(client, {
      chatId: 'oc-chat-1',
      card,
    });

    expect(client.sendMessage).toHaveBeenCalledOnce();
    expect(client.sendMessage).toHaveBeenCalledWith({
      receive_id_type: 'chat_id',
      receive_id: 'oc-chat-1',
      msg_type: 'interactive',
      content: JSON.stringify(card),
    });
    expect(client.replyMessage).not.toHaveBeenCalled();
    expect(result.code).toBe(0);
  });

  it('should reply with a card when replyToMessageId is set', async () => {
    const card = { elements: [{ tag: 'markdown', content: 'Reply card' }] };

    await sendCard(client, {
      chatId: 'oc-chat-1',
      card,
      replyToMessageId: 'om-original-msg',
    });

    expect(client.replyMessage).toHaveBeenCalledOnce();
    expect(client.replyMessage).toHaveBeenCalledWith('om-original-msg', {
      receive_id_type: 'chat_id',
      receive_id: 'oc-chat-1',
      msg_type: 'interactive',
      content: JSON.stringify(card),
    });
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('should serialize card to JSON string', async () => {
    const card = { config: { wide_screen_mode: true }, elements: [] };

    await sendCard(client, {
      chatId: 'oc-chat-1',
      card,
    });

    const callArgs = client.sendMessage.mock.calls[0][0];
    expect(callArgs.msg_type).toBe('interactive');
    const parsed = JSON.parse(callArgs.content);
    expect(parsed).toEqual(card);
  });
});

// ─── updateCard ───

describe('updateCard', () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
  });

  it('should call client.updateMessage with correct parameters', async () => {
    const card = { elements: [{ tag: 'markdown', content: 'Updated content' }] };

    await updateCard(client, {
      messageId: 'om-msg-to-update',
      card,
    });

    expect(client.updateMessage).toHaveBeenCalledOnce();
    expect(client.updateMessage).toHaveBeenCalledWith(
      'om-msg-to-update',
      'interactive',
      card,
    );
  });

  it('should return void', async () => {
    const result = await updateCard(client, {
      messageId: 'om-msg-1',
      card: { elements: [] },
    });

    expect(result).toBeUndefined();
  });
});

// ─── setTypingState ───

describe('setTypingState', () => {
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    client = createMockClient();
  });

  it('should call client.setTyping with chatId', async () => {
    await setTypingState(client, 'oc-chat-1');

    expect(client.setTyping).toHaveBeenCalledOnce();
    expect(client.setTyping).toHaveBeenCalledWith('oc-chat-1');
  });

  it('should return void', async () => {
    const result = await setTypingState(client, 'oc-chat-1');

    expect(result).toBeUndefined();
  });
});
