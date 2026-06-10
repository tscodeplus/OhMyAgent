/**
 * Fastify HTTP server for Feishu webhook callbacks.
 *
 * Routes:
 *   GET  /health        — health check
 *   POST /webhook/event — Feishu event callback (encryption, challenge, dedup, routing)
 *   POST /webhook/card  — Card action callback
 *
 * Rate limiting:
 *   Both POST routes are protected by a sliding-window rate limiter keyed by IP address.
 */

import http from 'node:http';
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from 'fastify';
import {
  decryptEvent,
  authenticateEvent,
  type FeishuAuthConfig,
} from './feishu-auth.js';
import type { FeishuRouter } from './feishu-router.js';
import type { FeishuCardActionCallback } from './feishu-types.js';
import { i18n } from '../../src/i18n/index.js';

// Captured raw request body, populated by the JSON content-type parser below
// so we can verify Feishu's signature over the exact bytes received.
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

// ─── Sliding-Window Rate Limiter ───

interface RateLimiterOptions {
  maxRequests: number;
  windowMs: number;
}

class SlidingWindowRateLimiter {
  private store: Map<string, number[]>;
  private maxRequests: number;
  private windowMs: number;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(options: RateLimiterOptions) {
    this.store = new Map();
    this.maxRequests = options.maxRequests;
    this.windowMs = options.windowMs;
    this.cleanupTimer = setInterval(() => this.cleanup(), 60000);
    if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  updateConfig(options: RateLimiterOptions): void {
    this.maxRequests = options.maxRequests;
    this.windowMs = options.windowMs;
  }

  /**
   * Check whether a request from the given key should be allowed.
   * Returns `true` if the request passes, `false` if rate-limited.
   */
  check(key: string): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    let timestamps = this.store.get(key);
    if (!timestamps) {
      timestamps = [];
      this.store.set(key, timestamps);
    }

    // Remove timestamps outside the current window
    const valid = timestamps.filter(t => t > windowStart);

    if (valid.length >= this.maxRequests) {
      // Keep the valid list (don't add the current request)
      this.store.set(key, valid);
      return false;
    }

    valid.push(now);
    this.store.set(key, valid);
    return true;
  }

  /** Remove stale entries to free memory. */
  private cleanup(): void {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    for (const [key, timestamps] of this.store.entries()) {
      const valid = timestamps.filter(t => t > windowStart);
      if (valid.length === 0) {
        this.store.delete(key);
      } else {
        this.store.set(key, valid);
      }
    }
  }

  /** Stop the cleanup timer and release resources. */
  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.store.clear();
  }
}

// ─── Types ───

export interface FeishuServerOptions {
  port: number;
  host?: string;
  feishuAuth: FeishuAuthConfig;
  feishuRouter: FeishuRouter;
  cardActionHandler?: (
    action: FeishuCardActionCallback,
  ) => Promise<Record<string, unknown> | void>;
  logger?: any;
  rateLimit?: {
    maxRequests: number;
    windowMs: number;
  };
}

// ─── Factory ───

/**
 * Create and configure a Fastify HTTP server for Feishu webhooks.
 */
export function createFeishuServer(
  options: FeishuServerOptions,
): FastifyInstance<http.Server> {
  const {
    port,
    host = '0.0.0.0',
    feishuAuth,
    feishuRouter,
    cardActionHandler,
    logger,
  } = options;

  // Initialize rate limiter with config (defaults: 100 requests per 60 seconds)
  const maxRequests = options.rateLimit?.maxRequests ?? 100;
  const windowMs = options.rateLimit?.windowMs ?? 60000;
  const rateLimiter = new SlidingWindowRateLimiter({ maxRequests, windowMs });

  const app = Fastify<http.Server>({
    logger: false,
    bodyLimit: 1024 * 1024, // 1 MB
  });

  // Capture the raw request body so we can verify Feishu's SHA-256 signature,
  // which is computed over the exact bytes sent (re-serializing the parsed
  // object would not reproduce them). Without this the signature can never be
  // checked on the encrypted path.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      req.rawBody = body as string;
      try {
        done(null, body ? JSON.parse(body as string) : {});
      } catch (err) {
        (err as any).statusCode = 400;
        done(err as Error, undefined);
      }
    },
  );

  // Store port/host for external use
  (app as any).__port = port;
  (app as any).__host = host;
  (app as any).updateRateLimit = (opts: RateLimiterOptions) => rateLimiter.updateConfig(opts);

  // Clean up rate limiter when the server shuts down
  app.addHook('onClose', (_instance, done) => {
    rateLimiter.destroy();
    done();
  });

  // ─── GET /health ───

  app.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ status: 'ok', timestamp: Date.now() });
  });

  // ─── POST /webhook/event ───

  app.post('/webhook/event', async (request: FastifyRequest, reply: FastifyReply) => {
    // Rate limit check
    const clientIp = request.ip;
    if (!rateLimiter.check(clientIp)) {
      return reply
        .code(429)
        .send({ code: -1, msg: i18n.t('feishu-server:rateLimited') });
    }

    const body = request.body as Record<string, unknown>;
    const rawBody = request.rawBody;
    const signature =
      (body.signature as string) ||
      (request.headers['x-lark-signature'] as string);
    const timestamp =
      (body.timestamp as string) ||
      (request.headers['x-lark-request-timestamp'] as string);
    const nonce =
      (body.nonce as string) ||
      (request.headers['x-lark-request-nonce'] as string);

    // Authenticate BEFORE doing any work. Fail-closed: when an encryptKey is
    // configured the signature (computed over rawBody) and timestamp freshness
    // are verified on EVERY path, including encrypted events and the URL
    // verification challenge. When only a verificationToken is set we fall back
    // to constant-time token comparison.
    const auth = authenticateEvent(
      { rawBody, signature, timestamp, nonce, parsedBody: body },
      feishuAuth,
    );
    if (!auth.ok) {
      const status = auth.reason === 'no-credentials' ? 500 : 403;
      logger?.warn?.({ reason: auth.reason, clientIp }, 'feishu webhook auth rejected');
      return reply
        .code(status)
        .send({ code: -1, msg: i18n.t('feishu-server:signatureVerifyFailed') });
    }

    // Encrypted event — decrypt now that the request is authenticated.
    if (body.encrypt && feishuAuth.encryptKey) {
      try {
        const decrypted = decryptEvent(
          body.encrypt as string,
          feishuAuth.encryptKey,
        );
        const parsed = JSON.parse(decrypted);

        if (parsed.challenge) {
          return reply.send({ challenge: parsed.challenge });
        }

        feishuRouter.route(parsed).catch((err) => {
          logger?.error?.({ err }, 'feishu event routing failed (encrypted)');
        });
        return reply.send({ code: 0 });
      } catch {
        return reply.code(400).send({ code: -1, msg: i18n.t('feishu-server:decryptFailed') });
      }
    }

    // Plaintext URL Verification challenge (token-only mode).
    if (body.challenge) {
      return reply.send({ challenge: body.challenge });
    }

    // Route event (async, return immediately).
    feishuRouter.route(body).catch((err) => {
      logger?.error?.({ err }, 'feishu event routing failed');
    });

    return reply.send({ code: 0 });
  });

  // ─── POST /webhook/card ───

  app.post(
    '/webhook/card',
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Rate limit check
      const clientIp = request.ip;
      if (!rateLimiter.check(clientIp)) {
        return reply
          .code(429)
          .send({ code: -1, msg: i18n.t('feishu-server:rateLimited') });
      }

      const body = request.body as FeishuCardActionCallback;
      const rawBody = request.rawBody;
      const signature =
        ((body as any).signature as string) ||
        (request.headers['x-lark-signature'] as string);
      const timestamp =
        ((body as any).timestamp as string) ||
        (request.headers['x-lark-request-timestamp'] as string);
      const nonce =
        ((body as any).nonce as string) ||
        (request.headers['x-lark-request-nonce'] as string);

      // Authenticate before processing (same fail-closed model as /webhook/event).
      const auth = authenticateEvent(
        { rawBody, signature, timestamp, nonce, parsedBody: body as any },
        feishuAuth,
      );
      if (!auth.ok) {
        const status = auth.reason === 'no-credentials' ? 500 : 403;
        logger?.warn?.({ reason: auth.reason, clientIp }, 'feishu card auth rejected');
        return reply
          .code(status)
          .send({ code: -1, msg: i18n.t('feishu-server:signatureVerifyFailed') });
      }

      // Handle URL Verification challenge
      if ((body as any).challenge) {
        return reply.send({ challenge: (body as any).challenge });
      }

      // Route to card action handler
      if (cardActionHandler) {
        try {
          const result = await cardActionHandler(body);
          if (result) {
            return reply.send(result);
          }
        } catch {
          return reply
            .code(500)
            .send({ code: -1, msg: i18n.t('feishu-server:cardActionError') });
        }
      }

      return reply.send({ code: 0 });
    },
  );

  return app;
}
