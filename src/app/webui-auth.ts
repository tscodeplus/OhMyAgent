/**
 * WebUI Token Authentication Middleware
 *
 * Simple Token auth: reads OMA_WEBUI_TOKEN (injected by the desktop shell) or
 * WEBUI_TOKEN from .env, generates a random token if neither is configured.
 * All /api/* and /ws requests must include Authorization: Bearer <token>
 * header.
 *
 * Excluded paths (no token required):
 *   - /api/feishu/*, /api/telegram/*, /api/wechat/*, /api/qq/*   (IM webhooks)
 *   - /api/auth/login, /api/health                                (login + health)
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { safeEqual } from '../shared/safe-equal.js';
import { createLogger } from './logger.js';

/**
 * Public paths that never require a token.
 *
 * Everything else — including any path registered by extensions at runtime —
 * requires auth. This default-protect posture matters because Fastify applies
 * onRequest hooks only to routes registered after the hook, so new routes
 * would otherwise silently bypass auth if they used an unexpected prefix.
 */
const PUBLIC_EXACT = [
  '/', // root redirect to /webui/
  '/wechat/login', // WeChat QR login page (GET) + QR creation (POST)
];

const PUBLIC_PREFIXES = [
  // IM platform webhooks (authenticated by platform signature)
  '/api/feishu',
  '/api/telegram',
  '/api/wechat',
  '/api/qq',
  '/webhook/event', // Feishu event webhook (signature-verified in feishu-auth.ts)
  '/webhook/telegram', // Telegram webhook (secret-token verified in webhook-handler.ts)
  // login + health
  '/api/auth/login',
  '/api/health',
  '/api/config/minimal-check',
  '/qr-exchange/',
  '/api/system/update-status',
  // WeChat QR scan status polling (returns no credentials; bot activation on
  // confirm happens server-side, see channel-wechat registerQrRoutes)
  '/wechat/login/poll',
];

let configuredToken: string;

export function getWebUIToken(): string {
  if (!configuredToken) {
    // The desktop shell injects the token it generated (OMA_WEBUI_TOKEN) so
    // desktop users never see a login screen; WEBUI_TOKEN is the manual .env
    // override; last resort is a per-run random token (fail-closed — the
    // desktop WebUI 401s until the shell injection chain is fixed).
    configuredToken =
      process.env.OMA_WEBUI_TOKEN ||
      process.env.WEBUI_TOKEN ||
      crypto.randomBytes(32).toString('hex');
    if (!process.env.OMA_WEBUI_TOKEN && !process.env.WEBUI_TOKEN) {
      // The operator needs this token to authenticate, so it has to be shown
      // once. Route it to stderr (the human-facing diagnostic channel) rather
      // than stdout, which is more likely to be captured into searchable,
      // long-lived application logs. It is also regenerated every restart —
      // set WEBUI_TOKEN in .env for a stable, non-logged secret.
      const authLogger = createLogger();
      authLogger.warn(
        '[webui-auth] SECURITY: no WEBUI_TOKEN configured; generated an ephemeral token for this run.',
      );
      authLogger.warn(`[webui-auth] Generated token: ${configuredToken}`);
      authLogger.warn(
        '[webui-auth] Set WEBUI_TOKEN in .env to persist it and keep it out of logs.',
      );
    }
  }
  return configuredToken;
}

export function resetWebUIToken(): void {
  // Only used for testing
  configuredToken = '';
}

function extractToken(request: FastifyRequest): string | null {
  // Authorization header
  const header = request.headers.authorization;
  if (header) {
    const parts = header.split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') return parts[1];
  }
  // WebSocket query param (used by browser WebSocket API which can't set headers)
  const url = new URL(request.url, 'http://localhost');
  return url.searchParams.get('token') || null;
}

function isPublic(path: string): boolean {
  return PUBLIC_EXACT.includes(path) || PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export async function webuiAuthHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const path = request.url.split('?')[0]; // strip query string

  // Skip auth for public paths and WebUI static assets
  if (isPublic(path)) return;
  if (path === '/webui' || path === '/webui/' || path.startsWith('/webui/')) return;

  const token = extractToken(request);
  const expected = getWebUIToken();

  if (!token) {
    reply.status(401).send({ error: 'Unauthorized', message: 'Missing Authorization header' });
    return;
  }

  if (!safeEqual(token, expected)) {
    reply.status(403).send({ error: 'Forbidden', message: 'Invalid token' });
    return;
  }
}

/**
 * Verify token without Fastify context (for WebSocket upgrade).
 */
export function verifyToken(token: string): boolean {
  return safeEqual(token, getWebUIToken());
}
