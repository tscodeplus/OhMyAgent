import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFeishuServer } from '../../extensions/channel-feishu/feishu-server.js';
import { FeishuRouter } from '../../extensions/channel-feishu/feishu-router.js';
import type { FastifyInstance } from 'fastify';

describe('Rate Limiter', () => {
  let server: FastifyInstance;
  let router: FeishuRouter;

  // Token-only mode: plaintext requests authenticate via the body token, so
  // these tests exercise the rate limiter without needing signed payloads.
  const AUTH_CONFIG = {
    verificationToken: 'test-token',
  };

  beforeEach(async () => {
    router = new FeishuRouter();
    server = createFeishuServer({
      port: 0,
      feishuAuth: AUTH_CONFIG,
      feishuRouter: router,
      rateLimit: {
        maxRequests: 3, // Low limit for testing
        windowMs: 60000,
      },
    });
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
  });

  it('allows requests under the limit', async () => {
    for (let i = 0; i < 3; i++) {
      const response = await server.inject({
        method: 'POST',
        url: '/webhook/event',
        payload: { challenge: 'test', token: 'test-token', type: 'url_verification' },
      });
      expect(response.statusCode).toBe(200);
    }
  });

  it('returns 429 when rate limit is exceeded on /webhook/event', async () => {
    // Exhaust the limit (3 requests)
    for (let i = 0; i < 3; i++) {
      await server.inject({
        method: 'POST',
        url: '/webhook/event',
        payload: { challenge: 'test', token: 'test-token', type: 'url_verification' },
      });
    }

    // 4th request should be rate limited
    const response = await server.inject({
      method: 'POST',
      url: '/webhook/event',
      payload: { challenge: 'test', token: 'test-token', type: 'url_verification' },
    });
    expect(response.statusCode).toBe(429);
    const body = JSON.parse(response.payload);
    expect(body.msg).toBe('Too Many Requests');
  });

  it('returns 429 when rate limit is exceeded on /webhook/card', async () => {
    // Exhaust the limit on /webhook/card
    for (let i = 0; i < 3; i++) {
      await server.inject({
        method: 'POST',
        url: '/webhook/card',
        payload: {
          operator: { open_id: 'ou_user' },
          token: 'test-token',
          action: { tag: 'button', value: { key: 'value' } },
          context: { open_chat_id: 'oc_chat' },
        },
      });
    }

    // 4th request should be rate limited
    const response = await server.inject({
      method: 'POST',
      url: '/webhook/card',
      payload: {
        operator: { open_id: 'ou_user' },
        token: 'test-token',
        action: { tag: 'button', value: { key: 'value' } },
        context: { open_chat_id: 'oc_chat' },
      },
    });
    expect(response.statusCode).toBe(429);
  });

  it('recovers after window expires', async () => {
    // Use a very short window for testing recovery
    await server.close();
    router = new FeishuRouter();
    server = createFeishuServer({
      port: 0,
      feishuAuth: AUTH_CONFIG,
      feishuRouter: router,
      rateLimit: {
        maxRequests: 2,
        windowMs: 100, // 100ms window
      },
    });
    await server.ready();

    // Exhaust the limit
    for (let i = 0; i < 2; i++) {
      await server.inject({
        method: 'POST',
        url: '/webhook/event',
        payload: { challenge: 'test', token: 'test-token', type: 'url_verification' },
      });
    }

    // 3rd request should be rate limited
    let response = await server.inject({
      method: 'POST',
      url: '/webhook/event',
      payload: { challenge: 'test', token: 'test-token', type: 'url_verification' },
    });
    expect(response.statusCode).toBe(429);

    // Wait for the window to expire
    await new Promise(resolve => setTimeout(resolve, 150));

    // After window expires, request should succeed
    response = await server.inject({
      method: 'POST',
      url: '/webhook/event',
      payload: { challenge: 'test', token: 'test-token', type: 'url_verification' },
    });
    expect(response.statusCode).toBe(200);
  });
});
