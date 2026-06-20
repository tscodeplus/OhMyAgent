/**
 * Tests for FeishuClient.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FeishuClient } from '../../extensions/channel-feishu/feishu-client.js';
import pino from 'pino';

// Suppress log output during tests.
const silentLogger = pino({ level: 'silent' });

const TEST_CONFIG = {
  appId: 'test-app-id',
  appSecret: 'test-app-secret',
};

// ─── Mock Helpers ───

function mockFetchSuccess(data: Record<string, unknown> = {}): void {
  const mockResponse = {
    ok: true,
    json: async () => ({ code: 0, msg: 'success', ...data }),
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));
}

function mockFetchError(status: number, body: string): void {
  const mockResponse = {
    ok: false,
    status,
    text: async () => body,
    json: async () => ({}),
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));
}

function mockFetchSequence(responses: Array<{ ok: boolean; status?: number; body?: any; json?: () => Promise<any>; text?: () => Promise<string> }>): void {
  const mockFn = vi.fn();
  for (const resp of responses) {
    mockFn.mockResolvedValueOnce({
      ok: resp.ok,
      status: resp.status ?? 200,
      json: resp.json ?? (async () => resp.body ?? { code: 0, msg: 'success' }),
      text: resp.text ?? (async () => ''),
    });
  }
  vi.stubGlobal('fetch', mockFn);
}

// ─── Tests ───

describe('FeishuClient', () => {
  let client: FeishuClient;

  beforeEach(() => {
    vi.useFakeTimers();
    client = new FeishuClient(TEST_CONFIG, silentLogger);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── Token Management ───

  describe('getAccessToken', () => {
    it('should fetch and return tenant access token', async () => {
      mockFetchSuccess({
        tenant_access_token: 't-abc123',
        expire: 7200,
      });

      const token = await client.getAccessToken();
      expect(token).toBe('t-abc123');
    });

    it('should send correct request body for token', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-abc123', expire: 7200 }),
      });
      vi.stubGlobal('fetch', fetchMock);

      await client.getAccessToken();

      expect(fetchMock).toHaveBeenCalledWith(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ app_id: 'test-app-id', app_secret: 'test-app-secret' }),
        }),
      );
    });

    it('should throw on HTTP error', async () => {
      mockFetchError(500, 'Internal Server Error');

      await expect(client.getAccessToken()).rejects.toThrow('Failed to get tenant access token: 500');
    });

    it('should throw on non-zero API code', async () => {
      mockFetchSuccess({ code: 10003, msg: 'invalid app_id' });

      await expect(client.getAccessToken()).rejects.toThrow('Token API error 10003: invalid app_id');
    });

    it('should throw when token is missing from response', async () => {
      mockFetchSuccess({ code: 0, msg: 'ok', expire: 7200 });

      await expect(client.getAccessToken()).rejects.toThrow('Token API returned no token');
    });

    it('should cache token and not fetch again', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-abc123', expire: 7200 }),
      });
      vi.stubGlobal('fetch', fetchMock);

      const token1 = await client.getAccessToken();
      const token2 = await client.getAccessToken();

      expect(token1).toBe('t-abc123');
      expect(token2).toBe('t-abc123');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should refresh token when expired', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-abc123', expire: 300 }),
      });
      vi.stubGlobal('fetch', fetchMock);

      // First call
      const token1 = await client.getAccessToken();
      expect(token1).toBe('t-abc123');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Advance time past token expiry (300 seconds - 300 seconds early refresh = 0)
      // With expire=300 and 5-min early refresh, tokenExpiresAt = now + 0 = now
      vi.advanceTimersByTime(1000);

      // Second call should refresh
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-new-token', expire: 7200 }),
      });

      const token2 = await client.getAccessToken();
      expect(token2).toBe('t-new-token');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('invalidateToken', () => {
    it('should force token refresh on next getAccessToken call', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-abc123', expire: 7200 }),
      });
      vi.stubGlobal('fetch', fetchMock);

      await client.getAccessToken();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      client.invalidateToken();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-new', expire: 7200 }),
      });

      const token = await client.getAccessToken();
      expect(token).toBe('t-new');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // ─── Messages ───

  describe('sendMessage', () => {
    it('should send message with correct request format', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', data: { message_id: 'msg-123' } }),
      });
      vi.stubGlobal('fetch', fetchMock);

      // First call: getAccessToken
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-abc123', expire: 7200 }),
      });

      const result = await client.sendMessage({
        receive_id_type: 'chat_id',
        receive_id: 'oc-test-chat',
        msg_type: 'text',
        content: JSON.stringify({ text: 'Hello' }),
      });

      expect(result.code).toBe(0);
      expect(result.data.message_id).toBe('msg-123');

      // Second call: sendMessage
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const sendCall = fetchMock.mock.calls[1];
      expect(sendCall[0]).toContain('/im/v1/messages?receive_id_type=chat_id');
      expect(sendCall[1].method).toBe('POST');
      const body = JSON.parse(sendCall[1].body);
      expect(body).toEqual({
        receive_id: 'oc-test-chat',
        msg_type: 'text',
        content: '{"text":"Hello"}',
      });
    });

    it('should include uuid when provided', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-abc123', expire: 7200 }),
      });
      vi.stubGlobal('fetch', fetchMock);

      // getAccessToken
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-abc123', expire: 7200 }),
      });
      // sendMessage
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', data: { message_id: 'msg-456' } }),
      });

      await client.sendMessage({
        receive_id_type: 'chat_id',
        receive_id: 'oc-test-chat',
        msg_type: 'text',
        content: '{"text":"Hello"}',
        uuid: 'uuid-123',
      });

      const sendCall = fetchMock.mock.calls[1];
      const body = JSON.parse(sendCall[1].body);
      expect(body.uuid).toBe('uuid-123');
    });

    it('should throw on non-zero response code', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-abc123', expire: 7200 }),
      });
      vi.stubGlobal('fetch', fetchMock);

      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-abc123', expire: 7200 }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 230001, msg: 'invalid receive_id' }),
      });

      await expect(
        client.sendMessage({
          receive_id_type: 'chat_id',
          receive_id: 'bad-id',
          msg_type: 'text',
          content: '{"text":"Hello"}',
        }),
      ).rejects.toThrow('Feishu API error code 230001: invalid receive_id');
    });
  });

  describe('recallMessage', () => {
    it('should call DELETE on the message endpoint', async () => {
      const fetchMock = vi.fn();
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-abc123', expire: 7200 }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', data: {} }),
      });
      vi.stubGlobal('fetch', fetchMock);

      await client.recallMessage('om_123');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toContain('/im/v1/messages/om_123');
      expect(fetchMock.mock.calls[1][1].method).toBe('DELETE');
    });
  });

  describe('sendCardByCardId', () => {
    it('retries when Feishu reports cardid is invalid, then succeeds', async () => {
      const reply = vi.fn()
        .mockResolvedValueOnce({
          code: 230099,
          msg: 'Failed to create card content, ext=ErrCode: 11310; ErrMsg: cardid is invalid;',
        })
        .mockResolvedValueOnce({
          code: 0,
          msg: 'success',
          data: { message_id: 'msg-card-1' },
        });

      (client as any).sdk = {
        im: {
          message: {
            reply,
            create: vi.fn(),
          },
        },
      };

      const promise = expect(client.sendCardByCardId('chat-1', 'card-1', 'reply-msg-1')).resolves.toBe('msg-card-1');
      await vi.advanceTimersByTimeAsync(300);
      await promise;
      expect(reply).toHaveBeenCalledTimes(2);
    });

    it('throws after exhausting invalid card id retries', async () => {
      const reply = vi.fn().mockResolvedValue({
        code: 230099,
        msg: 'Failed to create card content, ext=ErrCode: 11310; ErrMsg: cardid is invalid;',
      });

      (client as any).sdk = {
        im: {
          message: {
            reply,
            create: vi.fn(),
          },
        },
      };

      const promise = expect(client.sendCardByCardId('chat-1', 'card-1', 'reply-msg-1'))
        .rejects.toThrow('sendCardByCardId error 230099');
      await vi.advanceTimersByTimeAsync(300 + 600 + 900 + 1200 + 1500);
      await promise;
      // 6 calls: initial + 5 retries (CARD_ID_RETRY_ATTEMPTS=5)
      expect(reply).toHaveBeenCalledTimes(6);
    });
  });

  describe('replyMessage', () => {
    it('should reply with correct request format', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-abc123', expire: 7200 }),
      });
      vi.stubGlobal('fetch', fetchMock);

      // getAccessToken
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-abc123', expire: 7200 }),
      });
      // replyMessage
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', data: { message_id: 'msg-reply-123' } }),
      });

      const result = await client.replyMessage('om-original-msg', {
        receive_id_type: 'chat_id',
        receive_id: 'oc-test-chat',
        msg_type: 'text',
        content: JSON.stringify({ text: 'Reply' }),
      });

      expect(result.data.message_id).toBe('msg-reply-123');

      const replyCall = fetchMock.mock.calls[1];
      expect(replyCall[0]).toContain('/im/v1/messages/om-original-msg/reply');
      expect(replyCall[1].method).toBe('POST');
      const body = JSON.parse(replyCall[1].body);
      expect(body).toEqual({
        msg_type: 'text',
        content: '{"text":"Reply"}',
      });
    });
  });

  // ─── Typing State ───

  describe('setTyping', () => {
    it('should send typing action', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-abc123', expire: 7200 }),
      });
      vi.stubGlobal('fetch', fetchMock);

      // getAccessToken
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-abc123', expire: 7200 }),
      });
      // setTyping
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, msg: 'success' }),
      });

      await client.setTyping('oc-test-chat');

      const typingCall = fetchMock.mock.calls[1];
      expect(typingCall[0]).toContain('/im/v1/chats/oc-test-chat/user_typing_status');
      expect(typingCall[1].method).toBe('POST');
      expect(JSON.parse(typingCall[1].body)).toEqual({ action: 'typing' });
    });

    it('should not throw on failure (non-critical)', async () => {
      mockFetchError(500, 'Internal Server Error');

      // Should not throw
      await expect(client.setTyping('oc-test-chat')).resolves.toBeUndefined();
    });
  });

  describe('clearTyping', () => {
    it('should send cancel action', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-abc123', expire: 7200 }),
      });
      vi.stubGlobal('fetch', fetchMock);

      // getAccessToken
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-abc123', expire: 7200 }),
      });
      // clearTyping
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, msg: 'success' }),
      });

      await client.clearTyping('oc-test-chat');

      const typingCall = fetchMock.mock.calls[1];
      expect(JSON.parse(typingCall[1].body)).toEqual({ action: 'cancel' });
    });
  });

  // ─── Emoji Reaction ───

  describe('addReaction', () => {
    it('should add reaction and return reaction_id', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-abc123', expire: 7200 }),
      });
      vi.stubGlobal('fetch', fetchMock);

      // getAccessToken
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-abc123', expire: 7200 }),
      });
      // addReaction
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', data: { reaction_id: 're-123' } }),
      });

      const reactionId = await client.addReaction('om-msg-1', 'THUMBSUP');
      expect(reactionId).toBe('re-123');

      const reactionCall = fetchMock.mock.calls[1];
      expect(reactionCall[0]).toContain('/im/v1/messages/om-msg-1/reactions');
      expect(JSON.parse(reactionCall[1].body)).toEqual({
        reaction_type: { emoji_type: 'THUMBSUP' },
      });
    });

    it('should default to Typing emoji', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-abc123', expire: 7200 }),
      });
      vi.stubGlobal('fetch', fetchMock);

      // getAccessToken
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-abc123', expire: 7200 }),
      });
      // addReaction
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', data: { reaction_id: 're-456' } }),
      });

      await client.addReaction('om-msg-1');

      const reactionCall = fetchMock.mock.calls[1];
      expect(JSON.parse(reactionCall[1].body)).toEqual({
        reaction_type: { emoji_type: 'Typing' },
      });
    });

    it('should return null on failure (non-critical)', async () => {
      mockFetchError(500, 'Internal Server Error');

      const reactionId = await client.addReaction('om-msg-1', 'THUMBSUP');
      expect(reactionId).toBeNull();
    });
  });

  describe('removeReaction', () => {
    it('should send DELETE request', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-abc123', expire: 7200 }),
      });
      vi.stubGlobal('fetch', fetchMock);

      // getAccessToken
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, msg: 'success', tenant_access_token: 't-abc123', expire: 7200 }),
      });
      // removeReaction
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      await client.removeReaction('om-msg-1', 're-123');

      const removeCall = fetchMock.mock.calls[1];
      expect(removeCall[0]).toContain('/im/v1/messages/om-msg-1/reactions/re-123');
      expect(removeCall[1].method).toBe('DELETE');
    });

    it('should not throw on failure (non-critical)', async () => {
      mockFetchError(404, 'Not Found');

      await expect(client.removeReaction('om-msg-1', 're-123')).resolves.toBeUndefined();
    });
  });
});
