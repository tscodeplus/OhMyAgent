/**
 * Tests for bootstrap.ts
 *
 * Mocks all external dependencies (config, database, Feishu client, etc.)
 * to verify that bootstrap() wires up modules correctly and returns a
 * working AppServices container.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock: Config ───

const mockConfig = {
  logging: { level: 'info' },
  feishu: {
    enabled: true,
    appId: 'cli_test',
    appSecret: 'secret',
    verificationToken: 'token',
    encryptKey: 'key',
    wsEnabled: true,
  },
  piAi: {
    provider: 'deepseek',
    model: 'deepseek-chat',
    reasoningModel: 'deepseek-reasoner',
    apiKey: 'sk-test',
  },
  fallbackModels: [],
  customProviders: [],
  memoryAuxModels: undefined,
  embedding: {
    baseUrl: 'https://api.test.com/v1',
    apiKey: 'sk-embed',
    model: 'test-model',
    dimension: 1024,
  },
  database: {
    path: ':memory:',
  },
  tools: {
    shellEnabled: true,
    defaultTimeoutMs: 60000,
    maxOutputLength: 12000,
    toolsProfile: 'standard',
    shellExecMode: 'balanced',
    shellAllowlist: [],
    shellApprovalMode: 'balanced',
    shellApprovalWhitelist: [],
    shellApprovalTimeoutSec: 120,
    shellApprovalTimeoutAction: 'deny',
    fileRead: {
      allowedRoots: [],
      deniedPatterns: [],
      allowPathTraversal: false,
      allowHomeReference: false,
    },
  },
  memory: {
    autoRecall: false,
    autoCapture: false,
    recallTopK: 3,
    recallMinScore: 0.01,
    captureMaxChars: 500,
    summarizeInterval: 20,
    outputLanguage: 'Auto',
    decayHalfLifeDays: 30,
    embeddingCacheMaxEntries: 10000,
    hygiene: {
      enabled: true,
      retentionDays: 90,
    },
    embeddingCircuitBreaker: {
      failureThreshold: 5,
      cooldownSec: 30,
    },
    expansion: {
      enabled: false,
      minQueryLength: 15,
      minScoreTrigger: 0.3,
      maxVariants: 4,
    },
    queryEmbeddingTimeoutMs: 10000,
    queryPlanner: {
      enabled: true,
      commonalityCoverage: true,
      speakerBoost: 0.05,
      perSlotFloor: 2,
      maxEntities: 4,
      llm: { enabled: false },
    },
    recall: {
      prefilterMultiplier: 5,
      prefilterMin: 20,
      mergeCandidateMultiplier: 3,
    },
    offloading: {
      enabled: true,
      maxRefsInContext: 10,
      preserveInMessages: 2,
      refDir: '',
      retentionDays: 7,
    },
    persona: {
      enabled: true,
      distillThreshold: 3,
      minDistillIntervalHours: 0,
    },
    sceneClustering: {
      enabled: false,
      windowDays: 7,
      minMemories: 5,
    },
  },
  rateLimit: {
    webhookMaxRequests: 100,
    webhookWindowMs: 60000,
  },
  cron: {
    enabled: true,
    tickIntervalMs: 30000,
    dataDir: '/tmp/test-cron',
    executionTimeoutMs: 600000,
  },
  webSearch: {
    providerOrder: ['tavily', 'exa', 'baidu'],
    searchTimeoutMs: 30000,
    maxResults: 5,
  },
  footer: {
    showAgentName: true,
    showModel: true,
    showCompleted: true,
    showElapsed: true,
  },
  smart_agent_team: {
    enabled: false,
    max_children: 4,
  },
  policy: undefined,
  multimodal: undefined,
  agents: [],
};

vi.mock('../../src/app/config.js', () => ({
  loadConfig: vi.fn(() => mockConfig),
  setWatcherLogger: vi.fn(),
  startConfigWatcher: vi.fn(),
  startEnvWatcher: vi.fn(),
  stopConfigWatcher: vi.fn(),
  stopEnvWatcher: vi.fn(),
}));

vi.mock('../../src/app/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));

// ─── Mock: Database ───

const mockDb = {
  close: vi.fn(),
  pragma: vi.fn(),
  prepare: vi.fn(() => ({
    get: vi.fn(),
    all: vi.fn(() => []),
    run: vi.fn(),
  })),
};

vi.mock('../../src/memory/db.js', () => ({
  openDatabase: vi.fn(() => mockDb),
}));

// ─── Mock: Embedding ───

vi.mock('../../src/provider/embedding-client.js', () => ({
  createEmbeddingClient: vi.fn(() => ({
    embed: vi.fn(async () => []),
    embedOne: vi.fn(async () => new Float32Array(10)),
  })),
}));

vi.mock('../../src/provider/pi-ai-setup.js', () => ({
  getDefaultModel: vi.fn((config: typeof mockConfig) => ({
    provider: config.piAi.provider,
    id: config.piAi.model,
  })),
}));

// ─── Mock: Memory Repositories ───

vi.mock('../../src/memory/repositories/memory-repository.js', () => ({
  MemoryRepository: vi.fn().mockImplementation(() => ({
    findByScopeAndKind: vi.fn(() => []),
    findByScopeKind: vi.fn(() => []),
    upsert: vi.fn(),
  })),
}));

vi.mock('../../src/memory/repositories/embedding-repository.js', () => ({
  EmbeddingRepository: vi.fn().mockImplementation(() => ({
    backfillVec: vi.fn(() => 0),
    isVecAvailable: vi.fn(() => false),
    probeVec: vi.fn(),
    checkEmbeddingMeta: vi.fn(() => ({ needsReindex: false })),
    saveEmbeddingMeta: vi.fn(),
    dropVectorsForReindex: vi.fn(() => 0),
  })),
}));

vi.mock('../../src/memory/repositories/approval-policy-repository.js', () => ({
  ApprovalPolicyRepository: vi.fn().mockImplementation(() => ({
    findByTargetKind: vi.fn(() => []),
  })),
}));

vi.mock('../../src/memory/repositories/tool-run-repository.js', () => ({
  ToolRunRepository: vi.fn().mockImplementation(() => ({
    create: vi.fn(),
    update: vi.fn(),
  })),
}));

// ─── Mock: Memory Components ───

vi.mock('../../src/memory/memory-retriever.js', () => ({
  MemoryRetriever: vi.fn().mockImplementation(() => ({
    retrieve: vi.fn(async () => []),
  })),
}));

vi.mock('../../src/memory/memory-writer.js', () => ({
  MemoryWriter: vi.fn().mockImplementation(() => ({
    write: vi.fn(async () => ({ id: 'test', isDuplicate: false })),
  })),
}));

// ─── Mock: Agent ───

vi.mock('../../src/agent/agent-factory.js', () => ({
  createAgentFactory: vi.fn(() => ({
    create: vi.fn(),
    resolveApproval: vi.fn(),
  })),
}));

vi.mock('../../src/agent/agent-service.js', () => ({
  AgentService: vi.fn().mockImplementation(() => ({
    execute: vi.fn(),
    abort: vi.fn(),
    isRunning: vi.fn(() => false),
    rejectPendingApprovals: vi.fn(() => 0),
  })),
}));

// ─── Mock: Tools ───

// ToolRegistryImpl is NOT mocked — it's a simple in-memory Map wrapper
// with no external dependencies, so we let it run real code.

vi.mock('../../src/tools/builtins/shell-tool.js', () => ({
  createShellTool: vi.fn(() => ({ name: 'shell', execute: vi.fn() })),
}));

vi.mock('../../src/tools/builtins/file-read-tool.js', () => ({
  createFileReadTool: vi.fn(() => ({ name: 'file_read', execute: vi.fn() })),
}));

vi.mock('../../src/tools/builtins/file-search-tool.js', () => ({
  createFileSearchTool: vi.fn(() => ({ name: 'file_search', execute: vi.fn() })),
}));

vi.mock('../../src/tools/builtins/memory-recall-tool.js', () => ({
  createMemoryRecallTool: vi.fn(() => ({ name: 'memory-recall', execute: vi.fn() })),
}));

vi.mock('../../src/tools/builtins/memory-store-tool.js', () => ({
  createMemoryStoreTool: vi.fn(() => ({ name: 'memory-store', execute: vi.fn() })),
  createDefaultMemoryFilter: vi.fn(() => ({
    shouldCapture: vi.fn(() => ({ capture: true })),
    detectCategory: vi.fn(() => 'fact'),
  })),
}));

vi.mock('../../src/tools/approval-gate.js', () => ({
  SQLiteApprovalGate: vi.fn().mockImplementation(() => ({
    evaluate: vi.fn(async () => 'requires_approval'),
    recordDecision: vi.fn(),
    createWhitelistPolicies: vi.fn(),
  })),
}));

// ─── Mock: Skills ───

vi.mock('../../src/skills/skill-registry.js', () => ({
  SkillRegistry: vi.fn().mockImplementation(() => ({
    load: vi.fn(async () => {}),
    resolve: vi.fn(() => []),
    compile: vi.fn(() => ({
      allowedTools: [],
      deniedTools: [],
      promptContent: '',
      memoryScopes: [],
      approvalOverrides: {},
    })),
    getSkillById: vi.fn(),
    getSkills: vi.fn(() => []),
    isLoaded: vi.fn(() => true),
  })),
}));

// ─── Mock: Feishu ───

vi.mock('../../extensions/channel-feishu/feishu-client.js', () => ({
  FeishuClient: vi.fn().mockImplementation(() => ({
    getAccessToken: vi.fn(async () => 'token'),
    sendMessage: vi.fn(),
  })),
}));

vi.mock('../../extensions/channel-feishu/feishu-router.js', () => ({
  FeishuRouter: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    route: vi.fn(),
    startCleanup: vi.fn(),
    stopCleanup: vi.fn(),
  })),
}));

vi.mock('../../extensions/channel-feishu/feishu-server.js', () => ({
  createFeishuServer: vi.fn(() => ({
    listen: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    get: vi.fn(),
    post: vi.fn(),
  })),
}));

vi.mock('../../extensions/channel-feishu/feishu-ws-client.js', () => ({
  FeishuWSClient: vi.fn().mockImplementation(() => ({
    start: vi.fn(async () => {}),
    stop: vi.fn(),
  })),
}));

vi.mock('../../src/app/webui-routes.js', () => ({
  registerWebUIRoutes: vi.fn(async () => ({
    connectedCount: 0,
    broadcast: vi.fn(),
  })),
}));

vi.mock('../../extensions/channel-feishu/message-handler.js', () => ({
  MessageHandler: vi.fn().mockImplementation(() => ({
    handle: vi.fn(),
  })),
}));

vi.mock('../../src/commands/command-handler.js', () => ({
  handleCommand: vi.fn(async () => null),
}));

vi.mock('../../extensions/channel-feishu/chat-queue.js', () => ({
  ChatQueue: vi.fn().mockImplementation(() => ({
    enqueue: vi.fn(),
    getQueueSize: vi.fn(() => 0),
    isProcessing: vi.fn(() => false),
    setLogger: vi.fn(),
  })),
}));

vi.mock('../../extensions/channel-feishu/render/reply-dispatcher.js', () => ({
  ReplyDispatcher: vi.fn().mockImplementation(() => ({
    onStart: vi.fn(),
    onTextDelta: vi.fn(),
    onReasoningDelta: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    setApprovalStatus: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
  })),
}));

// ─── Import bootstrap (after mocks are set up) ───

import { i18n } from '../../src/i18n/index.js';
import { bootstrap } from '../../src/app/bootstrap.js';
import { loadConfig, stopConfigWatcher, stopEnvWatcher } from '../../src/app/config.js';
import { createLogger } from '../../src/app/logger.js';
import { openDatabase } from '../../src/memory/db.js';
import { createAgentFactory } from '../../src/agent/agent-factory.js';
import { AgentService } from '../../src/agent/agent-service.js';
import { FeishuClient } from '../../extensions/channel-feishu/feishu-client.js';
import { createFeishuServer } from '../../extensions/channel-feishu/feishu-server.js';
import { FeishuWSClient } from '../../extensions/channel-feishu/feishu-ws-client.js';
import { FeishuRouter } from '../../extensions/channel-feishu/feishu-router.js';
import { ReplyDispatcher } from '../../extensions/channel-feishu/render/reply-dispatcher.js';
import { SkillRegistry } from '../../src/skills/skill-registry.js';

// ─── Tests ───

describe('bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls loadConfig to load configuration', async () => {
    await bootstrap();
    expect(loadConfig).toHaveBeenCalledOnce();
  });

  it('calls createLogger to create logger', async () => {
    await bootstrap();
    expect(createLogger).toHaveBeenCalledOnce();
  });

  it('opens database with configured path', async () => {
    await bootstrap();
    expect(openDatabase).toHaveBeenCalledWith(mockConfig.database.path);
  });

  it('creates FeishuClient with appId and appSecret', async () => {
    await bootstrap();
    expect(FeishuClient).toHaveBeenCalledWith(
      { appId: mockConfig.feishu.appId, appSecret: mockConfig.feishu.appSecret },
      expect.anything(),
    );
  });

  it('creates FeishuRouter', async () => {
    await bootstrap();
    expect(FeishuRouter).toHaveBeenCalledOnce();
  });

  it('creates skill registry and loads skills', async () => {
    const mockInstance = { load: vi.fn(async () => {}) };
    vi.mocked(SkillRegistry).mockImplementationOnce(() => mockInstance as any);

    await bootstrap();
    expect(mockInstance.load).toHaveBeenCalledWith('./skills', expect.anything());
  });

  it('creates agent factory with config and tool registry', async () => {
    await bootstrap();
    expect(createAgentFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        config: mockConfig,
        toolRegistry: expect.anything(),
        skillRegistry: expect.anything(),
      }),
      expect.objectContaining({
        approvalGate: expect.anything(),
      }),
    );
  });

  it('passes provider-prefixed model display name to ReplyDispatcher', async () => {
    const customConfig = {
      ...mockConfig,
      piAi: {
        ...mockConfig.piAi,
        provider: 'nvidia',
        model: 'minimaxai/minimax-m2.7',
      },
    };
    vi.mocked(loadConfig).mockReturnValueOnce(customConfig as any);

    await bootstrap();

    const lastCall = vi.mocked(AgentService).mock.calls.at(-1);
    const replyDispatcherFactory = lastCall?.[1] as
      | ((chatId: string, messageId?: string) => unknown)
      | undefined;
    expect(replyDispatcherFactory).toBeTypeOf('function');

    replyDispatcherFactory?.('chat-1', 'msg-1');

    expect(ReplyDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'nvidia/minimaxai/minimax-m2.7',
      }),
    );
  });

  it('creates Feishu server with port 9191', async () => {
    await bootstrap();
    expect(createFeishuServer).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 9191,
        feishuAuth: expect.anything(),
        feishuRouter: expect.anything(),
      }),
    );
  });

  it('creates FeishuWSClient when wsEnabled is true', async () => {
    await bootstrap();
    expect(FeishuWSClient).toHaveBeenCalledOnce();
  });

  it('returns services object with all expected fields', async () => {
    const { services } = await bootstrap();

    expect(services.config).toBe(mockConfig);
    expect(services.logger).toBeDefined();
    expect(services.db).toBeDefined();
    expect(services.toolRegistry).toBeDefined();
    expect(services.memoryRetriever).toBeDefined();
    expect(services.memoryWriter).toBeDefined();
    expect(services.approvalGate).toBeDefined();
    expect(services.skillRegistry).toBeDefined();
    expect(services.agentFactory).toBeDefined();
    expect(services.agentService).toBeDefined();
    expect(services.feishuClient).toBeDefined();
    expect(services.feishuRouter).toBeDefined();
    expect(services.chatQueue).toBeDefined();
    expect(services.server).toBeDefined();
    expect(services.wsClient).toBeDefined();
  });

  it('registers v4 Phase 3 tools in the runtime tool registry', async () => {
    const { services } = await bootstrap();
    const names = services.toolRegistry.names();

    expect(names).toEqual(expect.arrayContaining([
      'file_write',
      'file_edit',
      'glob',
      'grep',
      'web_fetch',
      'tool_search',
      'ask_user_question',
      'brief',
      'todo_write',
      'sleep',
      'config',
    ]));
  });

  it('start() calls server.listen and wsClient.start', async () => {
    const mockServer = { listen: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    vi.mocked(createFeishuServer).mockReturnValueOnce(mockServer as any);

    const mockWs = { start: vi.fn(async () => {}), stop: vi.fn() };
    vi.mocked(FeishuWSClient).mockImplementationOnce(() => mockWs as any);

    const { start } = await bootstrap();
    await start();

    expect(mockServer.listen).toHaveBeenCalledWith({ port: 9191, host: '0.0.0.0' });
    expect(mockWs.start).toHaveBeenCalledOnce();
  });

  it('stop() calls server.close, wsClient.stop, and db.close', async () => {
    const mockServer = { listen: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    vi.mocked(createFeishuServer).mockReturnValueOnce(mockServer as any);

    const mockWs = { start: vi.fn(async () => {}), stop: vi.fn() };
    vi.mocked(FeishuWSClient).mockImplementationOnce(() => mockWs as any);

    const { stop } = await bootstrap();
    await stop();

    expect(mockWs.stop).toHaveBeenCalledOnce();
    expect(mockServer.close).toHaveBeenCalledOnce();
    expect(mockDb.close).toHaveBeenCalledOnce();
    expect(stopConfigWatcher).toHaveBeenCalledOnce();
    expect(stopEnvWatcher).toHaveBeenCalledOnce();
  });

  it('registers im.message.receive_v1 handler on FeishuRouter', async () => {
    const mockRouter = { on: vi.fn(), route: vi.fn(), startCleanup: vi.fn(), stopCleanup: vi.fn() };
    vi.mocked(FeishuRouter).mockImplementationOnce(() => mockRouter as any);

    await bootstrap();

    expect(mockRouter.on).toHaveBeenCalledWith(
      'im.message.receive_v1',
      expect.any(Function),
    );
  });

  it('passes feishuAuth with verificationToken and encryptKey', async () => {
    await bootstrap();
    expect(createFeishuServer).toHaveBeenCalledWith(
      expect.objectContaining({
        feishuAuth: {
          verificationToken: 'token',
          encryptKey: 'key',
        },
      }),
    );
  });

  it('returns handled toast and skips duplicate approval persistence', async () => {
    const resolveApproval = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    vi.mocked(createAgentFactory).mockReturnValueOnce({
      create: vi.fn(),
      resolveApproval,
    } as any);

    const approvalDecisionCreate = vi.fn();
    const approvalRequestUpdate = vi.fn();
    mockDb.prepare = vi.fn((sql: string) => {
      if (sql.includes('INSERT INTO approval_decisions')) {
        return { run: approvalDecisionCreate, get: vi.fn(), all: vi.fn(() => []) };
      }
      if (sql.includes('UPDATE approval_requests')) {
        return { run: approvalRequestUpdate, get: vi.fn(), all: vi.fn(() => []) };
      }
      return {
        run: vi.fn(),
        get: vi.fn(),
        all: vi.fn(() => []),
      };
    });

    await bootstrap();

    const wsOptions = vi.mocked(FeishuWSClient).mock.calls.at(-1)?.[0] as
      | { cardActionHandler?: (callback: any) => Promise<any> }
      | undefined;
    expect(wsOptions?.cardActionHandler).toBeTypeOf('function');

    const callback = {
      action: {
        value: {
          action: 'reject_once',
          requestId: 'req-1',
          command: 'rm /tmp/1.txt',
          risk: 'high',
        },
      },
      context: {},
    };

    const firstResult = await wsOptions?.cardActionHandler?.(callback);
    const secondResult = await wsOptions?.cardActionHandler?.(callback);

    expect(firstResult).toEqual(expect.objectContaining({
      toast: {
        type: 'error',
        content: i18n.t('bootstrap:toast.deniedOnce'),
      },
    }));
    expect(secondResult).toEqual({
      toast: {
        type: 'info',
        content: i18n.t('bootstrap:toast.alreadyHandled'),
      },
      card: expect.objectContaining({
        type: 'raw',
        data: expect.objectContaining({
          header: expect.objectContaining({
            template: 'red',
          }),
        }),
      }),
    });
    expect(resolveApproval).toHaveBeenCalledTimes(2);
    expect(approvalDecisionCreate).toHaveBeenCalledTimes(1);
    expect(approvalRequestUpdate).toHaveBeenCalledTimes(1);
  });

});
