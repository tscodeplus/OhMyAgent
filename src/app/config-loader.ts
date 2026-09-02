import { readFileSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { CustomProviderConfig, CustomModelConfig, ToolProfileId } from './types.js';
import type { AgentConfig } from '../agent/config-types.js';

// ─── Env interpolation ───

const ENV_INTERP_RE = /\$\{(\w+)\}/g;

type EnvMap = Record<string, string | undefined>;

/**
 * Recursively replace ${VAR_NAME} placeholders in strings.
 * Looks up values from `env` first, then falls back to process.env.
 */
function interpolateEnv(obj: unknown, env?: EnvMap): unknown {
  if (typeof obj === 'string') {
    return obj.replace(
      ENV_INTERP_RE,
      (_match, name: string) => env?.[name] ?? process.env[name] ?? '',
    );
  }
  if (Array.isArray(obj)) return obj.map((v) => interpolateEnv(v, env));
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = interpolateEnv(value, env);
    }
    return result;
  }
  return obj;
}

// ─── YAML load ───

type YamlNode = Record<string, any> | undefined;

export function loadYamlFile(path: string, env?: EnvMap): Record<string, any> | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw);
  return interpolateEnv(parsed, env) as Record<string, any>;
}

// ─── Helpers ───

function parseModelRef(ref: string): { provider: string; model: string } {
  const idx = ref.indexOf('/');
  if (idx === -1) {
    throw new Error(`Invalid model reference format: "${ref}". Expected "provider/model-id".`);
  }
  return { provider: ref.slice(0, idx), model: ref.slice(idx + 1) };
}

// ─── Strict scalar coercion (fail-fast) ───
//
// A config typo must surface as a startup error, not silently become a
// default (previously `port: 91O1` quietly became the default port and
// `show_tool_calls: "false"` quietly became `true`). Rules:
//
//   - missing (undefined/null)  → default (normal absence)
//   - correct scalar type       → used as-is
//   - numeric string for num()  → accepted (env interpolation ${VAR} always
//                                 yields strings)
//   - anything else             → recorded as an issue; yamlToAppConfigRaw
//                                 throws an aggregate error listing every
//                                 offending key at the end of the pass

interface ConfigIssue {
  key: string;
  message: string;
}

const configIssues: ConfigIssue[] = [];

function describeValue(val: unknown): string {
  const t = val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val;
  let rendered: string;
  try {
    rendered = JSON.stringify(val) ?? String(val);
  } catch {
    rendered = String(val);
  }
  if (rendered.length > 60) rendered = rendered.slice(0, 57) + '...';
  return `${t} ${rendered}`;
}

function recordIssue(key: string, expected: string, val: unknown): void {
  configIssues.push({
    key: key || '(unlabeled config key)',
    message: `expected ${expected}, got ${describeValue(val)}`,
  });
}

/**
 * Local node variable → config.yaml path, so error messages point at the key
 * the user actually wrote instead of an internal identifier (vbCfg.enabled →
 * vision_bridge.enabled). Variables not listed here fall through as-is.
 */
const nodeVarToYamlKey: Record<string, string> = {
  root: '',
  channels: 'channels',
  provider: 'provider',
  feishu: 'channels.feishu',
  telegram: 'channels.telegram',
  wechat: 'channels.wechat',
  qq: 'channels.qq',
  toolsCfg: 'tools',
  shellCfg: 'tools.shell',
  fileReadCfg: 'tools.file_read',
  memCfg: 'memory',
  vbCfg: 'vision_bridge',
  wsCfg: 'web_search',
  rlCfg: 'rate_limit',
  cronCfg: 'cron',
  embCfg: 'embedding',
  dbCfg: 'database',
  extCfg: 'extensions',
  memAuxCfg: 'memory_aux_models',
  cuCfg: 'computer_use',
};

function yamlKeyFromLabel(label: string): string {
  return label
    .split('??')
    .map((part) => {
      const segs = part.trim().split(/\?\?\.|\./);
      const mapped = nodeVarToYamlKey[segs[0]];
      if (mapped === undefined) return part.trim();
      return [mapped, ...segs.slice(1)].filter(Boolean).join('.');
    })
    .filter(Boolean)
    .join(' | ');
}

function str(val: unknown, defaultVal: string, key = ''): string {
  if (val === undefined || val === null) return defaultVal;
  if (typeof val === 'string') return val;
  // number/boolean → string is a benign YAML type slip (`app_id: 12345`)
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  recordIssue(key, 'a string', val);
  return defaultVal;
}

function num(val: unknown, defaultVal: number, key = ''): number {
  if (val === undefined || val === null) return defaultVal;
  if (typeof val === 'number') return val;
  if (typeof val === 'string' && val.trim() !== '' && !isNaN(Number(val))) return Number(val);
  recordIssue(key, 'a number', val);
  return defaultVal;
}

function strList(val: unknown, defaultVal: string, key = ''): string[] {
  if (Array.isArray(val)) return val.map((v) => String(v).trim()).filter(Boolean);
  if (val === undefined || val === null) {
    return defaultVal
      ? defaultVal
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  }
  if (typeof val === 'string') {
    return val
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  recordIssue(key, 'a string or list of strings', val);
  return defaultVal
    ? defaultVal
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

/**
 * Strict boolean for YAML values. Unlike shared/env.ts envBool (which is
 * lenient because env vars are always strings), an unrecognized YAML value
 * here is a typo — e.g. `enabled: "yes"` previously fell back to the default
 * silently, which could be the opposite of what was written.
 */
function yamlBool(val: unknown, defaultVal: boolean, key = ''): boolean {
  if (val === undefined || val === null) return defaultVal;
  if (typeof val === 'boolean') return val;
  if (val === 'true' || val === '1') return true;
  if (val === 'false' || val === '0') return false;
  recordIssue(key, 'a boolean', val);
  return defaultVal;
}

// ─── YAML → AppConfig raw object ───

// ── Section builders (extracted from yamlToAppConfigRaw) ──

function buildMemorySection(memCfg: YamlNode): Record<string, unknown> {
  const hygieneCfg = memCfg?.hygiene as YamlNode;
  const cbCfg = memCfg?.embedding_circuit_breaker as YamlNode;
  const offloadCfg = memCfg?.offloading as YamlNode;
  const mermaidCfg = memCfg?.mermaid_canvas as YamlNode;
  const personaCfg = memCfg?.persona as YamlNode;
  const sceneCfg = memCfg?.scene_clustering as YamlNode;
  const compressCfg = memCfg?.auto_compress as YamlNode;
  const compressModelCfg = compressCfg?.model as YamlNode;

  return {
    autoRecall: yamlBool(memCfg?.auto_recall, false, 'memCfg?.auto_recall'),
    autoRecallFrequency: str(
      memCfg?.auto_recall_frequency,
      'first',
      'memCfg?.auto_recall_frequency',
    ),
    autoCapture: yamlBool(memCfg?.auto_capture, false, 'memCfg?.auto_capture'),
    recallTopK: num(memCfg?.recall_top_k, 3, 'memCfg?.recall_top_k'),
    recallMinScore: num(memCfg?.recall_min_score, 0.01, 'memCfg?.recall_min_score'),
    captureMaxChars: num(memCfg?.capture_max_chars, 500, 'memCfg?.capture_max_chars'),
    historyLoadCount: num(memCfg?.history_load_count, 5, 'memCfg?.history_load_count'),
    historyMaxTokens: num(memCfg?.history_max_tokens, 1000, 'memCfg?.history_max_tokens'),
    summarizeInterval: num(memCfg?.summarize_interval, 20, 'memCfg?.summarize_interval'),
    outputLanguage: str(memCfg?.output_language, 'Auto', 'memCfg?.output_language'),
    decayHalfLifeDays: num(memCfg?.decay_half_life_days, 30, 'memCfg?.decay_half_life_days'),
    embeddingCacheMaxEntries: num(
      memCfg?.embedding_cache_max_entries,
      10000,
      'memCfg?.embedding_cache_max_entries',
    ),
    queryEmbeddingTimeoutMs: num(
      memCfg?.query_embedding_timeout_ms,
      10_000,
      'memCfg?.query_embedding_timeout_ms',
    ),
    queryPlanner: {
      enabled: yamlBool(memCfg?.query_planner?.enabled, true, 'memCfg?.query_planner?.enabled'),
      commonalityCoverage: yamlBool(
        memCfg?.query_planner?.commonality_coverage,
        true,
        'memCfg?.query_planner?.commonality_coverage',
      ),
      speakerBoost: num(
        memCfg?.query_planner?.speaker_boost,
        0.05,
        'memCfg?.query_planner?.speaker_boost',
      ),
      perSlotFloor: num(
        memCfg?.query_planner?.per_slot_floor,
        2,
        'memCfg?.query_planner?.per_slot_floor',
      ),
      maxEntities: num(
        memCfg?.query_planner?.max_entities,
        4,
        'memCfg?.query_planner?.max_entities',
      ),
      llm: {
        enabled: yamlBool(
          memCfg?.query_planner?.llm?.enabled,
          false,
          'memCfg?.query_planner?.llm?.enabled',
        ),
      },
    },
    recall: {
      prefilterMultiplier: num(
        memCfg?.recall?.prefilter_multiplier,
        5,
        'memCfg?.recall?.prefilter_multiplier',
      ),
      prefilterMin: num(memCfg?.recall?.prefilter_min, 20, 'memCfg?.recall?.prefilter_min'),
      mergeCandidateMultiplier: num(
        memCfg?.recall?.merge_candidate_multiplier,
        3,
        'memCfg?.recall?.merge_candidate_multiplier',
      ),
    },
    expansion: {
      enabled: yamlBool(memCfg?.expansion?.enabled, false, 'memCfg?.expansion?.enabled'),
      minQueryLength: num(
        memCfg?.expansion?.min_query_length,
        15,
        'memCfg?.expansion?.min_query_length',
      ),
      minScoreTrigger: num(
        memCfg?.expansion?.min_score_trigger,
        0.3,
        'memCfg?.expansion?.min_score_trigger',
      ),
      maxVariants: num(memCfg?.expansion?.max_variants, 4, 'memCfg?.expansion?.max_variants'),
    },
    hygiene: {
      enabled: yamlBool(hygieneCfg?.enabled, true, 'hygieneCfg?.enabled'),
      retentionDays: num(hygieneCfg?.retention_days, 90, 'hygieneCfg?.retention_days'),
    },
    embeddingCircuitBreaker: {
      failureThreshold: num(cbCfg?.failure_threshold, 5, 'cbCfg?.failure_threshold'),
      cooldownSec: num(cbCfg?.cooldown_sec, 30, 'cbCfg?.cooldown_sec'),
    },
    offloading: {
      enabled: yamlBool(offloadCfg?.enabled, true, 'offloadCfg?.enabled'),
      maxRefsInContext: num(offloadCfg?.max_refs_in_context, 10, 'offloadCfg?.max_refs_in_context'),
      preserveInMessages: num(
        offloadCfg?.preserve_in_messages,
        2,
        'offloadCfg?.preserve_in_messages',
      ),
      refDir: offloadCfg?.ref_dir ? str(offloadCfg.ref_dir, '', 'offloadCfg.ref_dir') : '',
      retentionDays: num(offloadCfg?.retention_days, 7, 'offloadCfg?.retention_days'),
    },
    mermaidCanvas: {
      enabled: yamlBool(mermaidCfg?.enabled, false, 'mermaidCfg?.enabled'),
      injectFormat: str(mermaidCfg?.inject_format, 'summary', 'mermaidCfg?.inject_format'),
      phaseTagging: str(mermaidCfg?.phase_tagging, 'auto', 'mermaidCfg?.phase_tagging'),
      maxNodesInContext: num(
        mermaidCfg?.max_nodes_in_context,
        20,
        'mermaidCfg?.max_nodes_in_context',
      ),
    },
    persona: {
      enabled: yamlBool(personaCfg?.enabled, true, 'personaCfg?.enabled'),
      distillThreshold: num(personaCfg?.distill_threshold, 3, 'personaCfg?.distill_threshold'),
      minDistillIntervalHours: num(
        personaCfg?.min_distill_interval_hours,
        0,
        'personaCfg?.min_distill_interval_hours',
      ),
    },
    sceneClustering: {
      enabled: yamlBool(sceneCfg?.enabled, false, 'sceneCfg?.enabled'),
      windowDays: num(sceneCfg?.window_days, 7, 'sceneCfg?.window_days'),
      minMemories: num(sceneCfg?.min_memories, 5, 'sceneCfg?.min_memories'),
    },
    autoCompress: {
      enabled: yamlBool(compressCfg?.enabled, true, 'compressCfg?.enabled'),
      reserveTokens: num(compressCfg?.reserve_tokens, 16384, 'compressCfg?.reserve_tokens'),
      keepRecentTokens: num(
        compressCfg?.keep_recent_tokens,
        20000,
        'compressCfg?.keep_recent_tokens',
      ),
      model: compressModelCfg
        ? {
            primary: compressModelCfg.primary
              ? str(compressModelCfg.primary, '', 'compressModelCfg.primary')
              : undefined,
            fallback_models: strList(
              compressModelCfg.fallback_models,
              '',
              'compressModelCfg.fallback_models',
            ),
          }
        : undefined,
    },
    maintenance: {
      enabled: yamlBool(memCfg?.maintenance?.enabled, true, 'memCfg?.maintenance?.enabled'),
      intervalMs: num(memCfg?.maintenance?.interval_ms, 300000, 'memCfg?.maintenance?.interval_ms'),
      jobs: {
        memory_hygiene: yamlBool(
          memCfg?.maintenance?.jobs?.memory_hygiene,
          true,
          'memCfg?.maintenance?.jobs?.memory_hygiene',
        ),
        embedding_backfill: yamlBool(
          memCfg?.maintenance?.jobs?.embedding_backfill,
          true,
          'memCfg?.maintenance?.jobs?.embedding_backfill',
        ),
        embedding_cache_trim: yamlBool(
          memCfg?.maintenance?.jobs?.embedding_cache_trim,
          true,
          'memCfg?.maintenance?.jobs?.embedding_cache_trim',
        ),
        entity_backfill: yamlBool(
          memCfg?.maintenance?.jobs?.entity_backfill,
          true,
          'memCfg?.maintenance?.jobs?.entity_backfill',
        ),
        persona_consistency: yamlBool(
          memCfg?.maintenance?.jobs?.persona_consistency,
          true,
          'memCfg?.maintenance?.jobs?.persona_consistency',
        ),
        offload_hygiene: yamlBool(
          memCfg?.maintenance?.jobs?.offload_hygiene,
          true,
          'memCfg?.maintenance?.jobs?.offload_hygiene',
        ),
        scene_cluster: yamlBool(
          memCfg?.maintenance?.jobs?.scene_cluster,
          false,
          'memCfg?.maintenance?.jobs?.scene_cluster',
        ),
        memory_doctor: yamlBool(
          memCfg?.maintenance?.jobs?.memory_doctor,
          false,
          'memCfg?.maintenance?.jobs?.memory_doctor',
        ),
      },
    },
  };
}

/**
 * Convert a parsed config.yaml object into the raw shape expected by configSchema.
 * Defaults are handled by the Zod schema — this function only maps keys.
 */
export function yamlToAppConfigRaw(root: Record<string, any>): Record<string, unknown> {
  configIssues.length = 0;

  // Provider
  const provider = root.provider as YamlNode;
  const primaryRef = str(provider?.primary, '', 'provider?.primary');
  const { provider: piProvider, model: piModel } = primaryRef
    ? parseModelRef(primaryRef)
    : { provider: '', model: '' };
  const reasoningRef = str(provider?.reasoning, '', 'provider?.reasoning');
  const reasoningModel = reasoningRef.includes('/') ? parseModelRef(reasoningRef).model : '';

  // Channels
  const channels = root.channels as YamlNode;
  const feishu = channels?.feishu as YamlNode;
  const telegram = channels?.telegram as YamlNode;
  const wechat = channels?.wechat as YamlNode;
  const qq = channels?.qq as YamlNode;

  // Tools
  const toolsCfg = root.tools as YamlNode;
  const shellCfg = toolsCfg?.shell as YamlNode;
  const fileReadCfg = toolsCfg?.file_read as YamlNode;

  // Memory (section builder extracted to buildMemorySection)
  const memCfg = root.memory as YamlNode;

  // Sub-configs
  const vbCfg = root.vision_bridge as YamlNode;
  const wsCfg = root.web_search as YamlNode;
  const rlCfg = root.rate_limit as YamlNode;
  const cronCfg = root.cron as YamlNode;
  const embCfg = root.embedding as YamlNode;
  const dbCfg = root.database as YamlNode;
  const extCfg = root.extensions as YamlNode;
  const memAuxCfg = root.memory_aux_models as YamlNode;
  const cuCfg = root.computer_use as YamlNode;
  const cuSSH = cuCfg?.ssh as YamlNode;
  const cuNode = cuCfg?.node as YamlNode;

  const raw: Record<string, unknown> = {
    logging: { level: str(root.log_level, 'info', 'root.log_level') },
    uiLanguage: str(root.ui_language, 'en', 'root.ui_language'),
    setupWizardDone: root.setup_wizard_done === true,
    showToolCalls: yamlBool(root.show_tool_calls, true, 'root.show_tool_calls'),
    showSkillCalls: yamlBool(root.show_skill_calls, true, 'root.show_skill_calls'),

    feishu: {
      enabled: yamlBool(feishu?.enabled, false, 'feishu?.enabled'),
      // Accept both camelCase (from WebUI save) and snake_case (from manual YAML edit)
      appId: str(feishu?.appId ?? feishu?.app_id, '', 'feishu?.appId??feishu?.app_id'),
      appSecret: str(
        feishu?.appSecret ?? feishu?.app_secret,
        '',
        'feishu?.appSecret??feishu?.app_secret',
      ),
      botName: str(feishu?.botName ?? feishu?.bot_name, '', 'feishu?.botName??feishu?.bot_name'),
      region: str(feishu?.region, 'feishu', 'feishu?.region'),
      verificationToken: str(
        feishu?.verificationToken ?? feishu?.verification_token,
        '',
        'feishu?.verificationToken??feishu?.verification_token',
      ),
      encryptKey: str(
        feishu?.encryptKey ?? feishu?.encrypt_key,
        '',
        'feishu?.encryptKey??feishu?.encrypt_key',
      ),
      wsEnabled:
        str(feishu?.wsEnabled ?? feishu?.connection_mode ?? 'websocket', 'websocket') !== 'webhook',
    },

    piAi: {
      provider: piProvider,
      model: piModel,
      reasoningModel: reasoningModel || '',
      apiKey: str(provider?.api_key, '', 'provider?.api_key'),
      baseUrl: str(provider?.base_url, '', 'provider?.base_url') || undefined,
    },

    customProviders: mapCustomProviders(root.custom_providers),

    providerKeys:
      root.provider_keys || root.providerKeys
        ? mapProviderKeys(root.provider_keys || root.providerKeys)
        : undefined,

    fallbackModels: strList(root.fallback_models, '', 'root.fallback_models'),

    defaultReasoningLevel: str(
      root.default_reasoning_level,
      'high',
      'root.default_reasoning_level',
    ),

    memoryAuxModels: memAuxCfg
      ? {
          primary: memAuxCfg.primary ? str(memAuxCfg.primary, '', 'memAuxCfg.primary') : undefined,
          fallback_models: strList(memAuxCfg.fallback_models, '', 'memAuxCfg.fallback_models'),
        }
      : undefined,

    // v5: Pass multimodal config through (keys match zod schema directly)
    multimodal: root.multimodal,

    // Legacy: kept for backward-compat; prefer multimodal.image.bridge
    visionBridge: vbCfg
      ? {
          enabled: yamlBool(vbCfg.enabled, false, 'vbCfg.enabled'),
          modelRef: vbCfg.model_ref ? str(vbCfg.model_ref, '', 'vbCfg.model_ref') : undefined,
          apiKey: vbCfg.api_key ? str(vbCfg.api_key, '', 'vbCfg.api_key') : undefined,
          baseUrl: vbCfg.base_url ? str(vbCfg.base_url, '', 'vbCfg.base_url') : undefined,
          timeoutMs: num(vbCfg.timeout_ms, 120_000, 'vbCfg.timeout_ms'),
          maxNoteChars: num(vbCfg.max_note_chars, 3200, 'vbCfg.max_note_chars'),
          maxCacheEntries: num(vbCfg.max_cache_entries, 256, 'vbCfg.max_cache_entries'),
        }
      : undefined,

    embedding: {
      baseUrl: str(embCfg?.base_url, '', 'embCfg?.base_url'),
      apiKey: str(embCfg?.api_key, '', 'embCfg?.api_key'),
      model: str(embCfg?.model, '', 'embCfg?.model'),
      dimension: num(embCfg?.dimension, 0, 'embCfg?.dimension'),
      maxInputChars: num(embCfg?.max_input_chars, 8000, 'embCfg?.max_input_chars'),
    },

    database: {
      path: str(dbCfg?.path, '~/.ohmyagent/data/app.db', 'dbCfg?.path'),
    },

    rateLimit: {
      webhookMaxRequests: num(rlCfg?.webhook_max, 100, 'rlCfg?.webhook_max'),
      webhookWindowMs: num(rlCfg?.webhook_window_ms, 60000, 'rlCfg?.webhook_window_ms'),
    },

    tools: {
      shellEnabled: yamlBool(
        shellCfg?.enabled ?? toolsCfg?.shell_enabled,
        true,
        'shellCfg?.enabled??toolsCfg?.shell_enabled',
      ),
      defaultTimeoutMs: num(shellCfg?.command_timeout_ms, 60000, 'shellCfg?.command_timeout_ms'),
      maxOutputLength: num(shellCfg?.max_output_chars, 12000, 'shellCfg?.max_output_chars'),
      toolsProfile: str(toolsCfg?.profile, 'standard', 'toolsCfg?.profile'),
      shellExecMode: str(shellCfg?.exec_mode, 'balanced', 'shellCfg?.exec_mode'),
      shellAllowlist: strList(shellCfg?.allowlist, '', 'shellCfg?.allowlist'),
      shellApprovalMode: str(shellCfg?.approval_mode, 'balanced', 'shellCfg?.approval_mode'),
      shellApprovalWhitelist: strList(
        shellCfg?.approval_whitelist,
        'date,ls,pwd,whoami,uname,echo,cat,head,tail,wc,grep,find,which,env,printenv',
        'tools.shell.approval_whitelist',
      ),
      shellApprovalTimeoutSec: num(
        toolsCfg?.shellApprovalTimeoutSec ?? shellCfg?.approval_timeout_sec,
        600,
        'tools.shell.approval_timeout_sec',
      ),
      shellApprovalTimeoutAction: str(
        shellCfg?.approval_timeout_action,
        'deny',
        'shellCfg?.approval_timeout_action',
      ),
      fileRead: {
        allowedRoots: strList(fileReadCfg?.allowed_roots, '', 'fileReadCfg?.allowed_roots'),
        deniedPatterns: strList(
          fileReadCfg?.denied_patterns,
          '.env,*.pem,/etc/passwd,*/.ssh/*',
          'fileReadCfg?.denied_patterns',
        ),
      },
    },

    memory: buildMemorySection(memCfg),

    cron: {
      enabled: yamlBool(cronCfg?.enabled, true, 'cronCfg?.enabled'),
      tickIntervalMs: num(cronCfg?.tick_interval_ms, 30000, 'cronCfg?.tick_interval_ms'),
      dataDir: str(cronCfg?.data_dir, './cron', 'cronCfg?.data_dir'),
      executionTimeoutMs: num(
        cronCfg?.execution_timeout_ms,
        600_000,
        'cronCfg?.execution_timeout_ms',
      ),
      maxConcurrency: num(cronCfg?.max_concurrency, 4, 'cronCfg?.max_concurrency'),
    },

    webSearch: {
      providerOrder: strList(
        wsCfg?.provider_order,
        'anysearch, tavily, exa, baidu',
        'wsCfg?.provider_order',
      ),
      tavilyApiKey: wsCfg?.tavily_api_key
        ? str(wsCfg.tavily_api_key, '', 'wsCfg.tavily_api_key')
        : undefined,
      exaApiKey: wsCfg?.exa_api_key ? str(wsCfg.exa_api_key, '', 'wsCfg.exa_api_key') : undefined,
      baiduApiKey: wsCfg?.baidu_api_key
        ? str(wsCfg.baidu_api_key, '', 'wsCfg.baidu_api_key')
        : undefined,
      anysearchApiKey: wsCfg?.anysearch_api_key
        ? str(wsCfg.anysearch_api_key, '', 'wsCfg.anysearch_api_key')
        : undefined,
      searchTimeoutMs: num(wsCfg?.timeout_ms, 30000, 'wsCfg?.timeout_ms'),
      maxResults: num(wsCfg?.max_results, 5, 'wsCfg?.max_results'),
    },

    telegram:
      yamlBool(telegram?.enabled, false, 'telegram?.enabled') &&
      (telegram?.botToken || telegram?.bot_token)
        ? {
            enabled: true,
            // Accept both camelCase (from WebUI) and snake_case (manual YAML)
            botToken: str(
              telegram?.botToken ?? telegram?.bot_token,
              '',
              'telegram?.botToken??telegram?.bot_token',
            ),
            botName: str(
              telegram?.botName ?? telegram?.bot_name,
              '',
              'telegram?.botName??telegram?.bot_name',
            ),
            mode: str(telegram?.mode, 'polling', 'telegram?.mode'),
            webhookUrl:
              (telegram?.webhookUrl ?? telegram?.webhook_url)
                ? str(
                    telegram?.webhookUrl ?? telegram?.webhook_url,
                    '',
                    'telegram?.webhookUrl??telegram?.webhook_url',
                  )
                : undefined,
            webhookPort: num(
              telegram?.webhookPort ?? telegram?.webhook_port,
              8443,
              'telegram?.webhookPort??telegram?.webhook_port',
            ),
            webhookSecret:
              (telegram?.webhookSecret ?? telegram?.webhook_secret)
                ? str(
                    telegram?.webhookSecret ?? telegram?.webhook_secret,
                    '',
                    'telegram?.webhookSecret??telegram?.webhook_secret',
                  )
                : undefined,
            allowedUsers: strList(
              telegram?.allowedUsers ?? telegram?.allowed_users,
              '',
              'telegram?.allowedUsers??telegram?.allowed_users',
            ),
            allowedGroups: strList(
              telegram?.allowedGroups ?? telegram?.allowed_groups,
              '',
              'telegram?.allowedGroups??telegram?.allowed_groups',
            ),
            proxyUrl:
              (telegram?.proxyUrl ?? telegram?.proxy_url)
                ? str(
                    telegram?.proxyUrl ?? telegram?.proxy_url,
                    '',
                    'telegram?.proxyUrl??telegram?.proxy_url',
                  )
                : undefined,
            streamMode: str(
              telegram?.streamMode ?? telegram?.stream_mode,
              'edit',
              'telegram?.streamMode??telegram?.stream_mode',
            ),
            textLimit: num(
              telegram?.textLimit ?? telegram?.text_limit,
              4096,
              'telegram?.textLimit??telegram?.text_limit',
            ),
            streamIntervalMs: num(
              telegram?.streamIntervalMs ?? telegram?.stream_interval,
              500,
              'telegram?.streamIntervalMs??telegram?.stream_interval',
            ),
          }
        : undefined,

    wechat: yamlBool(wechat?.enabled, false, 'wechat?.enabled')
      ? {
          enabled: true,
          // Accept both camelCase (from WebUI) and snake_case (manual YAML)
          botToken:
            (wechat?.botToken ?? wechat?.bot_token)
              ? str(
                  wechat?.botToken ?? wechat?.bot_token,
                  '',
                  'wechat?.botToken??wechat?.bot_token',
                )
              : undefined,
          apiBase:
            str(
              wechat?.apiBase ?? wechat?.api_base,
              'https://ilinkai.weixin.qq.com',
              'wechat?.apiBase??wechat?.api_base',
            ).trim() || 'https://ilinkai.weixin.qq.com',
          cursorDir: str(
            wechat?.cursorDir ?? wechat?.cursor_dir,
            './data/wechat',
            'wechat?.cursorDir??wechat?.cursor_dir',
          ),
          textLimit: num(
            wechat?.textLimit ?? wechat?.text_limit,
            2048,
            'wechat?.textLimit??wechat?.text_limit',
          ),
          aesKey:
            (wechat?.aesKey ?? wechat?.aes_key)
              ? str(wechat?.aesKey ?? wechat?.aes_key, '', 'wechat?.aesKey??wechat?.aes_key')
              : undefined,
          allowedUsers: strList(
            wechat?.allowedUsers ?? wechat?.allowed_users,
            '',
            'wechat?.allowedUsers??wechat?.allowed_users',
          ),
        }
      : undefined,

    qq:
      yamlBool(qq?.enabled, false, 'qq?.enabled') &&
      (qq?.appId || qq?.app_id) &&
      (qq?.clientSecret || qq?.client_secret)
        ? {
            enabled: true,
            // Accept both camelCase (from WebUI) and snake_case (manual YAML)
            appId: str(qq?.appId ?? qq?.app_id, '', 'qq?.appId??qq?.app_id'),
            clientSecret: str(
              qq?.clientSecret ?? qq?.client_secret,
              '',
              'qq?.clientSecret??qq?.client_secret',
            ),
            sandbox: yamlBool(qq?.sandbox, false, 'qq?.sandbox'),
            allowedUsers: strList(
              qq?.allowedUsers ?? qq?.allowed_users,
              '',
              'qq?.allowedUsers??qq?.allowed_users',
            ),
            allowedGroups: strList(
              qq?.allowedGroups ?? qq?.allowed_groups,
              '',
              'qq?.allowedGroups??qq?.allowed_groups',
            ),
            textLimit: num(qq?.textLimit ?? qq?.text_limit, 1500, 'qq?.textLimit??qq?.text_limit'),
          }
        : undefined,

    extensions: {
      directory: str(extCfg?.directory, 'extensions', 'extCfg?.directory'),
    },

    agents: mapAgents(root.agents),

    computerUse: cuCfg
      ? {
          enabled: yamlBool(cuCfg?.enabled, false, 'cuCfg?.enabled'),
          provider: cuCfg.provider ? str(cuCfg.provider, 'auto', 'cuCfg.provider') : undefined,
          allowedApps:
            cuCfg.allowed_apps != null
              ? strList(cuCfg.allowed_apps, '', 'cuCfg.allowed_apps')
              : undefined,
          allowedAgents: strList(cuCfg.allowed_agents, '', 'cuCfg.allowed_agents'),
          approvalWhitelist: strList(cuCfg.approval_whitelist, '', 'cuCfg.approval_whitelist'),
          ssh: cuSSH
            ? {
                host: str(cuSSH.host, '', 'cuSSH.host'),
                user: str(cuSSH.user, '', 'cuSSH.user'),
                keyPath: str(cuSSH.key_path, '', 'cuSSH.key_path'),
                port: num(cuSSH.port, 22, 'cuSSH.port'),
                jumpHost: str(cuSSH.jump_host, '', 'cuSSH.jump_host'),
                display: str(cuSSH.display, ':0', 'cuSSH.display'),
              }
            : undefined,
          node: cuNode
            ? {
                url: str(cuNode.url, '', 'cuNode.url'),
                token: cuNode.token ? str(cuNode.token, '', 'cuNode.token') : undefined,
                adb: cuNode.adb
                  ? {
                      path: str(cuNode.adb.path, 'adb', 'cuNode.adb.path'),
                      serial: cuNode.adb.serial
                        ? str(cuNode.adb.serial, '', 'cuNode.adb.serial')
                        : undefined,
                      // 兼容 snake_case(手写 YAML)与 camelCase(WebUI 保存),camelCase 优先
                      manageScreen:
                        cuNode.adb.manageScreen !== undefined
                          ? Boolean(cuNode.adb.manageScreen)
                          : cuNode.adb.manage_screen !== undefined
                            ? Boolean(cuNode.adb.manage_screen)
                            : false,
                    }
                  : undefined,
              }
            : undefined,
          perPlatformProvider: cuCfg.per_platform_provider
            ? (cuCfg.per_platform_provider as Record<string, unknown> as Record<string, string>)
            : undefined,
        }
      : undefined,

    footer: (() => {
      const ftCfg = root.footer as YamlNode;
      return {
        showAgentName: yamlBool(ftCfg?.show_agent_name, true, 'ftCfg?.show_agent_name'),
        showModel: yamlBool(ftCfg?.show_model, true, 'ftCfg?.show_model'),
        showCompleted: yamlBool(ftCfg?.show_completed, false, 'ftCfg?.show_completed'),
        showElapsed: yamlBool(ftCfg?.show_elapsed, true, 'ftCfg?.show_elapsed'),
        showUsage: yamlBool(ftCfg?.show_usage, false, 'ftCfg?.show_usage'),
        showCacheHitRate: yamlBool(ftCfg?.show_cache_hit_rate, false, 'ftCfg?.show_cache_hit_rate'),
      };
    })(),

    // ── v4 sections (orchestrator, smart_agent_team, multimodal, policy) ──
    orchestrator: root.orchestrator
      ? {
          enabled: yamlBool((root.orchestrator as YamlNode)?.enabled, true),
          maxChildAgents: num((root.orchestrator as YamlNode)?.max_child_agents, 4),
          allowGrandchildren: yamlBool((root.orchestrator as YamlNode)?.allow_grandchildren, false),
          inheritApprovals: yamlBool((root.orchestrator as YamlNode)?.inherit_approvals, true),
          inheritAppApprovals: yamlBool(
            (root.orchestrator as YamlNode)?.inherit_app_approvals,
            true,
            'orchestrator.inherit_app_approvals',
          ),
        }
      : undefined,

    smart_agent_team: root.smart_agent_team
      ? {
          enabled: yamlBool((root.smart_agent_team as YamlNode)?.enabled, true),
          max_children: num((root.smart_agent_team as YamlNode)?.max_children, 4),
          // P1 M5: child agent wall-clock cap + abort settle grace period
          child_timeout_sec: num((root.smart_agent_team as YamlNode)?.child_timeout_sec, 300),
          child_settle_timeout_ms: num(
            (root.smart_agent_team as YamlNode)?.child_settle_timeout_ms,
            15_000,
            'smart_agent_team.child_settle_timeout_ms',
          ),
        }
      : undefined,

    // P1 M6: turn-level watchdog (0 disables the timeout)
    agent: root.agent
      ? {
          turn_timeout_sec: num((root.agent as YamlNode)?.turn_timeout_sec, 300),
          max_retries: num((root.agent as YamlNode)?.max_retries, 2),
        }
      : undefined,

    policy: root.policy
      ? {
          mode: str((root.policy as YamlNode)?.mode, 'balanced'),
          approval: (root.policy as YamlNode)?.approval
            ? {
                timeoutSec: num(
                  ((root.policy as YamlNode)?.approval as YamlNode)?.timeout_sec,
                  120,
                  'policy.approval.timeout_sec',
                ),
                timeoutAction: str(
                  ((root.policy as YamlNode)?.approval as YamlNode)?.timeout_action,
                  'deny',
                  'policy.approval.timeout_action',
                ),
              }
            : undefined,
        }
      : undefined,

    // Harness: map snake_case YAML → camelCase for Zod schema
    harness: (() => {
      const hc = root.harness as YamlNode;
      if (!hc) return undefined;
      const ht = hc.trigger as YamlNode;
      const hr = hc.rate_limit as YamlNode;
      const hp = hc.proposal as YamlNode;
      const hi = hc.interactive as YamlNode;
      return {
        enabled: hc.enabled !== undefined ? Boolean(hc.enabled) : undefined,
        channels: hc.channels,
        trigger: ht
          ? {
              minIdenticalRetries: num(ht.min_identical_retries, 3, 'ht.min_identical_retries'),
              minExplorationSteps: num(ht.min_exploration_steps, 8, 'ht.min_exploration_steps'),
              minConsecutiveErrors: num(ht.min_consecutive_errors, 3, 'ht.min_consecutive_errors'),
              minDependencyErrors: num(ht.min_dependency_errors, 2, 'ht.min_dependency_errors'),
            }
          : undefined,
        rateLimit: hr
          ? {
              cooldownMinutes: num(hr.cooldown_minutes, 30, 'hr.cooldown_minutes'),
              maxPerHour: num(hr.max_per_hour, 2, 'hr.max_per_hour'),
              maxPerDay: num(hr.max_per_day, 10, 'hr.max_per_day'),
              maxAutoApplyPerDay: num(hr.max_auto_apply_per_day, 5, 'hr.max_auto_apply_per_day'),
            }
          : undefined,
        proposal: hp
          ? {
              model: str(hp.model, 'default', 'hp.model'),
              maxEditsPerProposal: num(hp.max_edits_per_proposal, 5, 'hp.max_edits_per_proposal'),
            }
          : undefined,
        interactive: {
          enabled: hc.enabled !== undefined ? Boolean(hc.enabled) : true,
          ...(hi?.approval ? { approval: hi.approval } : {}),
        },
        rules: hc.rules,
      };
    })(),
  };

  if (configIssues.length > 0) {
    const details = configIssues
      .map((i) => `  - ${yamlKeyFromLabel(i.key)}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid config.yaml: ${configIssues.length} value(s) have the wrong type.\n${details}\n` +
        `Fix these keys (or remove them to accept defaults). Numeric strings are accepted so ${'$'}{ENV}` +
        ` interpolation keeps working.`,
    );
  }

  return raw;
}

// ─── Sub-mappers ───

function mapCustomProviders(yamlVal: unknown): CustomProviderConfig[] | undefined {
  if (!yamlVal || typeof yamlVal !== 'object') return undefined;
  const providers: CustomProviderConfig[] = [];
  for (const [name, cfg] of Object.entries(yamlVal as Record<string, any>)) {
    const p = cfg as Record<string, any>;
    if (!p.api_key || !p.base_url || !Array.isArray(p.models)) continue;
    const models: CustomModelConfig[] = p.models.map((m: any) => ({
      id: str(m.id, '', 'm.id'),
      name: str(m.name, m.id ?? '', 'm.name'),
      api: str(m.api, 'openai-completions', 'm.api'),
      reasoning: m.reasoning !== undefined ? Boolean(m.reasoning) : undefined,
      reasoningLevel: m.reasoning_level
        ? str(m.reasoning_level, '', 'm.reasoning_level')
        : undefined,
      contextWindow: m.context_window ? num(m.context_window, 0, 'm.context_window') : undefined,
      maxTokens: m.max_tokens ? num(m.max_tokens, 0, 'm.max_tokens') : undefined,
      input: Array.isArray(m.input) ? (m.input as ('text' | 'image')[]) : undefined,
      compat: mapCompat(m.compat),
      cost: m.cost
        ? {
            input: num(m.cost.input, 0, 'm.cost.input'),
            output: num(m.cost.output, 0, 'm.cost.output'),
            cacheRead: m.cost.cache_read ? num(m.cost.cache_read, 0, 'm.cost.cache_read') : 0,
            cacheWrite: m.cost.cache_write ? num(m.cost.cache_write, 0, 'm.cost.cache_write') : 0,
          }
        : undefined,
    }));
    providers.push({
      provider: name,
      apiKey: str(p.api_key, '', 'p.api_key'),
      baseUrl: str(p.base_url, '', 'p.base_url'),
      models,
    });
  }
  return providers.length > 0 ? providers : undefined;
}

function mapProviderKeys(yamlVal: unknown): Record<string, { apiKey?: string; baseUrl?: string }> {
  const result: Record<string, { apiKey?: string; baseUrl?: string }> = {};
  if (!yamlVal || typeof yamlVal !== 'object') return result;
  for (const [name, cfg] of Object.entries(yamlVal as Record<string, any>)) {
    const c = cfg as Record<string, any>;
    result[name] = {
      apiKey: c.api_key ? str(c.api_key, '', 'c.api_key') : undefined,
      baseUrl: c.base_url ? str(c.base_url, '', 'c.base_url') : undefined,
    };
  }
  return result;
}

function mapCompat(yamlVal: unknown): Record<string, unknown> | undefined {
  if (!yamlVal || typeof yamlVal !== 'object') return undefined;
  const raw = yamlVal as Record<string, unknown>;
  const mapped: Record<string, unknown> = {};
  const consumed = new Set<string>();
  const assign = (from: string, to: string) => {
    if (raw[from] !== undefined) {
      mapped[to] = raw[from];
      consumed.add(from);
    }
  };

  assign('supports_store', 'supportsStore');
  assign('supports_developer_role', 'supportsDeveloperRole');
  assign('supports_reasoning_effort', 'supportsReasoningEffort');
  assign('supports_usage_in_streaming', 'supportsUsageInStreaming');
  assign('max_tokens_field', 'maxTokensField');
  assign('requires_tool_result_name', 'requiresToolResultName');
  assign('requires_assistant_after_tool_result', 'requiresAssistantAfterToolResult');
  assign('requires_thinking_as_text', 'requiresThinkingAsText');
  assign(
    'requires_reasoning_content_on_assistant_messages',
    'requiresReasoningContentOnAssistantMessages',
  );
  assign('thinking_format', 'thinkingFormat');
  assign('cache_control_format', 'cacheControlFormat');
  assign('send_session_affinity_headers', 'sendSessionAffinityHeaders');
  assign('supports_long_cache_retention', 'supportsLongCacheRetention');
  assign('session_affinity_format', 'sessionAffinityFormat');
  assign('zai_tool_stream', 'zaiToolStream');
  assign('supports_strict_mode', 'supportsStrictMode');

  for (const [key, value] of Object.entries(raw)) {
    if (!consumed.has(key) && !key.includes('_')) mapped[key] = value;
  }

  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function mapAgents(yamlVal: unknown): AgentConfig[] | undefined {
  if (!yamlVal || typeof yamlVal !== 'object') return undefined;
  const agents: AgentConfig[] = [];
  for (const [id, a] of Object.entries(yamlVal as Record<string, any>)) {
    const o = a as Record<string, any>;
    const modelCfg = o.model as Record<string, any> | undefined;
    const toolsCfg = o.tools as Record<string, any> | undefined;
    const spawnCfg = o.spawn as Record<string, any> | undefined;
    const extCfg = o.extensions as Record<string, any> | undefined;
    agents.push({
      id,
      name: str(o.name, id, 'o.name'),
      description: o.description ? str(o.description, '', 'o.description') : undefined,
      system_prompt: o.system_prompt ? str(o.system_prompt, '', 'o.system_prompt') : undefined,
      model: modelCfg
        ? {
            primary: modelCfg.primary ? str(modelCfg.primary, '', 'modelCfg.primary') : undefined,
            fallback: modelCfg.fallback
              ? strList(modelCfg.fallback, '', 'modelCfg.fallback')
              : undefined,
            reasoning_level: modelCfg.reasoning_level
              ? str(modelCfg.reasoning_level, '', 'modelCfg.reasoning_level')
              : undefined,
            transport: modelCfg.transport
              ? str(modelCfg.transport, '', 'modelCfg.transport')
              : undefined,
            max_retry: modelCfg.max_retry
              ? num(modelCfg.max_retry, 0, 'modelCfg.max_retry')
              : undefined,
          }
        : undefined,
      tools: toolsCfg
        ? {
            profile: toolsCfg.profile
              ? (str(toolsCfg.profile, '', 'toolsCfg.profile') as ToolProfileId)
              : undefined,
            add: toolsCfg.add ? strList(toolsCfg.add, '', 'toolsCfg.add') : undefined,
            deny: toolsCfg.deny ? strList(toolsCfg.deny, '', 'toolsCfg.deny') : undefined,
          }
        : undefined,
      spawn: spawnCfg
        ? {
            enabled: spawnCfg.enabled !== undefined ? Boolean(spawnCfg.enabled) : undefined,
            max_parallel: spawnCfg.max_parallel
              ? num(spawnCfg.max_parallel, 0, 'spawnCfg.max_parallel')
              : undefined,
            allowed_personas: spawnCfg.allowed_personas
              ? strList(spawnCfg.allowed_personas, '', 'spawnCfg.allowed_personas')
              : undefined,
          }
        : undefined,
      extensions: extCfg
        ? {
            disable: extCfg.disable ? strList(extCfg.disable, '', 'extCfg.disable') : undefined,
          }
        : undefined,
      channels: o.channels ? strList(o.channels, '', 'o.channels') : undefined,
    });
  }
  return agents.length > 0 ? agents : undefined;
}

// ─── JS Config → YAML (inverse of yamlToAppConfigRaw) ───

/**
 * Convert JS-shaped config back to YAML structure.
 * Inverse of yamlToAppConfigRaw() — when the read-side mapping changes,
 * this function must be updated together with it.
 *
 * @param jsConfig - JS-shaped config (partial updates, only changed fields)
 * @param existingYaml - Current YAML for resolving partial data (e.g. piAi.provider without piAi.model)
 */
export function jsConfigToYaml(
  jsConfig: Record<string, unknown>,
  existingYaml: Record<string, unknown>,
): Record<string, unknown> {
  const yaml: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(jsConfig)) {
    if (value === undefined) continue;

    switch (key) {
      // ─── piAi → provider ───
      case 'piAi': {
        const piAi = value as Record<string, unknown>;
        const curProvider = (existingYaml.provider as Record<string, unknown>) || {};
        yaml.provider = { ...curProvider };
        const p = yaml.provider as Record<string, unknown>;

        // provider + model → model ref
        if (piAi.provider !== undefined || piAi.model !== undefined) {
          const curRef = (curProvider.primary as string) || '';
          const slashIdx = curRef.indexOf('/');
          const curProv = slashIdx >= 0 ? curRef.slice(0, slashIdx) : curRef;
          const curModel = slashIdx >= 0 ? curRef.slice(slashIdx + 1) : curRef;
          const newProv = piAi.provider !== undefined ? String(piAi.provider) : curProv;
          const newModel = piAi.model !== undefined ? String(piAi.model) : curModel;
          p.primary = `${newProv}/${newModel}`;
        }

        if (piAi.reasoningModel !== undefined) p.reasoning = piAi.reasoningModel;
        if (piAi.apiKey !== undefined) p.api_key = piAi.apiKey;
        if (piAi.baseUrl !== undefined) p.base_url = piAi.baseUrl;
        break;
      }

      // ─── Simple renames ───
      case 'fallbackModels':
        yaml.fallback_models = value;
        break;
      case 'defaultReasoningLevel':
        yaml.default_reasoning_level = value;
        break;
      case 'showToolCalls':
        yaml.show_tool_calls = value;
        break;
      case 'showSkillCalls':
        yaml.show_skill_calls = value;
        break;
      case 'uiLanguage':
        yaml.ui_language = value;
        break;
      case 'setupWizardDone':
        yaml.setup_wizard_done = value;
        break;

      // ─── memoryAuxModels → memory_aux_models ───
      case 'memoryAuxModels': {
        const mam = value as Record<string, unknown>;
        yaml.memory_aux_models = {
          ...((existingYaml.memory_aux_models as Record<string, unknown>) || {}),
        };
        const m = yaml.memory_aux_models as Record<string, unknown>;
        if (mam.primary !== undefined) m.primary = mam.primary;
        if (mam.fallback_models !== undefined) m.fallback_models = mam.fallback_models;
        break;
      }

      // ─── providerKeys / provider_keys (camelCase JS or snake_case from frontend) → provider_keys ───
      case 'providerKeys':
      case 'provider_keys': {
        const pks: Record<string, unknown> = {};
        for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
          const e = entry as Record<string, unknown>;
          pks[name] = {
            api_key: e.apiKey || e.api_key || undefined,
            base_url: e.baseUrl || e.base_url || undefined,
          };
        }
        yaml.provider_keys = pks;
        break;
      }

      // ─── customProviders → custom_providers ───
      case 'customProviders': {
        const cps: Record<string, unknown> = {};
        for (const cp of value as Array<Record<string, unknown>>) {
          cps[cp.provider as string] = {
            api_key: cp.apiKey,
            base_url: cp.baseUrl,
            models: (cp.models as Array<Record<string, unknown>>)?.map(
              (m: Record<string, unknown>) => ({
                id: m.id,
                name: m.name,
                api: m.api,
                reasoning: m.reasoning,
                reasoning_level: m.reasoningLevel ?? m.reasoning_level,
                context_window: m.contextWindow ?? m.context_window,
                max_tokens: m.maxTokens ?? m.max_tokens,
                input: m.input,
                cost: m.cost
                  ? {
                      input: (m.cost as Record<string, unknown>).input,
                      output: (m.cost as Record<string, unknown>).output,
                      cache_read:
                        (m.cost as Record<string, unknown>).cacheRead ??
                        (m.cost as Record<string, unknown>).cache_read ??
                        0,
                      cache_write:
                        (m.cost as Record<string, unknown>).cacheWrite ??
                        (m.cost as Record<string, unknown>).cache_write ??
                        0,
                    }
                  : undefined,
              }),
            ),
          };
        }
        yaml.custom_providers = cps;
        break;
      }

      // ─── embedding (baseUrl/apiKey → base_url/api_key) ───
      case 'embedding': {
        const emb = value as Record<string, unknown>;
        yaml.embedding = {
          ...((existingYaml.embedding as Record<string, unknown>) || {}),
        };
        const e = yaml.embedding as Record<string, unknown>;
        if (emb.baseUrl !== undefined) e.base_url = emb.baseUrl;
        if (emb.apiKey !== undefined) e.api_key = emb.apiKey;
        if (emb.model !== undefined) e.model = emb.model;
        if (emb.dimension !== undefined) e.dimension = emb.dimension;
        break;
      }

      // ─── logging.level → log_level ───
      case 'logging': {
        const log = value as Record<string, unknown>;
        if (log.level !== undefined) yaml.log_level = log.level;
        break;
      }

      // ─── database ───
      case 'database':
        yaml.database = value;
        break;

      // ─── rateLimit → rate_limit ───
      case 'rateLimit': {
        const rl = value as Record<string, unknown>;
        yaml.rate_limit = {
          ...((existingYaml.rate_limit as Record<string, unknown>) || {}),
        };
        const r = yaml.rate_limit as Record<string, unknown>;
        if (rl.webhookMaxRequests !== undefined) r.webhook_max = rl.webhookMaxRequests;
        if (rl.webhookWindowMs !== undefined) r.webhook_window_ms = rl.webhookWindowMs;
        break;
      }

      // ─── multimodal.image.bridge → multimodal.image.bridge ───
      case 'multimodal.image.bridge':
      case 'visionBridge': {
        const vb = value as Record<string, unknown>;
        // Build the nested YAML path
        yaml.multimodal = { ...((existingYaml.multimodal as Record<string, unknown>) || {}) };
        const mm = yaml.multimodal as Record<string, unknown>;
        mm.image = { ...((mm.image as Record<string, unknown>) || {}) };
        const img = mm.image as Record<string, unknown>;
        img.bridge = { ...((img.bridge as Record<string, unknown>) || {}) };
        const v = img.bridge as Record<string, unknown>;
        if (vb.enabled !== undefined) v.enabled = vb.enabled;
        if (vb.modelRef !== undefined) v.model_ref = vb.modelRef;
        if (vb.apiKey !== undefined) v.api_key = vb.apiKey;
        if (vb.baseUrl !== undefined) v.base_url = vb.baseUrl;
        if (vb.timeoutMs !== undefined) v.timeout_ms = vb.timeoutMs;
        if (vb.maxNoteChars !== undefined) v.max_note_chars = vb.maxNoteChars;
        // Remove old vision_bridge key if it exists (migration)
        delete yaml.vision_bridge;
        break;
      }

      // ─── webSearch → web_search ───
      case 'webSearch': {
        const ws = value as Record<string, unknown>;
        yaml.web_search = {
          ...((existingYaml.web_search as Record<string, unknown>) || {}),
        };
        const w = yaml.web_search as Record<string, unknown>;
        if (ws.providerOrder !== undefined) w.provider_order = ws.providerOrder;
        if (ws.searchTimeoutMs !== undefined) w.timeout_ms = ws.searchTimeoutMs;
        if (ws.maxResults !== undefined) w.max_results = ws.maxResults;
        if (ws.tavilyApiKey !== undefined) w.tavily_api_key = ws.tavilyApiKey;
        if (ws.exaApiKey !== undefined) w.exa_api_key = ws.exaApiKey;
        if (ws.baiduApiKey !== undefined) w.baidu_api_key = ws.baiduApiKey;
        if (ws.anysearchApiKey !== undefined) w.anysearch_api_key = ws.anysearchApiKey;
        break;
      }

      // ─── computerUse → computer_use ───
      case 'computerUse': {
        const cu = value as Record<string, unknown>;
        yaml.computer_use = {
          ...((existingYaml.computer_use as Record<string, unknown>) || {}),
        };
        const c = yaml.computer_use as Record<string, unknown>;
        if (cu.enabled !== undefined) c.enabled = cu.enabled;
        if (cu.provider !== undefined) c.provider = cu.provider;
        if (cu.ssh) {
          const ssh = cu.ssh as Record<string, unknown>;
          c.ssh = { ...((c.ssh as Record<string, unknown>) || {}) };
          const s = c.ssh as Record<string, unknown>;
          if (ssh.host !== undefined) s.host = ssh.host;
          if (ssh.user !== undefined) s.user = ssh.user;
          if (ssh.port !== undefined) s.port = ssh.port;
          if (ssh.keyPath !== undefined) s.key_path = ssh.keyPath;
          if (ssh.jumpHost !== undefined) s.jump_host = ssh.jumpHost;
        }
        if (cu.node) c.node = cu.node;
        break;
      }

      // ─── policy → policy ───
      case 'policy': {
        const pol = value as Record<string, unknown>;
        yaml.policy = {
          ...((existingYaml.policy as Record<string, unknown>) || {}),
        };
        const p = yaml.policy as Record<string, unknown>;
        if (pol.mode !== undefined) p.mode = pol.mode;
        if (pol.approval) {
          const appr = pol.approval as Record<string, unknown>;
          p.approval = { ...((p.approval as Record<string, unknown>) || {}) };
          const a = p.approval as Record<string, unknown>;
          if (appr.timeoutSec !== undefined) a.timeout_sec = appr.timeoutSec;
          if (appr.timeoutAction !== undefined) a.timeout_action = appr.timeoutAction;
        }
        break;
      }

      // ─── orchestrator → orchestrator ───
      case 'orchestrator': {
        const orch = value as Record<string, unknown>;
        yaml.orchestrator = {
          ...((existingYaml.orchestrator as Record<string, unknown>) || {}),
        };
        const o = yaml.orchestrator as Record<string, unknown>;
        if (orch.enabled !== undefined) o.enabled = orch.enabled;
        if (orch.maxChildAgents !== undefined) o.max_child_agents = orch.maxChildAgents;
        if (orch.inheritApprovals !== undefined) o.inherit_approvals = orch.inheritApprovals;
        break;
      }

      // ─── smart_agent_team (already snake_case) ───
      case 'smart_agent_team':
        yaml.smart_agent_team = value;
        break;

      // ─── agent (P1 M6, already snake_case) ───
      case 'agent':
        yaml.agent = value;
        break;

      // ─── multimodal (already snake_case) ───
      case 'multimodal':
        yaml.multimodal = value;
        break;

      // ─── footer → footer ───
      case 'footer': {
        const ft = value as Record<string, unknown>;
        yaml.footer = {
          ...((existingYaml.footer as Record<string, unknown>) || {}),
        };
        const f = yaml.footer as Record<string, unknown>;
        if (ft.showAgentName !== undefined) f.show_agent_name = ft.showAgentName;
        if (ft.showModel !== undefined) f.show_model = ft.showModel;
        if (ft.showCompleted !== undefined) f.show_completed = ft.showCompleted;
        if (ft.showElapsed !== undefined) f.show_elapsed = ft.showElapsed;
        if (ft.showUsage !== undefined) f.show_usage = ft.showUsage;
        if (ft.showCacheHitRate !== undefined) f.show_cache_hit_rate = ft.showCacheHitRate;
        break;
      }

      // ─── Channels ───
      case 'feishu':
      case 'telegram':
      case 'wechat':
      case 'qq': {
        const channels = (yaml.channels || existingYaml.channels || {}) as Record<string, unknown>;
        yaml.channels = channels;
        const chKey = key; // feishu/telegram/wechat/qq — same name in YAML
        channels[chKey] = {
          ...((channels[chKey] as Record<string, unknown>) || {}),
          ...(value as Record<string, unknown>),
        };
        // Map feishu.wsEnabled → connection_mode
        if (key === 'feishu' && (value as Record<string, unknown>).wsEnabled !== undefined) {
          const f = channels.feishu as Record<string, unknown>;
          f.connection_mode = (value as Record<string, unknown>).wsEnabled
            ? 'websocket'
            : 'webhook';
          delete f.wsEnabled;
        }
        break;
      }

      // ─── Sections with snake_case sub-fields (memory, tools) ───
      case 'memory': {
        const mem = value as Record<string, unknown>;
        yaml.memory = {
          ...((existingYaml.memory as Record<string, unknown>) || {}),
        };
        const m = yaml.memory as Record<string, unknown>;
        // Top-level memory fields
        const memTopMap: Record<string, string> = {
          autoRecall: 'auto_recall',
          autoRecallFrequency: 'auto_recall_frequency',
          autoCapture: 'auto_capture',
          recallTopK: 'recall_top_k',
          recallMinScore: 'recall_min_score',
          captureMaxChars: 'capture_max_chars',
          summarizeInterval: 'summarize_interval',
          outputLanguage: 'output_language',
          historyLoadCount: 'history_load_count',
          historyMaxTokens: 'history_max_tokens',
          decayHalfLifeDays: 'decay_half_life_days',
          embeddingCacheMaxEntries: 'embedding_cache_max_entries',
          queryEmbeddingTimeoutMs: 'query_embedding_timeout_ms',
        };
        for (const [jsKey, yamlKey] of Object.entries(memTopMap)) {
          if (mem[jsKey] !== undefined) m[yamlKey] = mem[jsKey];
        }
        // Sub-sections
        for (const sub of [
          'hygiene',
          'persona',
          'sceneClustering',
          'maintenance',
          'autoCompress',
        ]) {
          if (mem[sub]) {
            const subMap: Record<string, string> = {
              hygiene: 'hygiene',
              persona: 'persona',
              sceneClustering: 'scene_clustering',
              maintenance: 'maintenance',
              autoCompress: 'auto_compress',
            };
            m[subMap[sub]] = {
              ...((m[subMap[sub]] as Record<string, unknown>) || {}),
              ...(mem[sub] as Record<string, unknown>),
            };
          }
        }
        if (mem.embeddingCircuitBreaker) {
          const ecb = mem.embeddingCircuitBreaker as Record<string, unknown>;
          m.embedding_circuit_breaker = {
            ...((m.embedding_circuit_breaker as Record<string, unknown>) || {}),
          };
          const e = m.embedding_circuit_breaker as Record<string, unknown>;
          if (ecb.failureThreshold !== undefined) e.failure_threshold = ecb.failureThreshold;
          if (ecb.cooldownSec !== undefined) e.cooldown_sec = ecb.cooldownSec;
        }
        if (mem.offloading) {
          const off = mem.offloading as Record<string, unknown>;
          m.offloading = { ...((m.offloading as Record<string, unknown>) || {}) };
          const o = m.offloading as Record<string, unknown>;
          if (off.enabled !== undefined) o.enabled = off.enabled;
          if (off.maxRefsInContext !== undefined) o.max_refs_in_context = off.maxRefsInContext;
          if (off.preserveInMessages !== undefined) o.preserve_in_messages = off.preserveInMessages;
          if (off.retentionDays !== undefined) o.retention_days = off.retentionDays;
        }
        if (mem.mermaidCanvas) {
          const mc = mem.mermaidCanvas as Record<string, unknown>;
          m.mermaid_canvas = { ...((m.mermaid_canvas as Record<string, unknown>) || {}) };
          const n = m.mermaid_canvas as Record<string, unknown>;
          if (mc.enabled !== undefined) n.enabled = mc.enabled;
          if (mc.injectFormat !== undefined) n.inject_format = mc.injectFormat;
          if (mc.phaseTagging !== undefined) n.phase_tagging = mc.phaseTagging;
          if (mc.maxNodesInContext !== undefined) n.max_nodes_in_context = mc.maxNodesInContext;
        }
        break;
      }

      // ─── tools → tools (with shell sub-section) ───
      case 'tools': {
        const tools = value as Record<string, unknown>;
        yaml.tools = {
          ...((existingYaml.tools as Record<string, unknown>) || {}),
        };
        const t = yaml.tools as Record<string, unknown>;
        const toolsTopMap: Record<string, string> = {
          toolsProfile: 'profile',
          shellEnabled: 'shell_enabled',
          shellExecMode: 'shell_exec_mode',
          shellApprovalMode: 'shell_approval_mode',
          shellApprovalTimeoutSec: 'shell_approval_timeout_sec',
          shellApprovalTimeoutAction: 'shell_approval_timeout_action',
        };
        for (const [jsKey, yamlKey] of Object.entries(toolsTopMap)) {
          if (tools[jsKey] !== undefined) t[yamlKey] = tools[jsKey];
        }
        if (tools.defaultTimeoutMs !== undefined || tools.maxOutputLength !== undefined) {
          t.shell = { ...((t.shell as Record<string, unknown>) || {}) };
          const s = t.shell as Record<string, unknown>;
          if (tools.defaultTimeoutMs !== undefined) s.command_timeout_ms = tools.defaultTimeoutMs;
          if (tools.maxOutputLength !== undefined) s.max_output_chars = tools.maxOutputLength;
        }
        if (tools.fileRead) {
          const fr = tools.fileRead as Record<string, unknown>;
          t.file_read = { ...((t.file_read as Record<string, unknown>) || {}) };
          const f = t.file_read as Record<string, unknown>;
          if (fr.allowedRoots !== undefined) f.allowed_roots = fr.allowedRoots;
          if (fr.deniedPatterns !== undefined) f.denied_patterns = fr.deniedPatterns;
        }
        break;
      }

      // ─── harness → harness (camelCase JS → snake_case YAML) ───
      case 'harness': {
        const h = value as Record<string, unknown>;
        const yh: Record<string, unknown> = {};

        if (h.enabled !== undefined) yh.enabled = h.enabled;

        // channels: same keys (webui, feishu, telegram, wechat, qq)
        if (h.channels) yh.channels = h.channels;

        // trigger: camelCase → snake_case
        if (h.trigger) {
          const t = h.trigger as Record<string, unknown>;
          yh.trigger = {};
          const yt = yh.trigger as Record<string, unknown>;
          if (t.minIdenticalRetries !== undefined) yt.min_identical_retries = t.minIdenticalRetries;
          if (t.minExplorationSteps !== undefined) yt.min_exploration_steps = t.minExplorationSteps;
          if (t.minConsecutiveErrors !== undefined)
            yt.min_consecutive_errors = t.minConsecutiveErrors;
        }

        // rateLimit → rate_limit (camelCase → snake_case)
        if (h.rateLimit) {
          const rl = h.rateLimit as Record<string, unknown>;
          yh.rate_limit = {};
          const yr = yh.rate_limit as Record<string, unknown>;
          if (rl.cooldownMinutes !== undefined) yr.cooldown_minutes = rl.cooldownMinutes;
          if (rl.maxPerHour !== undefined) yr.max_per_hour = rl.maxPerHour;
          if (rl.maxPerDay !== undefined) yr.max_per_day = rl.maxPerDay;
          if (rl.maxAutoApplyPerDay !== undefined)
            yr.max_auto_apply_per_day = rl.maxAutoApplyPerDay;
        }

        // proposal: same keys
        if (h.proposal) yh.proposal = h.proposal;

        // interactive.enabled → harness-level enabled; interactive.approval kept as-is
        if (h.interactive) {
          const inter = h.interactive as Record<string, unknown>;
          if (inter.enabled !== undefined) yh.enabled = inter.enabled;
          if (inter.approval) yh.interactive = { approval: inter.approval };
        }

        if (h.rules !== undefined) yh.rules = h.rules;

        yaml.harness = yh;
        break;
      }

      // ─── Unknown key — pass through as-is ───
      default:
        yaml[key] = value;
    }
  }

  return yaml;
}
