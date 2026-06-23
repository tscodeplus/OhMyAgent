/**
 * QQ QR-based credential exchange routes.
 *
 * Same credential-exchange pattern as Feishu: QR encodes a URL pointing to
 * /qr-exchange/qq/:sessionId on the local server. The user scans with a phone
 * browser, pastes their QQ App ID and Client Secret, and the credentials flow
 * back to the settings UI via polling.
 */

import QRCode from 'qrcode';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { QrSessionStore } from '../../src/channel/qr-session-store.js';
import { getLanAddress } from '../../src/shared/lan-ip.js';

/**
 * Register QQ QR configuration routes on the Fastify server.
 *
 * Called unconditionally from the extension entry point (before the
 * enabled/configured early-return check).
 */
export function registerQqQrRoutes(
  server: FastifyInstance,
  sessionStore: QrSessionStore,
  logger: Logger,
): void {
  // POST /api/channels/qq/qr — generate a QR code for credential exchange
  server.post('/api/channels/qq/qr', async (_req, reply) => {
    try {
      const addresses = server.addresses();
      const port = addresses.length > 0 ? addresses[0]!.port : 9191;

      sessionStore.invalidateChannel('qq');
      const session = sessionStore.create('qq');

      const baseUrl = getLanAddress(port);
      const exchangeUrl = `${baseUrl}/qr-exchange/qq/${session.id}`;

      const qrcodeImageDataUrl = await QRCode.toDataURL(exchangeUrl, {
        width: 280,
        margin: 2,
      });

      logger.info({ sessionId: session.id }, 'QQ QR session created');

      return reply.send({
        ok: true,
        sessionId: session.id,
        qrcodeImageDataUrl,
        expiresIn: 300,
        instructions:
          'Scan with your phone browser, then paste your QQ App ID and Client Secret on the page that opens.',
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Failed to generate QQ QR code');
      return reply.status(500).send({ ok: false, error: message });
    }
  });

  // POST /api/channels/qq/qr/poll — check if credentials have been submitted
  server.post('/api/channels/qq/qr/poll', async (req, reply) => {
    try {
      const body = req.body as { sessionId?: string };
      if (!body.sessionId) {
        return reply.status(400).send({ ok: false, error: 'sessionId required' });
      }

      const session = sessionStore.get(body.sessionId);
      if (!session) {
        return reply.send({ status: 'expired' });
      }

      if (session.status === 'confirmed' && session.credentials) {
        return reply.send({
          status: 'confirmed',
          credentials: session.credentials,
        });
      }

      if (Date.now() > session.expiresAt) {
        sessionStore.updateStatus(body.sessionId, 'expired');
        return reply.send({ status: 'expired' });
      }

      return reply.send({ status: session.status });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err }, 'Failed to poll QQ QR status');
      return reply.status(500).send({ ok: false, error: message });
    }
  });

  logger.info('QQ QR config routes registered at /api/channels/qq/qr*');
}
