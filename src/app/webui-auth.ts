/**
 * WebUI Token Authentication Middleware
 *
 * Simple Token auth: reads WEBUI_TOKEN from .env, generates a random token
 * if not configured. All /api/* and /ws requests must include
 * Authorization: Bearer <token> header.
 *
 * Excluded paths (no token required):
 *   - /api/feishu/*, /api/telegram/*, /api/wechat/*, /api/qq/*   (IM webhooks)
 *   - /api/auth/login, /api/health                                (login + health)
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { safeEqual } from '../shared/safe-equal.js';

const EXCLUDED_PREFIXES = [
  '/api/feishu',
  '/api/telegram',
  '/api/wechat',
  '/api/qq',
  '/api/auth/login',
  '/api/health',
  '/api/config/minimal-check',
  '/api/files/serve',
  '/api/files/download',
  '/api/subscriptions',
  '/api/system/update-status',
  '/qr-exchange/',
];

let configuredToken: string;

export function getWebUIToken(): string {
  // Electron desktop: all requests are local, no token needed.
  // Return a dummy value to avoid spurious warnings.
  if (process.env.ELECTRON_RUN === '1') {
    return 'electron-local';
  }

  if (!configuredToken) {
    configuredToken = process.env.WEBUI_TOKEN || crypto.randomBytes(32).toString('hex');
    if (!process.env.WEBUI_TOKEN) {
      // The operator needs this token to authenticate, so it has to be shown
      // once. Route it to stderr (the human-facing diagnostic channel) rather
      // than stdout, which is more likely to be captured into searchable,
      // long-lived application logs. It is also regenerated every restart —
      // set WEBUI_TOKEN in .env for a stable, non-logged secret.
      console.warn(
        `[webui-auth] SECURITY: no WEBUI_TOKEN configured; generated an ephemeral token for this run.`,
      );
      console.warn(`[webui-auth] Generated token: ${configuredToken}`);
      console.warn('[webui-auth] Set WEBUI_TOKEN in .env to persist it and keep it out of logs.');
    }
  }
  return configuredToken;
}

export function resetWebUIToken(): void {
  // Only used for testing
  configuredToken = '' as unknown as string;
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

function isExcluded(path: string): boolean {
  return EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export async function webuiAuthHook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // When running inside Electron, all requests come from localhost (127.0.0.1).
  // Token auth adds no security in this context and creates unnecessary
  // friction for desktop users — skip it entirely.
  if (process.env.ELECTRON_RUN === '1') return;

  const path = request.url.split('?')[0]; // strip query string

  // Skip auth for excluded paths and non-api/ws paths
  if (isExcluded(path)) return;
  if (!path.startsWith('/api/') && !path.startsWith('/ws')) return;

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
  // Electron desktop: all requests are local, skip verification
  if (process.env.ELECTRON_RUN === '1') return true;
  return safeEqual(token, getWebUIToken());
}
