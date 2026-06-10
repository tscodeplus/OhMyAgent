// ---------------------------------------------------------------------------
// channel-qq extension entry point.
//
// Registers a ChannelAdapter that bridges QQ Bot API v2 WebSocket events
// (api.sgroup.qq.com) into OhMyAgent's unified agent pipeline.
//
// This is the official QQ Bot API v2 protocol (used by OpenClaw, OpenHanako),
// NOT OneBot v11.
//
// Architecture:
//   index.ts          — entry point, ChannelAdapter lifecycle
//   qq-auth.ts        — OAuth2 token management + gateway URL discovery
//   qq-gateway.ts     — WebSocket lifecycle (Hello/Identify/Ready/Heartbeat/Resume)
//   message-handler.ts— Event routing, command interception, agent execution
//   qq-dispatcher.ts  — ReplyDispatcher for agent streaming output
//   send-message.ts   — QQ REST API send utilities (chunking, markdown, media)
//   message-context.ts— QQWsPayload → ChannelContext translation
//   group-handler.ts  — Group @-mention detection
//   qq-config.ts      — Configuration defaults
// ---------------------------------------------------------------------------

import type { Logger } from 'pino';
import type { ExtensionAPI } from '../../src/extensions/types.js';
import type { CommandDeps } from '../../src/commands/command-handler.js';
import type { ChannelAdapter, ChannelContext, ReplyContent } from '../../src/channel/types.js';
import type { AgentService } from '../../src/agent/agent-service.js';
import type { CronDeliveryRegistry } from '../../src/cron/delivery-registry.js';
import { resolveQQConfig } from './qq-config.js';
import { QQAuth } from './qq-auth.js';
import { QQGateway } from './qq-gateway.js';
import { setupMessageHandlers } from './message-handler.js';
import { sendReply, sendChunkedText } from './send-message.js';
import type { QQConfig } from './qq-types.js';

export default function (api: ExtensionAPI): void {
  const config = api.getConfig();
  const logger = api.getLogger();

  // Skip if QQ is not enabled / not configured
  if (!config.qq?.enabled || !config.qq?.appId) {
    logger.info('QQ channel not enabled or missing appId in config, skipping channel-qq');
    return;
  }

  const qqConfig: QQConfig = resolveQQConfig(config.qq);

  // Validate required fields
  if (!qqConfig.clientSecret) {
    logger.error('QQ clientSecret is required but not configured');
    return;
  }

  // Resolve shared services
  const agentService = api.getService<AgentService>('agentService');
  if (!agentService) {
    logger.error('AgentService not found — channel-qq requires it');
    return;
  }

  const commandDeps = api.getService<CommandDeps>('commandDeps');

  // -----------------------------------------------------------------------
  // QQ Bot API v2 core components
  // -----------------------------------------------------------------------

  const auth = new QQAuth(qqConfig.appId, qqConfig.clientSecret, qqConfig.sandbox, logger);
  const gateway = new QQGateway(auth, logger);

  // Register QQ cron delivery client
  const cronRegistry = api.getService<CronDeliveryRegistry>('cronDeliveryRegistry');
  if (cronRegistry) {
    cronRegistry.register('qq', {
      async deliver({ chatId, text, modelLabel, agentName, footer: footerConfig }) {
        // chatId format: "u:<openid>" for user, "g:<openid>" for group
        const target: { openid?: string; groupOpenid?: string } = {};
        if (chatId.startsWith('g:')) {
          target.groupOpenid = chatId.slice(2);
        } else {
          target.openid = chatId.startsWith('u:') ? chatId.slice(2) : chatId;
        }
        const parts: string[] = [];
        if (footerConfig.showAgentName && agentName) parts.push(agentName);
        if (footerConfig.showModel && modelLabel) parts.push(modelLabel);
        parts.push(new Date().toLocaleString('zh-CN'));
        const footer = `\n\n${parts.join(' · ')}`;
        await sendChunkedText(gateway, text + footer, target, qqConfig.textLimit, {
          warn: (msg, err) => logger.warn({ err, chatId }, msg),
        });
      },
    });
    logger.info('QQ cron delivery client registered');
  }

  // -----------------------------------------------------------------------
  // ChannelAdapter
  // -----------------------------------------------------------------------

  const adapter: ChannelAdapter = {
    id: 'qq',

    async start(): Promise<void> {
      logger.info({ appId: qqConfig.appId, sandbox: qqConfig.sandbox }, 'QQ channel starting');

      // Build a fallback CommandDeps if the DI container did not provide one
      const deps: CommandDeps | undefined = commandDeps ?? ({
        agentService,
        skillRegistry: undefined,
        cronService: undefined,
        feishuClient: undefined,
        agentManager: undefined,
        extensionManager: undefined,
      } as CommandDeps);

      // v5 P2: Build STT transcriber for QQ audio attachments
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

      // Wire gateway events into the agent pipeline BEFORE connecting
      setupMessageHandlers(gateway, qqConfig, agentService, deps, logger, api, sttTranscriber, sttHandlerConfig);

      // Connect to the QQ Bot API v2 gateway
      await gateway.connect();
      logger.info({ appId: qqConfig.appId }, 'QQ Bot API v2 gateway connected');
    },

    async stop(): Promise<void> {
      await gateway.close();
      logger.info('QQ gateway disconnected');
    },

    onReceive(_handler: (ctx: ChannelContext) => Promise<void>): void {
      // Messages are handled directly via gateway.onEvent in start().
      // This method exists to satisfy the ChannelAdapter interface.
    },

    async sendReply(ctx: ChannelContext, reply: ReplyContent): Promise<void> {
      const meta = ctx.message.replyMeta as Record<string, unknown> | undefined;
      if (!meta) {
        logger.warn('No replyMeta in ChannelContext, cannot send reply');
        return;
      }

      const target: { openid?: string; groupOpenid?: string } = {};
      if (meta.groupOpenid) {
        target.groupOpenid = meta.groupOpenid as string;
      } else if (meta.openid) {
        target.openid = meta.openid as string;
      } else {
        // Fallback: use sender ID as openid
        target.openid = ctx.message.senderId;
      }

      if (!target.openid && !target.groupOpenid) {
        logger.warn({ replyMeta: meta }, 'Cannot determine target for QQ reply');
        return;
      }

      try {
        await sendReply(gateway, reply, target, qqConfig);
      } catch (err) {
        logger.error({ err: (err as Error).message }, 'QQ sendReply failed');
      }
    },
  };

  api.registerChannel(adapter);
  logger.info('channel-qq registered');
}
