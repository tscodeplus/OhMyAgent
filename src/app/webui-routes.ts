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
import { registerProjectRoutes } from './webui/project-routes.js';
import { registerAgentRoutes } from './webui/agent-routes.js';
import { registerSessionRoutes } from './webui/session-routes.js';
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
import { registerGraphRoutes } from './webui/graph-routes.js';
import { registerKnowledgeRoutes } from './webui/knowledge-routes.js';
import type { KnowledgeStatsSnapshot } from '../commands/command-handler.js';
import { registerCronRoutes } from './webui/cron-routes.js';
import { registerApprovalRoutes } from './webui/approval-routes.js';
import { registerSubscriptionRoutes } from './subscription/subscription-routes.js';
import { registerMarketplaceRoutes } from './webui/marketplace-routes.js';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import { WebSocketManager, createWebSocketPlugin } from './webui/websocket.js';
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

  // 5. Register all route modules (route decorators are synchronous)
  registerProjectRoutes(app, projectStore);

  registerAgentRoutes(app, {
    getConfig: cfg.getConfig,
    onConfigChanged: cfg.onConfigChanged,
  });

  registerSessionRoutes(app, cfg.db, () => cfg.getConfig().footer);

  /**
   * Bot display name for a channel, shared by the inbox and the archive so a
   * group label cannot differ between the two trees.
   */
  const resolveBotName = async (channel: string): Promise<string | undefined> => {
    // Ask the platform first: the bot's name lives in its owner's console and
    // is edited there, so a config copy is stale the moment someone renames it.
    const discovered = await cfg.services.botIdentity?.resolve(channel);
    if (discovered) return discovered;

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

  /**
   * Knowledge pages (plan §6 K2). The service is NOT built here: it is the one
   * instance `createMemoryServices` constructs next to the database handle, so
   * the tool definitions, the per-turn injection provider, the `/knowledge`
   * chat command and the page-editor routes below cannot drift into reading and
   * writing through different objects. Gated on `knowledge.enabled` upstream —
   * absent means the layer is off, and an editor or command over a frozen table
   * would be dead ends. `curate.mode: off` is NOT this switch: it freezes
   * writing and keeps reading, which is exactly what these routes exist to serve.
   */
  const knowledgeService = cfg.services.knowledgeService;

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
      knowledgeService,
      knowledgeStats: knowledgeService ? () => countKnowledgePages(cfg.db) : undefined,
    },
    commandRegistry: cfg.services.commandRegistry,
    wsManager: undefined,
    userQuestionSenderRegistry: cfg.services.userQuestionSenderRegistry,
    harnessApprovalRegistry: cfg.services.harnessApprovalRegistry,
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

  // Read-only knowledge-graph API + unified search. Reuses the memory
  // retriever so /api/search ranks memories like chat recall does.
  registerGraphRoutes(app, {
    db: cfg.db,
    memoryRetriever: cfg.services.memoryRetriever,
    getFooterConfig: () => cfg.getConfig().footer,
    decayHalfLifeDays: cfg.getConfig().memory.graph?.decay_half_life_days ?? 0,
  });

  // Knowledge-page API (plan §6 K2 and §12 item 4). Pages live in SQLite, so the
  // WebUI editor is an API rather than a file path; the service owns the
  // transaction, the FTS sync and the version check. Registered only while the
  // layer is enabled — see `knowledgeService` above.
  if (knowledgeService) {
    registerKnowledgeRoutes(app, { db: cfg.db, service: knowledgeService });
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
 * Row counts for `/knowledge stats` (`CommandDeps.knowledgeStats`).
 *
 * The `KnowledgeService` contract has no aggregate accessor and its `list` is
 * paginated, so a count taken through it would silently cap at the page size.
 * This reads the counts from the table instead — the same reason
 * `GET /api/knowledge/stats` queries it. A database created before
 * migration-v14 has no `knowledge_pages` table, which answers "no pages" rather
 * than throwing on a stats command.
 */
function countKnowledgePages(db: Database.Database): KnowledgeStatsSnapshot {
  const grouped = (sql: string): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const row of db.prepare(sql).all() as Array<{ key: string; n: number | string }>) {
      counts[row.key] = Number(row.n);
    }
    return counts;
  };

  try {
    const total = (
      db.prepare('SELECT COUNT(*) AS n FROM knowledge_pages').get() as { n: number | string }
    ).n;
    return {
      total: Number(total),
      byStatus: grouped('SELECT status AS key, COUNT(*) AS n FROM knowledge_pages GROUP BY status'),
      byPageType: grouped(
        'SELECT page_type AS key, COUNT(*) AS n FROM knowledge_pages GROUP BY page_type',
      ),
    };
  } catch {
    return { total: 0, byStatus: {}, byPageType: {} };
  }
}
