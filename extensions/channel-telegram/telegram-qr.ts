/**
 * Telegram BotFather QR route.
 *
 * Telegram does not support programmatic bot creation via QR. Instead, we
 * generate a QR code encoding the BotFather deep link (https://t.me/botfather).
 * The user scans it, opens BotFather on their phone, creates a bot with
 * /newbot, and pastes the resulting token into the settings UI.
 *
 * No poll/submit endpoints are needed — the frontend QRCodeModal shows an
 * inline text input for token pasting.
 */

import QRCode from 'qrcode';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

const BOTFATHER_URL = 'https://t.me/botfather';

/**
 * Register Telegram QR configuration route on the Fastify server.
 *
 * Called unconditionally from the extension entry point (before the
 * enabled/configured early-return check).
 */
export function registerTelegramQrRoute(
  server: FastifyInstance,
  logger: Logger,
): void {
  // POST /api/channels/telegram/qr — generate a BotFather deep-link QR code
  server.post('/api/channels/telegram/qr', async (_req, reply) => {
    try {
      const qrcodeImageDataUrl = await QRCode.toDataURL(BOTFATHER_URL, {
        width: 280,
        margin: 2,
      });

      return reply.send({
        ok: true,
        sessionId: 'botfather',
        qrcodeImageDataUrl,
        directUrl: BOTFATHER_URL,
        instructions:
          'Scan to open BotFather in Telegram. Use /newbot to create a bot, then paste the token below.',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Failed to generate Telegram QR code');
      return reply.status(500).send({ ok: false, error: message });
    }
  });

  logger.info('Telegram QR config route registered at /api/channels/telegram/qr');
}
