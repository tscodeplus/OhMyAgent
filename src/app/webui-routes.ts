/**
 * WebUI Route Registration
 *
 * Fastify plugin that registers all WebUI API routes and WebSocket support.
 * Applies webui-auth middleware to protect all /api/ routes.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { AppConfig, AppServices } from './types.js';
import { webuiAuthHook } from './webui-auth.js';
import { ProjectStore } from './webui/project-store.js';
import { registerProjectRoutes } from './webui/project-routes.js';
import { registerAgentRoutes } from './webui/agent-routes.js';
import { registerSessionRoutes } from './webui/session-routes.js';
import { registerChatRoutes } from './webui/chat-routes.js';
import { registerConfigRoutes } from './webui/config-routes.js';
import { registerDashboardRoutes } from './webui/dashboard-routes.js';
import { registerChannelRoutes } from './webui/channel-routes.js';
import { registerSkillsRoutes } from './webui/skills-routes.js';
import { registerTemplateRoutes } from './webui/templates-routes.js';
import { registerFilesRoutes } from './webui/files-routes.js';
import { registerMemoryRoutes } from './webui/memory-routes.js';
import { registerCronRoutes } from './webui/cron-routes.js';
import { registerApprovalRoutes } from './webui/approval-routes.js';
import { registerSubscriptionRoutes } from './subscription/subscription-routes.js';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import { WebSocketManager, createWebSocketPlugin } from './webui/websocket.js';
import { registerDesktopBridge } from './webui/desktop-bridge-routes.js';
import type { DesktopBridgeRegistry } from '../agent/desktop-bridge-registry.js';

export interface WebUIRouteConfig {
  db: Database.Database;
  getConfig: () => AppConfig;
  services: AppServices;
  onConfigChanged: () => void;
  /** Called after config is saved via PUT /api/config — triggers hot-reload. */
  onConfigSaved?: (newConfig: AppConfig) => void;
}

export async function registerWebUIRoutes(
  app: FastifyInstance,
  cfg: WebUIRouteConfig,
): Promise<{ wsManager: WebSocketManager; bridgeRegistry: DesktopBridgeRegistry }> {
  // 1. Register CORS (must be before auth hook — handles OPTIONS preflight)
  app.register(cors, {
    origin: true, // Reflect request origin (safe for personal LAN tools)
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: true,
  });

  // 2. Register multipart for file uploads
  app.register(multipart);

  // 3. Apply auth middleware to all routes
  app.addHook('onRequest', webuiAuthHook);

  // 4. Create stores
  const projectStore = new ProjectStore(cfg.db);

  // 5. Register all route modules (route decorators are synchronous)
  registerProjectRoutes(app, projectStore);

  registerAgentRoutes(app, {
    getConfig: cfg.getConfig,
    onConfigChanged: cfg.onConfigChanged,
  });

  registerSessionRoutes(app, cfg.db, () => cfg.getConfig().footer);

  registerChatRoutes(app, {
    agentService: cfg.services.agentService,
    projectStore,
    db: cfg.db,
    getFooterConfig: () => cfg.getConfig().footer,
    agentManager: cfg.services.agentManager,
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
    },
    commandRegistry: cfg.services.commandRegistry,
  });

  registerConfigRoutes(app, {
    getConfig: cfg.getConfig,
    configPath: process.env.CONFIG_FILE || './config.yaml',
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

  registerTemplateRoutes(app);

  registerFilesRoutes(app, {
    getConfig: cfg.getConfig,
    onConfigChanged: cfg.onConfigChanged,
    configPath: process.env.CONFIG_FILE || './config.yaml',
  });

  registerMemoryRoutes(app, {
    db: cfg.db,
    services: cfg.services,
  });

  registerCronRoutes(app, cfg.services.cronService);

  // Approval routes — reuse the same ApprovalRequestRepository from memory services
  const { ApprovalRequestRepository } = await import('../memory/repositories/approval-request-repository.js');
  registerApprovalRoutes(app, {
    agentService: cfg.services.agentService,
    approvalRequestRepo: new ApprovalRequestRepository(cfg.db),
    db: cfg.db,
  });

  // 6. Register WebSocket (Fastify tracks the plugin promise internally;
  //    it will be resolved during server.listen())
  const wsManager = new WebSocketManager();
  app.register(createWebSocketPlugin(wsManager));

  // 7. Register Desktop Bridge WebSocket (for remote tool execution)
  const bridgeRegistry = registerDesktopBridge(app);

  // 8. Register subscription routes (depends on WebSocket for login progress)
  if (cfg.services.subscriptionService) {
    registerSubscriptionRoutes(app, {
      subscriptionService: cfg.services.subscriptionService,
      wsManager,
    });
  }

  return { wsManager, bridgeRegistry };
}
