import { readFileSync, existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { CustomProviderConfig, CustomModelConfig, ToolProfileId } from './types.js';
import type { AgentConfig } from '../agent/config-types.js';
import { envBool } from '../shared/env.js';

// ─── Env interpolation ───

const ENV_INTERP_RE = /\$\{(\w+)\}/g;

type EnvMap = Record<string, string | undefined>;

/**
 * Recursively replace ${VAR_NAME} placeholders in strings.
 * Looks up values from `env` first, then falls back to process.env.
 */
function interpolateEnv(obj: unknown, env?: EnvMap): unknown {
  if (typeof obj === 'string') {
    return obj.replace(ENV_INTERP_RE, (_match, name: string) => env?.[name] ?? process.env[name] ?? '');
  }
  if (Array.isArray(obj)) return obj.map(v => interpolateEnv(v, env));
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


function str(val: unknown, defaultVal: string): string {
  if (typeof val === 'string') return val;
  if (val === undefined || val === null) return defaultVal;
  return String(val);
}

function num(val: unknown, defaultVal: number): number {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') { const n = Number(val); return isNaN(n) ? defaultVal : n; }
  return defaultVal;
}

function strList(val: unknown, defaultVal: string): string[] {
  if (Array.isArray(val)) return val.map(v => String(v).trim()).filter(Boolean);
  if (typeof val === 'string') return val.split(',').map(s => s.trim()).filter(Boolean);
  return defaultVal ? defaultVal.split(',').map(s => s.trim()).filter(Boolean) : [];
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
    autoRecall: envBool(memCfg?.auto_recall, false),
    autoRecallFrequency: str(memCfg?.auto_recall_frequency, 'first'),
    autoCapture: envBool(memCfg?.auto_capture, false),
    recallTopK: num(memCfg?.recall_top_k, 3),
    recallMinScore: num(memCfg?.recall_min_score, 0.01),
    captureMaxChars: num(memCfg?.capture_max_chars, 500),
    historyLoadCount: num(memCfg?.history_load_count, 5),
    historyMaxTokens: num(memCfg?.history_max_tokens, 1000),
    summarizeInterval: num(memCfg?.summarize_interval, 20),
    outputLanguage: str(memCfg?.output_language, 'Auto'),
    decayHalfLifeDays: num(memCfg?.decay_half_life_days, 30),
    embeddingCacheMaxEntries: num(memCfg?.embedding_cache_max_entries, 10000),
    queryEmbeddingTimeoutMs: num(memCfg?.query_embedding_timeout_ms, 10_000),
    queryPlanner: {
      enabled: envBool(memCfg?.query_planner?.enabled, true),
      commonalityCoverage: envBool(memCfg?.query_planner?.commonality_coverage, true),
      speakerBoost: num(memCfg?.query_planner?.speaker_boost, 0.05),
      perSlotFloor: num(memCfg?.query_planner?.per_slot_floor, 2),
      maxEntities: num(memCfg?.query_planner?.max_entities, 4),
      llm: { enabled: envBool(memCfg?.query_planner?.llm?.enabled, false) },
    },
    recall: {
      prefilterMultiplier: num(memCfg?.recall?.prefilter_multiplier, 5),
      prefilterMin: num(memCfg?.recall?.prefilter_min, 20),
      mergeCandidateMultiplier: num(memCfg?.recall?.merge_candidate_multiplier, 3),
    },
    expansion: {
      enabled: envBool(memCfg?.expansion?.enabled, false),
      minQueryLength: num(memCfg?.expansion?.min_query_length, 15),
      minScoreTrigger: num(memCfg?.expansion?.min_score_trigger, 0.3),
      maxVariants: num(memCfg?.expansion?.max_variants, 4),
    },
    hygiene: {
      enabled: envBool(hygieneCfg?.enabled, true),
      retentionDays: num(hygieneCfg?.retention_days, 90),
    },
    embeddingCircuitBreaker: {
      failureThreshold: num(cbCfg?.failure_threshold, 5),
      cooldownSec: num(cbCfg?.cooldown_sec, 30),
    },
    offloading: {
      enabled: envBool(offloadCfg?.enabled, true),
      maxRefsInContext: num(offloadCfg?.max_refs_in_context, 10),
      preserveInMessages: num(offloadCfg?.preserve_in_messages, 2),
      refDir: offloadCfg?.ref_dir ? str(offloadCfg.ref_dir, '') : '',
      retentionDays: num(offloadCfg?.retention_days, 7),
    },
    mermaidCanvas: {
      enabled: envBool(mermaidCfg?.enabled, false),
      injectFormat: str(mermaidCfg?.inject_format, 'summary'),
      phaseTagging: str(mermaidCfg?.phase_tagging, 'auto'),
      maxNodesInContext: num(mermaidCfg?.max_nodes_in_context, 20),
    },
    persona: {
      enabled: envBool(personaCfg?.enabled, true),
      distillThreshold: num(personaCfg?.distill_threshold, 3),
      minDistillIntervalHours: num(personaCfg?.min_distill_interval_hours, 0),
    },
    sceneClustering: {
      enabled: envBool(sceneCfg?.enabled, false),
      windowDays: num(sceneCfg?.window_days, 7),
      minMemories: num(sceneCfg?.min_memories, 5),
    },
    autoCompress: {
      enabled: envBool(compressCfg?.enabled, true),
      reserveTokens: num(compressCfg?.reserve_tokens, 16384),
      keepRecentTokens: num(compressCfg?.keep_recent_tokens, 20000),
      model: compressModelCfg ? {
        primary: compressModelCfg.primary ? str(compressModelCfg.primary, '') : undefined,
        fallback_models: strList(compressModelCfg.fallback_models, ''),
      } : undefined,
    },
    maintenance: {
      enabled: envBool(memCfg?.maintenance?.enabled, true),
      intervalMs: num(memCfg?.maintenance?.interval_ms, 300000),
      jobs: {
        memory_hygiene: envBool(memCfg?.maintenance?.jobs?.memory_hygiene, true),
        embedding_backfill: envBool(memCfg?.maintenance?.jobs?.embedding_backfill, true),
        embedding_cache_trim: envBool(memCfg?.maintenance?.jobs?.embedding_cache_trim, true),
        entity_backfill: envBool(memCfg?.maintenance?.jobs?.entity_backfill, true),
        persona_consistency: envBool(memCfg?.maintenance?.jobs?.persona_consistency, true),
        offload_hygiene: envBool(memCfg?.maintenance?.jobs?.offload_hygiene, true),
        scene_cluster: envBool(memCfg?.maintenance?.jobs?.scene_cluster, false),
        memory_doctor: envBool(memCfg?.maintenance?.jobs?.memory_doctor, false),
      },
    },
  };
}

/**
 * Convert a parsed config.yaml object into the raw shape expected by configSchema.
 * Defaults are handled by the Zod schema — this function only maps keys.
 */
export function yamlToAppConfigRaw(root: Record<string, any>): Record<string, unknown> {
  // Provider
  const provider = root.provider as YamlNode;
  const primaryRef = str(provider?.primary, '');
  const { provider: piProvider, model: piModel } = primaryRef ? parseModelRef(primaryRef) : { provider: '', model: '' };
  const reasoningRef = str(provider?.reasoning, '');
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
    logging: { level: str(root.log_level, 'info') },
    uiLanguage: str(root.ui_language, 'en'),
    setupWizardDone: root.setup_wizard_done === true,
    showToolCalls: envBool(root.show_tool_calls, true),
    showSkillCalls: envBool(root.show_skill_calls, true),

    feishu: {
      enabled: envBool(feishu?.enabled, false),
      // Accept both camelCase (from WebUI save) and snake_case (from manual YAML edit)
      appId: str(feishu?.appId ?? feishu?.app_id, ''),
      appSecret: str(feishu?.appSecret ?? feishu?.app_secret, ''),
      botName: str(feishu?.botName ?? feishu?.bot_name, ''),
      region: str(feishu?.region, 'feishu'),
      verificationToken: str(feishu?.verificationToken ?? feishu?.verification_token, ''),
      encryptKey: str(feishu?.encryptKey ?? feishu?.encrypt_key, ''),
      wsEnabled: str(feishu?.wsEnabled ?? feishu?.connection_mode ?? 'websocket', 'websocket') !== 'webhook',
    },

    piAi: {
      provider: piProvider,
      model: piModel,
      reasoningModel: reasoningModel || '',
      apiKey: str(provider?.api_key, ''),
      baseUrl: str(provider?.base_url, '') || undefined,
    },


    customProviders: mapCustomProviders(root.custom_providers),

    providerKeys: (root.provider_keys || root.providerKeys) ? mapProviderKeys(root.provider_keys || root.providerKeys) : undefined,

    fallbackModels: strList(root.fallback_models, ''),

    defaultReasoningLevel: str(root.default_reasoning_level, 'high'),

    memoryAuxModels: memAuxCfg ? {
      primary: memAuxCfg.primary ? str(memAuxCfg.primary, '') : undefined,
      fallback_models: strList(memAuxCfg.fallback_models, ''),
    } : undefined,

    // v5: Pass multimodal config through (keys match zod schema directly)
    multimodal: root.multimodal,

    // Legacy: kept for backward-compat; prefer multimodal.image.bridge
    visionBridge: vbCfg ? {
      enabled: envBool(vbCfg.enabled, false),
      modelRef: vbCfg.model_ref ? str(vbCfg.model_ref, '') : undefined,
      apiKey: vbCfg.api_key ? str(vbCfg.api_key, '') : undefined,
      baseUrl: vbCfg.base_url ? str(vbCfg.base_url, '') : undefined,
      timeoutMs: num(vbCfg.timeout_ms, 120_000),
      maxNoteChars: num(vbCfg.max_note_chars, 3200),
      maxCacheEntries: num(vbCfg.max_cache_entries, 256),
    } : undefined,

    embedding: {
      baseUrl: str(embCfg?.base_url, ''),
      apiKey: str(embCfg?.api_key, ''),
      model: str(embCfg?.model, ''),
      dimension: num(embCfg?.dimension, 0),
      maxInputChars: num(embCfg?.max_input_chars, 8000),
    },

    database: {
      path: str(dbCfg?.path, '~/.ohmyagent/data/app.db'),
    },

    rateLimit: {
      webhookMaxRequests: num(rlCfg?.webhook_max, 100),
      webhookWindowMs: num(rlCfg?.webhook_window_ms, 60000),
    },

    tools: {
      shellEnabled: envBool(shellCfg?.enabled ?? toolsCfg?.shell_enabled, true),
      defaultTimeoutMs: num(shellCfg?.command_timeout_ms, 60000),
      maxOutputLength: num(shellCfg?.max_output_chars, 12000),
      toolsProfile: str(toolsCfg?.profile, 'standard'),
      shellExecMode: str(shellCfg?.exec_mode, 'balanced'),
      shellAllowlist: strList(shellCfg?.allowlist, ''),
      shellApprovalMode: str(shellCfg?.approval_mode, 'balanced'),
      shellApprovalWhitelist: strList(shellCfg?.approval_whitelist,
        'date,ls,pwd,whoami,uname,echo,cat,head,tail,wc,grep,find,which,env,printenv'),
      shellApprovalTimeoutSec: num(toolsCfg?.shellApprovalTimeoutSec ?? shellCfg?.approval_timeout_sec, 600),
      shellApprovalTimeoutAction: str(shellCfg?.approval_timeout_action, 'deny'),
      fileRead: {
        allowedRoots: strList(fileReadCfg?.allowed_roots, ''),
        deniedPatterns: strList(fileReadCfg?.denied_patterns,
          '.env,*.pem,/etc/passwd,*/.ssh/*'),
      },
    },

    memory: buildMemorySection(memCfg),

    cron: {
      enabled: envBool(cronCfg?.enabled, true),
      tickIntervalMs: num(cronCfg?.tick_interval_ms, 30000),
      dataDir: str(cronCfg?.data_dir, './cron'),
      executionTimeoutMs: num(cronCfg?.execution_timeout_ms, 600_000),
      maxConcurrency: num(cronCfg?.max_concurrency, 4),
    },

    webSearch: {
      providerOrder: strList(wsCfg?.provider_order, 'anysearch, tavily, exa, baidu'),
      tavilyApiKey: wsCfg?.tavily_api_key ? str(wsCfg.tavily_api_key, '') : undefined,
      exaApiKey: wsCfg?.exa_api_key ? str(wsCfg.exa_api_key, '') : undefined,
      baiduApiKey: wsCfg?.baidu_api_key ? str(wsCfg.baidu_api_key, '') : undefined,
      anysearchApiKey: wsCfg?.anysearch_api_key ? str(wsCfg.anysearch_api_key, '') : undefined,
      searchTimeoutMs: num(wsCfg?.timeout_ms, 30000),
      maxResults: num(wsCfg?.max_results, 5),
    },

    telegram: envBool(telegram?.enabled, false) && (telegram?.botToken || telegram?.bot_token) ? {
      enabled: true,
      // Accept both camelCase (from WebUI) and snake_case (manual YAML)
      botToken: str(telegram?.botToken ?? telegram?.bot_token, ''),
      botName: str(telegram?.botName ?? telegram?.bot_name, ''),
      mode: str(telegram?.mode, 'polling'),
      webhookUrl: telegram?.webhookUrl ?? telegram?.webhook_url ? str(telegram?.webhookUrl ?? telegram?.webhook_url, '') : undefined,
      webhookPort: num(telegram?.webhookPort ?? telegram?.webhook_port, 8443),
      webhookSecret: telegram?.webhookSecret ?? telegram?.webhook_secret ? str(telegram?.webhookSecret ?? telegram?.webhook_secret, '') : undefined,
      allowedUsers: strList(telegram?.allowedUsers ?? telegram?.allowed_users, ''),
      allowedGroups: strList(telegram?.allowedGroups ?? telegram?.allowed_groups, ''),
      proxyUrl: telegram?.proxyUrl ?? telegram?.proxy_url ? str(telegram?.proxyUrl ?? telegram?.proxy_url, '') : undefined,
      streamMode: str(telegram?.streamMode ?? telegram?.stream_mode, 'edit'),
      textLimit: num(telegram?.textLimit ?? telegram?.text_limit, 4096),
      streamIntervalMs: num(telegram?.streamIntervalMs ?? telegram?.stream_interval, 500),
    } : undefined,

    wechat: envBool(wechat?.enabled, false) ? {
      enabled: true,
      // Accept both camelCase (from WebUI) and snake_case (manual YAML)
      botToken: wechat?.botToken ?? wechat?.bot_token ? str(wechat?.botToken ?? wechat?.bot_token, '') : undefined,
      apiBase: str(wechat?.apiBase ?? wechat?.api_base, 'https://ilinkai.weixin.qq.com'),
      cursorDir: str(wechat?.cursorDir ?? wechat?.cursor_dir, './data/wechat'),
      textLimit: num(wechat?.textLimit ?? wechat?.text_limit, 2048),
      aesKey: wechat?.aesKey ?? wechat?.aes_key ? str(wechat?.aesKey ?? wechat?.aes_key, '') : undefined,
      allowedUsers: strList(wechat?.allowedUsers ?? wechat?.allowed_users, ''),
    } : undefined,

    qq: envBool(qq?.enabled, false) && (qq?.appId || qq?.app_id) && (qq?.clientSecret || qq?.client_secret) ? {
      enabled: true,
      // Accept both camelCase (from WebUI) and snake_case (manual YAML)
      appId: str(qq?.appId ?? qq?.app_id, ''),
      clientSecret: str(qq?.clientSecret ?? qq?.client_secret, ''),
      sandbox: envBool(qq?.sandbox, false),
      allowedUsers: strList(qq?.allowedUsers ?? qq?.allowed_users, ''),
      allowedGroups: strList(qq?.allowedGroups ?? qq?.allowed_groups, ''),
      textLimit: num(qq?.textLimit ?? qq?.text_limit, 1500),
    } : undefined,

    extensions: {
      directory: str(extCfg?.directory, 'extensions'),
    },

    agents: mapAgents(root.agents),

    computerUse: cuCfg ? {
      enabled: envBool(cuCfg?.enabled, false),
      provider: cuCfg.provider ? str(cuCfg.provider, 'auto') : undefined,
      allowedApps: cuCfg.allowed_apps != null ? strList(cuCfg.allowed_apps, '') : undefined,
      allowedAgents: strList(cuCfg.allowed_agents, ''),
      approvalWhitelist: strList(cuCfg.approval_whitelist, ''),
      ssh: cuSSH ? {
        host: str(cuSSH.host, ''),
        user: str(cuSSH.user, ''),
        keyPath: str(cuSSH.key_path, ''),
        port: num(cuSSH.port, 22),
        jumpHost: str(cuSSH.jump_host, ''),
        display: str(cuSSH.display, ':0'),
      } : undefined,
      node: cuNode ? {
        url: str(cuNode.url, ''),
      } : undefined,
      perPlatformProvider: cuCfg.per_platform_provider
        ? (cuCfg.per_platform_provider as Record<string, unknown>) as Record<string, string>
        : undefined,
    } : undefined,

    footer: (() => {
      const ftCfg = root.footer as YamlNode;
      return {
        showAgentName: envBool(ftCfg?.show_agent_name, true),
        showModel: envBool(ftCfg?.show_model, true),
        showCompleted: envBool(ftCfg?.show_completed, false),
        showElapsed: envBool(ftCfg?.show_elapsed, true),
        showUsage: envBool(ftCfg?.show_usage, false),
        showCacheHitRate: envBool(ftCfg?.show_cache_hit_rate, false),
      };
    })(),

    // ── v4 sections (orchestrator, smart_agent_team, multimodal, policy) ──
    orchestrator: root.orchestrator ? {
      enabled: envBool((root.orchestrator as YamlNode)?.enabled, true),
      maxChildAgents: num((root.orchestrator as YamlNode)?.max_child_agents, 4),
      allowGrandchildren: envBool((root.orchestrator as YamlNode)?.allow_grandchildren, false),
      inheritApprovals: envBool((root.orchestrator as YamlNode)?.inherit_approvals, true),
      inheritAppApprovals: envBool((root.orchestrator as YamlNode)?.inherit_app_approvals, true),
    } : undefined,

    smart_agent_team: root.smart_agent_team ? {
      enabled: envBool((root.smart_agent_team as YamlNode)?.enabled, true),
      max_children: num((root.smart_agent_team as YamlNode)?.max_children, 4),
    } : undefined,

    policy: root.policy ? {
      mode: str((root.policy as YamlNode)?.mode, 'balanced'),
      approval: (root.policy as YamlNode)?.approval ? {
        timeoutSec: num(((root.policy as YamlNode)?.approval as YamlNode)?.timeout_sec, 120),
        timeoutAction: str(((root.policy as YamlNode)?.approval as YamlNode)?.timeout_action, 'deny'),
      } : undefined,
    } : undefined,
  };

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
      id: str(m.id, ''),
      name: str(m.name, m.id ?? ''),
      api: str(m.api, 'openai-completions'),
      reasoning: m.reasoning !== undefined ? Boolean(m.reasoning) : undefined,
      reasoningLevel: m.reasoning_level ? str(m.reasoning_level, '') : undefined,
      contextWindow: m.context_window ? num(m.context_window, 0) : undefined,
      maxTokens: m.max_tokens ? num(m.max_tokens, 0) : undefined,
      input: Array.isArray(m.input) ? m.input as ('text' | 'image')[] : undefined,
      compat: mapCompat(m.compat),
      cost: m.cost ? {
        input: num(m.cost.input, 0),
        output: num(m.cost.output, 0),
        cacheRead: m.cost.cache_read ? num(m.cost.cache_read, 0) : 0,
        cacheWrite: m.cost.cache_write ? num(m.cost.cache_write, 0) : 0,
      } : undefined,
    }));
    providers.push({
      provider: name,
      apiKey: str(p.api_key, ''),
      baseUrl: str(p.base_url, ''),
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
      apiKey: c.api_key ? str(c.api_key, '') : undefined,
      baseUrl: c.base_url ? str(c.base_url, '') : undefined,
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
  assign('requires_reasoning_content_on_assistant_messages', 'requiresReasoningContentOnAssistantMessages');
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
      name: str(o.name, id),
      description: o.description ? str(o.description, '') : undefined,
      system_prompt: o.system_prompt ? str(o.system_prompt, '') : undefined,
      model: modelCfg ? {
        primary: modelCfg.primary ? str(modelCfg.primary, '') : undefined,
        fallback: modelCfg.fallback ? strList(modelCfg.fallback, '') : undefined,
        reasoning_level: modelCfg.reasoning_level ? str(modelCfg.reasoning_level, '') : undefined,
        transport: modelCfg.transport ? str(modelCfg.transport, '') : undefined,
        max_retry: modelCfg.max_retry ? num(modelCfg.max_retry, 0) : undefined,
      } : undefined,
      tools: toolsCfg ? {
        profile: toolsCfg.profile ? str(toolsCfg.profile, '') as ToolProfileId : undefined,
        add: toolsCfg.add ? strList(toolsCfg.add, '') : undefined,
        deny: toolsCfg.deny ? strList(toolsCfg.deny, '') : undefined,
      } : undefined,
      spawn: spawnCfg ? {
        enabled: spawnCfg.enabled !== undefined ? Boolean(spawnCfg.enabled) : undefined,
        max_parallel: spawnCfg.max_parallel ? num(spawnCfg.max_parallel, 0) : undefined,
        allowed_personas: spawnCfg.allowed_personas ? strList(spawnCfg.allowed_personas, '') : undefined,
      } : undefined,
      extensions: extCfg ? {
        disable: extCfg.disable ? strList(extCfg.disable, '') : undefined,
      } : undefined,
      channels: o.channels ? strList(o.channels, '') : undefined,
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
      case 'fallbackModels': yaml.fallback_models = value; break;
      case 'defaultReasoningLevel': yaml.default_reasoning_level = value; break;
      case 'showToolCalls': yaml.show_tool_calls = value; break;
      case 'showSkillCalls': yaml.show_skill_calls = value; break;
      case 'uiLanguage': yaml.ui_language = value; break;
      case 'setupWizardDone': yaml.setup_wizard_done = value; break;

      // ─── memoryAuxModels → memory_aux_models ───
      case 'memoryAuxModels': {
        const mam = value as Record<string, unknown>;
        yaml.memory_aux_models = {
          ...(existingYaml.memory_aux_models as Record<string, unknown> || {}),
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
        for (const cp of (value as Array<Record<string, unknown>>)) {
          cps[cp.provider as string] = {
            api_key: cp.apiKey,
            base_url: cp.baseUrl,
            models: (cp.models as Array<Record<string, unknown>>)?.map((m: Record<string, unknown>) => ({
              id: m.id,
              name: m.name,
              api: m.api,
              reasoning: m.reasoning,
              reasoning_level: m.reasoningLevel ?? m.reasoning_level,
              context_window: m.contextWindow ?? m.context_window,
              max_tokens: m.maxTokens ?? m.max_tokens,
              input: m.input,
              cost: m.cost ? {
                input: (m.cost as Record<string, unknown>).input,
                output: (m.cost as Record<string, unknown>).output,
                cache_read: (m.cost as Record<string, unknown>).cacheRead ?? (m.cost as Record<string, unknown>).cache_read ?? 0,
                cache_write: (m.cost as Record<string, unknown>).cacheWrite ?? (m.cost as Record<string, unknown>).cache_write ?? 0,
              } : undefined,
            })),
          };
        }
        yaml.custom_providers = cps;
        break;
      }

      // ─── embedding (baseUrl/apiKey → base_url/api_key) ───
      case 'embedding': {
        const emb = value as Record<string, unknown>;
        yaml.embedding = {
          ...(existingYaml.embedding as Record<string, unknown> || {}),
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
      case 'database': yaml.database = value; break;

      // ─── rateLimit → rate_limit ───
      case 'rateLimit': {
        const rl = value as Record<string, unknown>;
        yaml.rate_limit = {
          ...(existingYaml.rate_limit as Record<string, unknown> || {}),
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
        yaml.multimodal = { ...(existingYaml.multimodal as Record<string, unknown> || {}) };
        const mm = yaml.multimodal as Record<string, unknown>;
        mm.image = { ...(mm.image as Record<string, unknown> || {}) };
        const img = mm.image as Record<string, unknown>;
        img.bridge = { ...(img.bridge as Record<string, unknown> || {}) };
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
          ...(existingYaml.web_search as Record<string, unknown> || {}),
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
          ...(existingYaml.computer_use as Record<string, unknown> || {}),
        };
        const c = yaml.computer_use as Record<string, unknown>;
        if (cu.enabled !== undefined) c.enabled = cu.enabled;
        if (cu.provider !== undefined) c.provider = cu.provider;
        if (cu.ssh) {
          const ssh = cu.ssh as Record<string, unknown>;
          c.ssh = { ...(c.ssh as Record<string, unknown> || {}) };
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
          ...(existingYaml.policy as Record<string, unknown> || {}),
        };
        const p = yaml.policy as Record<string, unknown>;
        if (pol.mode !== undefined) p.mode = pol.mode;
        if (pol.approval) {
          const appr = pol.approval as Record<string, unknown>;
          p.approval = { ...(p.approval as Record<string, unknown> || {}) };
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
          ...(existingYaml.orchestrator as Record<string, unknown> || {}),
        };
        const o = yaml.orchestrator as Record<string, unknown>;
        if (orch.enabled !== undefined) o.enabled = orch.enabled;
        if (orch.maxChildAgents !== undefined) o.max_child_agents = orch.maxChildAgents;
        if (orch.inheritApprovals !== undefined) o.inherit_approvals = orch.inheritApprovals;
        break;
      }

      // ─── smart_agent_team (already snake_case) ───
      case 'smart_agent_team': yaml.smart_agent_team = value; break;

      // ─── multimodal (already snake_case) ───
      case 'multimodal': yaml.multimodal = value; break;

      // ─── footer → footer ───
      case 'footer': {
        const ft = value as Record<string, unknown>;
        yaml.footer = {
          ...(existingYaml.footer as Record<string, unknown> || {}),
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
      case 'feishu': case 'telegram': case 'wechat': case 'qq': {
        const channels = (yaml.channels || existingYaml.channels || {}) as Record<string, unknown>;
        yaml.channels = channels;
        const chKey = key; // feishu/telegram/wechat/qq — same name in YAML
        channels[chKey] = {
          ...(channels[chKey] as Record<string, unknown> || {}),
          ...(value as Record<string, unknown>),
        };
        // Map feishu.wsEnabled → connection_mode
        if (key === 'feishu' && (value as Record<string, unknown>).wsEnabled !== undefined) {
          const f = channels.feishu as Record<string, unknown>;
          f.connection_mode = (value as Record<string, unknown>).wsEnabled ? 'websocket' : 'webhook';
          delete f.wsEnabled;
        }
        break;
      }

      // ─── Sections with snake_case sub-fields (memory, tools) ───
      case 'memory': {
        const mem = value as Record<string, unknown>;
        yaml.memory = {
          ...(existingYaml.memory as Record<string, unknown> || {}),
        };
        const m = yaml.memory as Record<string, unknown>;
        // Top-level memory fields
        const memTopMap: Record<string, string> = {
          autoRecall: 'auto_recall', autoRecallFrequency: 'auto_recall_frequency',
          autoCapture: 'auto_capture', recallTopK: 'recall_top_k',
          recallMinScore: 'recall_min_score', captureMaxChars: 'capture_max_chars',
          summarizeInterval: 'summarize_interval', outputLanguage: 'output_language',
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
        for (const sub of ['hygiene', 'persona', 'sceneClustering', 'maintenance', 'autoCompress']) {
          if (mem[sub]) {
            const subMap: Record<string, string> = {
              hygiene: 'hygiene', persona: 'persona',
              sceneClustering: 'scene_clustering', maintenance: 'maintenance',
              autoCompress: 'auto_compress',
            };
            m[subMap[sub]] = { ...(m[subMap[sub]] as Record<string, unknown> || {}), ...(mem[sub] as Record<string, unknown>) };
          }
        }
        if (mem.embeddingCircuitBreaker) {
          const ecb = mem.embeddingCircuitBreaker as Record<string, unknown>;
          m.embedding_circuit_breaker = {
            ...(m.embedding_circuit_breaker as Record<string, unknown> || {}),
          };
          const e = m.embedding_circuit_breaker as Record<string, unknown>;
          if (ecb.failureThreshold !== undefined) e.failure_threshold = ecb.failureThreshold;
          if (ecb.cooldownSec !== undefined) e.cooldown_sec = ecb.cooldownSec;
        }
        if (mem.offloading) {
          const off = mem.offloading as Record<string, unknown>;
          m.offloading = { ...(m.offloading as Record<string, unknown> || {}) };
          const o = m.offloading as Record<string, unknown>;
          if (off.enabled !== undefined) o.enabled = off.enabled;
          if (off.maxRefsInContext !== undefined) o.max_refs_in_context = off.maxRefsInContext;
          if (off.preserveInMessages !== undefined) o.preserve_in_messages = off.preserveInMessages;
          if (off.retentionDays !== undefined) o.retention_days = off.retentionDays;
        }
        if (mem.mermaidCanvas) {
          const mc = mem.mermaidCanvas as Record<string, unknown>;
          m.mermaid_canvas = { ...(m.mermaid_canvas as Record<string, unknown> || {}) };
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
          ...(existingYaml.tools as Record<string, unknown> || {}),
        };
        const t = yaml.tools as Record<string, unknown>;
        const toolsTopMap: Record<string, string> = {
          toolsProfile: 'profile', shellEnabled: 'shell_enabled',
          shellExecMode: 'shell_exec_mode',
          shellApprovalMode: 'shell_approval_mode',
          shellApprovalTimeoutSec: 'shell_approval_timeout_sec',
          shellApprovalTimeoutAction: 'shell_approval_timeout_action',
        };
        for (const [jsKey, yamlKey] of Object.entries(toolsTopMap)) {
          if (tools[jsKey] !== undefined) t[yamlKey] = tools[jsKey];
        }
        if (tools.defaultTimeoutMs !== undefined || tools.maxOutputLength !== undefined) {
          t.shell = { ...(t.shell as Record<string, unknown> || {}) };
          const s = t.shell as Record<string, unknown>;
          if (tools.defaultTimeoutMs !== undefined) s.command_timeout_ms = tools.defaultTimeoutMs;
          if (tools.maxOutputLength !== undefined) s.max_output_chars = tools.maxOutputLength;
        }
        if (tools.fileRead) {
          const fr = tools.fileRead as Record<string, unknown>;
          t.file_read = { ...(t.file_read as Record<string, unknown> || {}) };
          const f = t.file_read as Record<string, unknown>;
          if (fr.allowedRoots !== undefined) f.allowed_roots = fr.allowedRoots;
          if (fr.deniedPatterns !== undefined) f.denied_patterns = fr.deniedPatterns;
        }
        break;
      }

      // ─── Unknown key — pass through as-is ───
      default:
        yaml[key] = value;
    }
  }

  return yaml;
}
