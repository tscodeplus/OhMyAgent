/**
 * Agent Services Composer
 *
 * Extracted from bootstrap.ts (Phase 9d). Creates the agent factory,
 * orchestrator, agent service, and Vision Bridge in dependency order.
 */

import { getDefaultModel } from '../../provider/pi-ai-setup.js';
import { getModel, completeSimple } from '@earendil-works/pi-ai';
import { createAgentFactory } from '../../agent/agent-factory.js';
import { AgentService } from '../../agent/agent-service.js';
import { VisionBridgeService } from '../../vision-bridge/vision-bridge-service.js';
import { ReplyDispatcher } from '../../../extensions/channel-feishu/render/reply-dispatcher.js';
import { renderApprovalCard, renderApprovalResultCard } from '../../../extensions/channel-feishu/render/approval-card-renderer.js';
import { createFeishuApprovalUiPort } from '../../../extensions/channel-feishu/render/approval-ui-port-feishu.js';
import { OrchestratorImpl } from '../../orchestrator/orchestrator.js';
import { InMemoryAgentRunStore } from '../../orchestrator/agent-run-store.js';
import { InMemoryTaskRunStore } from '../../orchestrator/task-run-store.js';
import { PermissionInheritanceServiceImpl } from '../../orchestrator/permission-inheritance.js';
import { ApprovalStateSyncImpl } from '../../orchestrator/approval-state-sync.js';
import { PendingApprovalStore } from '../../agent/approval-store.js';
import { UserQuestionStore } from '../../agent/user-question-store.js';
import { configEventBus } from '../config-event-bus.js';
import type { AppServices } from '../types.js';
import type { Logger } from 'pino';

// ─── Types ───

export interface AgentServicesResult {
  agentFactory: ReturnType<typeof createAgentFactory>;
  orchestrator: OrchestratorImpl;
  orchestratorRef: { current?: OrchestratorImpl };
  agentService: AgentService;
  cronServiceRef: { current: import('../../cron/service.js').CronService | undefined };
  modelName: string;
  userQuestionStore: UserQuestionStore;
}

export interface AgentServicesInput {
  config: import('../types.js').AppConfig;
  logger: Logger;
  db: ReturnType<typeof import('../../memory/db.js').openDatabase>;
  toolRegistry: import('../types.js').ToolRegistry;
  skillRegistry: import('../../skills/skill-registry.js').SkillRegistry;
  memoryRetriever: import('../../memory/memory-retriever.js').MemoryRetriever;
  personaStore?: import('../../memory/persona-store.js').PersonaStore;
  agentManager: import('../../agent/agent-manager.js').AgentManager;
  computerUseHost?: import('../../computer-use/computer-host.js').ComputerUseHost;
  approvalGate: import('../types.js').ApprovalGate;
  policyCenter?: import('../../policy/policy-center.js').PolicyCenter;
  feishuClient: any;
  replyApprovalRegistry: any;
  approvalRequestRepo: any;
  approvalDecisionRepository: any;
  approvalResolution: any;
  promptManager: import('../../prompt/prompt-manager.js').PromptManager;
  sessionRepository: import('../../memory/repositories/session-repository.js').SessionRepository;
  messageRepository: import('../../memory/repositories/message-repository.js').MessageRepository;
  episodeRepository: import('../../memory/repositories/episode-repository.js').EpisodeRepository;
  toolRunRepository: import('../../memory/repositories/tool-run-repository.js').ToolRunRepository;
  memorySummarizer: import('../../memory/memory-summarizer.js').MemorySummarizer;
  servicesRef: { current?: AppServices };
  harnessServices?: import('../../harness/factory.js').HarnessServices;
}

// ─── Helpers ───

function formatDisplayModel(provider: string | undefined, model: string | undefined): string {
  if (!provider && !model) return 'unknown';
  if (!provider) return model ?? 'unknown';
  if (!model) return provider;
  if (model.startsWith(`${provider}/`)) return model;
  return `${provider}/${model}`;
}

// ─── Composer ───

export function createAgentServices(input: AgentServicesInput): AgentServicesResult {
  const {
    config, logger, db, toolRegistry, skillRegistry, memoryRetriever,
    personaStore, agentManager, computerUseHost, approvalGate, policyCenter,
    feishuClient, replyApprovalRegistry, approvalRequestRepo,
    approvalDecisionRepository, approvalResolution, promptManager,
    sessionRepository, messageRepository, episodeRepository,
    toolRunRepository, memorySummarizer, servicesRef,
    harnessServices,
  } = input;

  const cronServiceRef: { current: import('../../cron/service.js').CronService | undefined } = { current: undefined };
  const orchestratorRef: { current?: OrchestratorImpl } = {};

  // ── Agent factory ──

  const approvalPort = createFeishuApprovalUiPort({
    feishuClient: feishuClient as { sendApprovalCard(chatId: string, card: Record<string, unknown>): Promise<string>; recallMessage?(messageId: string): Promise<void> },
    registry: replyApprovalRegistry,
  });

  // ── User Question Store (shared across all channels for ask_user_question tool) ──
  const userQuestionStore = new UserQuestionStore({
    defaultTimeoutMs: 300_000, // 5 minutes
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
    userQuestionStore,
  });
  configEventBus.onReload((c) => {
    agentFactory.updateConfig(c);
    // Keep persistence options in sync so fields like historyLoadCount
    // take effect immediately without restart.
    if (persistenceOpts) {
      persistenceOpts.historyLoadCount = c.memory.historyLoadCount;
      persistenceOpts.historyMaxTokens = c.memory.historyMaxTokens;
    }
  });

  // ── Orchestrator ──

  const agentRunStore = new InMemoryAgentRunStore();
  const taskRunStore = new InMemoryTaskRunStore();
  const permissionInheritance = new PermissionInheritanceServiceImpl(policyCenter!);

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
    policyCenter: policyCenter!,
    agentFactory,
    agentManager,
    pendingApprovals: orchestratorPendingStore,
    logger,
  });
  orchestratorRef.current = orchestrator;

  // ── Agent service ──

  const resolvedDefault = getDefaultModel(config);
  const modelName = formatDisplayModel(
    resolvedDefault?.provider,
    resolvedDefault?.id,
  );

  // Vision Bridge: lazy init on first image analysis
  type VB = import('../../vision-bridge/vision-bridge-types.js').VisionBridgeConfig;
  const imgBridgeCfg = (config.multimodal?.image?.bridge ?? {}) as Partial<VB>;
  const visionBridgeConfig: VB = {
    enabled: imgBridgeCfg.enabled ?? (config as any).visionBridge?.enabled ?? false,
    modelRef: imgBridgeCfg.modelRef ?? (config as any).visionBridge?.modelRef,
    apiKey: imgBridgeCfg.apiKey ?? (config as any).visionBridge?.apiKey,
    baseUrl: imgBridgeCfg.baseUrl ?? (config as any).visionBridge?.baseUrl,
    timeoutMs: imgBridgeCfg.timeoutMs ?? (config as any).visionBridge?.timeoutMs ?? 120_000,
    maxNoteChars: imgBridgeCfg.maxNoteChars ?? (config as any).visionBridge?.maxNoteChars ?? 3200,
    maxCacheEntries: imgBridgeCfg.maxCacheEntries ?? (config as any).visionBridge?.maxCacheEntries ?? 256,
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

  // v10: extracted to variable so config-event handler can update fields
  // (e.g. historyLoadCount) at runtime without restart.
  const persistenceOpts = {
    sessionRepository,
    messageRepository,
    episodeRepository,
    toolRunRepository,
    memorySummarizer,
    summarizeInterval: config.memory.summarizeInterval,
    historyLoadCount: config.memory.historyLoadCount,
    historyMaxTokens: config.memory.historyMaxTokens,
    logger,
  };

  // ── Wire harness LLM caller if harness services are available ──
  if (harnessServices) {
    const mainModel = getDefaultModel(config);
    harnessServices.optimizer.setLlmCaller(
      async (systemPrompt: string, userMessage: string, model?: string) => {
        let resolvedModel: ReturnType<typeof getModel> | undefined;

        if (!model) {
          // System default: use the main agent model
          resolvedModel = mainModel;
        } else {
          // Specific model: parse provider/modelId
          const slashIdx = model.indexOf('/');
          if (slashIdx > 0) {
            const provider = model.slice(0, slashIdx);
            const modelId = model.slice(slashIdx + 1);
            resolvedModel = getModel(provider, modelId);
          }
        }

        if (!resolvedModel) {
          throw new Error(
            `HarnessOptimizer: unable to resolve model "${model || 'default'}". ` +
            'Check that the provider and model ID are correct.',
          );
        }

        const response = await completeSimple(
          resolvedModel as any,
          {
            systemPrompt,
            messages: [
              {
                role: 'user' as const,
                content: [{ type: 'text' as const, text: userMessage }],
                timestamp: Date.now(),
              },
            ],
          },
          {
            maxTokens: 1024,
            signal: AbortSignal.timeout(30_000),
          },
        );

        return response.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text)
          .join('');
      },
    );
    logger.info('Harness LLM caller wired');
  }

  const agentService = new AgentService(
    agentFactory,
    (chatId: string, messageId?: string, agentId?: string) => {
      const agentName = agentId ? agentManager.get(agentId)?.name : undefined;
      return new ReplyDispatcher({ feishuClient, chatId, messageId, model: modelName, agentName, footerConfig: config.footer, showToolCalls: config.showToolCalls, showSkillCalls: config.showSkillCalls, logger });
    },
    persistenceOpts,
    getVisionBridge,
    config.multimodal?.image?.mode ?? 'native_first',
    harnessServices,
  );

  return {
    agentFactory,
    orchestrator,
    orchestratorRef,
    agentService,
    cronServiceRef,
    modelName,
    userQuestionStore,
  };
}
