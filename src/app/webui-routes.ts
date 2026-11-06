/**
 * WebUI Route Registration
 *
 * Fastify plugin that registers all WebUI API routes and WebSocket support.
 * Auth (webuiAuthHook) is registered in bootstrap.ts BEFORE extensions load —
 * Fastify applies onRequest hooks only to routes registered after the hook,
 * so registering it here would be too late for extension routes.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { AppConfig, AppServices } from './types.js';
import { loadConfig, resetConfig } from './config.js';
import { ProjectStore } from './webui/project-store.js';
import { SessionRepository } from '../memory/repositories/session-repository.js';
import { registerProjectRoutes } from './webui/project-routes.js';
import { registerAgentRoutes } from './webui/agent-routes.js';
import { registerSessionRoutes, listProjectSessions } from './webui/session-routes.js';
import { registerInboxRoutes } from './webui/inbox-routes.js';
import { registerArchiveRoutes } from './webui/archive-routes.js';
import { registerSessionDeleteRoutes } from './webui/session-delete-routes.js';
import { registerChatRoutes, type ChatRouteConfig } from './webui/chat-routes.js';
import { registerConfigRoutes } from './webui/config-routes.js';
import { registerJudgeRoutes } from './webui/judge-routes.js';
import { registerMcpRoutes } from './webui/mcp-routes.js';
import { registerDashboardRoutes } from './webui/dashboard-routes.js';
import { registerChannelRoutes } from './webui/channel-routes.js';
import { registerSkillsRoutes } from './webui/skills-routes.js';
import { registerTemplateRoutes } from './webui/templates-routes.js';
import { registerFilesRoutes } from './webui/files-routes.js';
import { registerPublicDownloadRoutes } from './webui/public-download-routes.js';
import { registerMemoryRoutes } from './webui/memory-routes.js';
import { registerSearchRoutes } from './webui/search-routes.js';
import { registerNotesRoutes } from './webui/notes-routes.js';
import { registerCronRoutes } from './webui/cron-routes.js';
import { registerApprovalRoutes } from './webui/approval-routes.js';
import { registerSubscriptionRoutes } from './subscription/subscription-routes.js';
import { registerMarketplaceRoutes } from './webui/marketplace-routes.js';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import { WebSocketManager, createWebSocketPlugin } from './webui/websocket.js';
import { ChatStreamHub } from './webui/chat-stream-hub.js';
import { registerDesktopBridge } from './webui/desktop-bridge-routes.js';
import { registerSystemRoutes } from './webui/system-routes.js';
import { registerQRExchangeRoutes } from './webui/qr-exchange-routes.js';
import type { DesktopBridgeRegistry } from '../agent/desktop-bridge-registry.js';
import type { QrSessionStore } from '../channel/qr-session-store.js';

export interface WebUIRouteConfig {
  db: Database.Database;
  getConfig: () => AppConfig;
  services: AppServices;
  onConfigChanged: () => void;
  /** Called after config is saved via PUT /api/config — triggers hot-reload. */
  onConfigSaved?: (newConfig: AppConfig) => void;
  /** Live config ref — mutating this updates the in-memory config used by agent factory. */
  liveConfigRef?: { current: AppConfig };
  /** QR session store for channel QR-based configuration flows. */
  qrSessionStore?: QrSessionStore;
}

export async function registerWebUIRoutes(
  app: FastifyInstance,
  cfg: WebUIRouteConfig,
): Promise<{ wsManager: WebSocketManager; bridgeRegistry: DesktopBridgeRegistry }> {
  // 1. Register CORS (must be before auth hook — handles OPTIONS preflight)
  //    Whitelist local WebUI origins only — the WebUI is same-origin with the
  //    API, so browsers never need CORS here; rejecting (not reflecting) every
  //    other origin stops a cross-origin page from reading API responses.
  //    Remote-mode WebUIs hit the gateway same-origin and are unaffected.
  app.register(cors, {
    origin: (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) => {
      if (!origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
        cb(null, true);
      } else {
        cb(null, false);
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: true,
  });

  // 2. Register multipart for file uploads
  app.register(multipart);

  // 3. Auth hook (webuiAuthHook) was already registered on the root instance
  //    in bootstrap.ts before extension loading — do NOT add it again here.

  // 4. Create stores
  const projectStore = new ProjectStore(cfg.db);

  // 4b. In-flight chat stream hub — lets a WebUI tab re-attach mid-turn
  //     instead of losing everything already streamed (see chat-stream-hub).
  const chatStreamHub = new ChatStreamHub({ logger: app.log });
  app.addHook('onClose', (_instance, done) => {
    chatStreamHub.dispose();
    done();
  });

  // 5. Register all route modules (route decorators are synchronous)
  //
  // One repository instance: `ensure-default` ships the sidebar's first page and
  // the sessions routes serve the rest of it, so both must project rows the same
  // way (`listProjectSessions`) instead of each preparing its own statements.
  const sessionRepository = new SessionRepository(cfg.db);
  registerProjectRoutes(app, projectStore, {
    listSessions: (projectId) => listProjectSessions(sessionRepository, projectId),
  });

  registerAgentRoutes(app, {
    getConfig: cfg.getConfig,
    onConfigChanged: cfg.onConfigChanged,
  });

  registerSessionRoutes(app, cfg.db, () => cfg.getConfig().footer);

  /**
   * Bot display name for a channel, shared by the inbox and the archive so a
   * group label cannot differ between the two trees.
   *
   * A listing never waits on a platform round trip for it: a name we already
   * know is returned at once and refreshed behind the response, and a first-ever
   * lookup gets a short budget. The registry's own 3 s timeout used to be the
   * inbox's load time on a platform that was slow or unreachable.
   */
  const BOT_NAME_BUDGET_MS = 600;
  const resolveBotName = async (channel: string): Promise<string | undefined> => {
    // Ask the platform first: the bot's name lives in its owner's console and
    // is edited there, so a config copy is stale the moment someone renames it.
    const identity = cfg.services.botIdentity;
    if (identity) {
      const known = identity.cached(channel);
      if (known) {
        // `resolve()` never rejects and is single-flight, so this is a refresh,
        // not a second copy of a lookup already running.
        void identity.resolve(channel);
        return known;
      }
      const discovered = await withBudget(identity.resolve(channel), BOT_NAME_BUDGET_MS);
      if (discovered) return discovered;
    }

    // Fallback for a channel that cannot answer (platform unreachable, or a
    // bridge with no bot identity at all) — better a configured label than a
    // bare "QQ"/"飞书" in the sidebar.
    const config = cfg.getConfig();
    if (channel === 'feishu') return config.feishu.botName || undefined;
    if (channel === 'telegram') return config.telegram?.botName || undefined;
    return undefined;
  };

  // Read-only IM inbox (sessions with project_id IS NULL). Same auth: the
  // webuiAuthHook is a root-level onRequest hook registered in bootstrap.ts.
  registerInboxRoutes(app, cfg.db, () => cfg.getConfig().footer, resolveBotName, {
    // A turn in flight would keep writing into the row being deleted.
    isRunning: (sessionId) => cfg.services.agentService.isRunning(sessionId),
    // The agent holds the conversation in memory; deleting the transcript has
    // to drop it too or the next reply answers from deleted history.
    destroyRuntime: (sessionId) => {
      cfg.services.agentService.destroyRuntime(sessionId);
    },
  });

  // Batch delete for a multi-select in any of the three lists (project chats, IM
  // inbox, archive). One endpoint, because a selection can span both trees.
  registerSessionDeleteRoutes(app, cfg.db, {
    isRunning: (sessionId) => cfg.services.agentService.isRunning(sessionId),
    destroyRuntime: (sessionId) => {
      cfg.services.agentService.destroyRuntime(sessionId);
    },
  });

  // Archive of both trees (project chats + IM inbox) and the batch flag write.
  // Auto-restore on new messages happens in the agent turn path, not here.
  registerArchiveRoutes(app, cfg.db, resolveBotName, {
    // Live read: the settings row lives in config.yaml and is hot-reloaded.
    getAutoConfig: () => loadConfig().archive?.auto,
    isRunning: (sessionId) => cfg.services.agentService.isRunning(sessionId),
  });

  const chatConfig: ChatRouteConfig = {
    agentService: cfg.services.agentService,
    projectStore,
    db: cfg.db,
    getFooterConfig: () => cfg.getConfig().footer,
    getShowSkillCalls: () => cfg.getConfig().showSkillCalls,
    getShowToolCalls: () => cfg.getConfig().showToolCalls,
    agentManager: cfg.services.agentManager,
    getConfig: () => cfg.getConfig(),
    commandDeps: {
      agentService: cfg.services.agentService,
      skillRegistry: cfg.services.skillRegistry
        ? {
            getSkills: () => cfg.services.skillRegistry.getSkills(),
            reload: async () => {
              await cfg.services.skillRegistry.load('./skills');
              return cfg.services.skillRegistry.getSkills().length;
            },
          }
        : undefined,
      cronService: cfg.services.cronService,
      feishuClient: cfg.services.feishuClient,
      agentManager: cfg.services.agentManager,
      extensionManager: cfg.services.extensionManager,
      configPath: process.env.CONFIG_FILE || './config.yaml',
      triggerConfigReload: () => {
        resetConfig();
        const newConfig = loadConfig();
        cfg.onConfigSaved?.(newConfig);
      },
      // `/note` typed into the WebUI chat input behaves exactly like `/note` in IM.
      notes: cfg.services.notesService,
    },
    commandRegistry: cfg.services.commandRegistry,
    wsManager: undefined,
    userQuestionSenderRegistry: cfg.services.userQuestionSenderRegistry,
    harnessApprovalRegistry: cfg.services.harnessApprovalRegistry,
    streamHub: chatStreamHub,
  };
  registerChatRoutes(app, chatConfig);

  registerConfigRoutes(app, {
    getConfig: cfg.getConfig,
    configPath: process.env.CONFIG_FILE || './config.yaml',
    onConfigSaved: cfg.onConfigSaved,
  });

  registerMcpRoutes(app, {
    db: cfg.db,
    getConfig: cfg.getConfig,
    getManager: () => cfg.services.mcpManager,
    onConfigSaved: cfg.onConfigSaved,
  });

  registerJudgeRoutes(app, {
    getConfig: cfg.getConfig,
    getJudge: () => cfg.services.judge,
    onConfigSaved: cfg.onConfigSaved,
  });

  registerDashboardRoutes(app, {
    db: cfg.db,
    getConfig: cfg.getConfig,
  });

  registerChannelRoutes(app, {
    getConfig: cfg.getConfig,
  });

  registerSkillsRoutes(app, { services: cfg.services });

  registerMarketplaceRoutes(app, { services: cfg.services });

  registerTemplateRoutes(app);

  registerFilesRoutes(app, {
    getConfig: cfg.getConfig,
    onConfigChanged: cfg.onConfigChanged,
    configPath: process.env.CONFIG_FILE || './config.yaml',
  });

  // Public download endpoint — serves files to external channels without auth
  registerPublicDownloadRoutes(app);

  registerMemoryRoutes(app, {
    db: cfg.db,
    services: cfg.services,
    // Scene digest files live under the same base dir SceneClusterer writes to
    sceneBaseDir: cfg.getConfig().memory.offloading?.refDir || './data',
  });

  // Unified search (`/api/search`, `/api/search/context`). Reuses the memory
  // retriever so memories rank here exactly like chat recall.
  registerSearchRoutes(app, {
    db: cfg.db,
    memoryRetriever: cfg.services.memoryRetriever,
    getFooterConfig: () => cfg.getConfig().footer,
  });

  // Notes API. Registered only while the service exists, so `notes.enabled:
  // false` means the routes 404 — "no service" is the off switch rather than a
  // second flag read at every call site. (Absent `notes:` no longer disables the
  // layer, so a fresh install has these routes; only an explicit `false`, or a
  // service that failed to construct, leaves the page without an API.) The WebUI
  // answers that 404 by showing the page as switched off, with a link to the
  // settings tab that turns it on, instead of rendering the 404 itself.
  if (cfg.services.notesService) {
    registerNotesRoutes(app, { service: cfg.services.notesService });
  }

  registerCronRoutes(app, cfg.services.cronService);

  // Approval routes — reuse the same ApprovalRequestRepository from memory services
  const { ApprovalRequestRepository } =
    await import('../memory/repositories/approval-request-repository.js');
  registerApprovalRoutes(app, {
    agentService: cfg.services.agentService,
    approvalRequestRepo: new ApprovalRequestRepository(cfg.db),
    db: cfg.db,
  });

  // 6. Register WebSocket (Fastify tracks the plugin promise internally;
  //    it will be resolved during server.listen())
  const wsManager = new WebSocketManager();
  wsManager.setLogger(app.log);
  chatConfig.wsManager = wsManager;
  app.register(createWebSocketPlugin(wsManager));

  // 7. Register Desktop Bridge WebSocket (for remote tool execution)
  const bridgeRegistry = registerDesktopBridge(app);

  // 8. Register system routes (update check, etc.)
  registerSystemRoutes(app);

  // 9. Register QR exchange routes (credential submission pages for channel setup)
  if (cfg.qrSessionStore) {
    registerQRExchangeRoutes(app, cfg.qrSessionStore);
  }

  // 10. Register subscription routes (depends on WebSocket for login progress)
  if (cfg.services.subscriptionService) {
    registerSubscriptionRoutes(app, {
      subscriptionService: cfg.services.subscriptionService,
      wsManager,
      liveConfigRef: cfg.liveConfigRef,
    });
  }

  return { wsManager, bridgeRegistry };
}

/**
 * Resolve `promise` if it settles within `ms`, else give up and answer
 * `undefined`.
 *
 * Used for labels a response may legitimately lack: the work keeps running (so
 * a later request gets the answer from cache), but the caller is not held open
 * by a platform that never answers.
 */
async function withBudget<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
    // The budget must not be the only thing keeping the process alive.
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
