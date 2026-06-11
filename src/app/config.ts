import { z } from 'zod';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { config as dotenvConfig } from 'dotenv';
import type { AppConfig } from './types.js';
import { loadYamlFile, yamlToAppConfigRaw } from './config-loader.js';
import { envBool } from '../shared/env.js';
import { ConfigError } from '../shared/errors.js';


/** Accepts comma-separated string or string array, normalizes to string array. */
function strListSchema(defaultVal: string) {
  return z.string().or(z.array(z.string())).default(defaultVal).transform(v => {
    if (Array.isArray(v)) return v.map(s => s.trim()).filter(Boolean);
    return v.split(',').map(s => s.trim()).filter(Boolean);
  });
}

const MEMORY_OUTPUT_LANGUAGE_ALIASES: Record<string, string> = {
  auto: 'Auto',
  english: 'English',
  en: 'English',
  'simplified chinese': 'Simplified Chinese',
  'zh-cn': 'Simplified Chinese',
  zh: 'Simplified Chinese',
  'traditional chinese': 'Traditional Chinese',
  'zh-tw': 'Traditional Chinese',
  'zh-hk': 'Traditional Chinese',
  spanish: 'Spanish',
  es: 'Spanish',
  japanese: 'Japanese',
  ja: 'Japanese',
  french: 'French',
  fr: 'French',
  german: 'German',
  de: 'German',
};

/**
 * Resolve "Auto" output language based on UI language.
 * This ensures the memory summarizer, persona distiller, and other LLM-based
 * memory components produce output in the user's preferred language even when
 * the MEMORY_OUTPUT_LANGUAGE config is left at its default ("Auto").
 */
export function resolveAutoOutputLanguage(uiLanguage: 'zh-CN' | 'en'): string {
  switch (uiLanguage) {
    case 'zh-CN': return 'Simplified Chinese';
    case 'en': return 'English';
    default: return 'English';
  }
}

function normalizeMemoryOutputLanguage(val: string | undefined): string {
  const normalized = val?.trim();
  if (!normalized) return 'Auto';

  const aliasKey = normalized.toLowerCase();
  const mapped = MEMORY_OUTPUT_LANGUAGE_ALIASES[aliasKey];
  if (!mapped) {
    throw new ConfigError(
      `Invalid MEMORY_OUTPUT_LANGUAGE: ${normalized}. Expected one of Auto, English, Simplified Chinese, Traditional Chinese, Spanish, Japanese, French, German.`,
    );
  }
  return mapped;
}

const configSchema = z.object({
  logging: z.object({
    level: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  }).default({}),
  uiLanguage: z.enum(['zh-CN', 'en']).default('en'),
  setupWizardDone: z.boolean().default(false),
  showToolCalls: z.boolean().default(true),
  feishu: z.object({
    enabled: z.boolean().default(true),
    appId: z.string().default(''),
    appSecret: z.string().default(''),
    verificationToken: z.string().default(''),
    encryptKey: z.string().default(''),
    wsEnabled: z.boolean().default(true),
  }),
  piAi: z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
    reasoningModel: z.string().default(''),
    apiKey: z.string().default(''),
    baseUrl: z.string().optional(),
  }),
  customProviders: z.array(z.object({
    provider: z.string().min(1),
    apiKey: z.string().min(1),
    baseUrl: z.string().min(1),
    models: z.array(z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      api: z.string().min(1),
      reasoning: z.boolean().optional(),
      reasoningLevel: z.string().optional(),
      contextWindow: z.number().int().positive().optional(),
      maxTokens: z.number().int().positive().optional(),
      input: z.array(z.enum(["text", "image"])).optional(),
      compat: z.record(z.string(), z.any()).optional(),
      cost: z.object({
        input: z.number(),
        output: z.number(),
        cacheRead: z.number().default(0),
        cacheWrite: z.number().default(0),
      }).optional(),
    })),
  })).optional(),
  embedding: z.object({
    baseUrl: z.string().default(''),
    apiKey: z.string().default(''),
    model: z.string().default(''),
    dimension: z.coerce.number().int().nonnegative().default(0),
    maxInputChars: z.coerce.number().int().positive().default(8000),
  }),
  database: z.object({
    path: z.string().default('~/.ohmyagent/data/app.db'),
  }),
  rateLimit: z.object({
    webhookMaxRequests: z.coerce.number().int().positive().default(100),
    webhookWindowMs: z.coerce.number().int().positive().default(60000),
  }).default({}),
  tools: z.object({
    shellEnabled: z.boolean().default(true),
    defaultTimeoutMs: z.coerce.number().int().positive().default(60000),
    maxOutputLength: z.coerce.number().int().positive().default(12000),
    // v2 fields
    toolsProfile: z.enum(['minimal', 'standard', 'advanced', 'full']).default('standard'),
    shellExecMode: z.enum(['safe', 'balanced', 'trusted']).default('balanced'),
    shellAllowlist: strListSchema(''),
    // deprecated v1 fields (kept for backward compat, mapped to v2 in loadConfig)
    shellApprovalMode: z.enum(['strict', 'balanced', 'relaxed']).default('balanced'),
    shellApprovalWhitelist: strListSchema('date,ls,pwd,whoami,uname,echo,cat,head,tail,wc,grep,find,which,env,printenv'),
    // approval timeout
    shellApprovalTimeoutSec: z.coerce.number().int().positive().default(600),
    shellApprovalTimeoutAction: z.enum(['deny', 'allow']).default('deny'),
    fileRead: z.object({
      allowedRoots: strListSchema(''),
      deniedPatterns: strListSchema('.env,*.pem,/etc/passwd,*/.ssh/*'),
    }).default({}),
  }),
  memory: z.object({
    autoRecall: z.boolean().default(false),
    autoRecallFrequency: z.enum(['first', 'every']).default('first'),
    // Deprecated: trigger-word auto-capture is unimplemented — marginal benefit over
    // LLM memory-store tool + MemorySummarizer. Config key kept for backward compat.
    autoCapture: z.boolean().default(false),
    recallTopK: z.coerce.number().int().positive().default(3),
    recallMinScore: z.coerce.number().min(0).default(0.01),
    captureMaxChars: z.coerce.number().int().positive().default(500),
    summarizeInterval: z.coerce.number().int().positive().default(20),
    outputLanguage: z.string().default('Auto'),
    // Temporal decay: half-life in days. 0 disables decay.
    decayHalfLifeDays: z.coerce.number().int().nonnegative().default(30),
    // Embedding cache max entries (SQLite table)
    embeddingCacheMaxEntries: z.coerce.number().int().positive().default(10000),
    queryEmbeddingTimeoutMs: z.coerce.number().int().positive().default(10000),
    // Intent-aware query planner (commonality/attribute coverage retrieval).
    queryPlanner: z.object({
      enabled: z.boolean().default(true),
      commonalityCoverage: z.boolean().default(true),
      speakerBoost: z.coerce.number().min(0).default(0.05),
      perSlotFloor: z.coerce.number().int().positive().default(2),
      maxEntities: z.coerce.number().int().positive().default(4),
      llm: z.object({ enabled: z.boolean().default(false) }).default({}),
    }).default({}),
    // Recall depth: larger values surface weak-margin (semantic) hits into the
    // candidate pool before reranking. Defaults match pre-tuning behavior.
    recall: z.object({
      prefilterMultiplier: z.coerce.number().int().positive().default(5),
      prefilterMin: z.coerce.number().int().positive().default(20),
      mergeCandidateMultiplier: z.coerce.number().int().positive().default(3),
    }).default({}),
    // Score-gated LLM query expansion. When enabled, a query whose initial recall
    // is weak (top similarity < minScoreTrigger) is rewritten into lexical variants
    // via the aux model to bridge wording gaps (e.g. "martial arts" → "kickboxing").
    // Disabled by default: it adds an aux-LLM call on weak-recall queries and is a
    // per-category trade-off, so it is opt-in. See memory_aux_models for the model.
    expansion: z.object({
      enabled: z.boolean().default(false),
      minQueryLength: z.coerce.number().int().positive().default(15),
      minScoreTrigger: z.coerce.number().min(0).max(1).default(0.3),
      maxVariants: z.coerce.number().int().positive().default(4),
    }).default({}),
    // Memory hygiene
    hygiene: z.object({
      enabled: z.boolean().default(true),
      retentionDays: z.coerce.number().int().positive().default(90),
    }).default({}),
    // Circuit breaker for embedding API
    embeddingCircuitBreaker: z.object({
      failureThreshold: z.coerce.number().int().nonnegative().default(5),
      cooldownSec: z.coerce.number().int().positive().default(30),
    }).default({}),
    offloading: z.object({
      enabled: z.boolean().default(true),
      maxRefsInContext: z.coerce.number().int().positive().default(10),
      preserveInMessages: z.coerce.number().int().nonnegative().default(2),
      refDir: z.string().default(''),
      retentionDays: z.coerce.number().int().positive().default(7),
    }).default({}),
    persona: z.object({
      enabled: z.boolean().default(true),
      distillThreshold: z.coerce.number().int().positive().default(3),
      minDistillIntervalHours: z.coerce.number().int().nonnegative().default(0),
    }).default({}),
    mermaidCanvas: z.object({
      enabled: z.boolean().default(false),
      injectFormat: z.enum(['summary', 'full']).default('summary'),
      phaseTagging: z.enum(['auto', 'llm', 'off']).default('auto'),
      maxNodesInContext: z.coerce.number().int().positive().default(20),
    }).default({}),
    sceneClustering: z.object({
      enabled: z.boolean().default(false),
      windowDays: z.coerce.number().int().positive().default(7),
      minMemories: z.coerce.number().int().positive().default(5),
    }).default({}),
    maintenance: z.object({
      enabled: z.boolean().default(true),
      intervalMs: z.coerce.number().int().positive().default(300000),
      jobs: z.object({
        memory_hygiene: z.boolean().default(true),
        embedding_backfill: z.boolean().default(true),
        embedding_cache_trim: z.boolean().default(true),
        entity_backfill: z.boolean().default(true),
        persona_consistency: z.boolean().default(true),
        offload_hygiene: z.boolean().default(true),
        scene_cluster: z.boolean().default(false),
        memory_doctor: z.boolean().default(false),
      }).default({}),
    }).default({}),
    // v9: Auto context compression
    autoCompress: z.object({
      enabled: z.boolean().default(true),
      reserveTokens: z.coerce.number().int().positive().default(16384),
      keepRecentTokens: z.coerce.number().int().positive().default(20000),
      model: z.object({
        primary: z.string().optional(),
        fallback_models: z.array(z.string()).default([]),
      }).optional(),
    }).default({}),
  }),
  cron: z.object({
    enabled: z.boolean().default(true),
    tickIntervalMs: z.coerce.number().int().positive().default(30000),
    dataDir: z.string().default('./cron'),
    executionTimeoutMs: z.coerce.number().int().positive().default(600000),
    maxConcurrency: z.coerce.number().int().positive().default(4),
  }).default({}),
  webSearch: z.object({
    providerOrder: strListSchema('anysearch, tavily, exa, baidu'),
    tavilyApiKey: z.string().optional(),
    exaApiKey: z.string().optional(),
    baiduApiKey: z.string().optional(),
    anysearchApiKey: z.string().optional(),
    searchTimeoutMs: z.coerce.number().int().positive().default(30000),
    maxResults: z.coerce.number().int().min(1).max(10).default(5),
  }).default({}),
  telegram: z.object({
    enabled: z.boolean().default(false),
    botToken: z.string().min(1),
    mode: z.enum(['polling', 'webhook']).default('polling'),
    webhookUrl: z.string().optional(),
    webhookPort: z.coerce.number().int().positive().default(8443),
    webhookSecret: z.string().optional(),
    allowedUsers: strListSchema(''),
    allowedGroups: strListSchema(''),
    proxyUrl: z.string().optional(),
    streamMode: z.enum(['edit', 'send']).default('edit'),
    textLimit: z.coerce.number().int().positive().default(4096),
    streamIntervalMs: z.coerce.number().int().min(200).max(2000).default(500),
  }).optional(),
  wechat: z.object({
    enabled: z.boolean().default(false),
    botToken: z.string().optional(),
    apiBase: z.string().default('https://ilinkai.weixin.qq.com'),
    cursorDir: z.string().default('./data/wechat'),
    textLimit: z.coerce.number().int().positive().default(2048),
    aesKey: z.string().optional(),
    allowedUsers: strListSchema(''),
  }).optional(),
  qq: z.object({
    enabled: z.boolean().default(false),
    appId: z.string().min(1),
    clientSecret: z.string().min(1),
    sandbox: z.boolean().default(false),
    allowedUsers: strListSchema(''),
    allowedGroups: strListSchema(''),
    textLimit: z.coerce.number().int().positive().default(1500),
  }).optional(),
  computerUse: z.object({
    enabled: z.boolean().default(false),
    provider: z.enum(['auto', 'ssh', 'local', 'node']).optional(),
    allowedApps: z.array(z.string()).default([]),
    allowedAgents: z.array(z.string()).default([]),
    approvalWhitelist: z.array(z.string()).default([]),
    ssh: z.object({
      host: z.string().default(''),
      user: z.string().default(''),
      keyPath: z.string().default(''),
      port: z.number().default(22),
      jumpHost: z.string().default(''),
      display: z.string().default(':0'),
      hostKeyChecking: z.enum(['accept-new', 'strict']).default('accept-new'),
      knownHostsPath: z.string().default(''),
    }).optional(),
    node: z.object({
      url: z.string().default(''),
    }).optional(),
    perPlatformProvider: z.record(z.string()).optional(),
  }).optional(),
  extensions: z.object({
    directory: z.string().default('extensions'),
  }).default({}),
  fallbackModels: z.array(z.string()).default([]),
  providerKeys: z.record(z.object({
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
  })).default({}),
  defaultReasoningLevel: z.string().default('high'),
  memoryAuxModels: z.object({
    primary: z.string().optional(),
    fallback_models: z.array(z.string()).default([]),
  }).optional(),
  // Legacy: vision bridge config for backward-compat with existing config.yaml.
  // Prefer multimodal.image.bridge in new configs. Bootstrap merges both.
  visionBridge: z.object({
    enabled: z.boolean().default(false),
    modelRef: z.string().optional(),
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    timeoutMs: z.number().int().positive().default(120_000),
    maxNoteChars: z.number().int().positive().default(3200),
    maxCacheEntries: z.number().int().positive().default(256),
  }).optional(),
  footer: z.object({
    showAgentName: z.boolean().default(true),
    showModel: z.boolean().default(true),
    showCompleted: z.boolean().default(false),
    showElapsed: z.boolean().default(true),
    showUsage: z.boolean().default(false),
    showCacheHitRate: z.boolean().default(false),
  }).default({}),
  // -----------------------------------------------------------------------
  // v4 configuration sections (all optional, backward-compatible)
  // -----------------------------------------------------------------------
  policy: z.object({
    mode: z.enum(['safe', 'balanced', 'permissive']).default('balanced'),
    path: z.object({
      readRoots: z.array(z.string()).default([]),
      writeRoots: z.array(z.string()).default([]),
      deniedPatterns: z.array(z.string()).default([]),
    }).optional(),
    approval: z.object({
      timeoutSec: z.number().default(120),
      timeoutAction: z.enum(['deny', 'allow']).default('deny'),
    }).optional(),
  }).optional(),
  orchestrator: z.object({
    enabled: z.boolean().default(true),
    maxChildAgents: z.number().default(4),
    allowGrandchildren: z.boolean().default(false),
    inheritApprovals: z.boolean().default(true),
    inheritAppApprovals: z.boolean().default(true),
  }).default({}),
  smart_agent_team: z.object({
    enabled: z.boolean().default(true),
    max_children: z.number().int().min(1).max(10).default(4),
  }).default({}),
  multimodal: z.object({
    enabled: z.boolean().default(true),
    attachments: z.object({
      cacheDir: z.string().default('./data/media-cache'),
      autoParseImages: z.boolean().default(true),
      autoParseDocuments: z.boolean().default(true),
      autoTranscribeAudio: z.boolean().default(false),
    }).optional(),
    image: z.object({
      mode: z.enum(['native_first', 'bridge_only', 'native_only']).default('native_first'),
      bridge: z.object({
        enabled: z.boolean().default(false),
        modelRef: z.string().optional(),
        apiKey: z.string().optional(),
        baseUrl: z.string().optional(),
        timeoutMs: z.number().int().positive().default(120_000),
        maxNoteChars: z.number().int().positive().default(3200),
        maxCacheEntries: z.number().int().positive().default(256),
      }).optional(),
    }).optional(),
    imageGeneration: z.object({
      enabled: z.boolean().default(false),
      modelRef: z.string().optional(),
      outputDir: z.string().default('./data/generated-images'),
      maxPromptChars: z.number().default(4000),
    }).optional(),
    videoGeneration: z.object({
      enabled: z.boolean().default(false),
      modelRef: z.string().optional(),
      outputDir: z.string().default('./data/generated-videos'),
      maxPromptChars: z.number().default(4000),
      defaultSeconds: z.string().default('5.0'),
      defaultSize: z.string().default('1280x768'),
    }).optional(),
    stt: z.object({
      enabled: z.boolean().default(false),
      language: z.string().default('auto'),
      autoTranscribe: z.boolean().default(true),
      maxDurationSec: z.number().int().positive().default(300),
      maxFileSizeMb: z.number().int().positive().default(25),
      providers: z.array(z.object({
        id: z.string(),
        apiKey: z.string().optional(),
        baseUrl: z.string().optional(),
        model: z.string().optional(),
        endpoint: z.string().optional(),
        requestType: z.enum(['multipart', 'json']).optional(),
        audioFieldName: z.string().optional(),
        languageFieldName: z.string().optional(),
        responseTextField: z.string().optional(),
        extraFields: z.record(z.string()).optional(),
        authPrefix: z.string().optional(),
      })).optional(),
    }).optional(),
  }).optional(),
  remoteTriggers: z.object({
    targets: z.array(z.object({
      id: z.string(),
      name: z.string(),
      url: z.string(),
      method: z.enum(['POST', 'PUT']),
      headers: z.record(z.string()).optional(),
    })).optional(),
  }).optional(),
  agents: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    system_prompt: z.string().optional(),
    model: z.object({
      primary: z.string().optional(),
      fallback: z.array(z.string()).optional(),
      reasoning_level: z.string().optional(),
      transport: z.string().optional(),
      max_retry: z.number().int().positive().optional(),
    }).optional(),
    tools: z.object({
      profile: z.enum(['minimal', 'standard', 'advanced', 'full']).optional(),
      add: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    }).optional(),
    spawn: z.object({
      enabled: z.boolean().optional(),
      max_parallel: z.number().int().positive().optional(),
      allowed_personas: z.array(z.string()).optional(),
    }).optional(),
    extensions: z.object({
      disable: z.array(z.string()).optional(),
    }).optional(),
    channels: z.array(z.string()).optional(),
  })).optional(),
  // Tool Search — progressive tool disclosure
  toolSearch: z.object({
    /** Enable mode: auto=threshold trigger, on=always active, off=disabled */
    enabled: z.enum(['auto', 'on', 'off']).default('on'),
    /** Percentage of context window at which auto mode activates (0-100) */
    thresholdPct: z.number().min(0).max(100).default(10),
    /** Default number of results returned by tool_search */
    searchDefaultLimit: z.number().min(1).max(20).default(5),
    /** Maximum results the model can request via limit parameter */
    maxSearchLimit: z.number().min(1).max(50).default(20),
  }).default({}),
});

let cachedConfig: AppConfig | null = null;

/**
 * Build raw config object from environment variables.
 * Used as primary source when config.yaml is absent, and as overrides when it exists.
 */
function buildRawFromEnv(env: Record<string, string | undefined>): Record<string, unknown> {
  return {
    logging: {
      level: env.LOG_LEVEL,
    },
    uiLanguage: env.UI_LANGUAGE,
    showToolCalls: envBool(env.SHOW_TOOL_CALLS, true),
    feishu: {
      enabled: envBool(env.FEISHU_ENABLED, true),
      appId: env.FEISHU_APP_ID ?? '',
      appSecret: env.FEISHU_APP_SECRET ?? '',
      verificationToken: env.FEISHU_VERIFICATION_TOKEN ?? '',
      encryptKey: env.FEISHU_ENCRYPT_KEY ?? '',
      wsEnabled: env.FEISHU_CONNECTION_MODE !== 'webhook',
    },
    piAi: {
      provider: env.PI_AI_PROVIDER,
      model: env.PI_AI_MODEL,
      reasoningModel: env.PI_AI_REASONING_MODEL,
      apiKey: env.PI_AI_API_KEY ?? '',
      baseUrl: env.PI_AI_BASE_URL || undefined,
    },
    customProviders: undefined,
    providerKeys: (() => {
      // Auto-detect <PROVIDER>_API_KEY env vars for known builtin providers
      const knownProviders = [
        'deepseek', 'openai', 'anthropic', 'google', 'mistral',
        'xai', 'xiaomi', 'cerebras', 'groq', 'together', 'fireworks',
        'openrouter', 'github-copilot', 'moonshotai', 'minimax',
        'kimi-coding', 'zai', 'opencode', 'huggingface',
      ];
      const keys: Record<string, { apiKey?: string; baseUrl?: string }> = {};
      for (const p of knownProviders) {
        const envKey = p.toUpperCase().replace(/-/g, '_');
        const pk = env[`${envKey}_API_KEY`];
        const pu = env[`${envKey}_BASE_URL`];
        if (pk) {
          keys[p] = { apiKey: pk, baseUrl: pu || undefined };
        }
      }
      return Object.keys(keys).length > 0 ? keys : undefined;
    })(),
    fallbackModels: env.FALLBACK_MODELS
      ? env.FALLBACK_MODELS.split(',').map(s => s.trim()).filter(Boolean)
      : [],
    defaultReasoningLevel: env.DEFAULT_REASONING_LEVEL?.trim() || 'high',
    memoryAuxModels: (() => {
      const primary = env.MEMORY_AUX_MODEL;
      const fallback = env.MEMORY_AUX_FALLBACK_MODELS;
      if (!primary && !fallback) return undefined;
      return {
        primary: primary || undefined,
        fallback_models: fallback ? fallback.split(',').map(s => s.trim()).filter(Boolean) : [],
      };
    })(),
    embedding: {
      baseUrl: env.EMBEDDING_BASE_URL,
      apiKey: env.EMBEDDING_API_KEY ?? '',
      model: env.EMBEDDING_MODEL,
      dimension: env.EMBEDDING_DIMENSION,
      maxInputChars: env.EMBEDDING_MAX_INPUT_CHARS,
    },
    database: {
      path: env.DATABASE_PATH,
    },
    rateLimit: {
      webhookMaxRequests: env.RATE_LIMIT_WEBHOOK_MAX,
      webhookWindowMs: env.RATE_LIMIT_WEBHOOK_WINDOW_MS,
    },
    tools: {
      shellEnabled: envBool(env.SHELL_ENABLED, true),
      defaultTimeoutMs: env.SHELL_COMMAND_TIMEOUT_MS,
      maxOutputLength: env.SHELL_MAX_OUTPUT_CHARS,
      toolsProfile: env.TOOLS_PROFILE,
      shellExecMode: env.SHELL_EXEC_MODE,
      shellAllowlist: env.SHELL_ALLOWLIST,
      shellApprovalMode: env.SHELL_APPROVAL_MODE,
      shellApprovalWhitelist: env.SHELL_APPROVAL_WHITELIST,
      shellApprovalTimeoutSec: env.SHELL_APPROVAL_TIMEOUT_SEC,
      shellApprovalTimeoutAction: env.SHELL_APPROVAL_TIMEOUT_ACTION,
      fileRead: {
        allowedRoots: env.FILE_READ_ALLOWED_ROOTS,
        deniedPatterns: env.FILE_READ_DENIED_PATTERNS,
      },
    },
    memory: {
      autoRecall: envBool(env.MEMORY_AUTO_RECALL, false),
      autoRecallFrequency: (env.MEMORY_AUTO_RECALL_FREQUENCY as 'first' | 'every') ?? 'first',
      autoCapture: envBool(env.MEMORY_AUTO_CAPTURE, false),
      recallTopK: env.MEMORY_RECALL_TOP_K,
      recallMinScore: env.MEMORY_RECALL_MIN_SCORE,
      captureMaxChars: env.MEMORY_CAPTURE_MAX_CHARS,
      summarizeInterval: env.MEMORY_SUMMARIZE_INTERVAL,
      outputLanguage: normalizeMemoryOutputLanguage(env.MEMORY_OUTPUT_LANGUAGE),
      decayHalfLifeDays: env.MEMORY_DECAY_HALF_LIFE_DAYS,
      embeddingCacheMaxEntries: env.EMBEDDING_CACHE_MAX_ENTRIES,
      queryPlanner: {
        enabled: envBool(env.MEMORY_QUERY_PLANNER_ENABLED, true),
        commonalityCoverage: envBool(env.MEMORY_QUERY_PLANNER_COMMONALITY, true),
        speakerBoost: env.MEMORY_QUERY_PLANNER_SPEAKER_BOOST,
        perSlotFloor: env.MEMORY_QUERY_PLANNER_PER_SLOT_FLOOR,
        maxEntities: env.MEMORY_QUERY_PLANNER_MAX_ENTITIES,
        llm: { enabled: envBool(env.MEMORY_QUERY_PLANNER_LLM_ENABLED, false) },
      },
      recall: {
        prefilterMultiplier: env.MEMORY_RECALL_PREFILTER_MULTIPLIER,
        prefilterMin: env.MEMORY_RECALL_PREFILTER_MIN,
        mergeCandidateMultiplier: env.MEMORY_RECALL_MERGE_CANDIDATE_MULTIPLIER,
      },
      expansion: {
        enabled: envBool(env.MEMORY_EXPANSION_ENABLED, false),
        minQueryLength: env.MEMORY_EXPANSION_MIN_QUERY_LENGTH,
        minScoreTrigger: env.MEMORY_EXPANSION_MIN_SCORE_TRIGGER,
        maxVariants: env.MEMORY_EXPANSION_MAX_VARIANTS,
      },
      hygiene: {
        enabled: envBool(env.MEMORY_HYGIENE_ENABLED, true),
        retentionDays: env.MEMORY_HYGIENE_RETENTION_DAYS,
      },
      embeddingCircuitBreaker: {
        failureThreshold: env.EMBEDDING_CB_FAILURE_THRESHOLD,
        cooldownSec: env.EMBEDDING_CB_COOLDOWN_SEC,
      },
      offloading: {
        enabled: envBool(env.OFFLOADING_ENABLED, false),
        maxRefsInContext: env.OFFLOADING_MAX_REFS_IN_CONTEXT,
        preserveInMessages: env.OFFLOADING_PRESERVE_IN_MESSAGES,
        refDir: env.OFFLOADING_REF_DIR ?? '',
        retentionDays: env.OFFLOADING_RETENTION_DAYS,
      },
      persona: {
        enabled: envBool(env.PERSONA_ENABLED, false),
        distillThreshold: env.PERSONA_DISTILL_THRESHOLD,
        minDistillIntervalHours: env.PERSONA_MIN_DISTILL_INTERVAL_HOURS,
      },
      mermaidCanvas: {
        enabled: envBool(env.MERMAID_CANVAS_ENABLED, false),
        injectFormat: (env.MERMAID_CANVAS_INJECT_FORMAT as 'summary' | 'full') ?? 'summary',
        phaseTagging: (env.MERMAID_CANVAS_PHASE_TAGGING as 'auto' | 'llm' | 'off') ?? 'auto',
        maxNodesInContext: env.MERMAID_CANVAS_MAX_NODES,
      },
      sceneClustering: {
        enabled: envBool(env.SCENE_CLUSTERING_ENABLED, false),
        windowDays: env.SCENE_CLUSTERING_WINDOW_DAYS,
        minMemories: env.SCENE_CLUSTERING_MIN_MEMORIES,
      },
    },
    cron: {
      enabled: envBool(env.CRON_ENABLED, true),
      tickIntervalMs: env.CRON_TICK_INTERVAL_MS,
      dataDir: env.CRON_DATA_DIR,
      executionTimeoutMs: env.CRON_EXECUTION_TIMEOUT_MS,
    },
    webSearch: {
      providerOrder: env.WEB_SEARCH_PROVIDER,
      tavilyApiKey: env.WEB_SEARCH_TAVILY_API_KEY || undefined,
      exaApiKey: env.WEB_SEARCH_EXA_API_KEY || undefined,
      baiduApiKey: env.WEB_SEARCH_BAIDU_API_KEY || undefined,
      anysearchApiKey: env.WEB_SEARCH_ANYSEARCH_API_KEY || undefined,
      searchTimeoutMs: env.WEB_SEARCH_TIMEOUT_MS,
      maxResults: env.WEB_SEARCH_MAX_RESULTS,
    },
    telegram: envBool(env.TELEGRAM_ENABLED, false) && env.TELEGRAM_BOT_TOKEN ? {
      enabled: true,
      botToken: env.TELEGRAM_BOT_TOKEN,
      mode: (env.TELEGRAM_MODE as 'polling' | 'webhook') ?? undefined,
      webhookUrl: env.TELEGRAM_WEBHOOK_URL || undefined,
      webhookPort: env.TELEGRAM_WEBHOOK_PORT,
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || undefined,
      allowedUsers: env.TELEGRAM_ALLOWED_USERS,
      allowedGroups: env.TELEGRAM_ALLOWED_GROUPS,
      proxyUrl: env.TELEGRAM_PROXY_URL || undefined,
      streamMode: (env.TELEGRAM_STREAM_MODE as 'edit' | 'send') ?? undefined,
      textLimit: env.TELEGRAM_TEXT_LIMIT,
      streamIntervalMs: env.TELEGRAM_STREAM_INTERVAL,
    } : undefined,
    wechat: envBool(env.WECHAT_ENABLED, false) ? {
      enabled: true,
      botToken: env.WECHAT_BOT_TOKEN || undefined,
      apiBase: env.WECHAT_API_BASE ?? undefined,
      cursorDir: env.WECHAT_CURSOR_DIR ?? undefined,
      textLimit: env.WECHAT_TEXT_LIMIT,
      aesKey: env.WECHAT_AES_KEY || undefined,
      allowedUsers: env.WECHAT_ALLOWED_USERS,
    } : undefined,
    qq: envBool(env.QQ_ENABLED, false) && env.QQ_APP_ID ? {
      enabled: true,
      appId: env.QQ_APP_ID,
      clientSecret: env.QQ_CLIENT_SECRET ?? '',
      sandbox: envBool(env.QQ_SANDBOX, false),
      allowedUsers: env.QQ_ALLOWED_USERS,
      allowedGroups: env.QQ_ALLOWED_GROUPS,
      textLimit: env.QQ_TEXT_LIMIT,
    } : undefined,
    extensions: {
      directory: env.EXTENSIONS_DIRECTORY,
    },
    footer: {
      showAgentName: envBool(env.FOOTER_SHOW_AGENT_NAME, true),
      showModel: envBool(env.FOOTER_SHOW_MODEL, true),
      showCompleted: envBool(env.FOOTER_SHOW_COMPLETED, false),
      showElapsed: envBool(env.FOOTER_SHOW_ELAPSED, true),
      showUsage: envBool(env.FOOTER_SHOW_USAGE, false),
      showCacheHitRate: envBool(env.FOOTER_SHOW_CACHE_HIT_RATE, false),
    },
  };
}

/**
 * Apply env var overrides on top of a YAML-derived raw config.
 * Only overrides fields where the env var is explicitly set (not undefined).
 */
function applyEnvOverrides(raw: Record<string, unknown>, env: Record<string, string | undefined>): void {
  // For simplicity, re-build the env raw and merge only defined top-level keys.
  // This avoids field-by-field tracking. The zod schema handles defaults for missing values.
  const envRaw = buildRawFromEnv(env);

  // Merge piAi env overrides — only override fields explicitly set, keep YAML values
  if (env.PI_AI_PROVIDER !== undefined || env.PI_AI_API_KEY !== undefined) {
    const yamlPiAi = (raw.piAi ?? {}) as Record<string, unknown>;
    const envPiAi = envRaw.piAi as Record<string, unknown>;
    if (env.PI_AI_PROVIDER !== undefined) yamlPiAi.provider = envPiAi.provider;
    if (env.PI_AI_MODEL !== undefined) yamlPiAi.model = envPiAi.model;
    if (env.PI_AI_REASONING_MODEL !== undefined) yamlPiAi.reasoningModel = envPiAi.reasoningModel;
    if (env.PI_AI_API_KEY !== undefined) yamlPiAi.apiKey = envPiAi.apiKey;
    if (env.PI_AI_BASE_URL !== undefined) yamlPiAi.baseUrl = envPiAi.baseUrl;
    raw.piAi = yamlPiAi;
  }

  // Feishu
  if (env.FEISHU_APP_ID !== undefined) {
    raw.feishu = envRaw.feishu;
  }

  // Fallback models
  if (env.FALLBACK_MODELS !== undefined) {
    raw.fallbackModels = envRaw.fallbackModels;
  }

  // Provider keys: only auto-detect from env when YAML has no explicit provider_keys.
  // Once managed via WebUI (YAML), env auto-detection is disabled to prevent deleted entries from reappearing.
  if (envRaw.providerKeys && Object.keys(envRaw.providerKeys as Record<string, unknown>).length > 0) {
    if (raw.providerKeys === undefined) {
      raw.providerKeys = envRaw.providerKeys;
    }
  }

  // Default reasoning level
  if (env.DEFAULT_REASONING_LEVEL !== undefined) {
    raw.defaultReasoningLevel = envRaw.defaultReasoningLevel;
  }

  // Memory aux models
  if (env.MEMORY_AUX_MODEL !== undefined || env.MEMORY_AUX_FALLBACK_MODELS !== undefined) {
    raw.memoryAuxModels = envRaw.memoryAuxModels;
  }

  // Embedding — merge individual fields to avoid wiping YAML config
  if (env.EMBEDDING_API_KEY !== undefined || env.EMBEDDING_BASE_URL !== undefined || env.EMBEDDING_MODEL !== undefined || env.EMBEDDING_DIMENSION !== undefined) {
    const yamlEmb = (raw.embedding ?? {}) as Record<string, unknown>;
    const envEmb = envRaw.embedding as Record<string, unknown>;
    if (env.EMBEDDING_BASE_URL !== undefined) yamlEmb.baseUrl = envEmb.baseUrl;
    if (env.EMBEDDING_API_KEY !== undefined) yamlEmb.apiKey = envEmb.apiKey;
    if (env.EMBEDDING_MODEL !== undefined) yamlEmb.model = envEmb.model;
    if (env.EMBEDDING_DIMENSION !== undefined) yamlEmb.dimension = envEmb.dimension;
    if (env.EMBEDDING_MAX_INPUT_CHARS !== undefined) yamlEmb.maxInputChars = envEmb.maxInputChars;
    raw.embedding = yamlEmb;
  }

  // Database
  if (env.DATABASE_PATH !== undefined) {
    raw.database = envRaw.database;
  }

  // Rate limit
  if (env.RATE_LIMIT_WEBHOOK_MAX !== undefined || env.RATE_LIMIT_WEBHOOK_WINDOW_MS !== undefined) {
    raw.rateLimit = envRaw.rateLimit;
  }

  // Tools (check key env vars)
  if (env.TOOLS_PROFILE !== undefined || env.SHELL_EXEC_MODE !== undefined) {
    raw.tools = envRaw.tools;
  }

  // Memory (check key env vars)
  if (env.MEMORY_AUTO_RECALL !== undefined || env.MEMORY_SUMMARIZE_INTERVAL !== undefined || env.OFFLOADING_ENABLED !== undefined || env.PERSONA_ENABLED !== undefined || env.MERMAID_CANVAS_ENABLED !== undefined || env.SCENE_CLUSTERING_ENABLED !== undefined) {
    raw.memory = envRaw.memory;
  }

  // Cron
  if (env.CRON_ENABLED !== undefined) {
    raw.cron = envRaw.cron;
  }

  // Web search
  if (env.WEB_SEARCH_PROVIDER !== undefined) {
    raw.webSearch = envRaw.webSearch;
  }

  // Channels — only override when the channel-level "enabling" flag is explicitly set in env.
  // Token-only env vars are for ${VAR} interpolation in config.yaml, not overrides.
  if (env.TELEGRAM_ENABLED !== undefined || env.TELEGRAM_MODE !== undefined || env.TELEGRAM_PROXY_URL !== undefined) raw.telegram = envRaw.telegram;
  if (env.WECHAT_ENABLED !== undefined) raw.wechat = envRaw.wechat;
  if (env.QQ_ENABLED !== undefined) raw.qq = envRaw.qq;

  // Extensions
  if (env.EXTENSIONS_DIRECTORY !== undefined) {
    raw.extensions = envRaw.extensions;
  }

  // Misc
  if (env.LOG_LEVEL !== undefined) {
    (raw.logging as Record<string, unknown>).level = (envRaw.logging as Record<string, unknown>).level;
  }
  if (env.UI_LANGUAGE !== undefined) {
    raw.uiLanguage = envRaw.uiLanguage;
  }
  if (env.SHOW_TOOL_CALLS !== undefined) {
    raw.showToolCalls = envRaw.showToolCalls;
  }
  if (env.FOOTER_SHOW_AGENT_NAME !== undefined || env.FOOTER_SHOW_MODEL !== undefined ||
      env.FOOTER_SHOW_COMPLETED !== undefined || env.FOOTER_SHOW_ELAPSED !== undefined ||
      env.FOOTER_SHOW_USAGE !== undefined || env.FOOTER_SHOW_CACHE_HIT_RATE !== undefined) {
    raw.footer = envRaw.footer;
  }
}

/**
 * Load and validate configuration.
 *
 * Priority: process.env > config.yaml > defaults
 *
 * 1. If config.yaml exists, it's the base config.
 * 2. Environment variables override config.yaml values.
 * 3. If config.yaml doesn't exist, falls back to environment variables (backward compat).
 *
 * Result is cached — subsequent calls return the same instance.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env, configPath?: string): AppConfig {
  if (cachedConfig) return cachedConfig;

  // Determine YAML config path: explicit arg > env > process.env > default
  // Empty string explicitly disables YAML config loading.
  const yamlPath = configPath ?? env.CONFIG_FILE ?? process.env.CONFIG_FILE ?? './config.yaml';
  const yamlConfig = yamlPath ? loadYamlFile(yamlPath, env) : null;

  let raw: Record<string, unknown>;

  if (yamlConfig) {
    raw = yamlToAppConfigRaw(yamlConfig);
    applyEnvOverrides(raw, env);
  } else {
    raw = buildRawFromEnv(env);
  }

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Configuration validation failed:\n${errors}`);
  }

  // Resolve Auto → concrete language based on uiLanguage
  if (result.data.memory.outputLanguage === 'Auto') {
    result.data.memory.outputLanguage = resolveAutoOutputLanguage(result.data.uiLanguage);
  }

  cachedConfig = result.data;
  return cachedConfig;
}

/**
 * Reset cached config (for testing and hot reload).
 */
export function resetConfig(): void {
  cachedConfig = null;
}

// ─── Hot reload ───

export type ConfigReloadFn = (newConfig: AppConfig) => void | Promise<void>;

let configWatcher: FSWatcher | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Watch config.yaml for changes and invoke `onReload` with the new config.
 * Debounces by 500ms to avoid double-fires from editors doing atomic-save.
 */
export function startConfigWatcher(
  configPath: string,
  onReload: ConfigReloadFn,
): void {
  if (configWatcher) return;
  if (!configPath || !existsSync(configPath)) return;

  configWatcher = watch(configPath, (_eventType) => {
    // Debounce: editors may trigger multiple events per save
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      try {
        resetConfig();
        const newConfig = loadConfig(process.env, configPath);
        void onReload(newConfig);
      } catch (err: unknown) {
        // Log but don't crash — keep running with old config
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[config-watcher] Failed to reload config:', msg);
      }
    }, 500);
  });

  reloadTimer?.unref();
}

/**
 * Stop the config file watcher.
 */
export function stopConfigWatcher(): void {
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
  }
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = undefined;
  }
}

// ─── .env hot reload ───

let envWatcher: FSWatcher | null = null;
let envReloadTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Watch .env for changes and invoke `onReload` with the new config.
 * Re-reads .env into process.env before reloading, so API keys and other
 * env-only settings take effect without a restart.
 */
export function startEnvWatcher(
  envPath: string,
  configPath: string,
  onReload: ConfigReloadFn,
): void {
  if (envWatcher) return;
  if (!envPath || !existsSync(envPath)) return;

  envWatcher = watch(envPath, (_eventType) => {
    if (envReloadTimer) clearTimeout(envReloadTimer);
    envReloadTimer = setTimeout(() => {
      try {
        // Re-read .env into process.env, overriding existing values
        dotenvConfig({ path: envPath, override: true });
        resetConfig();
        const newConfig = loadConfig(process.env, configPath);
        void onReload(newConfig);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[env-watcher] Failed to reload config:', msg);
      }
    }, 500);
  });

  envReloadTimer?.unref();
}

/**
 * Stop the .env file watcher.
 */
export function stopEnvWatcher(): void {
  if (envWatcher) {
    envWatcher.close();
    envWatcher = null;
  }
  if (envReloadTimer) {
    clearTimeout(envReloadTimer);
    envReloadTimer = undefined;
  }
}
