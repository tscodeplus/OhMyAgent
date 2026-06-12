/**
 * Bootstrap — assembles all modules into a working AppServices container.
 *
 * Initialization order is dependency-driven:
 *   1. Config & logger
 *   2. Database
 *   3. Custom providers
 *   4. Embedding client
 *   5. Memory repositories + retriever/writer
 *   6. Tool registry + built-in tools
 *   7. Approval gate
 *   8. Skill registry
 *   9. Agent factory + agent service
 *  10. Feishu components
 *  11. HTTP server (and optionally WebSocket client)
 */

import { i18n, changeI18nLocale } from '../i18n/index.js';
import { loadConfig, startConfigWatcher, startEnvWatcher, stopConfigWatcher, stopEnvWatcher, resetConfig } from './config.js';
import { createLogger } from './logger.js';
import { teamModeStore } from '../agent/team-mode-store.js';
import { createI18nService } from '../i18n/i18n-service.js';
import { PromptManager } from '../prompt/prompt-manager.js';
import { getDefaultModel } from '../provider/pi-ai-setup.js';
import type { AppConfig, AppServices, ApprovalDecisionType, CustomModelConfig } from './types.js';
import { openDatabase } from '../memory/db.js';
import { registerModel } from '@earendil-works/pi-ai';
import { createAgentFactory } from '../agent/agent-factory.js';
import { AgentService } from '../agent/agent-service.js';
import { loadVisionBridgeConfig } from '../vision-bridge/vision-bridge-config.js';
import { VisionBridgeService } from '../vision-bridge/vision-bridge-service.js';
import { createShellToolDefinition } from '../tools/builtins/shell/definition.js';
import { createSTTProviders, transcribeWithFallback } from '../media-providers/stt/factory.js';
import { SkillRegistry } from '../skills/skill-registry.js';
import { FeishuRouter } from '../../extensions/channel-feishu/feishu-router.js';
import { createFeishuServer } from '../../extensions/channel-feishu/feishu-server.js';
import { FeishuWSClient } from '../../extensions/channel-feishu/feishu-ws-client.js';
import { MessageHandler } from '../../extensions/channel-feishu/message-handler.js';
import { renderApprovalCard, renderApprovalResultCard } from '../../extensions/channel-feishu/render/approval-card-renderer.js';
import { createFeishuApprovalUiPort } from '../../extensions/channel-feishu/render/approval-ui-port-feishu.js';
import { ChatQueue } from '../../extensions/channel-feishu/chat-queue.js';
import { ReplyDispatcher } from '../../extensions/channel-feishu/render/reply-dispatcher.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { load as parseYaml, dump as dumpYaml } from 'js-yaml';
import { generateId } from '../shared/ids.js';
import { CronService } from '../cron/service.js';
import { registerWebUIRoutes } from './webui-routes.js';
import { createSkillLintTool } from '../tools/builtins/skills/skill-lint-definition.js';
import { createSkillCreateTool } from '../tools/builtins/skills/skill-create-definition.js';
import { getWebUIToken } from './webui-auth.js';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Computer Use
import { normalizeComputerUseSettings } from '../computer-use/settings.js';
import { ComputerProviderRegistry } from '../computer-use/provider-registry.js';
import { ComputerLeaseRegistry } from '../computer-use/lease-registry.js';
import { ComputerUseHost } from '../computer-use/computer-host.js';
import { SSHComputerUseProvider } from '../computer-use/providers/ssh-provider.js';
import { LocalWindowsProvider } from '../computer-use/providers/local-windows.js';
import { NutJSProvider } from '../computer-use/providers/local-nutjs.js';
import { createMockComputerProvider } from '../computer-use/providers/mock-provider.js';
import { SSHPool } from '../computer-use/transports/ssh-pool.js';

// V2 imports
import { AgentManager } from '../agent/agent-manager.js';

// v4 Phase 5: Orchestrator
import { OrchestratorImpl } from '../orchestrator/orchestrator.js';
import { InMemoryAgentRunStore } from '../orchestrator/agent-run-store.js';
import { InMemoryTaskRunStore } from '../orchestrator/task-run-store.js';
import { PermissionInheritanceServiceImpl } from '../orchestrator/permission-inheritance.js';
import { ApprovalStateSyncImpl } from '../orchestrator/approval-state-sync.js';
import { PendingApprovalStore } from '../agent/approval-store.js';
import { createMemoryServices } from './composers/memory-services.js';
import { createPolicyServices } from './composers/policy-services.js';
import { createToolServices, registerV4ToolDefinitions } from './composers/tool-services.js';
import { createChannelServices } from './composers/channel-services.js';
import { createSchedulers } from './composers/scheduler-services.js';
import { SubscriptionService } from './subscription/subscription-service.js';

// ─── Types ───

export interface BootstrapResult {
  services: AppServices;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

// ═══════════════════════════════════════════════════════════════
// Module-level helpers (extracted from bootstrap() to reduce
// closure nesting and improve readability)
// ═══════════════════════════════════════════════════════════════

function withCustomProviderCacheCompat(model: CustomModelConfig, providerName?: string): Record<string, unknown> | undefined {
  if (model.api === 'openai-completions') {
    const defaults: Record<string, unknown> = {
      sendSessionAffinityHeaders: true,
    };
    // xunfei (讯飞) uses standard OpenAI-compatible API but differs in a few areas:
    // - Only supports system/user/assistant/tool roles (no "developer" role)
    // - Does not support the `store: false` parameter
    // - Uses `max_tokens` instead of `max_completion_tokens`
    if (providerName === 'xunfei') {
      defaults.supportsDeveloperRole = false;
      defaults.supportsStore = false;
      defaults.maxTokensField = 'max_tokens';
    }
    return {
      ...defaults,
      ...model.compat,
    };
  }
  if (model.api === 'openai-responses') {
    return {
      sendSessionIdHeader: true,
      ...model.compat,
    };
  }
  return model.compat as Record<string, unknown> | undefined;
}

function formatDisplayModel(provider: string | undefined, model: string | undefined): string {
  if (!provider && !model) return 'unknown';
  if (!provider) return model ?? 'unknown';
  if (!model) return provider;
  if (model.startsWith(`${provider}/`)) return model;
  return `${provider}/${model}`;
}

// ─── Bootstrap ───

/**
 * Assemble all application modules into a fully-wired AppServices container.
 */
export async function bootstrap(): Promise<BootstrapResult> {
  // 1. Load config & logger
  let config = loadConfig();
  const logger = createLogger(config.logging.level);

  // v7: Initialize team mode store with global config defaults
  teamModeStore.init(config.smart_agent_team);

  // Initialize i18n service (must complete before other i18n-dependent services)
  const { fileURLToPath } = await import('node:url');
  const localesPath = fileURLToPath(new URL('../locales', import.meta.url));
  await createI18nService({
    defaultLocale: config.uiLanguage,
    localesPath,
  });
  logger.info({ uiLanguage: config.uiLanguage, localesPath, i18nLocale: i18n.locale }, 'i18n initialized');

  // 1.5 Initialize PromptManager (v5: centralized prompt management)
  const promptManager = new PromptManager({
    t: (key, interpolations) => i18n.t(key, interpolations),
    uiLanguage: config.uiLanguage ?? 'zh-CN',
  });
  logger.info('PromptManager initialized (v5)');

  // 2. Initialize database (includes V4 migration for project_id column)
  const db = openDatabase(config.database.path);

  // 3. Register custom providers defined in custom_providers.yaml or CUSTOM_PROVIDERS env
  if (config.customProviders) {
    for (const cp of config.customProviders) {
      logger.info({ provider: cp.provider, modelCount: cp.models.length }, 'Registering custom provider');
      for (const m of cp.models) {
        registerModel(cp.provider, m.id, {
          id: m.id,
          name: m.name,
          api: m.api,
          apiKey: cp.apiKey,
          provider: cp.provider,
          baseUrl: cp.baseUrl,
          reasoning: m.reasoning ?? false,
          input: m.input ?? ['text'],
          cost: {
            input: m.cost?.input ?? 0,
            output: m.cost?.output ?? 0,
            cacheRead: m.cost?.cacheRead ?? 0,
            cacheWrite: m.cost?.cacheWrite ?? 0,
          },
          contextWindow: m.contextWindow ?? 128000,
          maxTokens: m.maxTokens ?? 16000,
          compat: withCustomProviderCacheCompat(m, cp.provider),
        } as any);
      }
    }
  }

  // 3a. Initialize subscription service — injects OAuth API keys into providerKeys
  const subscriptionService = new SubscriptionService({
    dataDir: path.dirname(config.database.path),
    logger,
  });
  await subscriptionService.applyCredentialsToConfig(config);


  const memoryServices = await createMemoryServices(config, logger, db);
  const {
    embeddingClient,
    memoryRepository,
    embeddingRepository,
    memoryLinkRepo,
    memoryRetriever,
    memoryWriter,
    memoryHygiene,
    memorySummarizer,
    memoryDoctor,
    sessionRepository,
    messageRepository,
    processedMessageRepository,
    episodeRepository,
    toolRunRepository,
    approvalRequestRepo,
    approvalDecisionRepository,
    personaStore,
    personaDistiller,
    personaAuditService,
    sceneClusterer,
    memoryChangeCallbacks,
    offloadDir,
  } = memoryServices;

  const policyServices = createPolicyServices(config, db);
  const {
    approvalGate,
    replyApprovalRegistry,
    pathPolicy,
    approvalResolution,
    policyCenter,
  } = policyServices;

  const servicesRef: { current?: AppServices } = {};
  const toolServices = createToolServices({
    config,
    logger,
    memory: memoryServices,
    policyCenter,
    servicesRef,
  });
  const { toolRegistry, toolPlatformRegistry } = toolServices;

  // 9. Create skill registry
  const skillRegistry = new SkillRegistry();
  try {
    await skillRegistry.load('./skills', logger);
  } catch (err) {
    logger.warn({ err }, 'Skill registry load failed — continuing without skills');
  }

  // ── Computer Use ──

  let computerUseHost: ComputerUseHost | undefined;
  const agentManagerRef: { current?: AgentManager } = {};

  let cuaSettings = normalizeComputerUseSettings(config.computerUse);

  // Detect WSL: Linux kernel but can call powershell.exe to control Windows host
  const isWSL = process.platform === 'linux' && existsSync('/proc/sys/fs/binfmt_misc/WSLInterop');
  const isTermux = existsSync('/data/data/com.termux') || !!process.env.PREFIX?.includes('/com.termux/');

  if (cuaSettings.enabled) {
    const providerRegistry = new ComputerProviderRegistry();

    // Always register mock provider for testing
    providerRegistry.register(createMockComputerProvider());

    // WSL: register direct Windows provider (no SSH needed)
    if (isWSL) {
      providerRegistry.register(new LocalWindowsProvider({ logger }));
      logger.info('Computer Use: WSL detected, registered Windows local provider (powershell.exe)');
    }

    // Native desktop control via nut.js (Linux/macOS/Windows, non-WSL only).
    // Termux cannot load the native desktop addon, so skip registration instead
    // of logging a native module failure on every service start.
    if (!isWSL && !isTermux) {
      try {
        const nutProvider = new NutJSProvider({ logger });
        providerRegistry.register(nutProvider);
        logger.info(`Computer Use: registered NutJS local provider (${process.platform})`);
      } catch (err) {
        logger.warn({ err }, 'Computer Use: failed to register NutJS provider');
      }
    } else if (isTermux) {
      logger.info('Computer Use: Termux detected, skipping NutJS local provider');
    }

    // Register SSH provider if configured
    if (cuaSettings.ssh.host && cuaSettings.ssh.user && cuaSettings.ssh.keyPath) {
      const sshPool = new SSHPool({
        host: cuaSettings.ssh.host,
        user: cuaSettings.ssh.user,
        keyPath: cuaSettings.ssh.keyPath,
        port: cuaSettings.ssh.port,
        jumpHost: cuaSettings.ssh.jumpHost || undefined,
        display: cuaSettings.ssh.display,
        hostKeyChecking: cuaSettings.ssh.hostKeyChecking,
        knownHostsPath: cuaSettings.ssh.knownHostsPath || undefined,
      });
      providerRegistry.register(new SSHComputerUseProvider({
        sshPool,
        settings: cuaSettings,
        logger,
      }));
      logger.info('Computer Use: SSH provider registered');
    }

    // Resolve default provider with fallback chain
    let defaultProviderId: string;
    if (isWSL) {
      defaultProviderId = 'windows:local';
    } else if (providerRegistry.has('nutjs')) {
      defaultProviderId = 'nutjs';
    } else {
      defaultProviderId = 'mock';
      if (isTermux) {
        logger.info('Computer Use: using mock provider on Termux');
      } else {
        logger.warn('Computer Use: NutJS unavailable, falling back to mock provider');
      }
    }

    // Verify the resolved default provider is actually available at startup.
    // On platforms where the native addon cannot load (Termux aarch64, headless
    // Linux without X11), the provider will report available:false and we fall
    // back to mock to avoid returning unavailable to every computer_use call.
    const resolvedProvider = providerRegistry.get(defaultProviderId);
    if (resolvedProvider) {
      try {
        const status = await resolvedProvider.getStatus({ sessionPath: '', agentId: '' });
        if (!status.available) {
          logger.warn(
            { defaultProviderId, reason: status.message },
            `Computer Use: default provider '${defaultProviderId}' reports unavailable, falling back to mock`,
          );
          if (providerRegistry.has('mock')) {
            defaultProviderId = 'mock';
          }
        }
      } catch {
        // getStatus threw — provider is broken, fall back to mock
        logger.warn(
          { defaultProviderId },
          `Computer Use: default provider '${defaultProviderId}' threw during status check, falling back to mock`,
        );
        if (providerRegistry.has('mock')) {
          defaultProviderId = 'mock';
        }
      }
    }

    const leaseRegistry = new ComputerLeaseRegistry();
    computerUseHost = new ComputerUseHost({
      providers: providerRegistry,
      defaultProviderId,
      leases: leaseRegistry,
      platform: process.platform,
      getSettings: () => cuaSettings,
      getAccessMode: () => 'operate',
      getPrimaryAgentId: () => agentManagerRef.current?.list()[0]?.id ?? null,
      logger,
    });

    logger.info({ defaultProviderId, providerCount: providerRegistry.list().length }, 'Computer Use initialized');
  } else {
    logger.debug('Computer Use disabled');
  }

  const channelServices = createChannelServices({
    config,
    logger,
    db,
    memory: memoryServices,
    tools: toolServices,
    agentManagerRef,
  });
  const {
    feishuClient,
    commandRegistry,
    channelManager,
    extensionManager,
    servicesMap,
    apiDeps,
    cronDeliveryRegistry,
    agentManager,
  } = channelServices;

  // Load extensions from config directory — deferred to after all services
  // are created so extensions can resolve them via servicesMap.
  const extDir = config.extensions?.directory || 'extensions';

  // Lazy ref for CronService (not yet created, needed by agent-factory per-turn)
  const cronServiceRef: { current: CronService | undefined } = { current: undefined };
  const orchestratorRef: { current?: OrchestratorImpl } = {};

  // 10. Create agent factory (needs feishuClient for approval cards)
  const approvalPort = createFeishuApprovalUiPort({
    feishuClient: feishuClient as { sendApprovalCard(chatId: string, card: Record<string, unknown>): Promise<string>; recallMessage?(messageId: string): Promise<void> },
    registry: replyApprovalRegistry,
  });
  const agentFactory = createAgentFactory({
    config,
    toolRegistry,
    skillRegistry,
    defaultModel: undefined,
    memoryRetriever,
    personaStore,
    agentManager,
    computerUseHost,
  }, {
    approvalGate,
    feishuClient,
    approvalTimeoutMs: config.tools.shellApprovalTimeoutSec * 1000,
    approvalTimeoutAction: config.tools.shellApprovalTimeoutAction,
    shellEnabled: config.tools.shellEnabled,
    approvalRequestRepo,
    approvalPort,
    defaultToolsProfile: config.tools.toolsProfile,
    cronServiceFactory: () => cronServiceRef.current,
    policyCenter,
    orchestratorFactory: () => orchestratorRef.current,
    getServices: () => servicesRef.current,
    onApprovalAutoReject: (requestId, reason) => {
      // Update the messages table so the WebUI approval card shows
      // the auto-rejected result after page refresh.
      try {
        const msgId = `approval-${requestId}`;
        const row = db.prepare(
          'SELECT metadata FROM messages WHERE id = ?',
        ).get(msgId) as { metadata: string | null } | undefined;
        if (row) {
          let meta: Record<string, unknown> = {};
          try { meta = row.metadata ? JSON.parse(String(row.metadata)) : {}; } catch { /* ignore */ }
          const approval = (meta.approval || {}) as Record<string, unknown>;
          approval.status = 'rejected';
          approval.decision = 'reject_once';
          approval.timeoutReason = reason;
          meta.approval = approval;
          db.prepare(
            'UPDATE messages SET metadata = ? WHERE id = ?',
          ).run(JSON.stringify(meta), msgId);
        }
      } catch (err) {
        logger.warn({ err, requestId }, 'Failed to update approval message on auto-reject');
      }

      if (!feishuClient?.updateMessage || !approvalRequestRepo) return;
      const req = approvalRequestRepo.findById(requestId);
      if (!req?.card_message_id || !req.chat_id) return;
      // Clear the tracker's approvalMessageId so its resolve() won't recall
      // the card after we've already updated it to show the rejection.
      const tracker = replyApprovalRegistry.get(req.card_message_id);
      if (tracker) {
        tracker.clearApprovalMessageId(requestId);
      }
      const resultCard = renderApprovalResultCard('reject_once', {
        id: requestId,
        command: req.command_text ?? 'unknown',
        risk: (req.risk_level as 'low' | 'medium' | 'high') ?? 'low',
        sessionId: req.session_key,
        timestamp: Date.now(),
      }, reason === 'timeout' || reason === 'expired_before_recovery' ? 'timeout' : reason === 'steered' ? 'steered' : 'restart');
      feishuClient.updateMessage(req.card_message_id, 'interactive', resultCard).catch(() => {});
    },
    logger,
    promptManager,
  });

  // ── v4 Phase 5: Orchestrator ─────────────────────────────────────────

  const agentRunStore = new InMemoryAgentRunStore();
  const taskRunStore = new InMemoryTaskRunStore();
  const permissionInheritance = new PermissionInheritanceServiceImpl(policyCenter);

  const sendApprovalToChat = async (chatId: string, approval: any): Promise<string> => {
    if (!feishuClient?.sendApprovalCard) {
      logger.warn({ approvalId: approval.id, chatId }, 'No Feishu approval sender available for routed child approval');
      return `approval-msg-${Date.now()}`;
    }
    const card = renderApprovalCard({
      id: approval.id,
      command: approval.subject ?? approval.kind,
      risk: approval.risk ?? 'medium',
      reason: approval.reason,
      sessionId: approval.sessionId ?? chatId,
      timestamp: Date.now(),
    });
    return feishuClient.sendApprovalCard(chatId, card);
  };

  const orchestratorPendingStore = new PendingApprovalStore();

  const approvalStateSync = new ApprovalStateSyncImpl({
    approvalResolution,
    pendingApprovals: orchestratorPendingStore,
    sendApprovalToChat,
  });

  const orchestrator = new OrchestratorImpl({
    agentRunStore,
    taskRunStore,
    permissionInheritance,
    approvalStateSync,
    policyCenter,
    agentFactory,
    agentManager,
    pendingApprovals: orchestratorPendingStore,
    logger,
  });
  orchestratorRef.current = orchestrator;

  const feishuRouter = new FeishuRouter({ logger, processedMessageRepository });
  feishuRouter.startCleanup(60_000); // Periodically clean up dedup seen map every 60s
  const chatQueue = new ChatQueue();

  // 12. Create agent service with ReplyDispatcher factory
  // Resolve the effective model for footer display using the same fallback
  // chain as agent-factory.ts: config model → fallback
  const resolvedDefault = getDefaultModel(config);
  const effectiveModel = resolvedDefault;
  const modelName = formatDisplayModel(
    (effectiveModel as any)?.provider,
    (effectiveModel as any)?.id,
  );
  // Vision Bridge: lazy init on first image analysis (saves ~200ms at startup).
  // Config lives at multimodal.image.bridge (was standalone visionBridge).
  type VB = import('../vision-bridge/vision-bridge-types.js').VisionBridgeConfig;
  const imgBridgeCfg = (config.multimodal?.image?.bridge ?? {}) as Partial<VB>;
  const visionBridgeConfig: VB = {
    enabled: imgBridgeCfg.enabled ?? config.visionBridge?.enabled ?? false,
    modelRef: imgBridgeCfg.modelRef ?? config.visionBridge?.modelRef,
    apiKey: imgBridgeCfg.apiKey ?? config.visionBridge?.apiKey,
    baseUrl: imgBridgeCfg.baseUrl ?? config.visionBridge?.baseUrl,
    timeoutMs: imgBridgeCfg.timeoutMs ?? config.visionBridge?.timeoutMs ?? 120_000,
    maxNoteChars: imgBridgeCfg.maxNoteChars ?? config.visionBridge?.maxNoteChars ?? 3200,
    maxCacheEntries: imgBridgeCfg.maxCacheEntries ?? config.visionBridge?.maxCacheEntries ?? 256,
  };
  let _visionBridge: VisionBridgeService | undefined;
  const getVisionBridge = (): VisionBridgeService | undefined => {
    if (!visionBridgeConfig.enabled) return undefined;
    if (!_visionBridge) {
      _visionBridge = new VisionBridgeService(visionBridgeConfig, config.customProviders ?? [], logger);
      logger.info({ modelRef: visionBridgeConfig.modelRef }, 'Vision Bridge enabled (lazy init)');
    }
    return _visionBridge;
  };

  const agentService = new AgentService(
    agentFactory,
    (chatId: string, messageId?: string, agentId?: string) => {
      const agentName = agentId ? agentManager.get(agentId)?.name : undefined;
      return new ReplyDispatcher({ feishuClient, chatId, messageId, model: modelName, agentName, footerConfig: config.footer, showToolCalls: config.showToolCalls, logger });
    },
    {
      sessionRepository,
      messageRepository,
      episodeRepository,
      toolRunRepository,
      memorySummarizer,
      summarizeInterval: config.memory.summarizeInterval,
      logger,
    },
    getVisionBridge,
    config.multimodal?.image?.mode ?? 'native_first',
  );

  // Register agentService so extensions can resolve it via api.getService()
  servicesMap.set('agentService', agentService);

  const schedulerServices = createSchedulers({
    config,
    logger,
    db,
    memory: memoryServices,
    cronDeliveryRegistry,
    agentService,
    modelName,
  });
  const { maintenanceScheduler, cronService, jobRunner } = schedulerServices;
  cronServiceRef.current = cronService;
  servicesMap.set('cronService', cronService);

  // 14. Wire up Feishu event routing

  // v5 P2: STT transcriber — lazy init on first audio message (saves ~500ms at startup).
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

  // Assemble shared CommandDeps for slash commands (used by Feishu + other channels)
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

  // Register the im.message.receive_v1 event handler — MessageHandler is now
  // self-contained, handling both slash commands and agent execution.
  feishuRouter.on('im.message.receive_v1', async (context) => {
    await messageHandler.handle(context);
  });

  // 14. Create HTTP server
  const serverPort = parseInt(process.env.OHMYAGENT_PORT || process.env.PORT || '9191', 10);
  const server = createFeishuServer({
    port: serverPort,
    feishuAuth: {
      verificationToken: config.feishu.verificationToken || undefined,
      encryptKey: config.feishu.encryptKey || undefined,
    },
    feishuRouter,
    logger,
    rateLimit: {
      maxRequests: config.rateLimit.webhookMaxRequests,
      windowMs: config.rateLimit.webhookWindowMs,
    },
  });

  // Register server so extensions can access it (e.g. for webhook routes)
  servicesMap.set('server', server);
  servicesMap.set('subscriptionService', subscriptionService);

  // Now that all services are created, load extensions
  await extensionManager.loadAll([extDir]);
  logger.info({ extCount: extensionManager.list().length }, 'V2 extensions loaded');

  // Bridge: register all channel adapters from ExtensionManager into ChannelManager
  // so ChannelManager.startAll() / stopAll() controls their lifecycle.
  for (const channel of extensionManager.getChannels()) {
    channelManager.register(channel);
  }

  // 15. Create WebSocket client (if Feishu channel is enabled and WS mode)
  let wsClient: FeishuWSClient | undefined;
  if (config.feishu.enabled && config.feishu.wsEnabled) {
    wsClient = new FeishuWSClient({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      eventHandler: async (event: any) => {
        await feishuRouter.route(event);
      },
      cardActionHandler: async (callback: any) => {
        const value = callback?.action?.value ?? {};
        const { action, requestId, command, risk } = value;
        const approvalTracker = replyApprovalRegistry.get(callback?.context?.open_message_id);

        if (!requestId || !action) {
          return { code: 0 };
        }

        const decision = action as 'approve_once' | 'approve_session' | 'approve_always' | 'reject_once' | 'reject_always';
        const resolved = agentFactory.resolveApproval(requestId, decision);

        if (!resolved) {
          const existingDecision = approvalDecisionRepository.findLatestByRequestId(requestId);
          const resultCard = renderApprovalResultCard(
            (existingDecision?.decision as ApprovalDecisionType) ?? 'reject_once',
            {
              id: requestId,
              command: command ?? 'unknown',
              risk: (risk as 'low' | 'medium' | 'high') ?? 'low',
              sessionId: '',
              timestamp: Date.now(),
            },
          );
          return {
            toast: {
              type: 'info',
              content: i18n.t('bootstrap:toast.alreadyHandled'),
            },
            card: {
              type: 'raw',
              data: resultCard,
            },
          };
        }

        // Persist the decision to DB for audit trail
        approvalDecisionRepository.create({
          id: generateId(),
          request_id: requestId,
          decided_by: 'user',
          decision: decision,
        });
        approvalRequestRepo.update(requestId, {
          status: decision.startsWith('approve') ? 'approved' : 'rejected',
          decision_mode: decision,
        });

        if (approvalTracker) {
          await approvalTracker.resolve(requestId, decision, { skipRecall: true });
        }

        // Build result card to replace the approval card
        const resultCard = renderApprovalResultCard(decision, {
          id: requestId,
          command: command ?? 'unknown',
          risk: risk ?? 'low',
          sessionId: '',
          timestamp: Date.now(),
        });

        // Return toast + card replacement (data must be object, not string)
        const toastContent =
          decision === 'approve_once' ? i18n.t('bootstrap:toast.approvedOnce') :
          decision === 'approve_session' ? i18n.t('bootstrap:toast.approvedSession') :
          decision === 'approve_always' ? i18n.t('bootstrap:toast.approvedAlways') :
          decision === 'reject_once' ? i18n.t('bootstrap:toast.deniedOnce') :
          i18n.t('bootstrap:toast.deniedAlways');
        const response = {
          toast: {
            type: decision.startsWith('approve') ? 'success' : 'error',
            content: toastContent,
          },
          card: {
            type: 'raw',
            data: resultCard,
          },
        };
        return response;
      },
      logger,
    });
  }

  registerV4ToolDefinitions({
    config,
    logger,
    tools: toolServices,
    memory: memoryServices,
    policyCenter,
    computerUseHost,
    agentManager,
    agentFactory,
    orchestrator,
  });

  // ─── Register skill management tools (deferrable via tool_search) ────

  const skillToolsDeps = {
    skillRegistry,
    skillsDir: './skills',
    getToolNames: () => toolRegistry.names(),
  };
  toolRegistry.register(createSkillLintTool(skillToolsDeps));
  toolRegistry.register(createSkillCreateTool(skillToolsDeps));

  // ─── Assemble services ───

  const services: AppServices = {
    config,
    logger,
    db,
    toolRegistry,
    memoryRetriever,
    memoryWriter,
    memorySummarizer,
    sessionRepository,
    messageRepository,
    episodeRepository,
    toolRunRepository,
    approvalGate,
    skillRegistry,
    agentFactory,
    agentService,
    feishuClient,
    feishuRouter,
    chatQueue,
    cronService,
    cronDeliveryRegistry,
    server,
    wsClient,
    computerUseHost,
    agentManager,
    commandRegistry,
    channelManager,
    extensionManager,
    // v4
    policyCenter,
    toolPlatformRegistry,
    orchestrator,
    // Subscription
    subscriptionService,
  };
  servicesRef.current = services;

  // ─── Register WebUI routes (after services are assembled) ───
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  // Mutable ref for onConfigReload callback — assigned later after all services
  // are created. Passed to config routes so PUT /api/config can trigger a full
  // hot-reload (critical for first-run setup wizard where config.yaml doesn't
  // exist at bootstrap time and the file watcher was never started).
  const onConfigSavedRef: { current?: (newConfig: AppConfig) => void } = {};

  // Register WebUI API routes + WebSocket on the Fastify server
  const { wsManager, bridgeRegistry } = await registerWebUIRoutes(server, {
    db,
    getConfig: () => loadConfig(),
    services,
    liveConfigRef: { current: config },
    onConfigSaved: (newConfig) => onConfigSavedRef.current?.(newConfig),
    onConfigChanged: () => {
      // Persist in-memory config mutations (agent CRUD, etc.) to config.yaml.
      // The empty callback comment was misleading — the file watcher only detects
      // filesystem changes, not in-memory mutations.
      const configPath = process.env.CONFIG_FILE || './config.yaml';
      if (!existsSync(configPath)) return;
      try {
        const raw = readFileSync(configPath, 'utf-8');
        const yaml = parseYaml(raw) as Record<string, unknown>;
        const config = loadConfig();

        // Persist agents: JS array → YAML map (id → {name, ...})
        if (config.agents && config.agents.length > 0) {
          const agentsMap: Record<string, unknown> = {};
          for (const agent of config.agents) {
            const { id, ...rest } = agent as unknown as Record<string, unknown>;
            agentsMap[id as string] = rest;
          }
          yaml.agents = agentsMap;
        } else {
          delete yaml.agents;
        }

        writeFileSync(configPath, dumpYaml(yaml, { indent: 2, lineWidth: 120 }), 'utf-8');
        resetConfig();
      } catch (err) {
        console.error('[onConfigChanged] Failed to persist config:', err);
      }
    },
  });

  // Store the Desktop Bridge registry so agent-factory can inject it into tool contexts
  servicesMap.set('desktopBridgeRegistry', bridgeRegistry);
  // Also set on the typed services object so getServices() can find it
  services.desktopBridgeRegistry = bridgeRegistry;

  // Register WebUI cron delivery — pushes scheduled reminders to the browser
  cronDeliveryRegistry.register('webui', {
    async deliver({ chatId, text, modelLabel, agentName }) {
      const parts: string[] = [];
      if (agentName) parts.push(agentName);
      parts.push(`定时提醒 · ${modelLabel}`);
      const msg = {
        type: 'cron_delivery',
        title: '定时任务提醒',
        text,
        footer: parts.join(' · '),
      };
      logger.info({ chatId, textLen: text.length, connectedClients: wsManager.connectedCount }, '[cron-delivery:webui] broadcasting');
      wsManager.broadcast(msg);
      logger.info({ chatId }, '[cron-delivery:webui] broadcast done');
    },
  });

  // ─── WebUI serving (single port — same as API server) ───
  //
  // Two modes:
  //   Dev  (ui/src exists) → Vite middleware for fast transforms + HMR
  //   Prod (no ui/src)     → pre-built static files from ui/dist
  //
  // Both use /webui/ prefix on the SAME Fastify server — no second port.
  // Skip in test environments — the mock server doesn't support these plugins.

  const isTest = process.env.VITEST || process.env.NODE_ENV === 'test';

  // Declare outside the block so the stop() closure can close the Vite server
  let viteDevServer: Awaited<ReturnType<typeof import('vite').createServer>> | undefined;

  if (!isTest) {
  const uiRoot = path.join(__dirname, '../../ui');
  const uiDist = process.env.WEBUI_STATIC_ROOT || path.join(uiRoot, 'dist');
  const uiSrc = path.join(uiRoot, 'src');
  const isDevMode = !process.env.WEBUI_STATIC_ROOT && existsSync(uiSrc);

  if (isDevMode) {
    try {
      const { createServer: createViteServer } = await import('vite');
      const reactPlugin = (await import('@vitejs/plugin-react')).default;
      const tailwindPlugin = (await import('@tailwindcss/vite')).default;

      // configFile: false prevents Vite from auto-loading ui/vite.config.ts,
      // which would register duplicate plugins and inject the HMR runtime twice.
      viteDevServer = await createViteServer({
        configFile: false,
        server: {
          middlewareMode: true,
          hmr: {
            // Attach Vite's HMR WebSocket to the same HTTP server.
            // Vite's ws server only handles upgrade requests matching
            // its HMR path (derived from base), so it won't steal /ws.
            server: server.server,
          },
        },
        appType: 'custom',
        base: '/webui/',
        root: uiRoot,
        plugins: [reactPlugin(), tailwindPlugin()],
        resolve: {
          alias: {
            '@': path.resolve(uiRoot, 'src'),
          },
        },
      });

      // Root HTML page and SPA fallback: use Vite's transformIndexHtml so
      // the page gets HMR client injected and asset URLs are correct.
      const indexHtmlPath = path.join(uiRoot, 'index.html');

      const sendIndexHtml = async (reqUrl: string, reply: any) => {
        const raw = readFileSync(indexHtmlPath, 'utf-8');
        const transformed = await viteDevServer!.transformIndexHtml(reqUrl, raw);
        return reply.type('text/html').send(transformed);
      };

      server.get('/webui', (_, reply) => sendIndexHtml('/webui', reply));
      server.get('/webui/', (_, reply) => sendIndexHtml('/webui/', reply));

      // All other /webui/* and /@* paths: delegate to Vite's middlewares
      // (handles JS/TS/CSS transforms, HMR client, etc.). If Vite can't
      // find a file, fall back to index.html (SPA routing).
      const delegateToVite = async (
        request: { raw: any; url: string },
        reply: { hijack: () => Promise<void>; raw: any },
      ) => {
        await reply.hijack();
        const url = request.url;
        viteDevServer!.middlewares(request.raw, reply.raw, () => {
          // Vite didn't handle this request — serve index.html for SPA routing
          if (!reply.raw.headersSent) {
            viteDevServer!.transformIndexHtml(url, readFileSync(indexHtmlPath, 'utf-8'))
              .then((html) => {
                if (!reply.raw.headersSent) {
                  reply.raw.statusCode = 200;
                  reply.raw.setHeader('Content-Type', 'text/html; charset=utf-8');
                  reply.raw.end(html);
                }
              })
              .catch(() => {
                if (!reply.raw.headersSent) {
                  reply.raw.statusCode = 500;
                  reply.raw.end('Internal Server Error');
                }
              });
          }
        });
      };

      server.route({
        method: ['GET'],
        url: '/webui/*',
        handler: delegateToVite as any,
      });

      server.route({
        method: ['GET'],
        url: '/@*',
        handler: delegateToVite as any,
      });

      logger.info({ base: '/webui/' }, 'WebUI dev middleware (Vite) registered on same port');
    } catch (err) {
      logger.warn({ err }, 'Vite dev middleware failed — falling back to static files');
      viteDevServer = undefined;
    }
  }

  // Production or fallback (no Vite middleware): serve pre-built static files from ui/dist
  if (!viteDevServer && existsSync(uiDist)) {
    await server.register(fastifyStatic, {
      root: uiDist,
      prefix: '/webui/',
      wildcard: false,
    });

    // SPA fallback: serve index.html for /webui/* routes not matching a static file
    server.setNotFoundHandler((request, reply) => {
      const url = request.url.split('?')[0];
      if (url.startsWith('/webui/') && !url.startsWith('/webui/assets/')) {
        return reply.sendFile('index.html');
      }
      if (url === '/webui' || url === '/webui/') {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: 'Not Found' });
    });
    logger.info({ uiDist, prefix: '/webui/' }, 'WebUI static files registered');
  } else if (!viteDevServer) {
    logger.info('WebUI not available — run "cd ui && pnpm build" to build it');
  }

  // Redirect root to WebUI
  server.get('/', async (_request, reply) => {
    return reply.redirect('/webui/');
  });

  } // end if (!isTest)

  // ─── Hot reload: watch config.yaml and .env for changes ───
  const yamlPath = process.env.CONFIG_FILE || './config.yaml';

  const onConfigReload = (newConfig: AppConfig) => {
    // Replace the closure-level config reference so all downstream callbacks
    // (ReplyDispatcher, cron delivery, etc.) pick up the new values.
    config = newConfig;

    // Update servicesRef so tools reading ctx.services.config see new values
    if (servicesRef.current) {
      servicesRef.current.config = newConfig;
    }

    // Update extension API's config ref so channels using api.getConfig() see new values
    apiDeps.config = newConfig;

    // Re-apply OAuth credentials to providerKeys (token may have refreshed)
    subscriptionService.applyCredentialsToConfig(newConfig).catch(err =>
      logger.warn({ err }, '[hot-reload] Failed to apply OAuth credentials'),
    );

    // Update agent factory's config ref (fallbackModels, reasoningLevel, tools, memory, etc.)
    agentFactory.updateConfig(newConfig);

    approvalGate.updateConfig({
      execMode: newConfig.tools.shellExecMode,
      shellAllowlist: newConfig.tools.shellAllowlist,
      fileReadAllowedRoots: newConfig.tools.fileRead.allowedRoots,
      shellApprovalMode: newConfig.tools.shellApprovalMode,
      shellApprovalWhitelist: newConfig.tools.shellApprovalWhitelist,
    });
    approvalGate.createWhitelistPolicies(
      (newConfig.tools.shellAllowlist?.length ?? 0) > 0
        ? newConfig.tools.shellAllowlist
        : newConfig.tools.shellApprovalWhitelist,
    );
    pathPolicy.updateConfig({
      readRoots: newConfig.policy?.path?.readRoots ?? newConfig.tools.fileRead.allowedRoots,
      writeRoots: newConfig.policy?.path?.writeRoots ?? [],
      deniedPatterns: newConfig.policy?.path?.deniedPatterns ?? newConfig.tools.fileRead.deniedPatterns,
      autoInjectCwd: true,
      autoInjectMediaCache: newConfig.multimodal?.attachments?.cacheDir,
    });

    // Re-resolve agents if definitions changed (agent list, profiles, model refs)
    const newAgents = newConfig.agents ?? [];
    agentManager.reload(newConfig, newAgents);

    // Start or stop cron scheduler based on new config
    if (newConfig.cron.enabled) {
      cronService.start();
    } else {
      cronService.stop();
    }

    // Update logger level immediately (pino supports runtime level change)
    logger.level = newConfig.logging.level;

    // i18n: switch locale without restart (locale files already loaded)
    if (newConfig.uiLanguage && newConfig.uiLanguage !== i18n.locale) {
      changeI18nLocale(newConfig.uiLanguage).catch(err =>
        console.error('[hot-reload] Failed to change locale:', err),
      );
    }

    // Computer use: re-compute settings from new config
    cuaSettings = normalizeComputerUseSettings(newConfig.computerUse);

    // Team mode: update default config for new sessions
    teamModeStore.updateConfig(newConfig.smart_agent_team);

    // Rate limiter: update webhook rate limit settings
    (server as any).updateRateLimit?.({
      maxRequests: newConfig.rateLimit.webhookMaxRequests,
      windowMs: newConfig.rateLimit.webhookWindowMs,
    });

    // Shell tool: re-register with new timeout/output limits
    toolPlatformRegistry.registerDefinition(createShellToolDefinition({
      timeoutMs: newConfig.tools.defaultTimeoutMs,
      maxOutputLength: newConfig.tools.maxOutputLength,
    }));

    // Footer: update on JobRunner (ReplyDispatcher reads config.footer per-execution)
    jobRunner.updateConfig({ footer: newConfig.footer });

    logger.info(
      {
        logLevel: newConfig.logging.level,
        showToolCalls: newConfig.showToolCalls,
        uiLanguage: newConfig.uiLanguage,
        toolsProfile: newConfig.tools.toolsProfile,
        memoryAutoRecall: newConfig.memory.autoRecall,
        fallbackModels: newConfig.fallbackModels,
        agents: newAgents.length,
        cronEnabled: newConfig.cron.enabled,
      },
      'config reloaded (hot-reloaded items applied; channels/embedding/database require restart)',
    );
  };

  // Wire up the onConfigReload callback so PUT /api/config can trigger hot-reload
  onConfigSavedRef.current = onConfigReload;

  startConfigWatcher(yamlPath, onConfigReload);

  // Also watch .env so API keys and env-only settings take effect without restart
  const envPath = './.env';
  startEnvWatcher(envPath, yamlPath, onConfigReload);

  let hygieneTimer: ReturnType<typeof setTimeout> | undefined;

  return {
    services,

    start: async () => {
      // Print WebUI access info
      const webuiToken = getWebUIToken();
      logger.info({ token: webuiToken }, 'WebUI token (use this to log in)');

      // V2: Start all channels (via extensions)
      try {
        await channelManager.startAll();
      } catch (err) {
        logger.warn({ err }, 'ChannelManager start failed (non-fatal)');
      }

      // Start cron scheduler
      if (config.cron.enabled) {
        cronService.start();
        logger.info('Cron scheduler started');
      }

      // Start maintenance scheduler (replaces DreamCycle)
      maintenanceScheduler.start();
      logger.info('MaintenanceScheduler started');

      // Start WebSocket client if enabled
      if (wsClient) {
        await wsClient.start();
        logger.info('WebSocket client started');
      }

      // Start HTTP server (always, even with WS — serves /health and /webhook/card)
      const bindHost = process.env.OHMYAGENT_BIND_ADDRESS || '0.0.0.0';
      await server.listen({ port: serverPort, host: bindHost });
      logger.info(`Server started on port ${serverPort}`);

      // Fire-and-forget: run memory hygiene 5 seconds after startup (non-blocking)
      if (config.memory.hygiene.enabled) {
        hygieneTimer = setTimeout(() => {
          try {
            const report = memoryHygiene.runIfDue();
            if (report.cleanedCount > 0) {
              logger.info(
                { cleanedCount: report.cleanedCount, kinds: report.cleanedKinds, durationMs: report.durationMs },
                'Memory hygiene completed',
              );
            }
            if (report.error) {
              logger.warn({ error: report.error }, 'Memory hygiene error (non-fatal)');
            }
          } catch (e) {
            logger.warn({ error: e }, 'Memory hygiene error (non-fatal)');
          }
        }, 5000);
        hygieneTimer.unref?.();
      }
    },

    stop: async () => {
      // V2: Stop all channels
      await channelManager.stopAll();

      // Stop cron scheduler
      cronService.stop();

      // Stop maintenance scheduler and delayed startup jobs before closing DB
      maintenanceScheduler.stop();
      if (hygieneTimer) {
        clearTimeout(hygieneTimer);
        hygieneTimer = undefined;
      }

      // Stop hot-reload watchers
      stopConfigWatcher();
      stopEnvWatcher();

      // Stop WebSocket client
      if (wsClient) {
        wsClient.stop();
        console.log('[OhMyAgent] WebSocket client stopped');
      }

      // Stop periodic dedup cleanup timer
      feishuRouter.stopCleanup();
      console.log('[OhMyAgent] Dedup cleanup timer stopped');

      // Close Vite dev server if active
      if (viteDevServer) {
        await viteDevServer.close();
        console.log('[OhMyAgent] Vite dev server stopped');
      }

      // Close HTTP server
      await server.close();
      console.log('[OhMyAgent] HTTP server stopped');

      // Close database
      db.close();
      console.log('[OhMyAgent] Database closed');

      console.log('[OhMyAgent] Shutdown complete');
    },
  };
}
