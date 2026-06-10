import type { ExtensionAPI } from '../../src/extensions/types.js';
import type { ChannelAdapter } from '../../src/channel/types.js';
import type { FeishuClient } from './feishu-client.js';

export default function (api: ExtensionAPI) {
  const config = api.getConfig();
  const logger = api.getLogger();

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
        await feishuClient.sendMessage({
          receive_id: ctx.message.replyMeta?.chatId as string,
          receive_id_type: 'chat_id',
          msg_type: 'text',
          content: JSON.stringify({ text: reply.text }),
        });
      }
    },
  };

  api.registerChannel(adapter);
}
