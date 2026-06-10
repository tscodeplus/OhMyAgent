import { Bot } from 'grammy';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import type { Logger } from 'pino';
import type { TelegramConfig } from './telegram-types.js';

const ALLOWED_UPDATES = ['message', 'callback_query', 'message_reaction'] as const;

export function createTelegramBot(config: TelegramConfig, logger: Logger): Bot {
  if (config.proxyUrl) {
    logger.info({ proxyUrl: config.proxyUrl }, 'Configuring Telegram bot with proxy');
    const proxyAgent = new ProxyAgent(config.proxyUrl);
    return new Bot(config.botToken, {
      client: {
        fetch: ((url: any, init: any) => {
          const { agent, compress, signal: grammySignal, ...rest } = init || {};
          const fetchInit: any = { ...rest, dispatcher: proxyAgent };
          if (grammySignal && !grammySignal.aborted) {
            const bridge = new AbortController();
            grammySignal.addEventListener('abort', () => bridge.abort(grammySignal.reason), { once: true });
            fetchInit.signal = bridge.signal;
          }
          return undiciFetch(url, fetchInit);
        }) as any,
      },
    } as any);
  }
  return new Bot(config.botToken);
}

export async function startBot(bot: Bot, config: TelegramConfig, logger: Logger): Promise<void> {
  if (config.mode !== 'polling') return;
  await bot.start({
    allowed_updates: [...ALLOWED_UPDATES],
    onStart: (b) => logger.info({ username: b.username }, 'Telegram bot polling started'),
  });
}

export async function stopBot(bot: Bot, config: TelegramConfig, logger: Logger): Promise<void> {
  try { if (config.mode === 'webhook') await bot.api.deleteWebhook(); await bot.stop(); } catch {}
}

export async function setupWebhook(bot: Bot, config: TelegramConfig, logger: Logger): Promise<void> {
  if (config.webhookUrl) {
    await bot.api.setWebhook(config.webhookUrl, {
      secret_token: config.webhookSecret,
      allowed_updates: [...ALLOWED_UPDATES],
    });
  }
}
