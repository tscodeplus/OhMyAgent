/**
 * Webhook handler for Telegram Bot API updates.
 *
 * Registers a Fastify POST route to receive updates from Telegram
 * and feeds them to the grammY Bot instance via bot.handleUpdate().
 */
import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { SlidingWindowRateLimiter } from './rate-limiter.js';

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

    // Secret token validation
    if (options.secretToken) {
      const provided = (req.headers as Record<string, string>)['x-telegram-bot-api-secret-token'];
      if (provided !== options.secretToken) {
        logger.warn({ ip: clientIp }, 'Webhook: invalid secret token');
        return reply.status(401).send({ error: 'Unauthorized' });
      }
    }

    try {
      await bot.handleUpdate(req.body as any);
      reply.status(200).send({ ok: true });
    } catch (err) {
      logger.error({ err }, 'Webhook: bot.handleUpdate failed');
      reply.status(500).send({ error: 'Internal error' });
    }
  });

  logger.info({ path: options.path }, 'Telegram webhook route registered');
}
