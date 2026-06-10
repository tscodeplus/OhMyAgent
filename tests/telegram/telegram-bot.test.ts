import { describe, expect, it, vi } from 'vitest';
import { setupWebhook, startBot } from '../../extensions/channel-telegram/telegram-bot.js';
import type { TelegramConfig } from '../../extensions/channel-telegram/telegram-types.js';

const baseConfig: TelegramConfig = {
  botToken: 'token',
  mode: 'webhook',
  webhookUrl: 'https://example.com/webhook/telegram',
  webhookPort: 8443,
  webhookSecret: 'secret',
  allowedUsers: [],
  allowedGroups: [],
  streamMode: 'edit',
  textLimit: 4096,
  streamIntervalMs: 500,
};

describe('telegram-bot', () => {
  it('requests callback_query updates when setting webhook', async () => {
    const bot = {
      api: {
        setWebhook: vi.fn(async () => true),
      },
    };

    await setupWebhook(bot as any, baseConfig, {} as any);

    expect(bot.api.setWebhook).toHaveBeenCalledWith(
      baseConfig.webhookUrl,
      expect.objectContaining({
        secret_token: baseConfig.webhookSecret,
        allowed_updates: expect.arrayContaining(['message', 'callback_query']),
      }),
    );
  });

  it('requests callback_query updates when starting polling via startBot', async () => {
    const bot = {
      start: vi.fn(async () => undefined),
    };
    const logger = { info: vi.fn() };

    await startBot(bot as any, { ...baseConfig, mode: 'polling' }, logger as any);

    expect(bot.start).toHaveBeenCalledWith(
      expect.objectContaining({
        allowed_updates: expect.arrayContaining(['message', 'callback_query']),
      }),
    );
  });
});
