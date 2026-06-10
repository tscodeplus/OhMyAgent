import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFeishuServer } from '../../extensions/channel-feishu/feishu-server.js';
import { FeishuRouter } from '../../extensions/channel-feishu/feishu-router.js';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// ─── Helpers ───

const ENCRYPT_KEY = 'test-encrypt-key';
const VERIFICATION_TOKEN = 'test-token';

function encryptPayload(plaintext: string, encryptKey: string): string {
  const key = createHash('sha256').update(encryptKey).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return Buffer.concat([iv, encrypted]).toString('base64');
}

/** Compute a Feishu signature over an exact raw body string. */
function signBody(rawBody: string, timestamp: string, nonce: string, encryptKey: string): string {
  return createHash('sha256')
    .update(timestamp + nonce + encryptKey + rawBody)
    .digest('hex');
}

/**
 * Inject a request the way real Feishu sends it when an encrypt key is set:
 * a JSON string body plus X-Lark-Signature / timestamp / nonce headers.
 */
function injectSigned(
  server: FastifyInstance,
  url: string,
  payloadObj: unknown,
  opts: { timestamp?: string; nonce?: string; encryptKey?: string } = {},
) {
  const raw = JSON.stringify(payloadObj);
  const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? 'test-nonce';
  const signature = signBody(raw, timestamp, nonce, opts.encryptKey ?? ENCRYPT_KEY);
  return server.inject({
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      'x-lark-signature': signature,
      'x-lark-request-timestamp': timestamp,
      'x-lark-request-nonce': nonce,
    },
    payload: raw,
  });
}

function makeEventEnvelope(overrides: { eventType?: string; messageId?: string; token?: string } = {}) {
  const {
    eventType = 'im.message.receive_v1',
    messageId = 'om_msg001',
    token = VERIFICATION_TOKEN,
  } = overrides;
  return {
    token,
    header: {
      event_type: eventType,
      event_id: 'ev_001',
      create_time: '1700000000',
      token: VERIFICATION_TOKEN,
      app_id: 'app1',
      tenant_key: 'tenant1',
    },
    event: {
      message: {
        chat_id: 'oc_chat001',
        chat_type: 'p2p',
        message_id: messageId,
        message_type: 'text',
        content: '{"text":"hello"}',
      },
      sender: {
        sender_id: { open_id: 'ou_sender' },
        sender_type: 'user',
        tenant_key: 'tenant1',
      },
    },
  };
}

// ─── Tests (encrypt-key mode: signature required) ───

describe('FeishuServer', () => {
  let server: FastifyInstance;
  let router: FeishuRouter;

  const AUTH_CONFIG = {
    verificationToken: VERIFICATION_TOKEN,
    encryptKey: ENCRYPT_KEY,
  };

  beforeEach(async () => {
    router = new FeishuRouter();
    server = createFeishuServer({
      port: 0,
      feishuAuth: AUTH_CONFIG,
      feishuRouter: router,
    });
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
  });

  describe('GET /health', () => {
    it('returns 200 with status ok', async () => {
      const response = await server.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.status).toBe('ok');
      expect(typeof body.timestamp).toBe('number');
    });
  });

  describe('POST /webhook/event — challenge', () => {
    it('returns challenge for a signed URL verification', async () => {
      const response = await injectSigned(server, '/webhook/event', {
        challenge: 'test-challenge-token',
        token: VERIFICATION_TOKEN,
        type: 'url_verification',
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).challenge).toBe('test-challenge-token');
    });
  });

  describe('POST /webhook/event — message routing', () => {
    it('routes a signed event and returns { code: 0 }', async () => {
      const handler = vi.fn();
      router.on('im.message.receive_v1', handler);

      const response = await injectSigned(server, '/webhook/event', makeEventEnvelope());
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).code).toBe(0);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('POST /webhook/event — replay & tamper protection', () => {
    it('rejects a stale timestamp (replay)', async () => {
      const handler = vi.fn();
      router.on('im.message.receive_v1', handler);

      const stale = String(Math.floor(Date.now() / 1000) - 10 * 60);
      const response = await injectSigned(server, '/webhook/event', makeEventEnvelope(), {
        timestamp: stale,
      });
      expect(response.statusCode).toBe(403);
      expect(handler).not.toHaveBeenCalled();
    });

    it('rejects a request with a missing/invalid signature', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/webhook/event',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(makeEventEnvelope()),
      });
      expect(response.statusCode).toBe(403);
    });

    it('rejects a tampered body', async () => {
      const raw = JSON.stringify(makeEventEnvelope());
      const timestamp = String(Math.floor(Date.now() / 1000));
      const nonce = 'n1';
      const signature = signBody(raw, timestamp, nonce, ENCRYPT_KEY);
      const response = await server.inject({
        method: 'POST',
        url: '/webhook/event',
        headers: {
          'content-type': 'application/json',
          'x-lark-signature': signature,
          'x-lark-request-timestamp': timestamp,
          'x-lark-request-nonce': nonce,
        },
        payload: JSON.stringify(makeEventEnvelope({ messageId: 'tampered' })),
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe('POST /webhook/event — encrypted event', () => {
    it('decrypts a signed encrypted event before routing', async () => {
      const handler = vi.fn();
      router.on('im.message.receive_v1', handler);

      const envelope = makeEventEnvelope({ messageId: 'om_encrypted' });
      const encrypted = encryptPayload(JSON.stringify(envelope), ENCRYPT_KEY);
      const response = await injectSigned(server, '/webhook/event', { encrypt: encrypted });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).code).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(handler).toHaveBeenCalledOnce();
    });

    it('returns challenge from a signed encrypted body', async () => {
      const challengeBody = {
        challenge: 'encrypted-challenge',
        token: VERIFICATION_TOKEN,
        type: 'url_verification',
      };
      const encrypted = encryptPayload(JSON.stringify(challengeBody), ENCRYPT_KEY);
      const response = await injectSigned(server, '/webhook/event', { encrypt: encrypted });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).challenge).toBe('encrypted-challenge');
    });

    it('returns 400 for invalid (but signed) encrypted data', async () => {
      const response = await injectSigned(server, '/webhook/event', {
        encrypt: 'not-valid-encrypted-data!!!',
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /webhook/card', () => {
    it('returns { code: 0 } when no handler is registered (signed)', async () => {
      const response = await injectSigned(server, '/webhook/card', {
        operator: { open_id: 'ou_user' },
        token: VERIFICATION_TOKEN,
        action: { tag: 'button', value: { key: 'value' } },
        host: 'https://example.com',
        context: { open_chat_id: 'oc_chat' },
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).code).toBe(0);
    });

    it('routes to card action handler and returns result (signed)', async () => {
      const cardHandler = vi.fn().mockResolvedValue({ toast: { type: 'info', content: 'Done' } });
      await server.close();
      server = createFeishuServer({
        port: 0,
        feishuAuth: AUTH_CONFIG,
        feishuRouter: router,
        cardActionHandler: cardHandler,
      });
      await server.ready();

      const response = await injectSigned(server, '/webhook/card', {
        operator: { open_id: 'ou_user' },
        token: VERIFICATION_TOKEN,
        action: { tag: 'button', value: { key: 'approve' } },
        host: 'https://example.com',
        context: { open_chat_id: 'oc_chat' },
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).toast.type).toBe('info');
      expect(cardHandler).toHaveBeenCalledOnce();
    });

    it('rejects an unsigned card callback', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/webhook/card',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          operator: { open_id: 'ou_user' },
          token: VERIFICATION_TOKEN,
          action: { tag: 'button', value: {} },
        }),
      });
      expect(response.statusCode).toBe(403);
    });
  });
});

// ─── Tests (token-only mode: no encrypt key, signature not required) ───

describe('FeishuServer — token-only mode', () => {
  let server: FastifyInstance;
  let router: FeishuRouter;

  beforeEach(async () => {
    router = new FeishuRouter();
    server = createFeishuServer({
      port: 0,
      feishuAuth: { verificationToken: VERIFICATION_TOKEN },
      feishuRouter: router,
    });
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
  });

  it('routes a plaintext event with a valid token', async () => {
    const handler = vi.fn();
    router.on('im.message.receive_v1', handler);

    const response = await server.inject({
      method: 'POST',
      url: '/webhook/event',
      payload: makeEventEnvelope(),
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.payload).code).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('rejects an event with the wrong token', async () => {
    const handler = vi.fn();
    router.on('im.message.receive_v1', handler);

    const response = await server.inject({
      method: 'POST',
      url: '/webhook/event',
      payload: { ...makeEventEnvelope(), token: 'wrong-token' },
    });
    expect(response.statusCode).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });
});

// ─── Tests (no credentials: fail-closed) ───

describe('FeishuServer — no credentials configured', () => {
  it('rejects all webhook traffic with 500', async () => {
    const router = new FeishuRouter();
    const server = createFeishuServer({
      port: 0,
      feishuAuth: {},
      feishuRouter: router,
    });
    await server.ready();
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/webhook/event',
        payload: makeEventEnvelope(),
      });
      expect(response.statusCode).toBe(500);
    } finally {
      await server.close();
    }
  });
});


