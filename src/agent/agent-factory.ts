/**
 * Agent Factory
 *
 * Creates Agent instances with the correct model, tools, system prompt,
 * and lifecycle hooks pre-configured. Optionally integrates with the
 * Skills system and the Approval Gate for shell command gating.
 */

import { Agent } from '@earendil-works/pi-agent-core';
import { getModel } from '@earendil-works/pi-ai';
import type {
  AppConfig,
  AppServices,
  ApprovalGate,
  ToolRegistry,
  ReplyDispatcher,
  ToolProfileId,
} from '../app/types.js';
import type { SkillRegistry } from '../skills/skill-registry.js';
import { getDefaultModel } from '../provider/pi-ai-setup.js';
import { createTransformContext } from './context-transform.js';
import { convertToLlm } from './convert-to-llm.js';
import { generateId } from '../shared/ids.js';
import { createCronjobTool } from '../cron/cronjob-tool.js';
import type { ApprovalDecisionType } from '../app/types.js';
import type { ApprovalRequestRepository } from '../memory/repositories/approval-request-repository.js';
import type { ApprovalUiPort } from './approval-ui-port.js';
import type { AgentManager } from './agent-manager.js';
import { PROFILE_TOOLS } from './agent-manager.js';
import type { ResolvedAgentConfig } from './config-types.js';
import type { ComputerUseHost } from '../computer-use/computer-host.js';
import { createComputerUseTool } from '../tools/builtins/computer-use-tool.js';
import { PendingApprovalStore } from './approval-store.js';
import { i18n } from '../i18n/index.js';
import type { PromptManager } from '../prompt/prompt-manager.js';
import type { PromptAssemblyOptions } from '../prompt/types.js';
import { teamModeStore } from './team-mode-store.js';
import { createBeforeToolCall, type BeforeToolCallDeps } from './before-tool-call.js';
import type { PolicyCenter } from '../policy/policy-center.js';
import type { AgentPolicyScope } from '../policy/types.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import type { Logger } from 'pino';
import { AgentToolAdapterImpl } from '../tools/platform/agent-tool-adapter.js';
import type { DesktopBridgeRegistry } from './desktop-bridge-registry.js';
import { createSpawnAgentToolDefinition } from '../tools/builtins/agents/spawn-definition.js';
import { OffloadStore } from '../runtime-artifacts/offload-store.js';
import { summarizeToolResult } from '../memory/offload-summarizer.js';
import { loadConfig as loadToolSearchConfig, assembleTools } from '../tools/tool-search/index.js';

import { MermaidCanvas } from '../runtime-artifacts/mermaid-canvas.js';
import { MermaidPhaseTagger } from '../runtime-artifacts/mermaid-phase-tagger.js';
import { updateMermaidCanvas } from './mermaid-canvas-updater.js';
import { createDistillerLLM } from '../memory/persona-distiller.js';
import type { PersonaStore } from '../memory/persona-store.js';
import type { SummaryLLMConfig } from '../memory/memory-summarizer.js';
import path from 'node:path';
import { SkillComplianceTracker } from '../skills/skill-compliance.js';

// ─── Types ───

// P1-3: Skill compliance tracker (session-scoped violation tracking)
const complianceTracker = new SkillComplianceTracker();
/** Map of sessionId → reinforcement messages to inject in the next turn */
const reinforcementMessages = new Map<string, string>();
/** Map of sessionId → active skill info for compliance tracking */
const activeSkillForSession = new Map<string, { skillId: string; skill: import('../skills/skill-loader.js').LoadedSkill }>();
/** Map of sessionId → feedback tracking info for metrics */
const activeSkillFeedbackIds = new Map<string, { feedbackId: string; startTime: number }>();

function mergeProviderKeys(
  apiKeys: Record<string, string>,
  baseUrls: Record<string, string>,
  config: AppConfig,
): void {
  // providerKeys (lowest priority, per-provider defaults)
  for (const [name, pk] of Object.entries(config.providerKeys ?? {})) {
    if (pk.apiKey) apiKeys[name] = pk.apiKey;
    if (pk.baseUrl) baseUrls[name] = pk.baseUrl;
  }
  // customProviders (medium priority)
  for (const cp of config.customProviders ?? []) {
    apiKeys[cp.provider] = cp.apiKey;
    baseUrls[cp.provider] = cp.baseUrl;
  }
  // piAi (highest priority for the primary provider)
  if (config.piAi.apiKey) apiKeys[config.piAi.provider] = config.piAi.apiKey;
  if (config.piAi.baseUrl) baseUrls[config.piAi.provider] = config.piAi.baseUrl;
}

function buildSummaryLLMConfig(config: AppConfig): SummaryLLMConfig {
  const apiKeys: Record<string, string> = {};
  const baseUrls: Record<string, string> = {};

  mergeProviderKeys(apiKeys, baseUrls, config);
  // Use memory_aux_models → primary model → fallback_models chain
  const memAux = config.memoryAuxModels;
  const mainModel = `${config.piAi.provider}/${config.piAi.model}`;
  return {
    modelRef: memAux?.primary || mainModel,
    fallbackRefs: [
      ...(memAux?.fallback_models ?? []),
      ...(memAux?.primary ? [] : config.fallbackModels),
    ],
    apiKeys,
    baseUrls,
    outputLanguage: config.memory.outputLanguage,
  };
}

function isDeepSeekLikeModel(model: any): boolean {
  const provider = String(model?.provider ?? '').toLowerCase();
  const id = String(model?.id ?? '').toLowerCase();
  const baseUrl = String(model?.baseUrl ?? '').toLowerCase();
  return provider.includes('deepseek') || id.includes('deepseek') || baseUrl.includes('deepseek');
}

function textBlockChars(blocks: Array<{ type?: string; text?: string }>): number {
  return blocks.reduce((sum, block) => sum + (typeof block.text === 'string' ? block.text.length : 0), 0);
}

function currentTimeTemplateValue(): string {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

function shouldKeepFullToolResultInContext(toolName: string): boolean {
  return ['web_search', 'web-search', 'web_fetch'].includes(toolName);
}

/** Options for creating an Agent instance. */
export interface AgentCreateOptions {
  message?: string;
  agentId?: string;
  systemPrompt?: string;
  model?: any;
  tools?: any[];
  /** Extra tools to append to the agent's tool list (used by channels for send_media). */
  extraTools?: any[];
  sessionId?: string;
  chatId?: string;
  messageId?: string;
  historyMessages?: Array<{ role: string; content: string; timestamp: number }>;
  turnContext?: AgentTurnContext;
  channel?: string;
  computerUseAllowed?: boolean;
  toolsProfileOverride?: ToolProfileId;
  policyScope?: AgentPolicyScope;
  policyAgentId?: string;
  /** Non-Feishu channel approval message sender. */
  channelApprovalSender?: BeforeToolCallDeps['channelApprovalSender'];
  /** Channel-specific Computer Use screenshot sender. */
  computerUseImageSender?: (image: { data: string; mimeType: string }) => Promise<string>;
  /** v5: Spawn as child agent with optimized prompt */
  isChildAgent?: boolean;
  /** v5: Task description for child agent */
  childTaskDescription?: string;
}

interface ResolvedSkillScope {
  scope: 'global' | 'skill';
  scopeKey: string;
}

/** Minimal Feishu client interface for sending approval cards and media. */
export interface FeishuApprovalClient {
  sendApprovalCard(chatId: string, card: Record<string, unknown>): Promise<string>;
  recallMessage?(messageId: string): Promise<void>;
  uploadImage?(image: Buffer | string, imageType?: 'message' | 'avatar'): Promise<{ imageKey: string }>;
  uploadFile?(file: Buffer | string, fileName: string, fileType: string, duration?: number): Promise<{ fileKey: string }>;
  sendMessage?(params: {
    receive_id: string;
    receive_id_type: string;
    msg_type: string;
    content: string;
    uuid?: string;
  }): Promise<any>;
  updateMessage?(messageId: string, msgType: string, card: Record<string, unknown>): Promise<void>;
}

export interface AgentTurnContext {
  chatId?: string;
  messageId?: string;
  replyDispatcher?: ReplyDispatcher;
  /** Factory to create a fresh channel-specific dispatcher (used by followUp). */
  replyDispatcherFactory?: () => ReplyDispatcher;
  /** Message with $skill-id stripped (set by skill fast path). Falls back to original input. */
  effectiveMessage?: string;
}

/** Options for the approval integration. */
export interface AgentFactoryOptions {
  approvalGate?: ApprovalGate;
  feishuClient?: FeishuApprovalClient;
  approvalTimeoutMs?: number;
  approvalTimeoutAction?: 'deny' | 'allow';
  shellEnabled?: boolean;
  approvalRequestRepo?: ApprovalRequestRepository;
  /** Channel-agnostic approval UI port (Feishu impl injected at bootstrap). */
  approvalPort?: ApprovalUiPort;
  defaultToolsProfile?: ToolProfileId;
  cronServiceFactory?: () => any;
  policyCenter?: PolicyCenter;
  orchestratorFactory?: () => Orchestrator | undefined;
  getServices?: () => AppServices | undefined;
  onApprovalAutoReject?: (requestId: string, reason: 'timeout' | 'stale_after_restart' | 'expired_before_recovery' | 'steered') => void;
  onApprovalAutoApprove?: (requestId: string) => void;
  logger?: Logger;
  promptManager?: PromptManager;
}

function shellModeForProfile(profile: ToolProfileId): 'full' | 'read-only' {
  return profile === 'minimal' ? 'read-only' : 'full';
}

/** Factory that produces configured Agent instances. */
export interface AgentFactory {
  create(options?: AgentCreateOptions): Agent;
  updateConfig(config: AppConfig): void;
  resolveApproval(requestId: string, decision: ApprovalDecisionType): boolean;
  rejectPendingApprovals(sessionKey: string, reason?: 'stopped_by_user' | 'steered'): number;
  /** Resolve the first pending approval for a session. Returns false if none pending. */
  resolveFirstPendingApproval(sessionKey: string, decision: ApprovalDecisionType): boolean;
  /** Resolve all pending approvals for a session. Returns count. */
  resolveAllPendingApprovals(sessionKey: string, decision: ApprovalDecisionType): number;
  /** v9: Get compression model config for overflow recovery. */
  getAutoCompressConfig(): {
    contextWindow: number;
    mainModelRef: string;
    globalFallbackRefs: string[];
    compressModelRef?: string;
    compressFallbackRefs?: string[];
    apiKeys: Record<string, string>;
    baseUrls: Record<string, string>;
    baseUrl?: string;
  } | undefined;
}

/** Dependencies required by the factory. */
export interface AgentFactoryServices {
  config: AppConfig;
  toolRegistry: ToolRegistry;
  skillRegistry?: SkillRegistry;
  defaultModel?: any;
  memoryRetriever?: any;
  personaStore?: PersonaStore;
  agentManager?: AgentManager;
  computerUseHost?: ComputerUseHost;
}

// ─── System Prompt ───

function buildDefaultSystemPrompt(lang?: string): string {
  return [
    i18n.t('prompts:base.identity'),
    '',
    i18n.t('prompts:base.memory.title'),
    i18n.t('prompts:base.memory.body'),
    '',
    i18n.t('prompts:base.cron.title'),
    i18n.t('prompts:base.cron.body'),
  ].join('\n');
}

// ─── Tool Search helper ───

/**
 * Resolve the context window size from the model object.
 * Tries common property names; returns 0 if none found (fallback in threshold.ts).
 */
function resolveModelContextLength(model: any): number {
  if (typeof model?.contextWindow === 'number') return model.contextWindow;
  if (typeof model?.context_length === 'number') return model.context_length;
  if (typeof model?.maxTokens === 'number') return model.maxTokens;
  return 0;
}

// ─── Factory ───

export function createAgentFactory(
  services: AgentFactoryServices,
  factoryOptions: AgentFactoryOptions = {},
): AgentFactory {
  const { toolRegistry, skillRegistry, defaultModel, memoryRetriever, personaStore, agentManager, computerUseHost } = services;
  const configRef = { current: services.config };
  const {
    approvalGate,
    feishuClient,
    approvalTimeoutMs = 600_000,
    approvalTimeoutAction = 'deny',
    shellEnabled = true,
    approvalRequestRepo,
    approvalPort,
    defaultToolsProfile,
    policyCenter,
    orchestratorFactory,
    getServices,
    logger,
    promptManager,
  } = factoryOptions;

  const pendingApprovals = new PendingApprovalStore({
    onAutoReject: factoryOptions.onApprovalAutoReject,
    onAutoApprove: factoryOptions.onApprovalAutoApprove,
    timeoutAction: approvalTimeoutAction,
  });

  if (approvalRequestRepo) {
    pendingApprovals.recoverFromDB(approvalRequestRepo);
  }

  // Mutable refs updated on hot reload
  let _approvalTimeoutMs = approvalTimeoutMs;
  let _shellEnabled = shellEnabled;

  const factory: AgentFactory = {
    updateConfig(cfg: AppConfig): void {
      configRef.current = cfg;
      _approvalTimeoutMs = cfg.tools.shellApprovalTimeoutSec * 1000;
      _shellEnabled = cfg.tools.shellEnabled;
      pendingApprovals.setTimeoutAction(cfg.tools.shellApprovalTimeoutAction);
    },

    create(options?: AgentCreateOptions): Agent {
      let agentConfig: ResolvedAgentConfig | undefined;
      if (agentManager) {
        agentConfig = options?.agentId
          ? (agentManager.get(options.agentId) ?? agentManager.getDefault(options?.channel))
          : agentManager.getDefault(options?.channel);
      }

      let model = options?.model ?? getDefaultModel(configRef.current) ?? defaultModel;

      if (agentConfig?.model.primary && !options?.model) {
        const ref = agentConfig.model.primary;
        const idx = ref.indexOf('/');
        if (idx !== -1) {
          const agentModel = getModel(ref.slice(0, idx) as any, ref.slice(idx + 1) as any) as any;
          if (agentModel) model = agentModel;
        }
      }

      const modelProvider = model?.provider as string | undefined;
      const modelId = model?.id as string | undefined;
      const cacheProfile = isDeepSeekLikeModel(model) ? 'deepseek' as const : 'default' as const;
      const customModelCfg = configRef.current.customProviders
        ?.find(p => p.provider === modelProvider)
        ?.models.find(m => m.id === modelId);
      const thinkingLevel =
        customModelCfg?.reasoningLevel ??
        configRef.current.defaultReasoningLevel ??
        'off';

      const fallbackModels = (configRef.current.fallbackModels ?? [])
        .map(ref => {
          const idx = ref.indexOf('/');
          if (idx === -1) return undefined;
          const provider = ref.slice(0, idx);
          const modelId = ref.slice(idx + 1);
          return getModel(provider as any, modelId as any) as any;
        })
        .filter(Boolean);

      let tools = options?.tools ?? toolRegistry.listAsAgentTools();

      if (agentConfig && !options?.tools) {
        tools = agentManager!.resolveTools(agentConfig);
      }

      tools = tools.filter((t: any) => t.name !== 'cronjob');
      const cronService = factoryOptions.cronServiceFactory?.();
      if (cronService && options?.chatId) {
        try {
          const cronTool = createCronjobTool({
            cronService,
            chatId: options.chatId,
            channel: options.channel ?? 'unknown',
            agentName: agentConfig?.name,
            agentId: options.agentId,
            computerUseAllowed: () => tools.some((t: any) => t.name === 'computer_use'),
          });
          tools = [...tools, cronTool];
        } catch {
          logger?.debug('Cronjob tool creation failed — continuing without it');
        }
      }

      let systemPrompt = options?.systemPrompt ?? buildDefaultSystemPrompt(configRef.current.uiLanguage);

      if (agentConfig && !options?.systemPrompt) {
        systemPrompt = agentConfig.system_prompt || systemPrompt;
      }

      // Render template variables in agent system_prompt
      if (promptManager && agentConfig && !options?.systemPrompt) {
        const renderedAgent = promptManager.renderTemplate(systemPrompt, {
          agent_name: agentConfig.name ?? '',
          agent_id: agentConfig.id ?? '',
          current_time: currentTimeTemplateValue(),
          channel: options?.channel ?? 'unknown',
          ui_language: configRef.current.uiLanguage ?? 'zh-CN',
        });
        promptManager.registerAgentOverride(agentConfig.id, renderedAgent);
        systemPrompt = renderedAgent;
      }

      let resolvedSkillScope: ResolvedSkillScope = {
        scope: 'global',
        scopeKey: '',
      };

      let compiled: ReturnType<SkillRegistry['compile']> | undefined;
      if (skillRegistry && options?.message) {
        const resolved = skillRegistry.resolve(options.message);
        logger?.debug({ message: options.message, count: resolved.length, skills: resolved.map(r => r.skill.manifest.id) }, 'skill resolution result');
        if (resolved.length > 0) {
          compiled = skillRegistry.compile(resolved);
          const skillCtx = compiled;
          const skill = resolved[0]!.skill;
          resolvedSkillScope = {
            scope: 'skill',
            scopeKey: resolved[0]!.skill.manifest.id,
          };
          logger?.debug({ skillId: skill.manifest.id }, 'skill activated via fast path');

          // P1-3: Store active skill for compliance tracking
          const sessionKey = options?.sessionId ?? 'default';
          activeSkillForSession.set(sessionKey, { skillId: skill.manifest.id, skill });

          // P1-4: Record skill activation for metrics
          let skillFeedbackId: string | undefined;
          if (getServices?.()?.skillMetricsService) {
            const metricsService = getServices()!.skillMetricsService!;
            skillFeedbackId = metricsService.recordActivation(
              skill.manifest.id,
              sessionKey,
              options.message,
            );
            activeSkillFeedbackIds.set(sessionKey, { feedbackId: skillFeedbackId, startTime: Date.now() });
          }

          // Strip $skill-id and /skill-id tokens from the user message
          const escapedId = skill.manifest.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          let cleanMessage = options.message
            .replace(new RegExp(`(?:^/${escapedId}\\s*)|(?:\\$${escapedId}\\s*)`, 'gi'), '')
            .trim();
          if (!cleanMessage) {
            cleanMessage = 'I am ready to help with this skill.';
          }
          options.message = cleanMessage;

          // Skill allowed-tools is declarative ("this skill needs these"),
          // NOT restrictive. Tool filtering is handled by the tools profile.

          if (skillCtx.approvalOverrides && approvalGate && approvalGate.createPolicy) {
            for (const [key, override] of Object.entries(skillCtx.approvalOverrides)) {
              const ov = override as { targetKind: string; patternType: string; pattern: string; effect: string };
              const policyId = `skill-${key}`;
              approvalGate.createPolicy({
                id: policyId,
                scope: 'skill',
                scopeKey: '',
                targetKind: ov.targetKind,
                patternType: ov.patternType as any,
                pattern: ov.pattern,
                effect: ov.effect as any,
              });
            }
          }
        }
      }

      // Assemble final system prompt via PromptManager (v5)
      // Skip when caller provided an explicit systemPrompt override (e.g. cron delivery)
      let promptAssembly: ReturnType<PromptManager['assemble']> | undefined;
      if (promptManager && !options?.systemPrompt) {
        // Gather L1 metadata for skills catalog
        let availableSkills: PromptAssemblyOptions['availableSkills'];
        if (skillRegistry?.isLoaded()) {
          const allSkills = skillRegistry.getSkills();
          if (allSkills.length > 0) {
            availableSkills = allSkills.map(s => ({
              id: s.manifest.id,
              name: s.manifest.name,
              description: s.manifest.description,
              path: `skills/${s.manifest.id}/SKILL.md`,
            }));
          }
        }

        // v7: Agent Team mode — inject orchestrator role layer for primary agent
        const sessionId = options?.sessionId ?? 'default';
        const teamState = teamModeStore.get(sessionId);
        const isTeamMode = (teamState?.enabled ?? configRef.current.smart_agent_team.enabled)
          && !options?.isChildAgent;
        const teamModeMaxChildren = teamState?.config.max_children
          ?? configRef.current.smart_agent_team.max_children
          ?? 4;

        promptAssembly = promptManager.assemble({
          agentId: options?.agentId ?? agentConfig?.id,
          availableSkills,
          activeSkillLayers: compiled?.promptLayers,
          isChildAgent: options?.isChildAgent,
          childTaskDescription: options?.childTaskDescription,
          uiLanguage: configRef.current.uiLanguage,
          channel: options?.channel,
          isTeamMode,
          teamModeMaxChildren,
        });
        systemPrompt = promptAssembly.systemPrompt;
      } else if (compiled?.promptContent) {
        // Legacy fallback: string concatenation (when PromptManager not available)
        systemPrompt = `${systemPrompt}\n\n${compiled.promptContent}`;
      }

      // P1-3: Inject skill compliance reinforcement when needed
      const sessionKey = options?.sessionId;
      if (sessionKey) {
        const reinforcement = reinforcementMessages.get(sessionKey);
        if (reinforcement) {
          systemPrompt = `${systemPrompt}\n\n${reinforcement}`;
          logger?.info({ sessionId: sessionKey }, 'Skill compliance reinforcement injected into system prompt');
          // Clear after injection (per-turn reinforcement)
          reinforcementMessages.delete(sessionKey);
        }
      }

      const sessionId = options?.sessionId;
      const chatId = options?.chatId;
      const messageId = options?.messageId;
      const turnContext = options?.turnContext;
      const runtimeAgentId = options?.policyAgentId ?? agentConfig?.id ?? options?.agentId;

      // Pass skill activation data to agent-service via turnContext.
      // Only set when a skill IS activated — otherwise clear so the next
      // turn falls back to the current input (turnContext is shared across turns).
      if (turnContext) {
        if (compiled) {
          turnContext.effectiveMessage = options?.message;
        } else {
          turnContext.effectiveMessage = undefined;
        }
      }

      // Initialize offloadStore for context offloading (P0)
      const offloadCfg = configRef.current.memory.offloading;
      const offloadBaseDir = offloadCfg?.refDir || path.dirname(configRef.current.database.path);
      const offloadDir = path.join(offloadBaseDir, 'offload');
      const offloadStore = offloadCfg?.enabled
        ? new OffloadStore(offloadBaseDir)
        : undefined;

      // Initialize Mermaid canvas for task graph tracking (P1)
      const mermaidCanvasCfg = configRef.current.memory.mermaidCanvas;
      const mermaidCanvas = mermaidCanvasCfg?.enabled
        ? (offloadStore && sessionId
            ? MermaidCanvas.fromRecords(offloadStore.getSessionRecords(sessionId))
            : new MermaidCanvas())
        : undefined;
      // Lazy phase tagger (initialized fire-and-forget in afterToolCall)
      let phaseTagger: MermaidPhaseTagger | undefined;

      const skillProfile = (compiled?.toolsProfile) as ToolProfileId | undefined;
      const globalProfile = defaultToolsProfile ?? configRef.current.tools.toolsProfile ?? 'standard';
      const effectiveProfile: ToolProfileId = options?.toolsProfileOverride ?? skillProfile ?? globalProfile;
      const effectiveShellMode = _shellEnabled ? shellModeForProfile(effectiveProfile) : 'read-only' as const;
      const runtimePolicyScope: AgentPolicyScope = options?.policyScope ?? {
        toolsProfile: effectiveProfile,
        readRoots: [],
        writeRoots: [],
        deniedPatterns: [],
        shellExecMode: effectiveShellMode === 'read-only' ? 'safe' : 'balanced',
        sessionApprovals: [],
        appApprovals: [],
        readOnly: effectiveShellMode === 'read-only',
        computerUseEnabled: options?.computerUseAllowed !== false,
      };

      const profileAllowedTools = PROFILE_TOOLS[effectiveProfile] ?? PROFILE_TOOLS.standard;
      if (profileAllowedTools[0] !== '*' && !options?.tools) {
        tools = tools.filter((t: any) => profileAllowedTools.includes(t.name) || t.name === 'computer_use');
      }

      if (options?.computerUseAllowed === false) {
        tools = tools.filter((t: any) => t.name !== 'computer_use');
      }

      const runtimeToolPlatformRegistry = getServices?.()?.toolPlatformRegistry;
      const bridgeRegistry = getServices?.()?.desktopBridgeRegistry;
      if (runtimeToolPlatformRegistry && policyCenter) {
        const runtimeAdapter = new AgentToolAdapterImpl({
          policyCenter,
          getServices,
          getContextOverrides: () => {
            const overrides: Record<string, unknown> = {
              sessionId,
              agentId: runtimeAgentId,
              channel: options?.channel,
              policyScope: runtimePolicyScope,
              approvalAlreadyHandled: !!approvalGate,
            };

            // Inject desktop bridge if one is registered for this session
            if (bridgeRegistry && sessionId && bridgeRegistry.hasBridge(sessionId)) {
              overrides.desktopBridge = {
                callTool: (tool: string, args: unknown, timeoutMs: number) =>
                  bridgeRegistry.callTool(sessionId, tool, args, timeoutMs),
              };
            }

            return overrides as any;
          },
        });
        tools = tools.map((tool: any) => {
          const def = runtimeToolPlatformRegistry.getDefinition(tool.name);
          return def ? runtimeAdapter.toAgentTool(def) : tool;
        });
      }

      // Append extra tools provided by the channel (e.g. feishu_send_media, qq_send_media).
      // Must run AFTER all filtering so these tools are never removed.
      if (options?.extraTools && options.extraTools.length > 0) {
        tools = [...tools, ...options.extraTools];
      }

      if (computerUseHost && tools.some((t: any) => t.name === 'computer_use')) {
        const modelInput = Array.isArray(model?.input)
          ? model.input
          : ['text'];
        const sendComputerUseImage = options?.computerUseImageSender
          ?? (options?.channel === 'feishu' && chatId && feishuClient?.uploadImage && feishuClient?.sendMessage
          ? async (image: { data: string; mimeType: string }) => {
              const buffer = Buffer.from(image.data, 'base64');
              const { imageKey } = await feishuClient.uploadImage!(buffer, 'message');
              await feishuClient.sendMessage!({
                receive_id: chatId,
                receive_id_type: 'chat_id',
                msg_type: 'image',
                content: JSON.stringify({ image_key: imageKey }),
                uuid: generateId(),
              });
              return `Sent to Feishu as image ${imageKey}`;
            }
          : undefined);
        tools = tools.map((tool: any) => tool.name === 'computer_use'
          ? createComputerUseTool(computerUseHost, () => ({
              sessionPath: sessionId,
              agentId: runtimeAgentId,
              accessMode: effectiveShellMode === 'read-only' ? 'read-only' : 'operate',
              model: {
                provider: String(model?.provider ?? ''),
                id: String(model?.id ?? ''),
                input: modelInput,
              },
            }), {
              sendImage: sendComputerUseImage,
              policyCenter,
              policyScope: {
                ...runtimePolicyScope,
                computerUseEnabled: runtimePolicyScope.computerUseEnabled && options?.computerUseAllowed !== false,
              },
              approvalAlreadyHandled: !!approvalGate,
              logger,
            })
          : tool);
      }

      const orchestrator = orchestratorFactory?.();
      if (orchestrator && agentManager && logger && tools.some((t: any) => t.name === 'spawn_agent')) {
        const spawnDef = createSpawnAgentToolDefinition({
          agentManager,
          logger,
          orchestrator,
          createAgent: (config, task, childOptions) => {
            const childTools = agentManager.resolveTools(config)
              .filter((t: any) => t.name !== 'spawn_agent');
            return factory.create({
              agentId: config.id,
              systemPrompt: config.system_prompt,
              tools: childTools,
              message: task,
              sessionId: childOptions?.sessionId,
              toolsProfileOverride: config.tools.profile,
              policyScope: childOptions?.policyScope,
              policyAgentId: childOptions?.agentId,
              computerUseAllowed: childOptions?.policyScope?.computerUseEnabled,
              isChildAgent: true,
              childTaskDescription: task,
            });
          },
        });
        const spawnAdapter = new AgentToolAdapterImpl({
          policyCenter,
          getServices,
          getContextOverrides: () => ({
            sessionId,
            agentId: runtimeAgentId,
            policyScope: runtimePolicyScope,
            approvalAlreadyHandled: !!approvalGate,
          }),
        });
        tools = tools.map((tool: any) => tool.name === 'spawn_agent'
          ? spawnAdapter.toAgentTool(spawnDef)
          : tool);
      }

      // ── Tool Search Assembly ──
      // Runs LAST — after profile filtering, runtime-adapter wrapping, channel
      // extraTools, and computer_use/spawn_agent wiring — so that:
      //   1. the tool_search bridge is created here and is NOT clobbered by the
      //      adapter remap (which would otherwise replace it with the standalone
      //      registry-search version, destroying the deferredCatalog + invoke);
      //   2. the deferredCatalog references the final policy-wrapped tools, so
      //      direct calls and bridge invoke both run identical policy hooks;
      //   3. deferred tools (flagged) stay in the tools array → resolvable by
      //      name for direct invocation, hidden only from the LLM prompt.
      // extraTools (channel-injected) are forced visible to preserve their
      // "never removed" contract.
      // Wrapped in try-catch so any assembly error falls back to the full list.
      let toolSearchAssembly: ReturnType<typeof assembleTools> | undefined;
      try {
        const tsConfig = loadToolSearchConfig(configRef.current);

        if (tsConfig.enabled !== 'off') {
          const contextLength = resolveModelContextLength(model);
          const forceVisible = options?.extraTools?.length
            ? new Set(options.extraTools.map((t: any) => t.name))
            : undefined;
          toolSearchAssembly = assembleTools(tools, tsConfig, contextLength, forceVisible);

          logger?.debug({
            activated: toolSearchAssembly.activated,
            deferredCount: toolSearchAssembly.deferredCount,
            deferredTokens: toolSearchAssembly.deferredTokens,
          }, 'tool_search assembly');

          if (toolSearchAssembly.activated) {
            logger?.info({
              deferred: toolSearchAssembly.deferredCount,
              deferredTokens: toolSearchAssembly.deferredTokens,
              threshold: toolSearchAssembly.thresholdTokens,
            }, 'tool_search activated');
          }

          tools = toolSearchAssembly.tools;
        }
      } catch (err) {
        logger?.warn({ err }, 'tool_search assembly failed, continuing without tool search');
      }

      const agent = new Agent({
        initialState: {
          systemPrompt,
          model,
          tools,
          thinkingLevel: thinkingLevel as any,
          messages: options?.historyMessages as any ?? [],
        },
        convertToLlm,
        transformContext: createTransformContext({
          memoryRetriever,
          autoRecall: configRef.current.memory.autoRecall,
          autoRecallFrequency: configRef.current.memory.autoRecallFrequency as 'first' | 'every',
          sessionKey: sessionId,
          agentId: runtimeAgentId,
          dateLanguage: configRef.current.uiLanguage,
          offloadConfig: configRef.current.memory.offloading,
          offloadStore: offloadStore,
          personaContextProvider: personaStore ? () => personaStore.toContextString() : undefined,
          desktopBridgeReminderProvider: bridgeRegistry
            ? (sKey?: string) => {
                if (!sKey || !bridgeRegistry.hasBridge(sKey)) return undefined;
                return `<system-reminder>
You have file access to BOTH the user's desktop and this gateway server:

  • Desktop paths → automatically routed through Desktop Bridge:
      Windows: C:\\..., E:\\...  macOS: /Users/...  Linux: /home/...
  • Gateway paths → executed locally on this server:
      /data/..., /tmp/... and other server-local paths

To send a file to the user, use webui_send_media with the file path.
It works for BOTH desktop and gateway paths — routing is automatic.

NEVER refuse to access files. You can read and send files from BOTH sources.
</system-reminder>`;
              }
            : undefined,
          mermaidCanvasConfig: configRef.current.memory.mermaidCanvas,
          mermaidCanvas: mermaidCanvas,
          cacheProfile,
          compressConfig: (() => {
            const cc = configRef.current.memory.autoCompress;
            if (!cc?.enabled) return undefined;
            const apiKeys: Record<string, string> = {};
            const baseUrls: Record<string, string> = {};
            mergeProviderKeys(apiKeys, baseUrls, configRef.current);
            return {
              config: cc,
              contextWindow: model?.contextWindow ?? 128000,
              mainModelRef: `${configRef.current.piAi.provider}/${configRef.current.piAi.model}`,
              globalFallbackRefs: configRef.current.fallbackModels ?? [],
              compressModelRef: cc.model?.primary || undefined,
              compressFallbackRefs: cc.model?.fallback_models,
              apiKeys,
              baseUrls,
              baseUrl: configRef.current.piAi.baseUrl,
            };
          })(),
          logger,
        }),
        sessionId,
        getApiKey: (provider: string) => {
          // 1. Custom providers (explicit per-provider key)
          const cp = configRef.current.customProviders?.find(p => p.provider === provider);
          if (cp?.apiKey) return cp.apiKey;
          // 2. Built-in provider keys (from config.yaml provider_keys)
          const pk = configRef.current.providerKeys?.[provider];
          if (pk?.apiKey) return pk.apiKey;
          // 3. Primary model's provider (piAi.apiKey from config.yaml provider.api_key)
          if (provider === configRef.current.piAi.provider && configRef.current.piAi.apiKey) {
            return configRef.current.piAi.apiKey;
          }
          return undefined;
        },
        fallbackModels: fallbackModels.length > 0 ? fallbackModels : undefined,
        afterToolCall: async (context) => {
          const result = context.result;

          // Auto-reload skill registry when a SKILL.md is written via file_write.
          // Agents may use file_write instead of skill_create, so we detect writes
          // to skills/*/SKILL.md and reload so the new skill is immediately active.
          if (skillRegistry && context.toolCall.name === 'file_write' && result && !context.isError) {
            try {
              const fp = (context.args as Record<string, unknown>)?.filePath as string | undefined;
              if (fp && /(?:^|[\\/])skills[\\/][^\\/]+[\\/]SKILL\.md$/i.test(fp)) {
                await skillRegistry.load('./skills');
                logger?.info({ filePath: fp }, 'Skill registry auto-reloaded after file_write to SKILL.md');
              }
            } catch {
              logger?.debug('Skill registry auto-reload failed — continuing');
            }
          }

          // P1-3: Check skill compliance (track unauthorized tool usage against active skill rules)
          const sessionKey = sessionId ?? 'default';
          const activeSkill = activeSkillForSession.get(sessionKey);
          if (activeSkill && context.toolCall.name) {
            const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [
              { name: context.toolCall.name, args: (context.args as Record<string, unknown>) ?? {} },
            ];
            const complianceResult = complianceTracker.check(
              activeSkill.skillId,
              toolCalls,
              activeSkill.skill,
              sessionKey,
            );
            if (complianceResult.reinforcementMessage) {
              reinforcementMessages.set(sessionKey, complianceResult.reinforcementMessage);
              logger?.warn(
                { skillId: activeSkill.skillId, violations: complianceResult.violations },
                'Skill compliance violation — reinforcement queued',
              );
            }
          }

          // Shared Mermaid phase-tagger initializer for both offloading branches
          const ensurePhaseTagger = (): MermaidPhaseTagger | undefined => {
            if (!logger) return undefined;
            if (!phaseTagger) {
              const summaryConfig = buildSummaryLLMConfig(configRef.current);
              createDistillerLLM(summaryConfig, logger).then(llm => {
                phaseTagger = new MermaidPhaseTagger(llm, logger);
              }).catch(() => {});
            }
            return phaseTagger;
          };

          // Check if context offloading is enabled
          const offloadCfg = configRef.current.memory.offloading;
          if (offloadCfg?.enabled && offloadStore && sessionId) {
            if (!result) return undefined;

            // Normalize content to TextBlock array format
            const formatted = typeof result.content === 'string'
              ? [{ type: 'text' as const, text: result.content }]
              : (Array.isArray(result.content) ? result.content : [{ type: 'text' as const, text: String(result.content ?? '') }]);

            // Read existing records to determine the next sequence number
            const records = offloadStore.getSessionRecords(sessionId);
            const seq = records.length + 1;

            const summary = summarizeToolResult(context.toolCall.name, context.args, formatted, context.isError);
            // Archive full result to offload store (for context trimming recovery)
            const record = offloadStore.writeToolResult(
              sessionId, seq, context.toolCall.name, context.args, formatted, context.isError, summary
            );
            const resultChars = textBlockChars(formatted);
            const shouldCompactForDeepSeek =
              cacheProfile === 'deepseek' &&
              resultChars > 4000 &&
              !shouldKeepFullToolResultInContext(context.toolCall.name);

            // P1: Mermaid canvas update (via shared helper)
            updateMermaidCanvas({
              canvas: mermaidCanvas,
              config: mermaidCanvasCfg ?? {},
              node: {
                nodeId: record.nodeId,
                toolName: context.toolCall.name,
                toolArgs: (context.args ?? {}) as Record<string, unknown>,
                summary,
                status: record.status,
                seq: record.seq,
                refPath: record.refPath,
              },
              sessionId,
              logger,
              ensurePhaseTagger,
            });

            if (shouldCompactForDeepSeek) {
              const ref = `${offloadStore.getSessionDirPath(sessionId)}/${record.refPath}`;
              logger?.info({
                sessionId,
                toolName: context.toolCall.name,
                charsBefore: resultChars,
                refPath: record.refPath,
              }, 'DeepSeek cache profile compacted large tool result');
              return {
                ...result,
                content: [{
                  type: 'text' as const,
                  text: `[工具结果已压缩]\n${summary}\n\n完整结果已归档: ${ref}\n如需原始输出，请使用 file_read 读取该路径。`,
                }],
                details: {
                  ...(typeof result.details === 'object' && result.details !== null ? result.details : {}),
                  offloadRef: ref,
                  originalChars: resultChars,
                  compactedFor: 'deepseek-cache',
                },
              };
            }

            // Return full result unchanged when it is small enough or the model
            // is not using DeepSeek's automatic prefix-cache profile.
            return { ...result, content: formatted };
          }

          // P1: Mermaid canvas update (when offloading is disabled)
          if (mermaidCanvasCfg?.enabled && mermaidCanvas && result) {
            const fmt = typeof result.content === 'string'
              ? [{ type: 'text' as const, text: result.content }]
              : (Array.isArray(result.content) ? result.content : [{ type: 'text' as const, text: String(result.content ?? '') }]);
            const toolSummary = summarizeToolResult(context.toolCall.name, context.args, fmt, context.isError);
            updateMermaidCanvas({
              canvas: mermaidCanvas,
              config: mermaidCanvasCfg ?? {},
              node: {
                nodeId: `node-${String(mermaidCanvas.size + 1).padStart(3, '0')}`,
                toolName: context.toolCall.name,
                toolArgs: (context.args ?? {}) as Record<string, unknown>,
                summary: toolSummary,
                status: context.isError ? 'error' : 'success',
                seq: mermaidCanvas.size + 1,
                refPath: '',
              },
              sessionId,
              logger,
              ensurePhaseTagger,
            });
          }

          // Offloading disabled: keep original behavior (string → TextBlock)
          if (result && typeof result.content === 'string') {
            return {
              ...result,
              content: [{ type: 'text' as const, text: result.content }],
            };
          }
          return undefined;
        },
        beforeToolCall: approvalGate
          ? createBeforeToolCall({
              approvalGate,
              approvalPort,
              approvalTimeoutMs: _approvalTimeoutMs,
              approvalRequestRepo,
              computerUseHost,
              pendingApprovals,
              sessionId,
              chatId,
              messageId,
              turnContext,
              agentConfig,
              resolvedSkillScope,
              effectiveProfile,
              shellMode: effectiveShellMode,
              policyCenter,
              policyScope: runtimePolicyScope,
              policyAgentId: options?.policyAgentId,
              channelApprovalSender: options?.channelApprovalSender,
              channel: (options?.channel as BeforeToolCallDeps['channel']),
            })
          : undefined,
      });

      agent.ohmyagent_agentName = agentConfig?.name;

      return agent;
    },

    resolveApproval(
      requestId: string,
      decision: ApprovalDecisionType,
    ): boolean {
      return pendingApprovals.resolve(requestId, decision);
    },

    resolveFirstPendingApproval(
      sessionKey: string,
      decision: ApprovalDecisionType,
    ): boolean {
      return pendingApprovals.resolveFirstForSession(sessionKey, decision);
    },

    resolveAllPendingApprovals(
      sessionKey: string,
      decision: ApprovalDecisionType,
    ): number {
      return pendingApprovals.resolveAllForSession(sessionKey, decision);
    },

    rejectPendingApprovals(sessionKey: string, reason?: 'stopped_by_user' | 'steered'): number {
      return pendingApprovals.rejectAllForSession(sessionKey, approvalRequestRepo, reason);
    },

    getAutoCompressConfig() {
      const cc = configRef.current.memory.autoCompress;
      if (!cc?.enabled) return undefined;
      const apiKeys: Record<string, string> = {};
      const baseUrls: Record<string, string> = {};
      mergeProviderKeys(apiKeys, baseUrls, configRef.current);
      const compressModel = configRef.current.memory.autoCompress?.model;
      return {
        contextWindow: getDefaultModel(configRef.current)?.contextWindow ?? 128000,
        mainModelRef: `${configRef.current.piAi.provider}/${configRef.current.piAi.model}`,
        globalFallbackRefs: configRef.current.fallbackModels ?? [],
        compressModelRef: compressModel?.primary || undefined,
        compressFallbackRefs: compressModel?.fallback_models,
        apiKeys,
        baseUrls,
        baseUrl: configRef.current.piAi.baseUrl,
      };
    },
  };

  return factory;
}
