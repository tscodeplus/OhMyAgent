// ---------------------------------------------------------------------------
// Global type definitions for OhMyAgent
// ---------------------------------------------------------------------------

import type { Logger } from 'pino';
import type Database from 'better-sqlite3';
import type { AgentFactory } from '../agent/agent-factory.js';
import type { AgentService } from '../agent/agent-service.js';
import type { AgentManager } from '../agent/agent-manager.js';
import type { ChannelManager } from '../channel/channel-manager.js';
import type { CommandRegistry } from '../commands/command-registry.js';
import type { ExtensionManager } from '../extensions/extension-manager.js';
import type { MemoryRetriever } from '../memory/memory-retriever.js';
import type { MemoryWriter } from '../memory/memory-writer.js';
import type { MemorySummarizer } from '../memory/memory-summarizer.js';
import type { SessionRepository } from '../memory/repositories/session-repository.js';
import type { MessageRepository } from '../memory/repositories/message-repository.js';
import type { EpisodeRepository } from '../memory/repositories/episode-repository.js';
import type { ToolRunRepository } from '../memory/repositories/tool-run-repository.js';
import type { FeishuClient } from '../../extensions/channel-feishu/feishu-client.js';
import type { FeishuRouter } from '../../extensions/channel-feishu/feishu-router.js';
import type { FeishuWSClient } from '../../extensions/channel-feishu/feishu-ws-client.js';
import type { ChatQueue } from '../../extensions/channel-feishu/chat-queue.js';
import type { AgentTool } from '../pi-mono/agent/types.js';
import type { ResolvedSkill } from '../skills/skill-router.js';
import type { CronService } from '../cron/service.js';
import type { CronDeliveryRegistry } from '../cron/delivery-registry.js';
import type { FastifyInstance } from 'fastify';
import type { VisionBridgeConfig } from '../vision-bridge/vision-bridge-types.js';
import type { AgentConfig } from '../agent/config-types.js';
import type {
  OpenAICompletionsCompat,
  OpenAIResponsesCompat,
} from '../pi-mono/ai/types.js';

// ---------------------------------------------------------------------------
// 1. AppConfig
// ---------------------------------------------------------------------------

export interface CustomModelConfig {
  id: string;
  name: string;
  api: string;
  reasoning?: boolean;
  /** Reasoning effort level. Provider-specific values accepted (e.g. "low", "high", "max"). */
  reasoningLevel?: string;
  contextWindow?: number;
  maxTokens?: number;
  /** Supported input modalities. Defaults to ["text"] if not set. */
  input?: ("text" | "image")[];
  cost?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /** Provider compatibility overrides for OpenAI-compatible custom models. */
  compat?: OpenAICompletionsCompat | OpenAIResponsesCompat;
}

export interface CustomProviderConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  models: CustomModelConfig[];
}

/** Shared model config for all memory aux LLM tasks. */
export interface MemoryAuxModels {
  /** Primary model in "provider/model-id" format. */
  primary?: string;
  /** Fallback models tried in order. */
  fallback_models?: string[];
}

/** v9: Auto context compression configuration. Follows pi coding-agent conventions. */
export interface AutoCompressConfig {
  /** Enable automatic context compression. Default true. */
  enabled: boolean;
  /** Token reserve for the summarization LLM output. Default 16384. */
  reserveTokens: number;
  /** Token budget for recent messages to keep uncompressed. Default 20000. */
  keepRecentTokens: number;
  /** Optional compression model. Falls back to primary model when unset. */
  model?: {
    primary?: string;
    fallback_models?: string[];
  };
}

export interface AppConfig {
  logging: {
    /** Pino log level: fatal | error | warn | info | debug | trace. Default: info. */
    level: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  };
  uiLanguage: 'zh-CN' | 'en';
  /** Show tool execution indicators in channel replies (🔧 name... / ✓ name). Default: true. */
  showToolCalls: boolean;
  feishu: {
    /** When false, the Feishu channel is disabled even if credentials are configured. Default: true. */
    enabled: boolean;
    appId: string;
    appSecret: string;
    verificationToken: string;
    encryptKey: string;
    wsEnabled: boolean;
  };
  piAi: {
    provider: string;
    model: string;
    reasoningModel: string;
    apiKey: string;
    baseUrl?: string;
  };
  /** Custom provider definitions from custom_providers.yaml. */
  customProviders?: CustomProviderConfig[];
  /** Per-provider API keys and base URLs. Keyed by provider name (e.g. "deepseek", "xiaomi"). */
  providerKeys: Record<string, { apiKey?: string; baseUrl?: string }>;
  /** Fallback models tried in order when the primary model fails. Format: "provider/model-id" */
  fallbackModels: string[];
  /** Default reasoning level applied when not specified per-model. Any string accepted. */
  defaultReasoningLevel?: string;
  /** Vision bridge: analyze images via a vision-capable model before sending to text-only models. */
  /** @deprecated — moved to multimodal.image.bridge */
  visionBridge?: VisionBridgeConfig;
  embedding: {
    baseUrl: string;
    apiKey: string;
    model: string;
    dimension: number;
    /** Max chars per embedding input; longer text is truncated. Default 8000. */
    maxInputChars: number;
  };
  database: {
    path: string;
  };
  rateLimit: {
    webhookMaxRequests: number;
    webhookWindowMs: number;
  };
  tools: {
    shellEnabled: boolean;
    defaultTimeoutMs: number;
    maxOutputLength: number;
    /** v2: Tool profile for first-layer tool gating. */
    toolsProfile: ToolProfileId;
    /** v2: Execution mode. Maps old strict->safe, balanced->balanced, relaxed->trusted. */
    shellExecMode: ExecMode;
    /** v2: Argument-aware allowlist. Format: "program" or "program:subcommand". */
    shellAllowlist: string[];
    /** @deprecated Use shellExecMode instead. */
    shellApprovalMode: 'strict' | 'balanced' | 'relaxed';
    /** @deprecated Use shellAllowlist instead. */
    shellApprovalWhitelist: string[];
    shellApprovalTimeoutSec: number;
    shellApprovalTimeoutAction: 'deny' | 'allow';
    fileRead: {
      allowedRoots: string[];
      deniedPatterns: string[];
    };
  };
  memory: {
    autoRecall: boolean;
    /** "first" = only on first message per session, "every" = before every LLM call. */
    autoRecallFrequency?: 'first' | 'every';
    autoCapture: boolean;
    recallTopK: number;
    /** Minimum retrieval score. Default 0.01 (RRF-scale). */
    recallMinScore: number;
    captureMaxChars: number;
    summarizeInterval: number;
    outputLanguage: string;
    /** Temporal decay half-life in days. 0 = disabled. */
    decayHalfLifeDays: number;
    /** Max entries in embedding cache (SQLite table). */
    embeddingCacheMaxEntries: number;
    /** Timeout for a single query embedding call before retrieval falls back to text/terms. */
    queryEmbeddingTimeoutMs: number;
    /** Intent-aware query planner (commonality/attribute coverage retrieval). */
    queryPlanner: {
      enabled: boolean;
      commonalityCoverage: boolean;
      speakerBoost: number;
      perSlotFloor: number;
      maxEntities: number;
      llm: { enabled: boolean };
    };
    /** Recall-depth knobs; larger surfaces weak-margin hits before rerank. */
    recall: {
      prefilterMultiplier: number;
      prefilterMin: number;
      mergeCandidateMultiplier: number;
    };
    /** Score-gated LLM query expansion (opt-in; uses memory_aux_models). */
    expansion: {
      enabled: boolean;
      minQueryLength: number;
      minScoreTrigger: number;
      maxVariants: number;
    };
    hygiene: {
      enabled: boolean;
      retentionDays: number;
    };
    embeddingCircuitBreaker: {
      failureThreshold: number;
      cooldownSec: number;
    };
    offloading?: {
      enabled: boolean;
      maxRefsInContext: number;
      preserveInMessages: number;
      refDir: string;
      retentionDays: number;
    };
    autoCompress?: AutoCompressConfig;
    persona?: {
      enabled: boolean;
      distillThreshold: number;
      minDistillIntervalHours: number;
    };
    mermaidCanvas?: {
      enabled: boolean;
      injectFormat: 'summary' | 'full';
      phaseTagging: 'auto' | 'llm' | 'off';
      maxNodesInContext: number;
    };
    sceneClustering?: {
      enabled: boolean;
      windowDays: number;
      minMemories: number;
    };
    maintenance?: {
      enabled: boolean;
      intervalMs: number;
      jobs: {
        memory_hygiene: boolean;
        embedding_backfill: boolean;
        embedding_cache_trim: boolean;
        entity_backfill: boolean;
        persona_consistency: boolean;
        offload_hygiene: boolean;
        scene_cluster: boolean;
        memory_doctor: boolean;
      };
    };
  };
  cron: {
    enabled: boolean;
    tickIntervalMs: number;
    dataDir: string;
    executionTimeoutMs: number;
    maxConcurrency?: number;
  };
  webSearch: {
    providerOrder: string[];
    tavilyApiKey?: string;
    exaApiKey?: string;
    baiduApiKey?: string;
    anysearchApiKey?: string;
    searchTimeoutMs: number;
    maxResults: number;
  };
  extensions: {
    directory: string;
  };
  telegram?: {
    /** When false, the Telegram channel is disabled even if a bot token is configured. Default: false. */
    enabled: boolean;
    botToken: string;
    mode: 'polling' | 'webhook';
    webhookUrl?: string;
    webhookPort: number;
    webhookSecret?: string;
    allowedUsers: string[];
    allowedGroups: string[];
    proxyUrl?: string;
    streamMode: 'edit' | 'send';
    textLimit: number;
    streamIntervalMs: number;
  };
  wechat?: {
    enabled: boolean;
    botToken?: string;
    apiBase: string;
    cursorDir: string;
    textLimit: number;
    aesKey?: string;
    allowedUsers: string[];
  };
  qq?: {
    enabled: boolean;
    appId: string;
    clientSecret: string;
    sandbox: boolean;
    allowedUsers: string[];
    allowedGroups: string[];
    textLimit: number;
  };
  /** Shared model config for all memory background LLM tasks. */
  memoryAuxModels?: MemoryAuxModels;
  /** Agent definitions. When loaded from config.yaml, this replaces agents.yaml. */
  agents?: AgentConfig[];
  /** Computer Use: remote/local desktop control. */
  computerUse?: ComputerUseConfig;
  /** Footer display options. Applies to all channels. */
  footer: FooterConfig;

  // -------------------------------------------------------------------------
  // v4 configuration sections (all optional, backward-compatible)
  // -------------------------------------------------------------------------

  /** v4: Unified policy center configuration. */
  policy?: {
    mode?: 'safe' | 'balanced' | 'permissive';
    path?: {
      readRoots?: string[];
      writeRoots?: string[];
      deniedPatterns?: string[];
    };
    approval?: {
      timeoutSec?: number;
      timeoutAction?: 'deny' | 'allow';
    };
  };
  /** v4: Orchestrator configuration. */
  orchestrator?: {
    enabled?: boolean;
    maxChildAgents?: number;
    allowGrandchildren?: boolean;
    inheritApprovals?: boolean;
    inheritAppApprovals?: boolean;
  };
  /** v7: Agent Team mode global configuration. */
  smart_agent_team: SmartAgentTeamConfig;
  /** v4: Multimodal runtime configuration. */
  multimodal?: {
    enabled?: boolean;
    attachments?: {
      cacheDir?: string;
      autoParseImages?: boolean;
      autoParseDocuments?: boolean;
      autoTranscribeAudio?: boolean;
    };
    /** v4 Phase 4: Image handling configuration. */
    image?: {
      /** Image processing mode:
       *   "native_first" — pass images to the model natively if it supports them (default)
       *   "bridge_only"  — always bridge images to text via VisionBridge
       *   "native_only"  — always pass images natively, never bridge
       */
      mode?: 'native_first' | 'bridge_only' | 'native_only';
      /** Vision bridge configuration (merged from visionBridge). */
      bridge?: {
        enabled?: boolean;
        modelRef?: string;
        apiKey?: string;
        baseUrl?: string;
        timeoutMs?: number;
        maxNoteChars?: number;
        maxCacheEntries?: number;
      };
    };
    /** v4: Image generation configuration. */
    imageGeneration?: {
      enabled: boolean;
      modelRef?: string;
      outputDir: string;
      maxPromptChars: number;
    };
    /** v4: Video generation configuration. */
    videoGeneration?: {
      enabled: boolean;
      modelRef?: string;
      outputDir: string;
      maxPromptChars: number;
      defaultSeconds?: string;
      defaultSize?: string;
    };
    /** v5 P2: Speech-to-text configuration. */
    stt?: {
      enabled?: boolean;
      language?: string;
      autoTranscribe?: boolean;
      maxDurationSec?: number;
      maxFileSizeMb?: number;
      /** Providers in priority order (fallback chain). */
      providers?: Array<{
        id: string;
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        endpoint?: string;
        requestType?: 'multipart' | 'json';
        audioFieldName?: string;
        languageFieldName?: string;
        responseTextField?: string;
        extraFields?: Record<string, string>;
        authPrefix?: string;
      }>;
    };
  };
  /** v4: Remote trigger targets for the remote_trigger tool. */
  remoteTriggers?: {
    targets?: Array<{
      id: string;
      name: string;
      url: string;
      method: 'POST' | 'PUT';
      headers?: Record<string, string>;
    }>;
  };
  /** v12: Tool Search — progressive tool disclosure. */
  toolSearch?: {
    enabled: 'auto' | 'on' | 'off';
    thresholdPct: number;
    searchDefaultLimit: number;
    maxSearchLimit: number;
  };
  /** Whether the first-run setup wizard has been completed. */
  setupWizardDone?: boolean;
}

// ---------------------------------------------------------------------------
// Agent Team configuration (v7)
// ---------------------------------------------------------------------------

export interface SmartAgentTeamConfig {
  enabled: boolean;
  max_children: number;
}

// ---------------------------------------------------------------------------
// Computer Use configuration
// ---------------------------------------------------------------------------

export interface ComputerUseConfig {
  enabled: boolean;
  provider?: 'auto' | 'ssh' | 'local' | 'node';
  allowedApps: string[];
  allowedAgents?: string[];
  approvalWhitelist: string[];
  ssh?: {
    host: string;
    user: string;
    keyPath: string;
    port: number;
    jumpHost: string;
    display: string;
    hostKeyChecking?: 'accept-new' | 'strict';
    knownHostsPath?: string;
  };
  node?: {
    url: string;
  };
  perPlatformProvider?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Footer display configuration
// ---------------------------------------------------------------------------

export interface FooterConfig {
  /** Show agent name in footer. Default: true. */
  showAgentName: boolean;
  /** Show model (provider/model-id) in footer. Default: true. */
  showModel: boolean;
  /** Show "Completed" status in footer (live messages). Default: true. */
  showCompleted: boolean;
  /** Show elapsed time in footer (live messages). Default: true. */
  showElapsed: boolean;
  /** Show token usage in footer. Default: true. */
  showUsage?: boolean;
  /** Show prompt cache hit rate in footer. Default: true. */
  showCacheHitRate?: boolean;
}

// ---------------------------------------------------------------------------
// 2. ApprovalGate and related types
// ---------------------------------------------------------------------------

export type PatternType = 'exact' | 'prefix' | 'program' | 'regex';
export type PolicyEffect = 'allow' | 'deny' | 'require_approval';
export type ShellApprovalMode = 'strict' | 'balanced' | 'relaxed';

/** v2: Execution mode replacing shellApprovalMode. */
export type ExecMode = 'safe' | 'balanced' | 'trusted';

/** v2: Tool profile for first-layer tool gating. */
export type ToolProfileId = 'minimal' | 'standard' | 'advanced' | 'full';

/** v2: Hardline blocklist entry — always blocked, no exceptions. */
export interface HardlinePatternEntry {
  pattern: string;
  type: 'exact' | 'prefix' | 'program' | 'regex';
  description: string;
}

/** v2: Result of hardline blocklist check. */
export type HardlineCheckResult =
  | { blocked: true; pattern: string; description: string }
  | { blocked: false };

/** v2: Dangerous command pattern for detection. */
export interface DangerousPatternEntry {
  category: string;
  pattern: string;
  description: string;
}

/** v2: Per-program safe/warn/denied subcommand classification. */
export interface ProgramPolicy {
  safe: string[];
  warn: string[];
  denied: string[];
  ref?: string;
}

/** v2: Result of command classification against SAFE_SUBSETS. */
export interface CommandClassification {
  program: string;
  subcommandLabel: string;
  level: 'safe' | 'warn' | 'denied' | 'unknown';
}

export type ApprovalDecisionType =
  | 'approve_once'
  | 'approve_session'
  | 'approve_always'
  | 'reject_once'
  | 'reject_always';
export type ApprovalDecision = 'approved' | 'rejected' | 'requires_approval';

export interface NormalizedShellCommand {
  raw: string;
  normalized: string;
  program: string;
  args: string[];
  containsSecrets: boolean;
}

export interface ApprovalRequest {
  kind: 'tool' | 'shell';
  toolName?: string;
  command?: NormalizedShellCommand;
  sessionKey: string;
  scope: 'global' | 'agent' | 'skill' | 'session';
  scopeKey?: string;
}

export interface ApprovalPolicy {
  id: string;
  scope: string;
  scopeKey: string;
  targetKind: string;
  patternType: PatternType;
  pattern: string;
  effect: PolicyEffect;
}

export interface ApprovalGate {
  evaluate(request: ApprovalRequest): Promise<ApprovalDecision>;
  /** Reason set by the last evaluation when it returns requires_approval. */
  lastRejectReason?: string;
  recordDecision(
    requestId: string,
    decision: ApprovalDecisionType,
    command?: string,
    sessionKey?: string,
    targetKind?: 'shell' | 'tool',
  ): Promise<void>;
  getPolicy(
    scope: string,
    target: string,
  ): Promise<ApprovalPolicy | null>;
  createPolicy?(input: {
    id: string;
    scope: string;
    scopeKey: string;
    targetKind: string;
    patternType: PatternType;
    pattern: string;
    effect: PolicyEffect;
  }): void;
}

// ---------------------------------------------------------------------------
// 3. ToolRegistry
// ---------------------------------------------------------------------------

export interface ToolRegistry {
  register(tool: AgentTool<any>): void;
  get(name: string): AgentTool<any> | undefined;
  list(): AgentTool<any>[];
  listAsAgentTools(): AgentTool<any>[];
  has(name: string): boolean;
  unregister(name: string): void;
  names(): string[];
}

// ---------------------------------------------------------------------------
// 4. MemoryStore and related types
// ---------------------------------------------------------------------------

export type MemoryScope = 'user' | 'chat' | 'session' | 'skill';
export type MemoryKind =
  | 'preference'
  | 'fact'
  | 'task'
  | 'device_state'
  | 'summary';
export type RetrievalSource = 'vector' | 'text' | 'fallback' | 'cosine';

export interface MemoryRecord {
  scope: MemoryScope;
  scopeKey: string;
  kind: MemoryKind;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface RetrievalResult {
  record: MemoryRecord;
  score: number;
  source: RetrievalSource;
}

export interface MemoryStore {
  write(
    record: MemoryRecord,
    generateEmbedding?: boolean,
  ): Promise<void>;
  writeBatch(records: MemoryRecord[]): Promise<void>;
  retrieve(
    query: string,
    queryEmbedding?: Float32Array,
  ): Promise<RetrievalResult[]>;
  summarizeSession(sessionKey: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// 5. SkillRegistry and related types
// ---------------------------------------------------------------------------

export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  triggers: string[];
  priority: number;
  enabled: boolean;
  author?: string;
  tags?: string[];
}

export interface ApprovalOverride {
  targetKind: 'tool' | 'shell';
  patternType: PatternType;
  pattern: string;
  effect: PolicyEffect;
}

export interface ToolsConfig {
  allowedTools: string[];
  deniedTools?: string[];
  toolConfigs?: Record<string, unknown>;
}

export interface SkillMemoryScope {
  type: 'session' | 'user' | 'global';
  key?: string;
  readPolicy: 'always' | 'on_demand' | 'never';
  writePolicy: 'always' | 'on_demand' | 'never';
}

export interface SkillMemoryPolicy {
  scopes: SkillMemoryScope[];
  captureEnabled?: boolean;
  recallEnabled?: boolean;
}

export interface LoadedSkill {
  manifest: SkillManifest;
  promptContent: string;
  tools: ToolsConfig;
  memoryPolicy: SkillMemoryPolicy;
  path: string;
}

export interface CompiledSkillContext {
  allowedTools: string[];
  deniedTools: string[];
  promptContent: string;
  memoryScopes: SkillMemoryScope[];
  approvalOverrides: Record<string, ApprovalOverride>;
}

export interface SkillRouterOptions {
  explicitIds?: string[];
  allowMerge?: boolean;
}

export interface SkillRegistry {
  load(dirPath: string): Promise<void>;
  resolve(message: string): ResolvedSkill[];
  compile(resolved: ResolvedSkill[]): CompiledSkillContext;
  getSkillById(id: string): LoadedSkill | undefined;
  getSkills(): LoadedSkill[];
  isLoaded(): boolean;
}

// ---------------------------------------------------------------------------
// 6. ReplyDispatcher
// ---------------------------------------------------------------------------

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  /** Prompt cache hit rate, 0..1. Undefined when provider exposes no cache stats. */
  cacheHitRate?: number;
}

export interface ReplyDispatcher {
  onStart(): void | Promise<void>;
  onTextDelta(delta: string): void;
  onReasoningDelta(delta: string): void;
  onToolStart(name: string, args: unknown, toolCallId?: string): void;
  onToolEnd(name: string, result: unknown, isError?: boolean, toolCallId?: string): void;
  /** Update the model name for footer display (for fallback tracking). */
  setModel(model: string): void;
  /** Update the agent name for footer display. */
  setAgentName(name: string): void;
  setApprovalStatus(status: string | null): void;
  setApprovalRecords(records: Array<{
    requestId: string;
    command: string;
    risk: 'low' | 'medium' | 'high';
    status: 'pending' | 'approved' | 'rejected';
    decision?: ApprovalDecisionType;
    reason?: string;
    updatedAt: number;
  }>, expanded: boolean): void;
  getReplyMessageId(): string | undefined;
  onComplete(usage?: Usage): void | Promise<void>;
  onError(error: Error): void | Promise<void>;
  /** Called when agent execution is aborted (e.g. via /stop). */
  onAborted(): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// 7. FeishuMessageContext
// ---------------------------------------------------------------------------

export interface FeishuMessageContext {
  accountId: string;
  chatId: string;
  threadId?: string;
  messageId: string;
  senderId: string;
  senderName?: string;
  text: string;
  replyToMessageId?: string;
  sessionKey: string;
}

// ---------------------------------------------------------------------------
// 8. AppServices
// ---------------------------------------------------------------------------

/**
 * Central services container assembled by bootstrap().
 *
 * All services are initialized during bootstrap and passed around as a
 * single object so that consumers don't need to know about individual
 * factory functions or construction order.
 */
export interface AppServices {
  config: AppConfig;
  logger: Logger;
  db: Database.Database;
  toolRegistry: ToolRegistry;
  memoryRetriever: MemoryRetriever;
  memoryWriter: MemoryWriter;
  memorySummarizer: MemorySummarizer;
  sessionRepository: SessionRepository;
  messageRepository: MessageRepository;
  episodeRepository: EpisodeRepository;
  toolRunRepository: ToolRunRepository;
  approvalGate: ApprovalGate;
  skillRegistry: SkillRegistry;
  /** P1-4: Skill metrics service for usage tracking and feedback analysis */
  skillMetricsService?: import('../skills/skill-evolution/skill-metrics.js').SkillMetricsService;
  agentFactory: AgentFactory;
  agentService: AgentService;
  feishuClient: FeishuClient;
  feishuRouter: FeishuRouter;
  chatQueue: ChatQueue;
  cronService: CronService;
  cronDeliveryRegistry: CronDeliveryRegistry;
  server: FastifyInstance;
  wsClient?: FeishuWSClient;
  computerUseHost?: import('../computer-use/computer-host.js').ComputerUseHost;
  agentManager: AgentManager;
  commandRegistry: CommandRegistry;
  channelManager: ChannelManager;
  extensionManager: ExtensionManager;

  // -------------------------------------------------------------------------
  // v4 services (populated in later phases)
  // -------------------------------------------------------------------------

  /** v4: Unified policy center (Phase 1+). */
  policyCenter?: import('../policy/policy-center.js').PolicyCenter;
  /** v4: Tool platform registry (Phase 2+). */
  toolPlatformRegistry?: import('../tools/platform/registry.js').ToolPlatformRegistry;
  /** v4: Agent orchestrator (Phase 5+). */
  orchestrator?: import('../orchestrator/orchestrator.js').Orchestrator;
  /** v4: External message sender for cross-channel delivery (F3). */
  externalMessageSender?: import('../tools/builtins/tasks/send-message-definition.js').ExternalMessageSender;
  /** Desktop Bridge registry for remote tool execution (file_read/write/shell). */
  desktopBridgeRegistry?: import('../agent/desktop-bridge-registry.js').DesktopBridgeRegistry;
  /** Subscription service for OAuth-based provider logins (Claude Pro, ChatGPT Plus, GitHub Copilot). */
  subscriptionService?: import('./subscription/subscription-service.js').SubscriptionService;
}
