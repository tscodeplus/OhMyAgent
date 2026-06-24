/**
 * QQ QR-based credential route.
 *
 * QQ Bot uses the same pattern as Telegram: generate a QR code encoding the
 * QQ Open Platform URL (https://q.qq.com). The user scans it, opens the QQ
 * developer console on their phone, creates a bot, and pastes the resulting
 * App ID + Client Secret into the inline input fields shown by QRCodeModal.
 *
 * No poll/submit endpoints are needed — the frontend QRCodeModal handles
 * inline credential input (same as Telegram).
 */

import QRCode from 'qrcode';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

const QQ_OPEN_PLATFORM_URL = 'https://q.qq.com';

/**
 * Register QQ QR configuration route on the Fastify server.
 *
 * Called unconditionally from the extension entry point (before the
 * enabled/configured early-return check).
 */
export function registerQqQrRoutes(
  server: FastifyInstance,
  _sessionStore: unknown,
  logger: Logger,
): void {
  // POST /api/channels/qq/qr — generate a QQ Open Platform deep-link QR code
  server.post('/api/channels/qq/qr', async (_req, reply) => {
    try {
      const qrcodeImageDataUrl = await QRCode.toDataURL(QQ_OPEN_PLATFORM_URL, {
        width: 280,
        margin: 2,
      });

      return reply.send({
        ok: true,
        sessionId: 'qq-open-platform',
        qrcodeImageDataUrl,
        directUrl: QQ_OPEN_PLATFORM_URL,
        instructions:
          'Scan to open the QQ Open Platform. Create a bot, then paste the App ID and Client Secret below.',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Failed to generate QQ QR code');
      return reply.status(500).send({ ok: false, error: message });
    }
  });

  // POST /api/channels/qq/qr/poll — QQ uses inline credential input (same as
  // Telegram), so polling is not needed. Return a not-supported status so the
  // frontend knows to show the inline form instead of polling.
  server.post('/api/channels/qq/qr/poll', async (_req, reply) => {
    return reply.send({ status: 'waiting' });
  });

  logger.info('QQ QR config route registered at /api/channels/qq/qr');
}
