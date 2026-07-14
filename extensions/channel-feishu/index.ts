import type { ExtensionAPI } from '../../src/extensions/types.js';
import type { ChannelAdapter } from '../../src/channel/types.js';
import type { FeishuClient } from './feishu-client.js';
import type { FastifyInstance } from 'fastify';
import { registerFeishuQrRoutes } from './feishu-qr.js';
import { fixFeishuMarkdown } from './render/markdown-sanitizer.js';
import { buildSimpleMarkdownCard } from './render/cardkit-builder.js';

export default function (api: ExtensionAPI) {
  const config = api.getConfig();
  const logger = api.getLogger();

  // Always register QR config routes (even if disabled/unconfigured)
  const server = api.getService<FastifyInstance>('server');
  if (server) {
    registerFeishuQrRoutes(server, logger);
  }

  if (!config.feishu.enabled) {
    logger.info('Feishu channel disabled in config, skipping channel-feishu');
    return;
  }

  if (!config.feishu.appId || !config.feishu.appSecret) {
    logger.warn('Feishu appId or appSecret not configured, skipping channel-feishu');
    return;
  }

  // Use shared components from bootstrap (not creating duplicates)
  const feishuClient = api.getService<FeishuClient>('feishuClient');
  if (!feishuClient) {
    logger.error('FeishuClient not found in services — channel-feishu requires it from bootstrap');
    return;
  }

  const adapter: ChannelAdapter = {
    id: 'feishu',
    start: async () => {
      logger.info('channel-feishu started');
    },
    stop: async () => {
      logger.info('channel-feishu stopped');
    },
    onReceive: (handler) => {
      // The actual event routing is set up in bootstrap.ts via feishuRouter.on()
      // which directly calls commandHandler / messageHandler / agentService.
      // This onReceive provides a hook for ChannelManager's alternative path.
      // Nothing to wire here since bootstrap handles the routing.
    },
    sendReply: async (ctx, reply) => {
      if (reply.text) {
        const card = buildSimpleMarkdownCard(fixFeishuMarkdown(reply.text));
        await feishuClient.sendMessage({
          receive_id: ctx.message.replyMeta?.chatId as string,
          receive_id_type: 'chat_id',
          msg_type: 'interactive',
          content: JSON.stringify(card),
        });
      }
    },
  };

  api.registerChannel(adapter);
}
