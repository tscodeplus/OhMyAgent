import type { ExtensionAPI } from '../../src/extensions/types.js';
import type { ChannelAdapter } from '../../src/channel/types.js';
import type { CronService } from '../../src/cron/service.js';

export default function (api: ExtensionAPI) {
  const config = api.getConfig();
  const logger = api.getLogger();

  if (!config.cron.enabled) {
    logger.info('Cron is disabled, skipping channel-cron');
    return;
  }

  const cronService = api.getService<CronService>('cronService');

  // Note: cronjob tool is NOT registered here — it's injected per-message by
  // agent-factory.ts with the correct chatId. The extension only provides the
  // channel adapter for cron scheduling infrastructure.

  const adapter: ChannelAdapter = {
    id: 'cron',
    start: async () => {
      logger.info({ wired: !!cronService }, 'Cron channel ready');
    },
    stop: async () => {
      logger.info('Cron channel stopped');
    },
    onReceive: (handler) => {
    },
    sendReply: async (ctx, reply) => {
      logger.info({ channelId: ctx.channelId, reply: reply.text?.slice(0, 100) }, 'Cron job result');
    },
  };

  api.registerChannel(adapter);

  logger.info('channel-cron registered');
}
