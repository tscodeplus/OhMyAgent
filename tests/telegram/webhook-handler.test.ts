import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import type { Bot } from 'grammy';
import { registerWebhookHandler } from '../../extensions/channel-telegram/webhook-handler';
import { SlidingWindowRateLimiter } from '../../extensions/channel-telegram/rate-limiter';

/**
 * Regression tests for report #2: an unconfigured webhook secret used to
 * fail-open (log a warning, then process the forged update anyway). The fix
 * makes the route fail-closed — no secret configured means every request is
 * rejected with 401, matching the Feishu channel's no-credentials contract.
 */

const logger = { info: () => {}, warn: () => {}, error: () => {} } as never;

function makeBot() {
  return { handleUpdate: vi.fn(async () => {}) };
}

async function buildServer(bot: Bot, secretToken?: string) {
  const server = Fastify();
  registerWebhookHandler(server, bot, logger, {
    path: '/webhook/telegram',
    secretToken,
    rateLimiter: new SlidingWindowRateLimiter(1000, 60_000),
  });
  await server.ready();
  return server;
}

const UPDATE = { update_id: 1, message: { chat: { id: 42 }, text: 'hello' } };

describe('telegram webhook secret handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects with 401 and never touches the bot when no secret is configured', async () => {
    const bot = makeBot();
    const server = await buildServer(bot as unknown as Bot);

    const res = await server.inject({
      method: 'POST',
      url: '/webhook/telegram',
      payload: UPDATE,
    });

    expect(res.statusCode).toBe(401);
    expect(bot.handleUpdate).not.toHaveBeenCalled();
    await server.close();
  });

  it('rejects with 401 when the secret is configured but the header mismatches', async () => {
    const bot = makeBot();
    const server = await buildServer(bot as unknown as Bot, 's3cret');

    const res = await server.inject({
      method: 'POST',
      url: '/webhook/telegram',
      payload: UPDATE,
      headers: { 'x-telegram-bot-api-secret-token': 'wrong' },
    });

    expect(res.statusCode).toBe(401);
    expect(bot.handleUpdate).not.toHaveBeenCalled();
    await server.close();
  });

  it('accepts the update when the secret matches', async () => {
    const bot = makeBot();
    const server = await buildServer(bot as unknown as Bot, 's3cret');

    const res = await server.inject({
      method: 'POST',
      url: '/webhook/telegram',
      payload: UPDATE,
      headers: { 'x-telegram-bot-api-secret-token': 's3cret' },
    });

    expect(res.statusCode).toBe(200);
    expect(bot.handleUpdate).toHaveBeenCalledTimes(1);
    await server.close();
  });
});
