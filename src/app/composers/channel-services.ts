import type { AppConfig, AppServices, FooterConfig } from '../types.js';
import type { openDatabase } from '../../memory/db.js';
import { i18n } from '../../i18n/index.js';
import { FeishuClient } from '../../../extensions/channel-feishu/feishu-client.js';
import { CommandRegistry } from '../../commands/command-registry.js';
import { ChannelManager } from '../../channel/channel-manager.js';
import { ExtensionLoader } from '../../extensions/extension-loader.js';
import { ExtensionManager } from '../../extensions/extension-manager.js';
import { createExtensionAPI } from '../../extensions/extension-api.js';
import { CronDeliveryRegistry, type CronDeliveryClient } from '../../cron/delivery-registry.js';
import { AgentManager } from '../../agent/agent-manager.js';
import { setDefaultAgentId } from '../../agent/agent-context.js';
import { configEventBus } from '../config-event-bus.js';
import type { MemoryServices } from './memory-services.js';
import type { ToolServices } from './tool-services.js';

export interface ChannelServices {
  feishuClient: FeishuClient;
  commandRegistry: CommandRegistry;
  channelManager: ChannelManager;
  extensionManager: ExtensionManager;
  servicesMap: Map<string, unknown>;
  apiDeps: {
    toolRegistry: ToolServices['toolRegistry'];
    toolPlatformRegistry: ToolServices['toolPlatformRegistry'];
    commandRegistry: CommandRegistry;
    extensionManager: ExtensionManager;
    hooks: import('../../extensions/types.js').ExtensionHooks[];
    config: AppConfig;
    logger: AppServices['logger'];
    services: Map<string, unknown>;
  };
  cronDeliveryRegistry: CronDeliveryRegistry;
  agentManager: AgentManager;
}

function buildCronFooter(modelLabel: string, agentName: string | undefined, footerConfig: FooterConfig): string {
  const parts: string[] = [];
  if (footerConfig.showAgentName && agentName) parts.push(agentName);
  if (footerConfig.showModel && modelLabel) parts.push(modelLabel);
  parts.push(new Date().toLocaleString('zh-CN'));
  return parts.join(' · ');
}

function createFeishuCronDelivery(
  feishuClient: FeishuClient,
  appFooterConfig: FooterConfig,
): CronDeliveryClient {
  return {
    async deliver({ chatId, text, modelLabel, agentName, footer: footerConfig }) {
      const footerText = buildCronFooter(modelLabel, agentName, footerConfig ?? appFooterConfig);
      const cardData = {
        schema: '2.0' as const,
        config: { streaming_mode: false },
        header: {
          title: { tag: 'plain_text', content: i18n.t('tools-cron:card.title') },
          template: 'wathet' as const,
        },
        body: {
          elements: [
            { tag: 'markdown', content: text },
            { tag: 'hr' },
            { tag: 'markdown', content: footerText, text_size: 'notation' },
          ],
        },
      };
      const cardId = await feishuClient.createCard(cardData);
      await feishuClient.sendCardByCardId(chatId, cardId);
    },
  };
}

export function createChannelServices(input: {
  config: AppConfig;
  logger: AppServices['logger'];
  db: ReturnType<typeof openDatabase>;
  memory: MemoryServices;
  tools: ToolServices;
  agentManagerRef: { current?: AgentManager };
}): ChannelServices {
  const { config, logger, db, memory, tools, agentManagerRef } = input;

  // Only create FeishuClient when the channel is enabled AND has credentials.
  // Creating it with empty appId/appSecret triggers lark SDK errors.
  const feishuEnabled = config.feishu.enabled && config.feishu.appId && config.feishu.appSecret;
  const feishuClient = feishuEnabled
    ? new FeishuClient(
        { appId: config.feishu.appId, appSecret: config.feishu.appSecret },
        logger,
      )
    : undefined as unknown as FeishuClient;

  const commandRegistry = new CommandRegistry();
  const channelManager = new ChannelManager();
  channelManager.setLogger(logger);
  const extensionLoader = new ExtensionLoader();
  const extensionHooks: import('../../extensions/types.js').ExtensionHooks[] = [];
  const servicesMap = new Map<string, unknown>();
  servicesMap.set('db', db);
  servicesMap.set('logger', logger);
  if (feishuEnabled) {
    servicesMap.set('feishuClient', feishuClient);
  }
  servicesMap.set('processedMessageRepository', memory.processedMessageRepository);

  const cronDeliveryRegistry = new CronDeliveryRegistry();
  servicesMap.set('cronDeliveryRegistry', cronDeliveryRegistry);
  if (feishuEnabled) {
    cronDeliveryRegistry.register('feishu', createFeishuCronDelivery(feishuClient, config.footer));
  }

  const apiDeps = {
    toolRegistry: tools.toolRegistry,
    toolPlatformRegistry: tools.toolPlatformRegistry,
    commandRegistry,
    extensionManager: undefined as any,
    hooks: extensionHooks,
    config,
    logger,
    services: servicesMap,
  };
  const extensionAPI = createExtensionAPI(apiDeps);
  const extensionManager = new ExtensionManager(extensionLoader, extensionAPI, logger);
  apiDeps.extensionManager = extensionManager;

  const agents = config.agents ?? [];
  logger.info({ agentCount: agents.length }, 'V2 agents loaded');

  const agentManager = new AgentManager(config, agents, tools.toolRegistry);
  agentManagerRef.current = agentManager;
  logger.info({ agentCount: agentManager.list().length }, 'V2 AgentManager initialized');
  const agentsList = agentManager.list();
  if (agentsList.length > 0) {
    setDefaultAgentId(agentsList[0]!.id);
  }

  // Reload agents on config change
  configEventBus.onReload((c) => {
    agentManager.reload(c, c.agents ?? []);
  });

  return {
    feishuClient,
    commandRegistry,
    channelManager,
    extensionManager,
    servicesMap,
    apiDeps,
    cronDeliveryRegistry,
    agentManager,
  };
}
