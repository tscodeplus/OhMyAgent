import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetWebUIToken, webuiAuthHook } from '../../src/app/webui-auth';

/**
 * Regression tests for the P0 auth bypass chain reported in
 * MyDocs/code-review-2026-08-25.md:
 *
 *   #2 — extension-registered routes ("/api/channels/.../qr...") must NOT
 *        bypass webuiAuthHook (hook is registered BEFORE loadAll in bootstrap.ts).
 *   #3 — the "/api/subscriptions" prefix must not be in the public exemption list.
 *   #1 — /wechat/login/start must require auth (only /wechat/login and
 *        /wechat/login/poll are public by design).
 *
 * These tests pin the exemption lists themselves: if someone re-adds a
 * bypassed prefix, they fail here first.
 */

function makeRequest(url: string, authorization?: string, method = 'GET') {
  return {
    url,
    method,
    headers: authorization ? { authorization } : {},
  } as never;
}

function makeReply() {
  const reply = {
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
  };
  const boxed = reply as unknown as {
    status(code: number): unknown;
    send(body: unknown): unknown;
  };
  boxed.status = (code: number) => {
    reply.statusCode = code;
    return boxed;
  };
  boxed.send = (body: unknown) => {
    reply.body = body;
    return boxed;
  };
  return reply;
}

const TEST_TOKEN = 'test-webui-token';

describe('webuiAuthHook exemption list', () => {
  beforeEach(() => {
    process.env.WEBUI_TOKEN = TEST_TOKEN;
    resetWebUIToken();
  });

  afterEach(() => {
    delete process.env.WEBUI_TOKEN;
    resetWebUIToken();
  });

  describe('routes that were previously reachable WITHOUT auth must now 401', () => {
    const mustBeProtected = [
      '/wechat/login/start',
      '/wechat/login/confirm',
      '/api/channels/wechat/qr/start',
      '/api/channels/wechat/qr/status',
      '/api/subscriptions',
      '/api/subscriptions/google/login',
      '/api/subscriptions/google/refresh',
    ];

    for (const path of mustBeProtected) {
      it(`401s unauthenticated request to ${path}`, async () => {
        const reply = makeReply();
        await webuiAuthHook(makeRequest(path), reply);
        expect(reply.statusCode).toBe(401);
      });
    }
  });

  describe('intentionally public paths stay public (no auth challenge)', () => {
    const publicPaths = [
      '/',
      '/wechat/login',
      '/wechat/login/poll',
      '/api/health',
      '/api/auth/login',
      '/api/feishu/webhook',
      '/api/telegram/webhook',
      '/webhook/event',
    ];

    for (const path of publicPaths) {
      it(`does not challenge ${path}`, async () => {
        const reply = makeReply();
        await webuiAuthHook(makeRequest(path), reply);
        expect(reply.statusCode).toBeUndefined();
      });
    }
  });

  it('accepts a valid bearer token on protected paths', async () => {
    const reply = makeReply();
    await webuiAuthHook(
      makeRequest('/api/channels/wechat/qr/start', `Bearer ${TEST_TOKEN}`),
      reply,
    );
    expect(reply.statusCode).toBeUndefined();
  });

  it('rejects an invalid bearer token with 403', async () => {
    const reply = makeReply();
    await webuiAuthHook(makeRequest('/api/channels/wechat/qr/start', 'Bearer wrong-token'), reply);
    expect(reply.statusCode).toBe(403);
  });

  describe('public prefixes match whole path segments', () => {
    // startsWith('/api/feishu') used to exempt any sibling spelling too, so a
    // future /api/feishu-admin route would have been reachable unauthenticated.
    const siblingsThatMustStayProtected = [
      '/api/feishu-admin',
      '/api/telegram-stats',
      '/api/wechatconsole',
      '/api/health-report',
      '/api/healthcheck',
    ];

    for (const path of siblingsThatMustStayProtected) {
      it(`401s ${path}`, async () => {
        const reply = makeReply();
        await webuiAuthHook(makeRequest(path), reply);
        expect(reply.statusCode).toBe(401);
      });
    }

    it('still exempts real sub-paths of a public prefix', async () => {
      const reply = makeReply();
      await webuiAuthHook(makeRequest('/api/feishu/webhook/callback'), reply);
      expect(reply.statusCode).toBeUndefined();
    });
  });

  describe('query-string token', () => {
    // <img>/<a download>/WebSocket cannot set headers, so GET may carry the
    // token in the URL. Everything else must use the Authorization header —
    // URLs land in history, proxies and Referer headers.
    it('authenticates a GET', async () => {
      const reply = makeReply();
      await webuiAuthHook(makeRequest(`/api/files/serve?path=a.txt&token=${TEST_TOKEN}`), reply);
      expect(reply.statusCode).toBeUndefined();
    });

    for (const method of ['POST', 'PUT', 'DELETE']) {
      it(`is ignored on ${method}`, async () => {
        const reply = makeReply();
        await webuiAuthHook(
          makeRequest(`/api/files/upload?token=${TEST_TOKEN}`, undefined, method),
          reply,
        );
        expect(reply.statusCode).toBe(401);
      });
    }

    it('still accepts a bearer token on state-changing methods', async () => {
      const reply = makeReply();
      await webuiAuthHook(makeRequest('/api/files/upload', `Bearer ${TEST_TOKEN}`, 'POST'), reply);
      expect(reply.statusCode).toBeUndefined();
    });
  });
});
