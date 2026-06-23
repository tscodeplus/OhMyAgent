/**
 * Feishu / Lark QR-based device authorization flow.
 *
 * Uses Feishu's device-code OAuth flow to auto-create a PersonalAgent bot app
 * WITHOUT requiring the user to visit the developer console.
 *
 * Flow:
 * 1. POST /api/channels/feishu/qr → calls Feishu accounts API to get device_code
 *    + verification_uri_complete, returns QR data URL of the verification URL.
 * 2. User scans QR with Feishu/Lark app → confirms app creation on phone.
 * 3. POST /api/channels/feishu/qr/poll → polls the accounts API until the
 *    user confirms or the code expires.
 * 4. On success: App ID and App Secret are returned to the frontend.
 *
 * API reference (reverse-engineered from Hermes Agent & LobsterAI):
 *   POST https://accounts.{domain}/oauth/v1/app/registration
 *   - action=begin  → { device_code, verification_uri_complete, interval, expire_in }
 *   - action=poll   → { client_id, client_secret, user_info } or { error: "authorization_pending" }
 *
 * Domains:
 *   Feishu (domestic):  accounts.feishu.cn
 *   Lark (international): accounts.larksuite.com
 */

import QRCode from 'qrcode';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACCOUNTS_BASE: Record<string, string> = {
  feishu: 'https://accounts.feishu.cn',
  lark: 'https://accounts.larksuite.com',
};

const REGISTRATION_PATH = '/oauth/v1/app/registration';

// In-memory store for active device-code sessions
interface DeviceSession {
  deviceCode: string;
  region: string;
  interval: number;
  expiresAt: number;
  domain: string; // current polling domain (may switch feishu→lark)
}

const sessions = new Map<string, DeviceSession>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function accountsBase(region: string): string {
  return ACCOUNTS_BASE[region] || ACCOUNTS_BASE['feishu']!;
}

async function postRegistration(baseUrl: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = `${baseUrl}${REGISTRATION_PATH}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Registration API HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerFeishuQrRoutes(
  server: FastifyInstance,
  logger: Logger,
): void {
  // ── Generate QR code (begin device flow) ──
  server.post('/api/channels/feishu/qr', async (req, reply) => {
    try {
      const body = (req.body || {}) as { region?: string };
      const region = body.region === 'lark' ? 'lark' : 'feishu';

      const baseUrl = accountsBase(region);

      // Begin device-code registration
      const result = await postRegistration(baseUrl, {
        action: 'begin',
        archetype: 'PersonalAgent',
        auth_method: 'client_secret',
        request_user_info: 'open_id',
      });

      const deviceCode = result['device_code'] as string;
      if (!deviceCode) {
        logger.error({ result }, 'Feishu QR: no device_code in begin response');
        return reply.status(500).send({
          ok: false,
          error: 'Feishu registration did not return a device code',
        });
      }

      const verificationUrl = (result['verification_uri_complete'] as string) || '';
      const interval = (result['interval'] as number) || 5;
      const expireIn = (result['expire_in'] as number) || 600;

      // Store session
      const session: DeviceSession = {
        deviceCode,
        region,
        interval: Math.max(interval, 2),
        expiresAt: Date.now() + expireIn * 1000,
        domain: region,
      };
      // Use a random session ID to track this in the frontend
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, session);

      // Generate QR code image from the verification URL
      const qrcodeImageDataUrl = await QRCode.toDataURL(verificationUrl, {
        width: 280,
        margin: 2,
      });

      logger.info({ sessionId, region, expiresIn: expireIn }, 'Feishu QR device flow started');

      return reply.send({
        ok: true,
        sessionId,
        qrcodeImageDataUrl,
        expiresIn: expireIn,
        instructions:
          region === 'lark'
            ? 'Scan with the Lark app to auto-create your bot'
            : '使用飞书 App 扫码即可自动创建机器人',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Failed to start Feishu QR device flow');
      return reply.status(500).send({ ok: false, error: message });
    }
  });

  // ── Poll device flow status ──
  server.post('/api/channels/feishu/qr/poll', async (req, reply) => {
    try {
      const body = req.body as { sessionId?: string };
      if (!body.sessionId) {
        return reply.status(400).send({ ok: false, error: 'sessionId required' });
      }

      const session = sessions.get(body.sessionId);
      if (!session) {
        return reply.send({ status: 'expired' });
      }

      // Check if session expired
      if (Date.now() > session.expiresAt) {
        sessions.delete(body.sessionId);
        return reply.send({ status: 'expired' });
      }

      const baseUrl = accountsBase(session.domain);

      let result: Record<string, unknown>;
      try {
        result = await postRegistration(baseUrl, {
          action: 'poll',
          device_code: session.deviceCode,
          tp: 'ob_app',
        });
      } catch {
        return reply.send({ status: 'waiting' });
      }

      // Domain auto-detection: if user is on Lark, switch domain
      const userInfo = (result['user_info'] || {}) as Record<string, unknown>;
      if (userInfo['tenant_brand'] === 'lark' && session.domain !== 'lark') {
        session.domain = 'lark';
        logger.info({ sessionId: body.sessionId }, 'Feishu QR: domain switched to lark');
      }

      // Success — got credentials
      if (result['client_id'] && result['client_secret']) {
        const appId = result['client_id'] as string;
        const appSecret = result['client_secret'] as string;
        const domain = session.domain;

        logger.info({ sessionId: body.sessionId, domain, appId: appId.slice(0, 10) + '...' }, 'Feishu QR device flow completed');

        // Clean up session
        sessions.delete(body.sessionId);

        return reply.send({
          status: 'confirmed',
          credentials: { appId, appSecret, region: domain },
        });
      }

      // Check for errors
      const error = result['error'] as string | undefined;
      if (error) {
        if (error === 'authorization_pending') {
          return reply.send({ status: 'waiting' });
        }
        if (error === 'slow_down') {
          session.interval = Math.min(session.interval * 2, 30);
          return reply.send({ status: 'waiting' });
        }
        if (error === 'expired_token') {
          sessions.delete(body.sessionId);
          return reply.send({ status: 'expired' });
        }
        // Other errors: access_denied, etc.
        logger.warn({ sessionId: body.sessionId, error }, 'Feishu QR device flow error');
        sessions.delete(body.sessionId);
        return reply.send({ status: 'error', error: `Feishu registration error: ${error}` });
      }

      // Still waiting
      return reply.send({ status: 'waiting' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Failed to poll Feishu QR device flow');
      return reply.send({ status: 'error', error: message });
    }
  });

  logger.info('Feishu QR device flow routes registered at /api/channels/feishu/qr*');
}
