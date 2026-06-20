/**
 * Feishu Message Services Composer
 *
 * Extracted from bootstrap.ts (Phase 9d). Creates STT transcriber,
 * CommandDeps, MessageHandler, and registers Feishu event routing.
 */

import { createSTTProviders, transcribeWithFallback } from '../../media-providers/stt/factory.js';
import { MessageHandler } from '../../../extensions/channel-feishu/message-handler.js';
import type { AppConfig } from '../types.js';
import type { AgentService } from '../../agent/agent-service.js';
import type { SkillRegistry } from '../../skills/skill-registry.js';
import type { CronService } from '../../cron/service.js';
import type { FeishuClient } from '../../../extensions/channel-feishu/feishu-client.js';
import type { AgentManager } from '../../agent/agent-manager.js';
import type { ExtensionManager } from '../../extensions/extension-manager.js';
import type { ChatQueue } from '../../../extensions/channel-feishu/chat-queue.js';
import type { Logger } from 'pino';

export interface FeishuServicesResult {
  messageHandler: MessageHandler;
  commandDeps: Record<string, unknown>;
}

export function createFeishuServices(options: {
  config: AppConfig;
  logger: Logger;
  agentService: AgentService;
  skillRegistry: SkillRegistry;
  cronService: CronService;
  feishuClient: FeishuClient;
  agentManager: AgentManager;
  extensionManager: ExtensionManager;
  chatQueue: ChatQueue;
  servicesMap: Map<string, unknown>;
}): FeishuServicesResult {
  const { config, logger, agentService, skillRegistry, cronService, feishuClient, agentManager, extensionManager, chatQueue, servicesMap } = options;

  // STT transcriber — lazy init on first audio message
  const sttCfg = config.multimodal?.stt;
  const getSttTranscriber = (): ((path: string, lang?: string) => Promise<string>) | undefined => {
    if (!sttCfg?.enabled || !sttCfg.providers?.length) return undefined;
    const sttProviders = createSTTProviders(sttCfg.providers);
    if (sttProviders.length === 0) return undefined;
    return async (audioPath: string, language?: string) => {
      const result = await transcribeWithFallback(sttProviders, {
        audioPath,
        language: language ?? sttCfg.language ?? 'auto',
      });
      return result.text;
    };
  };

  // Config path for slash commands that modify config (e.g. /permission)
  const configPath = process.env.CONFIG_FILE || './config.yaml';

  // Shared CommandDeps for slash commands
  const commandDeps = {
    agentService,
    skillRegistry: {
      getSkills: () => skillRegistry.getSkills(),
      reload: async () => {
        await skillRegistry.load('./skills', logger);
        return skillRegistry.getSkills().length;
      },
    },
    cronService,
    feishuClient,
    agentManager,
    extensionManager,
    configPath,
    // config hot-reload is triggered by the file watcher; no explicit callback needed
    // because startConfigWatcher in bootstrap.ts watches config.yaml
  };
  servicesMap.set('commandDeps', commandDeps);

  const sendTextReply = async (chatId: string, text: string) => {
    await feishuClient.sendMessage({
      receive_id: chatId,
      receive_id_type: 'chat_id',
      msg_type: 'text',
      content: JSON.stringify({ text }),
    });
  };

  const messageHandler = new MessageHandler({
    agentService,
    chatQueue,
    mediaDownloader: feishuClient,
    feishuClient,
    mediaAllowedRoots: config.tools.fileRead.allowedRoots.length > 0
      ? config.tools.fileRead.allowedRoots : undefined,
    mediaDeniedPatterns: config.tools.fileRead.deniedPatterns.length > 0
      ? config.tools.fileRead.deniedPatterns : undefined,
    logger,
    commandDeps,
    sendTextReply,
    addReaction: async (messageId: string, type: string) => {
      return feishuClient.addReaction(messageId, type);
    },
    removeReaction: async (messageId: string, reactionId: string) => {
      await feishuClient.removeReaction(messageId, reactionId);
    },
    getSttTranscriber,
    sttConfig: sttCfg ? {
      enabled: sttCfg.enabled ?? false,
      autoTranscribe: sttCfg.autoTranscribe ?? true,
      language: sttCfg.language ?? 'zh',
    } : undefined,
    botAppId: config.feishu.appId,
  });

  return { messageHandler, commandDeps };
}
