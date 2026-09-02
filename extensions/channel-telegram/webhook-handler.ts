/**
 * Webhook handler for Telegram Bot API updates.
 *
 * Registers a Fastify POST route to receive updates from Telegram
 * and feeds them to the grammY Bot instance via bot.handleUpdate().
 */
import type { Bot } from 'grammy';
/** grammY's expected update payload type (Update is not re-exported from grammy's main entry). */
type TelegramUpdate = Parameters<Bot['handleUpdate']>[0];
import type { Logger } from 'pino';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { SlidingWindowRateLimiter } from './rate-limiter.js';
import { safeEqual } from '../../src/shared/safe-equal.js';

export interface WebhookHandlerOptions {
  path: string;
  secretToken?: string;
  rateLimiter: SlidingWindowRateLimiter;
}

export function registerWebhookHandler(
  server: FastifyInstance,
  bot: Bot,
  logger: Logger,
  options: WebhookHandlerOptions,
): void {
  server.post(options.path, async (req: FastifyRequest, reply: FastifyReply) => {
    // Rate limiting by IP
    const clientIp = req.ip ?? 'unknown';
    if (!options.rateLimiter.check(clientIp)) {
      return reply.status(429).send({ error: 'Too many requests' });
    }

    // Secret token validation (constant-time comparison — the webhook is
    // publicly reachable so timing attacks on a plain !== are realistic).
    // Fail CLOSED when no secret is configured: this route is in
    // PUBLIC_PREFIXES, so an unauthenticated caller on the network could
    // otherwise POST a forged Update (with their own chat_id) and drive the
    // whole agent/tool pipeline — the same fail-closed contract the Feishu
    // webhook enforces with its 'no-credentials' path.
    if (!options.secretToken) {
      logger.error(
        { path: options.path },
        'SECURITY: Telegram webhook has no secret_token configured — refusing update. Set telegram.webhookSecret.',
      );
      return reply.status(401).send({ error: 'Webhook secret not configured' });
    }
    const provided = (req.headers as Record<string, string>)['x-telegram-bot-api-secret-token'];
    if (!safeEqual(provided, options.secretToken)) {
      logger.warn({ ip: clientIp }, 'Webhook: invalid secret token');
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    try {
      await bot.handleUpdate(req.body as TelegramUpdate);
      reply.status(200).send({ ok: true });
      // pi-lens-ignore: missing-error-propagation
    } catch (err) {
      logger.error({ err }, 'Webhook: bot.handleUpdate failed');
      reply.status(500).send({ error: 'Internal error' });
    }
  });

  logger.info({ path: options.path }, 'Telegram webhook route registered');
}
