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
import { loadConfig, startConfigWatcher, startEnvWatcher, stopConfigWatcher, stopEnvWatcher } from './config.js';
import { createLogger } from './logger.js';
import { teamModeStore } from '../agent/team-mode-store.js';
import { createI18nService } from '../i18n/i18n-service.js';
import { PromptManager } from '../prompt/prompt-manager.js';
import type { AppConfig, AppServices, CustomModelConfig } from './types.js';
import { openDatabase } from '../memory/db.js';
import { registerModel } from '@earendil-works/pi-ai';
import { SkillRegistry } from '../skills/skill-registry.js';
import { FeishuRouter } from '../../extensions/channel-feishu/feishu-router.js';
import { createFeishuServer } from '../../extensions/channel-feishu/feishu-server.js';
import { FeishuWSClient } from '../../extensions/channel-feishu/feishu-ws-client.js';
import { ChatQueue } from '../../extensions/channel-feishu/chat-queue.js';
import { registerWebUIRoutes } from './webui-routes.js';
import { createSkillLintTool } from '../tools/builtins/skills/skill-lint-definition.js';
import { createSkillCreateTool } from '../tools/builtins/skills/skill-create-definition.js';
import { createSkillTestTool } from '../tools/builtins/skills/skill-test-definition.js';
import { SkillMetricsService } from '../skills/skill-evolution/skill-metrics.js';
import { getWebUIToken } from './webui-auth.js';
import { setupWebUIMiddleware } from './webui/setup-vite.js';
import { createOnConfigChanged } from './webui/config-persist.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Computer Use (provider logic extracted to composers/computer-use-services.ts)
import { normalizeComputerUseSettings } from '../computer-use/settings.js';

// v4 Phase 5: Orchestrator
import { createMemoryServices } from './composers/memory-services.js';
import { createPolicyServices } from './composers/policy-services.js';
import { createToolServices, registerV4ToolDefinitions } from './composers/tool-services.js';
import { createChannelServices } from './composers/channel-services.js';
import { createSchedulers } from './composers/scheduler-services.js';
import { createComputerUseServices } from './composers/computer-use-services.js';
import { createAgentServices } from './composers/agent-services.js';
import { createFeishuServices } from './composers/feishu-services.js';
import { SubscriptionService } from './subscription/subscription-service.js';
import { configEventBus } from './config-event-bus.js';
import { createWSCardActionHandler } from './feishu/ws-card-action-handler.js';
import { QrSessionStore } from '../channel/qr-session-store.js';

// ─── Types ───

export interface BootstrapResult {
  services: AppServices;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

// ═══════════════════════════════════════════════════════════════
// Module-level helpers
// ═══════════════════════════════════════════════════════════════

function registerCustomProviders(config: AppConfig, logger: AppServices['logger']): void {
  if (!config.customProviders) return;
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
      } as Parameters<typeof registerModel>[2]);
    }
  }
}

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

  // Register config-reload handlers for simple services (self-contained, no
  // complex dependency chains). Remaining services are still updated inline
  // in onConfigReload and will be migrated incrementally.
  configEventBus.onReload((c) => { logger.level = c.logging.level; });
  configEventBus.onReload((c) => teamModeStore.updateConfig(c.smart_agent_team));
  configEventBus.onReload((c) => {
    if (c.uiLanguage && c.uiLanguage !== i18n.locale) {
      changeI18nLocale(c.uiLanguage).catch((err) => console.error('[hot-reload] Failed to change locale:', err));
    }
  });

  // 1.5 Initialize PromptManager (v5: centralized prompt management)
  const promptManager = new PromptManager({
    uiLanguage: config.uiLanguage ?? 'zh-CN',
  });
  logger.info('PromptManager initialized (v5)');

  // 2. Initialize database (includes V4 migration for project_id column)
  const db = openDatabase(config.database.path);

  // 3. Register custom providers defined in custom_providers.yaml or CUSTOM_PROVIDERS env
  registerCustomProviders(config, logger);

  // 3a. Initialize subscription service — injects OAuth API keys into providerKeys
  const subscriptionService = new SubscriptionService({
    dataDir: path.dirname(config.database.path),
    logger,
  });
  await subscriptionService.applyCredentialsToConfig(config);
  configEventBus.onReload((c) =>
    subscriptionService.applyCredentialsToConfig(c).catch((err) => logger.warn({ err }, '[hot-reload] Failed to apply OAuth credentials')),
  );


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

  // P1-4: Skill metrics service (tracks usage, success rates, feedback)
  const skillMetricsService = new SkillMetricsService(db);
  logger.info('Skill metrics service initialized (P1-4)');

  // ── Computer Use (extracted to composers/computer-use-services.ts) ──
  const cuServices = await createComputerUseServices(config, logger);
  const { computerUseHost, agentManagerRef, cuaSettingsRef } = cuServices;

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

  // ── Agent services (extracted to composers/agent-services.ts) ──
  const agentServicesResult = createAgentServices({
    config,
    logger,
    db,
    toolRegistry,
    skillRegistry,
    memoryRetriever,
    personaStore,
    agentManager,
    computerUseHost,
    approvalGate,
    policyCenter,
    feishuClient,
    replyApprovalRegistry,
    approvalRequestRepo,
    approvalDecisionRepository,
    approvalResolution,
    promptManager,
    sessionRepository,
    messageRepository,
    episodeRepository,
    toolRunRepository,
    memorySummarizer,
    servicesRef,
  });
  const {
    agentFactory,
    orchestrator,
    orchestratorRef,
    agentService,
    cronServiceRef,
    modelName,
    userQuestionStore,
  } = agentServicesResult;

  const feishuRouter = new FeishuRouter({ logger, processedMessageRepository });
  feishuRouter.startCleanup(60_000);
  const chatQueue = new ChatQueue();

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
  const { maintenanceScheduler, dreamCycle, cronService, jobRunner } = schedulerServices;
  cronServiceRef.current = cronService;
  servicesMap.set('cronService', cronService);

  // 14. Wire up Feishu event routing (extracted to composers/feishu-services.ts)
  const feishuServices = createFeishuServices({
    config,
    logger,
    agentService,
    skillRegistry,
    cronService,
    feishuClient,
    agentManager,
    extensionManager,
    chatQueue,
    servicesMap,
  });
  const { messageHandler } = feishuServices;

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

  // QR session store for channel QR-based auto-configuration
  const qrSessionStore = new QrSessionStore();
  servicesMap.set('qrSessionStore', qrSessionStore);

  // ── User Question Sender registry ──
  // Channels register their UserQuestionSender implementations here during
  // extension startup. The ask_user_question tool looks up the sender via
  // getUserQuestionSender() in AppServices.
  const userQuestionSenderRegistry = new Map<string, import('../agent/user-question-port.js').UserQuestionSender>();
  function getUserQuestionSender(channel: string, _chatId: string, sessionId?: string): import('../agent/user-question-port.js').UserQuestionSender | undefined {
    // Session-specific lookup first (e.g. WebUI SSE connections)
    if (sessionId) {
      const sessionKey = `${channel}:${sessionId}`;
      if (userQuestionSenderRegistry.has(sessionKey)) {
        return userQuestionSenderRegistry.get(sessionKey);
      }
    }
    // Fall back to channel-wide sender (e.g. Feishu, Telegram, QQ)
    return userQuestionSenderRegistry.get(channel);
  }

  // Make the user question sender registry available to all channel extensions
  servicesMap.set('userQuestionSenderRegistry', userQuestionSenderRegistry);
  servicesMap.set('userQuestionStore', userQuestionStore);

  // ── Register Feishu UserQuestionSender ──
  if (feishuClient) {
    const { createFeishuUserQuestionSender } = await import('../../extensions/channel-feishu/render/user-question-sender.js');
    userQuestionSenderRegistry.set('feishu', createFeishuUserQuestionSender({
      sendCard: (chatId: string, card: Record<string, unknown>) =>
        feishuClient.sendApprovalCard(chatId, card),
      recallMessage: (messageId: string) =>
        feishuClient.recallMessage?.(messageId) ?? Promise.resolve(),
    }));
  }

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
      cardActionHandler: createWSCardActionHandler({
        agentFactory,
        replyApprovalRegistry,
        approvalDecisionRepository,
        approvalRequestRepo,
        userQuestionStore,
      }),
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
  toolRegistry.register(createSkillTestTool(skillToolsDeps));

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
    skillMetricsService,
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
    // User question
    userQuestionStore,
    getUserQuestionSender,
    userQuestionSenderRegistry,
  };
  servicesRef.current = services;

  // ─── Register WebUI routes (after services are assembled) ───

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
    onConfigChanged: createOnConfigChanged(),
    qrSessionStore,
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

  // ─── WebUI middleware (extracted to webui/setup-vite.ts) ───
  const { viteDevServer } = await setupWebUIMiddleware({
    server,
    logger,
    isTest: !!process.env.VITEST || process.env.NODE_ENV === 'test',
    uiRoot: path.join(process.cwd(), 'ui'),
  });

  // ─── Hot reload: watch config.yaml and .env for changes ───
  const yamlPath = process.env.CONFIG_FILE || './config.yaml';

  const onConfigReload = (newConfig: AppConfig) => {
    // ── Detect which sections changed (before overwriting old config) ──
    const oldConfig = config;
    const restartReasons: string[] = [];

    // Channel configs (feishu, telegram, wechat, qq) require restart
    const channelKeys = ['feishu', 'telegram', 'wechat', 'qq'] as const;
    for (const key of channelKeys) {
      if (JSON.stringify(oldConfig[key]) !== JSON.stringify(newConfig[key])) {
        restartReasons.push('channels');
        break; // one channel change is enough
      }
    }

    // Embedding config requires restart
    if (JSON.stringify(oldConfig.embedding) !== JSON.stringify(newConfig.embedding)) {
      restartReasons.push('embedding');
    }

    // Database path requires restart
    if (oldConfig.database?.path !== newConfig.database?.path) {
      restartReasons.push('database');
    }

    // Replace the closure-level config reference so all downstream callbacks
    // (ReplyDispatcher, cron delivery, etc.) pick up the new values.
    config = newConfig;

    // Update servicesRef so tools reading ctx.services.config see new values
    if (servicesRef.current) {
      servicesRef.current.config = newConfig;
    }

    // Update extension API's config ref so channels using api.getConfig() see new values
    apiDeps.config = newConfig;

    // ── Services migrated to configEventBus ─────────────────────────────
    // Most services now self-register via configEventBus.onReload() at
    // their construction sites. Only a few remain inline due to mutable
    // refs or dynamic API surface.

    // Computer use: re-compute settings from new config (mutable ref)
    cuaSettingsRef.current = normalizeComputerUseSettings(newConfig.computerUse);

    // Rate limiter: dynamic method on Fastify server (not typed)
    (server as any).updateRateLimit?.({
      maxRequests: newConfig.rateLimit.webhookMaxRequests,
      windowMs: newConfig.rateLimit.webhookWindowMs,
    });

    // ── Fire event bus for self-registered listeners ────────────────────
    configEventBus.emit(newConfig).catch(err =>
      logger.warn({ err }, 'Config reload event handler failed'),
    );

    // ── Log and notify ──────────────────────────────────────────────────
    const restartMsg = restartReasons.length > 0
      ? `; ${restartReasons.join('/')} require restart`
      : '';

    logger.info(
      {
        logLevel: newConfig.logging.level,
        showToolCalls: newConfig.showToolCalls,
        uiLanguage: newConfig.uiLanguage,
        toolsProfile: newConfig.tools.toolsProfile,
        memoryAutoRecall: newConfig.memory.autoRecall,
        fallbackModels: newConfig.fallbackModels,
        agents: (newConfig.agents ?? []).length,
        cronEnabled: newConfig.cron.enabled,
        restartReasons: restartReasons.length > 0 ? restartReasons : undefined,
      },
      `config reloaded (hot-reloaded items applied${restartMsg})`,
    );

    // Push restart notification to WebUI when channels/embedding/database changed
    if (restartReasons.length > 0) {
      try {
        wsManager.broadcast({
          type: 'config_changed',
          restartRequired: true,
          restartReasons,
          timestamp: Date.now(),
        });
      } catch {
        // wsManager might not be ready yet (first-run setup wizard)
      }
    }
  };

  // Wire up the onConfigReload callback so PUT /api/config can trigger hot-reload
  onConfigSavedRef.current = onConfigReload;

  startConfigWatcher(yamlPath, onConfigReload);

  // Also watch .env so API keys and env-only settings take effect without restart
  const envPath = './.env';
  startEnvWatcher(envPath, yamlPath, onConfigReload);

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

      // Start maintenance scheduler (day-time interval jobs)
      maintenanceScheduler.start();
      logger.info('MaintenanceScheduler started');

      // Start DreamCycle (nightly heavy orchestration)
      dreamCycle.start();
      logger.info('DreamCycle scheduler started');

      // Start WebSocket client if enabled
      if (wsClient) {
        await wsClient.start();
        logger.info('WebSocket client started');
      }

      // Start HTTP server (always, even with WS — serves /health and /webhook/card)
      const bindHost = process.env.OHMYAGENT_BIND_ADDRESS || '0.0.0.0';
      await server.listen({ port: serverPort, host: bindHost });
      logger.info(`Server started on port ${serverPort}`);
    },

    stop: async () => {
      // V2: Stop all channels
      await channelManager.stopAll();

      // Stop cron scheduler
      cronService.stop();

      // Stop maintenance scheduler and DreamCycle
      maintenanceScheduler.stop();
      await dreamCycle.stop();

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
