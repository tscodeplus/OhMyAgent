/**
 * Feishu Message Services Composer
 *
 * Extracted from bootstrap.ts (Phase 9d). Creates STT transcriber,
 * CommandDeps, MessageHandler, and registers Feishu event routing.
 */

import { createSTTProviders, transcribeWithFallback } from '../../media-providers/stt/factory.js';
import { MessageHandler } from '../../../extensions/channel-feishu/message-handler.js';
import { fixFeishuMarkdown } from '../../../extensions/channel-feishu/render/markdown-sanitizer.js';
import { buildSimpleMarkdownCard } from '../../../extensions/channel-feishu/render/cardkit-builder.js';
import { loadConfig, resetConfig } from '../config.js';
import { configManager } from '../config-manager.js';
import type { AppConfig } from '../types.js';
import type { CommandDeps } from '../../commands/command-handler.js';
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
  commandDeps: CommandDeps;
}

/** Operator shape the admin check receives (subset of CommandOperator). */
interface AdminOperator {
  senderId?: string;
  chatType?: string;
  channel?: string;
}

/**
 * Channel-aware admin check for privileged slash commands (e.g. /permission).
 *
 * The CommandDeps instance is shared across all channels, so the check must
 * resolve the operator's own channel instead of always consulting the Feishu
 * config. Rules per channel:
 * - allowedUsers configured → only whitelisted senders are admins
 * - no whitelist → single/private chat counts as the operator's own channel
 *   (admin); group chats cannot run privileged commands
 *   (Feishu 'p2p', Telegram private (anything but group/supergroup), WeChat
 *   is inherently 1:1, QQ 'c2c')
 */
export function createChannelIsAdmin(config: AppConfig) {
  return (operator: AdminOperator): boolean => {
    const channel = operator.channel ?? 'feishu';
    const allowedUsers = ((): string[] => {
      switch (channel) {
        case 'telegram': return config.telegram?.allowedUsers ?? [];
        case 'wechat': return config.wechat?.allowedUsers ?? [];
        case 'qq': return config.qq?.allowedUsers ?? [];
        default: return config.feishu.allowedUsers ?? [];
      }
    })();
    if (allowedUsers.length > 0) {
      return !!operator.senderId && allowedUsers.includes(operator.senderId);
    }
    switch (channel) {
      case 'telegram':
        return operator.chatType !== 'group' && operator.chatType !== 'supergroup';
      case 'qq':
        return operator.chatType !== 'group';
      case 'wechat':
        return true; // personal WeChat bot — every conversation is 1:1
      default: // feishu
        return operator.chatType === 'p2p';
    }
  };
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
  const commandDeps: CommandDeps = {
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
    triggerConfigReload: () => {
      configManager.reloadFromFile().catch(err =>
        logger.error({ err }, 'Config reload via /permission failed'),
      );
    },
    isAdmin: createChannelIsAdmin(config),
  };
  servicesMap.set('commandDeps', commandDeps);

  const sendTextReply = async (chatId: string, text: string) => {
    // Send as an interactive card so **bold**, *italic*, ~~strikethrough~~
    // are rendered via lark_md. ZWSP insertion fixes CJK-adjacent marker issues.
    const card = buildSimpleMarkdownCard(fixFeishuMarkdown(text));
    await feishuClient.sendMessage({
      receive_id: chatId,
      receive_id_type: 'chat_id',
      msg_type: 'interactive',
      content: JSON.stringify(card),
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
    allowedUsers: config.feishu.allowedUsers,
  });

  return { messageHandler, commandDeps };
}
