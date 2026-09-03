/**
 * Agent Factory
 *
 * Creates Agent instances with the correct model, tools, system prompt,
 * and lifecycle hooks pre-configured. Optionally integrates with the
 * Skills system and the Approval Gate for shell command gating.
 */

import { Agent } from '@earendil-works/pi-agent-core';
import { streamSimple } from '@earendil-works/pi-ai';
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
import { estimateStaticContextTokens } from './compress.js';
import { convertToLlm } from './convert-to-llm.js';
import type { ApprovalDecisionType } from '../app/types.js';
import type { ApprovalRequestRepository } from '../memory/repositories/approval-request-repository.js';
import type { ApprovalUiPort } from './approval-ui-port.js';
import type { AgentManager } from './agent-manager.js';
import type { ResolvedAgentConfig } from './config-types.js';
import type { ComputerUseHost } from '../computer-use/computer-host.js';
import { PendingApprovalStore } from './approval-store.js';

import type { PromptManager } from '../prompt/prompt-manager.js';
import type { PromptAssemblyOptions } from '../prompt/types.js';
import { teamModeStore } from './team-mode-store.js';
import { turnCounter, planOnlyReflection, hasSpawnCapability } from './turn-counter.js';
import { createRetryingStreamFn } from './retrying-stream.js';
import { createBeforeToolCall, type BeforeToolCallDeps } from './before-tool-call.js';
import type { PolicyCenter } from '../policy/policy-center.js';
import type { AgentPolicyScope } from '../policy/types.js';
import { PROFILE_TOOLS, STRICT_FORCED_CORE_TOOLS } from '../policy/tool-visibility.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import type { Logger } from 'pino';
import { OffloadStore } from '../runtime-artifacts/offload-store.js';
import { summarizeToolResult } from '../memory/offload-summarizer.js';

import { MermaidCanvas } from '../runtime-artifacts/mermaid-canvas.js';
import { MermaidPhaseTagger } from '../runtime-artifacts/mermaid-phase-tagger.js';
import { updateMermaidCanvas } from './mermaid-canvas-updater.js';
import { createDistillerLLM } from '../memory/persona-distiller.js';
import type { PersonaStore } from '../memory/persona-store.js';
import type { SummaryLLMConfig } from '../memory/memory-summarizer.js';
import path from 'node:path';
import { SkillComplianceTracker } from '../skills/skill-compliance.js';
import { resolveModel } from './model-resolver.js';
import { assembleAgentTools, shellModeForProfile } from './tool-pipeline.js';
import { detectIntentDomain } from './intent.js';
import { recordToolSurfaceTurn } from './tool-surface-stats.js';
import type { CreateChildAgent } from './tool-pipeline.js';

// ─── Types ───

// P1-3: Skill compliance tracker (session-scoped violation tracking)
const complianceTracker = new SkillComplianceTracker();
/** Map of sessionId → reinforcement messages to inject in the next turn */
const reinforcementMessages = new Map<string, string>();
import { activeSkillForSession, activateSkill } from './skill-activator.js';

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

/**
 * Resolve the API key for a provider, mirroring the agent loop's priority:
 * customProviders → provider_keys → piAi.apiKey (primary provider only).
 * Shared by agent-factory's getApiKey and auxiliary LLM callers (harness
 * optimizer, session titles) so every outbound call uses the same key source.
 */
export function resolveProviderApiKey(config: AppConfig, provider: string): string | undefined {
  // 1. Custom providers (explicit per-provider key)
  const cp = config.customProviders?.find((p) => p.provider === provider);
  if (cp?.apiKey) return cp.apiKey;
  // 2. Built-in provider keys (from config.yaml provider_keys)
  const pk = config.providerKeys?.[provider];
  if (pk?.apiKey) return pk.apiKey;
  // 3. Primary model's provider (piAi.apiKey from config.yaml provider.api_key)
  if (provider === config.piAi.provider && config.piAi.apiKey) return config.piAi.apiKey;
  return undefined;
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

function textBlockChars(blocks: Array<{ type?: string; text?: string }>): number {
  return blocks.reduce(
    (sum, block) => sum + (typeof block.text === 'string' ? block.text.length : 0),
    0,
  );
}

function resolveResponseLanguage(config: AppConfig): string {
  const outputLang = config.memory?.outputLanguage;
  if (outputLang && outputLang !== 'Auto') {
    return outputLang; // Already a full language name, e.g. "Simplified Chinese"
  }
  // Fall back from uiLanguage locale code
  const uiLang = config.uiLanguage ?? 'zh-CN';
  return uiLang.startsWith('zh') ? 'Simplified Chinese' : 'English';
}

function shouldKeepFullToolResultInContext(toolName: string): boolean {
  return ['web_search', 'web-search', 'web_fetch'].includes(toolName);
}

/** Build a compact one-line "label: first sentence" snippet for the tools catalog layer. */
function toolOneLineSnippet(tool: { name?: string; label?: string; description?: string }): string {
  const label =
    typeof tool.label === 'string' && tool.label.length > 0 ? tool.label : (tool.name ?? '');
  const desc = typeof tool.description === 'string' ? tool.description : '';
  const firstLine = desc.split('\n')[0] ?? '';
  const firstSentence = firstLine.split(/(?<=[.!?。！？])\s/)[0]?.trim() ?? '';
  const body = firstSentence || firstLine.trim().slice(0, 60) || '';
  return `${label}: ${body}`.slice(0, 120);
}

/** Options for creating an Agent instance. */
export interface AgentCreateOptions {
  message?: string;
  agentId?: string;
  systemPrompt?: string;
  model?: any;
  /** Per-turn thinking/reasoning level override (WebUI chat input's reasoning
   *  selector). Valid values: off|minimal|low|medium|high|xhigh|max. Wins over
   *  the per-model config and the global defaultReasoningLevel. */
  reasoningLevel?: string;
  tools?: any[];
  /** Extra tools to append to the agent's tool list (used by channels for send_media). */
  extraTools?: any[];
  sessionId?: string;
  chatId?: string;
  messageId?: string;
  /** Operator identity of the current message sender (e.g. Feishu open_id).
   *  Threaded into approval request records as the requester so approval
   *  callbacks can verify the clicker is the requester. */
  senderId?: string;
  historyMessages?: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string }>;
    timestamp: number;
  }>;
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
  /** Maximum retry attempts for transient provider/transport errors (0 disables). */
  maxRetries?: number;
}

interface ResolvedSkillScope {
  scope: 'global' | 'skill';
  scopeKey: string;
}

/** Minimal Feishu client interface for sending approval cards and media. */
export interface FeishuApprovalClient {
  sendApprovalCard(chatId: string, card: Record<string, unknown>): Promise<string>;
  recallMessage?(messageId: string): Promise<void>;
  uploadImage?(
    image: Buffer | string,
    imageType?: 'message' | 'avatar',
  ): Promise<{ imageKey: string }>;
  uploadFile?(
    file: Buffer | string,
    fileName: string,
    fileType: string,
    duration?: number,
  ): Promise<{ fileKey: string }>;
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
  /** Operator identity of the current message sender (e.g. Feishu open_id). */
  senderId?: string;
  replyDispatcher?: ReplyDispatcher;
  /** Factory to create a fresh channel-specific dispatcher (used by followUp). */
  replyDispatcherFactory?: () => ReplyDispatcher;
  /** Message with $skill-id stripped (set by skill fast path). Falls back to original input. */
  effectiveMessage?: string;
  /** Skill name activated for this turn (set when a skill matches via trigger or explicit command). */
  activatedSkillName?: string;
  /** Skill id (manifest id) activated for this turn — the stable identifier
   *  used for metrics and harness failure context. */
  activatedSkillId?: string;
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
  onApprovalAutoReject?: (
    requestId: string,
    reason: 'timeout' | 'stale_after_restart' | 'expired_before_recovery' | 'steered',
  ) => void;
  onApprovalAutoApprove?: (requestId: string) => void;
  /** Called when a human approves a file-access approval; wired by the
   *  composer to grantFileServeAccess so the approved path becomes servable
   *  by the WebUI for the allowlist TTL (report #6b option B). */
  onFileServeApproved?: (info: { path: string; requestId: string }) => void;
  logger?: Logger;
  promptManager?: PromptManager;
  userQuestionStore?: import('./user-question-store.js').UserQuestionStore;
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
  /** Resolve a pending user question. Returns false if not found. */
  resolveUserQuestion(requestId: string, answer: string): boolean;
  /** Resolve the first pending user question for a session. Returns false if none. */
  resolveFirstPendingQuestion(sessionKey: string, answer: string): boolean;
  /** Reject all pending user questions for a session. Returns count. */
  rejectPendingQuestions(sessionKey: string): number;
  /** v9: Get compression model config for overflow recovery. */
  getAutoCompressConfig():
    | {
        contextWindow: number;
        mainModelRef: string;
        globalFallbackRefs: string[];
        compressModelRef?: string;
        compressFallbackRefs?: string[];
        apiKeys: Record<string, string>;
        baseUrls: Record<string, string>;
        baseUrl?: string;
      }
    | undefined;
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

function buildDefaultSystemPrompt(_lang?: string): string {
  return [
    'You are OhMyAgent, a helpful AI assistant.',
    '',
    '## Memory',
    `You have long-term memory capabilities. Use the memory tools to manage information:
- **memory-store**: Save user preferences, facts, decisions, or anything worth remembering.
- **memory-recall**: Search your memory when you need context about the user or past conversations.
- **summarize-session**: When a discussion topic or task has reached a natural conclusion, call this to summarize the conversation into long-term memory.

**CRITICAL RULES — MUST FOLLOW:**
1. When the user shares the following, **immediately call memory-store** (do NOT just verbally acknowledge):
   - Their name or how they want to be addressed (e.g., "call me XX")
   - Your name or identity (e.g., "your name is XX")
   - Personal preferences, habits, devices, skills, etc.
2. Use memory-recall to search memory when you need context about the user or past discussions.
3. After completing complex tasks or multi-turn discussions, call summarize-session.

Example: User says "My name is Bob, call me Boss. Your name is Helper." → Immediately call memory-store twice: once for the user's name/preference, once for your name. Do not just reply "OK" without calling the tools.`,
    '',
    '## Scheduled Tasks (cronjob)',
    `You can create scheduled/reminder tasks using the **cronjob** tool. Use it when the user:
- Asks for a reminder (e.g., "remind me to check logs in 30 minutes")
- Requests periodic reports or messages (e.g., "send me a summary every morning at 9am")
- Wants delayed execution (e.g., "run this task in 5 minutes")

**CRITICAL: Create the cron job immediately, without asking clarifying questions.**

**The prompt parameter is key — it determines what the user ultimately sees.**
- prompt must be the final message the user will receive, written in natural language, e.g. "Time to read the news! Check out today's top stories"
- prompt is NOT an instruction for another agent — it IS the final message itself
- For pure reminders: write the reminder content directly, not in instruction format like "remind user to XXX"
- For information-gathering: write what to fetch, e.g. "Search for today's top AI news and summarize"

When the user says something like "remind me in X minutes about YYY":
  1. Call cronjob with action=create, name="Remind YYY", schedule="Xm", prompt="YYY"
  2. Then reply: "Reminder set for YYY in X minutes"
Do NOT ask how/when/frequency.

Schedule format examples:
- "5m" or "30m" = once after a delay (minutes/hours/days)
- "every 2h" or "every 1d" = repeat at fixed intervals
- "0 9 * * *" = cron expression (daily at 9:00)

Results are automatically delivered to this chat — you do NOT need to provide a chat_id.`,
  ].join('\n');
}

// ─── Tool Search helper (resolveModelContextLength moved to model-resolver.ts) ───

// ─── Factory ───

export function createAgentFactory(
  services: AgentFactoryServices,
  factoryOptions: AgentFactoryOptions = {},
): AgentFactory {
  const {
    toolRegistry,
    skillRegistry,
    defaultModel,
    memoryRetriever,
    personaStore,
    agentManager,
    computerUseHost,
  } = services;
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
    onFileServeApproved: factoryOptions.onFileServeApproved,
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

      // ── Model resolution (extracted to model-resolver.ts) ──
      const resolvedModel = resolveModel({
        explicitModel: options?.model,
        agentConfig,
        servicesDefaultModel: defaultModel,
        config: configRef.current,
        reasoningLevelOverride: options?.reasoningLevel,
      });
      const {
        model,
        modelProvider,
        modelId,
        cacheProfile,
        thinkingLevel,
        fallbackModels,
        contextWindow,
      } = resolvedModel;

      // ── Base tools (will be piped through assembleAgentTools below) ──
      let tools = options?.tools ?? toolRegistry.listAsAgentTools();

      if (agentConfig && !options?.tools) {
        tools = agentManager!.resolveTools(agentConfig);
      }

      let systemPrompt =
        options?.systemPrompt ?? buildDefaultSystemPrompt(configRef.current.uiLanguage);

      if (agentConfig && !options?.systemPrompt) {
        // Empty agent prompt → no override layer. The PromptManager base
        // layer (Task Execution, Memory, cronjob, ...) is the system default;
        // falling back to the legacy built-in prompt here would duplicate it.
        systemPrompt = agentConfig.system_prompt?.trim() ? agentConfig.system_prompt : '';
      }

      // Render template variables in agent system_prompt
      if (promptManager && agentConfig && !options?.systemPrompt) {
        const renderedAgent = promptManager.renderTemplate(systemPrompt, {
          agent_name: agentConfig.name ?? '',
          agent_id: agentConfig.id ?? '',
          // NOTE: no `current_time` here — dynamic dates are injected per-turn
          // into the LAST user message by context-transform.ts instead. Keeping
          // the system prompt byte-stable preserves provider prefix caching and
          // avoids UTC-vs-local timezone mismatches (toISOString is UTC).
          channel: options?.channel ?? 'unknown',
          ui_language: configRef.current.uiLanguage ?? 'zh-CN',
        });
        // Empty content → PromptManager.buildAgentLayer skips it (falsy check),
        // so no override layer is registered for blank prompts.
        promptManager.registerAgentOverride(agentConfig.id, renderedAgent);
        systemPrompt = renderedAgent;
      }

      // ── Skill activation (extracted to skill-activator.ts) ──
      const activation = activateSkill(options?.message ?? '', options?.sessionId ?? 'default', {
        skillRegistry,
        approvalGate,
        logger,
        getServices: getServices
          ? () =>
              getServices()
                ? { skillMetricsService: getServices()!.skillMetricsService }
                : undefined
          : undefined,
      });
      const { compiled } = activation;
      const resolvedSkillScope: ResolvedSkillScope = activation.scope;
      if (options) options.message = activation.cleanMessage;
      if (compiled) {
        logger?.info(
          {
            skillScope: resolvedSkillScope,
            hasPromptLayers: !!compiled.promptLayers?.length,
            allowedTools: compiled.allowedTools,
          },
          '[agent-factory] skill context applied to agent',
        );
      }

      // Assemble final system prompt via PromptManager (v5)
      // Skip when caller provided an explicit systemPrompt override (e.g. cron delivery)
      // Effective tools profile for this turn (skill override > explicit > global).
      // Computed before prompt assembly — used by the catalog filter inside the
      // assembly block AND by the runtime policy scope / tool pipeline below.
      const skillProfile = compiled?.toolsProfile as ToolProfileId | undefined;
      const globalProfile =
        defaultToolsProfile ?? configRef.current.tools.toolsProfile ?? 'standard';
      const effectiveProfile: ToolProfileId =
        options?.toolsProfileOverride ?? skillProfile ?? globalProfile;
      // P1: skill strict tool surface — replaces the profile baseline in the
      // pipeline filter and the runtime one-line catalog.
      const skillToolsStrict = compiled?.toolsSurfaceStrict === true;
      const skillAllowedTools = compiled?.allowedTools;
      const skillDeniedTools = compiled?.deniedTools;
      // P4: per-turn intent narrowing — only when NO skill owns the turn
      // (strict mode replaces it entirely; skill-activated turns are already
      // domain-scoped by the skill itself).
      const intentNarrowingEnabled =
        (configRef.current.tools.intentNarrowing ?? 'auto') !== 'off';
      const intentDomain =
        !compiled && intentNarrowingEnabled
          ? detectIntentDomain(options?.message ?? '')?.domain
          : undefined;

      let promptAssembly: ReturnType<PromptManager['assemble']> | undefined;
      if (promptManager && !options?.systemPrompt) {
        // Gather L1 metadata for skills catalog
        let availableSkills: PromptAssemblyOptions['availableSkills'];
        if (skillRegistry?.isLoaded()) {
          const allSkills = skillRegistry.getSkills();
          if (allSkills.length > 0) {
            availableSkills = allSkills.map((s) => ({
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
        const isTeamMode =
          (teamState?.enabled ?? configRef.current.smart_agent_team.enabled) &&
          !options?.isChildAgent;
        const teamModeMaxChildren =
          teamState?.config.max_children ?? configRef.current.smart_agent_team.max_children ?? 4;

        // Config switch: providers without prompt caching can disable the
        // skills/tools catalog layers to save per-turn tokens (T2).
        const catalogsEnabled = configRef.current.tools.systemPromptCatalogs !== false;

        // One-line tool index for the system prompt (pi-style). Uses the
        // pre-pipeline tool set — names are stable across the pipeline, so
        // the snippets remain accurate for index purposes only.
        // The catalog is filtered by the EFFECTIVE tools profile so it lists
        // only tools this turn can actually execute — otherwise the model may
        // try to call profile-denied tools (wasted cycles) and every request
        // pays catalog tokens for unusable entries.
        let availableTools: Array<{ name: string; snippet: string }> | undefined;
        if (catalogsEnabled) {
          // P1: strict mode narrows the catalog to the skill-allowed surface;
          // otherwise the profile baseline applies.
          let catalogCandidates: any[];
          if (skillToolsStrict) {
            const strictAllowed = new Set(skillAllowedTools ?? []);
            for (const d of skillDeniedTools ?? []) strictAllowed.delete(d);
            catalogCandidates = tools.filter(
              (t: any) => strictAllowed.has(t.name) || STRICT_FORCED_CORE_TOOLS.has(t.name),
            );
          } else {
            const allowedCatalogTools = PROFILE_TOOLS[effectiveProfile] || PROFILE_TOOLS.standard;
            catalogCandidates =
              allowedCatalogTools[0] === '*' || effectiveProfile === 'full'
                ? tools
                : tools.filter(
                    (t: any) => allowedCatalogTools.includes(t.name) || t.name === 'computer_use',
                  );
          }
          availableTools =
            catalogCandidates.length > 0
              ? catalogCandidates
                  .map((t: any) => ({ name: String(t.name ?? ''), snippet: toolOneLineSnippet(t) }))
                  .filter((t) => t.name.length > 0)
              : undefined;
        }

        promptAssembly = promptManager.assemble({
          agentId: options?.agentId ?? agentConfig?.id,
          availableSkills,
          availableTools: availableTools && availableTools.length > 0 ? availableTools : undefined,
          activeSkillLayers: compiled?.promptLayers,
          isChildAgent: options?.isChildAgent,
          childTaskDescription: options?.childTaskDescription,
          uiLanguage: configRef.current.uiLanguage,
          channel: options?.channel,
          isTeamMode,
          teamModeMaxChildren,
          includeCatalogs: catalogsEnabled,
          responseLanguage: resolveResponseLanguage(configRef.current),
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
          logger?.info(
            { sessionId: sessionKey },
            'Skill compliance reinforcement injected into system prompt',
          );
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
          turnContext.activatedSkillName =
            activation.activatedSkillNames ?? activation.scope.scopeKey;
          turnContext.activatedSkillId = activation.scope.scopeKey;
          logger?.info(
            { scopeKey: activation.scope.scopeKey, skillNames: turnContext.activatedSkillName },
            '[agent-factory] skill activation names resolved',
          );
        } else {
          turnContext.effectiveMessage = undefined;
          turnContext.activatedSkillName = undefined;
          turnContext.activatedSkillId = undefined;
        }
      }

      // Initialize offloadStore for context offloading (P0)
      const offloadCfg = configRef.current.memory.offloading;
      const offloadBaseDir = offloadCfg?.refDir || path.dirname(configRef.current.database.path);
      const offloadStore = offloadCfg?.enabled ? new OffloadStore(offloadBaseDir) : undefined;

      // Initialize Mermaid canvas for task graph tracking (P1)
      const mermaidCanvasCfg = configRef.current.memory.mermaidCanvas;
      const mermaidCanvas = mermaidCanvasCfg?.enabled
        ? offloadStore && sessionId
          ? MermaidCanvas.fromRecords(offloadStore.getSessionRecords(sessionId))
          : new MermaidCanvas()
        : undefined;
      // Lazy phase tagger (initialized fire-and-forget in afterToolCall)
      let phaseTagger: MermaidPhaseTagger | undefined;

      const effectiveShellMode = _shellEnabled
        ? shellModeForProfile(effectiveProfile)
        : ('read-only' as const);
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
        policyMode: configRef.current.policy?.mode ?? 'balanced',
      };

      // ── Tool pipeline (extracted to tool-pipeline.ts) ──
      // bridgeRegistry is resolved here because the desktop bridge reminder
      // (in transformContext) also needs it.
      const bridgeRegistry = getServices?.()?.desktopBridgeRegistry;

      const toolPipelineResult = assembleAgentTools({
        explicitTools: options?.tools,
        toolRegistry,
        agentConfig,
        agentManager,
        config: configRef.current,
        chatId,
        channel: options?.channel,
        sessionId,
        runtimeAgentId,
        effectiveProfile,
        effectiveShellMode,
        runtimePolicyScope,
        skillToolsStrict,
        skillAllowedTools,
        skillDeniedTools,
        intentDomain,
        computerUseAllowed: options?.computerUseAllowed,
        modelProvider,
        modelId,
        modelInput: Array.isArray(model?.input) ? model.input : ['text'],
        contextLength: contextWindow,
        extraTools: options?.extraTools,
        computerUseHost,
        computerUseImageSender: options?.computerUseImageSender,
        feishuClient: feishuClient,
        policyCenter,
        approvalGate,
        getServices,
        orchestratorFactory,
        createChildAgent: ((cfg, task, childOpts) => {
          const childTools = agentManager!
            .resolveTools(cfg)
            .filter((t: any) => t.name !== 'spawn_agent');
          return factory.create({
            agentId: cfg.id,
            systemPrompt: cfg.system_prompt,
            tools: childTools,
            message: task,
            sessionId: childOpts.sessionId,
            toolsProfileOverride: cfg.tools.profile,
            policyScope: childOpts.policyScope,
            policyAgentId: childOpts.agentId,
            computerUseAllowed: childOpts.policyScope?.computerUseEnabled,
            isChildAgent: true,
            childTaskDescription: task,
          });
        }) as CreateChildAgent,
        cronServiceFactory: factoryOptions.cronServiceFactory,
        agentName: agentConfig?.name,
        agentId: options?.agentId,
        logger,
      });

      tools = toolPipelineResult.tools;

      // P5: per-turn tool-surface health stats (debug log + in-memory window).
      recordToolSurfaceTurn({
        sessionId: sessionId ?? 'default',
        profile: effectiveProfile,
        skillStrict: skillToolsStrict,
        intentDomain,
        visibleCount: tools.length,
        deferredCount: toolPipelineResult.toolSearchAssembly?.deferredCount,
        toolSearchActivated: toolPipelineResult.toolSearchAssembly?.activated,
        at: Date.now(),
      });
      logger?.debug(
        {
          sessionId,
          profile: effectiveProfile,
          skillStrict: skillToolsStrict,
          intentDomain,
          visibleTools: tools.length,
          deferred: toolPipelineResult.toolSearchAssembly?.deferredCount,
        },
        'tool surface stats',
      );

      // Declared before construction so the transform closure can write
      // compression results back to state. The transform only runs during
      // agent.prompt(), by which time `agent` is assigned.
      let agent: Agent;
      agent = new Agent({
        initialState: {
          systemPrompt,
          model,
          tools,
          thinkingLevel: thinkingLevel as import('@earendil-works/pi-ai').ThinkingLevel,
          messages: (options?.historyMessages ??
            []) as import('@earendil-works/pi-agent-core').AgentMessage[],
        },
        streamFn: (() => {
          const baseStreamFn = createRetryingStreamFn(streamSimple as any, {
            maxRetries: options?.maxRetries ?? configRef.current.agent?.max_retries ?? 2,
          }) as any;
          // HTTP-level first-response timeout: bounds connect + response-headers
          // wait so a provider that accepts the connection but never responds
          // fails fast into the retry wrapper instead of hanging until the turn
          // watchdog (turn_timeout_sec) fires. Streaming bodies are NOT cut off
          // mid-generation — the OpenAI-compatible SDK applies the timeout only
          // until the response starts. 0 disables.
          const requestTimeoutMs = configRef.current.agent?.request_timeout_ms ?? 0;
          if (requestTimeoutMs <= 0) return baseStreamFn;
          return ((model: any, ctx: any, opts: any) =>
            baseStreamFn(model, ctx, { timeoutMs: requestTimeoutMs, ...opts })) as any;
        })(),
        maxToolCycles: configRef.current.agent?.max_tool_cycles,
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
          staticContextTokens: estimateStaticContextTokens(systemPrompt, tools),
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
          // M4: persist successful compression back to the agent transcript so
          // later turns (and end-of-turn persistence) start from the summary
          // instead of re-compressing the same old messages every call.
          onCompressed: (compressed) => {
            agent.state.messages = compressed;
          },
          logger,
        }),
        sessionId,
        getApiKey: (provider: string) => resolveProviderApiKey(configRef.current, provider),
        fallbackModels: fallbackModels.length > 0 ? fallbackModels : undefined,
        afterToolCall: async (context) => {
          const result = context.result;

          // Auto-reload skill registry when a SKILL.md is written via file_write.
          // Agents may use file_write instead of skill_create, so we detect writes
          // to skills/*/SKILL.md and reload so the new skill is immediately active.
          if (
            skillRegistry &&
            context.toolCall.name === 'file_write' &&
            result &&
            !context.isError
          ) {
            try {
              const fp = (context.args as Record<string, unknown>)?.filePath as string | undefined;
              if (fp && /(?:^|[\\/])skills[\\/][^\\/]+[\\/]SKILL\.md$/i.test(fp)) {
                await skillRegistry.load('./skills');
                logger?.info(
                  { filePath: fp },
                  'Skill registry auto-reloaded after file_write to SKILL.md',
                );
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
              {
                name: context.toolCall.name,
                args: (context.args as Record<string, unknown>) ?? {},
              },
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
          let phaseTaggerPromise: Promise<void> | undefined;
          const ensurePhaseTagger = (): MermaidPhaseTagger | undefined => {
            if (!logger) return undefined;
            if (!phaseTagger && !phaseTaggerPromise) {
              const summaryConfig = buildSummaryLLMConfig(configRef.current);
              // Single-flight: compaction runs per tool result, and until this
              // resolves `phaseTagger` is still undefined — without the guard a
              // burst of tool calls created one LLM client each.
              phaseTaggerPromise = createDistillerLLM(summaryConfig, logger)
                .then((llm) => {
                  phaseTagger = new MermaidPhaseTagger(llm, logger);
                })
                .catch((err) => {
                  logger.warn(
                    { err },
                    'Failed to create Mermaid phase-tagger LLM — phase tagging will be unavailable',
                  );
                });
            }
            return phaseTagger;
          };

          // Check if context offloading is enabled
          const offloadCfg = configRef.current.memory.offloading;
          if (offloadCfg?.enabled && offloadStore && sessionId) {
            if (!result) return undefined;

            // Normalize content to TextBlock array format
            const formatted =
              typeof result.content === 'string'
                ? [{ type: 'text' as const, text: result.content }]
                : Array.isArray(result.content)
                  ? result.content
                  : [{ type: 'text' as const, text: String(result.content ?? '') }];

            // Read existing records to determine the next sequence number
            const records = offloadStore.getSessionRecords(sessionId);
            const seq = records.length + 1;

            const summary = summarizeToolResult(
              context.toolCall.name,
              context.args,
              formatted,
              context.isError,
            );
            // Archive full result to offload store (for context trimming recovery)
            const record = offloadStore.writeToolResult(
              sessionId,
              seq,
              context.toolCall.name,
              context.args,
              formatted,
              context.isError,
              summary,
            );
            const resultChars = textBlockChars(formatted);
            // Large tool results are archived above and replaced in context
            // with a summary + archive path (file_read restores the full
            // output). DeepSeek's cache profile compacts earlier (4K chars)
            // because repeated large payloads are expensive against its
            // prefix cache; the default profile compacts at 20K chars so a
            // single oversized result does not crowd out the answer budget.
            const compactThreshold = cacheProfile === 'deepseek' ? 4000 : 20000;
            const shouldCompactLargeResult =
              resultChars > compactThreshold &&
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

            if (shouldCompactLargeResult) {
              const ref = `${offloadStore.getSessionDirPath(sessionId)}/${record.refPath}`;
              logger?.info(
                {
                  sessionId,
                  toolName: context.toolCall.name,
                  charsBefore: resultChars,
                  refPath: record.refPath,
                },
                'Large tool result compacted and archived',
              );
              return {
                ...result,
                content: [
                  {
                    type: 'text' as const,
                    text: `[Tool result compressed]\n${summary}\n\nFull result archived at: ${ref}\nUse file_read on that path for the original output.`,
                  },
                ],
                details: {
                  ...(typeof result.details === 'object' && result.details !== null
                    ? result.details
                    : {}),
                  offloadRef: ref,
                  originalChars: resultChars,
                  compactedFor: cacheProfile === 'deepseek' ? 'deepseek-cache' : 'large-result',
                },
              };
            }

            // Return full result unchanged when it is small enough or the tool
            // needs its full payload in context (web_search/web_fetch).
            return { ...result, content: formatted };
          }

          // P1: Mermaid canvas update (when offloading is disabled)
          if (mermaidCanvasCfg?.enabled && mermaidCanvas && result) {
            const fmt =
              typeof result.content === 'string'
                ? [{ type: 'text' as const, text: result.content }]
                : Array.isArray(result.content)
                  ? result.content
                  : [{ type: 'text' as const, text: String(result.content ?? '') }];
            const toolSummary = summarizeToolResult(
              context.toolCall.name,
              context.args,
              fmt,
              context.isError,
            );
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
              channel: options?.channel as BeforeToolCallDeps['channel'],
              senderId: options?.senderId,
              logger,
            })
          : undefined,

        // ── P3: prepareNextTurnWithContext hook (turn counter + reflection injection) ──
        prepareNextTurnWithContext: async (ctx, _signal) => {
          if (!sessionId) return undefined;

          try {
            // Count tool calls and spawn activity from this turn
            const toolCallCount = ctx.toolResults?.length ?? 0;
            const didSpawn = ctx.toolResults?.some((tr) => tr.toolName === 'spawn_agent') ?? false;

            turnCounter.recordTurn(sessionId, { toolCallCount, didSpawn });
            logger?.debug(
              { sessionId, toolCallCount, didSpawn },
              '[P3] prepareNextTurn: turn recorded',
            );

            // Only evaluate reflection prompts when team mode is active
            const teamState = teamModeStore.get(sessionId);
            const isTeamActive =
              teamState?.enabled ?? configRef.current.smart_agent_team?.enabled ?? false;
            if (!isTeamActive) {
              logger?.debug(
                { sessionId, isTeamActive },
                '[P3] prepareNextTurn: team mode not active, skip',
              );
              return undefined;
            }

            // Capability gate: only steer toward orchestration when spawn_agent
            // is in this turn's assembled surface. standard carries it deferred
            // (discoverable via tool_search); restricted never has it — injecting
            // a reminder for a tool the model cannot call is pure token noise.
            if (!hasSpawnCapability(tools)) {
              logger?.debug(
                { sessionId, profile: effectiveProfile },
                '[P3] prepareNextTurn: spawn_agent not in surface, skip reflection',
              );
              return undefined;
            }

            // ── Plan-only detection: model output <plan> text but called 0 tools ──
            // The model described a plan in free text but didn't execute it.
            // This catches the anti-pattern where the agent outputs <plan>...</plan>
            // and then stops without taking any action.
            let reflection = turnCounter.evaluate(sessionId, toolCallCount);

            if (!reflection && toolCallCount === 0) {
              // Check if the just-completed assistant message contains a <plan> block
              const assistantText = (ctx.message as any)?.content;
              const hasPlanText =
                typeof assistantText === 'string'
                  ? assistantText.includes('<plan>')
                  : Array.isArray(assistantText)
                    ? assistantText.some(
                        (block: any) =>
                          block?.type === 'text' &&
                          typeof block?.text === 'string' &&
                          block.text.includes('<plan>'),
                      )
                    : false;

              if (hasPlanText) {
                logger?.info(
                  { sessionId },
                  '[P3] prepareNextTurn: plan-only detected (model output plan but no tools called)',
                );
                reflection = planOnlyReflection();
                // Update debounce so we don't re-inject immediately
                const state = turnCounter.get(sessionId);
                state.lastReflectionAt = Date.now();
              }
            }

            if (!reflection) {
              const state = turnCounter.get(sessionId);
              logger?.debug(
                {
                  sessionId,
                  serialToolCalls: state.serialToolCalls,
                  turnsSinceLastSpawn: state.turnsSinceLastSpawn,
                },
                '[P3] prepareNextTurn: no reflection triggered',
              );
              return undefined;
            }

            logger?.info(
              { sessionId, reflectionLen: reflection.length },
              '[P3] prepareNextTurn: injecting reflection',
            );

            // Inject reflection as a user message at the END of the context
            // (not in systemPrompt). This preserves the prefix cache — only the
            // new trailing message causes a cache miss, not the entire context.
            return {
              context: {
                ...ctx.context,
                messages: [
                  ...ctx.context.messages,
                  {
                    role: 'user',
                    content: [{ type: 'text', text: reflection }],
                    timestamp: Date.now(),
                  } as any,
                ],
              },
            };
          } catch {
            // Contract: must not throw — prevent hook failure from crashing the agent loop
            logger?.debug('Transform context failed in afterToolCall — returning undefined');
            return undefined;
          }
        },
      });

      agent.ohmyagent_agentName = agentConfig?.name;

      return agent;
    },

    resolveApproval(requestId: string, decision: ApprovalDecisionType): boolean {
      return pendingApprovals.resolve(requestId, decision);
    },

    resolveFirstPendingApproval(sessionKey: string, decision: ApprovalDecisionType): boolean {
      return pendingApprovals.resolveFirstForSession(sessionKey, decision);
    },

    resolveAllPendingApprovals(sessionKey: string, decision: ApprovalDecisionType): number {
      return pendingApprovals.resolveAllForSession(sessionKey, decision);
    },

    rejectPendingApprovals(sessionKey: string, reason?: 'stopped_by_user' | 'steered'): number {
      return pendingApprovals.rejectAllForSession(sessionKey, approvalRequestRepo, reason);
    },

    resolveUserQuestion(requestId: string, answer: string): boolean {
      return factoryOptions.userQuestionStore?.resolve(requestId, answer) ?? false;
    },

    resolveFirstPendingQuestion(sessionKey: string, answer: string): boolean {
      const store = factoryOptions.userQuestionStore;
      if (!store) return false;
      const requestId = store.findPendingForSession(sessionKey);
      if (!requestId) return false;
      return store.resolve(requestId, answer);
    },

    rejectPendingQuestions(sessionKey: string): number {
      return (
        factoryOptions.userQuestionStore?.rejectAllForSession(
          sessionKey,
          'User sent a new message',
        ) ?? 0
      );
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
