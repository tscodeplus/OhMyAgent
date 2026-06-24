/**
 * channel-telegram extension entry point.
 *
 * Registers a ChannelAdapter that bridges Telegram Bot API messages
 * into OhMyAgent's unified channel/agent pipeline.
 */
import type { ExtensionAPI } from '../../src/extensions/types.js';
import type { ChannelAdapter, ChannelContext, ReplyContent } from '../../src/channel/types.js';
import type { AgentService } from '../../src/agent/agent-service.js';
import type { CommandDeps } from '../../src/commands/command-handler.js';
import type { CronDeliveryRegistry } from '../../src/cron/delivery-registry.js';
import type { FastifyInstance } from 'fastify';
import { resolveTelegramConfig } from './telegram-config.js';
import { createTelegramBot, setupWebhook, stopBot } from './telegram-bot.js';
import { setupMessageHandlers } from './message-handler.js';
import { sendReply } from './send-message.js';
import { SlidingWindowRateLimiter } from './rate-limiter.js';
import { registerWebhookHandler } from './webhook-handler.js';
import { registerTelegramQrRoute } from './telegram-qr.js';

export default function (api: ExtensionAPI) {
  const config = api.getConfig();
  const logger = api.getLogger();

  // Always register QR config route (even if disabled/unconfigured)
  const server = api.getService<FastifyInstance>('server');
  if (server) {
    registerTelegramQrRoute(server, logger);
  }

  // Skip if Telegram is not enabled
  if (!config.telegram?.enabled) {
    logger.info('Telegram channel disabled in config, skipping channel-telegram');
    return;
  }

  // Skip if Telegram is not configured
  if (!config.telegram?.botToken) {
    logger.info('Telegram bot token not configured, skipping channel-telegram');
    return;
  }

  const tgConfig = resolveTelegramConfig(config.telegram);

  // Get shared services
  const agentService = api.getService<AgentService>('agentService');
  if (!agentService) {
    logger.error('AgentService not found in services — channel-telegram requires it');
    return;
  }

  const commandDeps = api.getService<CommandDeps>('commandDeps');

  // Create the grammY Bot instance
  const bot = createTelegramBot(tgConfig, logger);

  // Register Telegram cron delivery client
  const cronRegistry = api.getService<CronDeliveryRegistry>('cronDeliveryRegistry');
  if (cronRegistry) {
    cronRegistry.register('telegram', {
      async deliver({ chatId, text, modelLabel, agentName, footer: footerConfig }) {
        const chatIdNum = Number(chatId);
        if (isNaN(chatIdNum)) {
          logger.warn({ chatId }, 'Cannot deliver cron result - invalid Telegram chat ID');
          return;
        }
        const parts: string[] = [];
        if (footerConfig.showAgentName && agentName) parts.push(agentName);
        if (footerConfig.showModel && modelLabel) parts.push(modelLabel);
        parts.push(new Date().toLocaleString('zh-CN'));
        const footer = `\n\n${parts.join(' · ')}`;
        try {
          await bot.api.sendMessage(chatIdNum, text + footer, {
            link_preview_options: { is_disabled: true },
          });
        } catch (err) {
          logger.warn({ err, chatId }, 'Telegram cron delivery failed');
          throw err;
        }
      },
    });
    logger.info('Telegram cron delivery client registered');
  }

  // Create the ChannelAdapter
  const adapter: ChannelAdapter = {
    id: 'telegram',

    async start(): Promise<void> {
      // Apply custom bot name if configured
      if (tgConfig.botName) {
        try {
          await bot.api.setMyName(tgConfig.botName);
          logger.info({ botName: tgConfig.botName }, 'Telegram bot name updated');
        } catch (err) {
          logger.warn({ err, botName: tgConfig.botName }, 'Failed to set Telegram bot name');
        }
      }

      // Wire message handlers BEFORE starting the bot
      // (grammY handlers must be registered before polling/webhook starts)
      if (!commandDeps) {
        logger.warn('CommandDeps not found in services — slash commands disabled');
      }
      const deps = commandDeps ?? { agentService, skillRegistry: undefined, cronService: undefined, feishuClient: undefined, agentManager: undefined, extensionManager: undefined };
      // v5 P2: Build STT transcriber for Telegram audio messages
      let sttTranscriber: ((path: string, lang?: string) => Promise<string>) | undefined;
      const appConfig = api.getConfig();
      const sttCfg = appConfig.multimodal?.stt;
      if (sttCfg?.enabled && sttCfg.providers?.length) {
        const { createSTTProviders, transcribeWithFallback } = await import('../../src/media-providers/stt/factory.js');
        const sttProviders = createSTTProviders(sttCfg.providers);
        if (sttProviders.length > 0) {
          sttTranscriber = async (audioPath: string, language?: string) => {
            const result = await transcribeWithFallback(sttProviders, { audioPath, language: language ?? sttCfg.language ?? 'auto' });
            return result.text;
          };
        }
      }
      const sttHandlerConfig = sttCfg ? { enabled: sttCfg.enabled ?? false, autoTranscribe: sttCfg.autoTranscribe ?? true, language: sttCfg.language ?? 'auto' } : undefined;
      setupMessageHandlers(bot, tgConfig, agentService, deps, logger, api, sttTranscriber, sttHandlerConfig);

      if (tgConfig.mode === 'webhook') {
        if (!tgConfig.webhookUrl) {
          logger.error('Webhook mode requires webhookUrl, falling back to polling');
          tgConfig.mode = 'polling';
        } else {
          if (!server) {
            logger.error('Fastify server not available for webhook, falling back to polling');
            tgConfig.mode = 'polling';
          } else {
            // Set up webhook with Telegram
            await setupWebhook(bot, tgConfig, logger);

            // Register Fastify route for incoming updates
            const rateLimiter = new SlidingWindowRateLimiter(100, 60_000);
            registerWebhookHandler(server, bot, logger, {
              path: '/webhook/telegram',
              secretToken: tgConfig.webhookSecret,
              rateLimiter,
            });

            logger.info({ url: tgConfig.webhookUrl }, 'Telegram webhook mode active');
            return;
          }
        }
      }

      // Default: polling mode — start in background (bot.start() blocks indefinitely)
      const { startPolling } = await import('./polling-handler.js');
      startPolling(bot, logger).catch(err =>
        logger.error({ err }, 'Telegram polling crashed'),
      );
    },

    async stop(): Promise<void> {
      const { stopPolling } = await import('./polling-handler.js');
      await Promise.allSettled([
        stopPolling(bot, logger),
        stopBot(bot, tgConfig, logger),
      ]);
    },

    onReceive(_handler: (ctx: ChannelContext) => Promise<void>): void {
      // Handlers are already wired in start() via setupMessageHandlers.
      // This method exists to satisfy the ChannelAdapter interface.
    },

    async sendReply(ctx: ChannelContext, reply: ReplyContent): Promise<void> {
      const chatId = Number(ctx.message.replyMeta?.chatId);
      if (isNaN(chatId)) {
        logger.warn({ replyMeta: ctx.message.replyMeta }, 'Cannot determine chatId for reply');
        return;
      }
      await sendReply(bot.api, chatId, reply, { textLimit: tgConfig.textLimit });
    },
  };

  api.registerChannel(adapter);
  logger.info('channel-telegram registered');
}
