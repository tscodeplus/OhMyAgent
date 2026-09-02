/**
 * Model Resolver
 *
 * Extracted from agent-factory.ts (Phase 8). Resolves the model to use for
 * an Agent turn: picks the correct model from agent config / explicit override /
 * default, determines cache profile (deepseek vs default), resolves thinking
 * level, and builds the fallback model chain.
 */

import { getModel, type Model, type KnownProvider } from '@earendil-works/pi-ai';
import type { Api } from '../pi-mono/ai/types.js';
import { getDefaultModel, ensureModelRegistered } from '../provider/pi-ai-setup.js';
import { ensureV1BaseUrl } from '../utils/base-url.js';
import type { AppConfig } from '../app/types.js';
import type { ResolvedAgentConfig } from './config-types.js';
import { createLogger } from '../app/logger.js';

const logger = createLogger();

// ── Types ──

/** Opaque model instance returned by getModel / getDefaultModel. */
type ModelInstance = Model<Api>;

/** Result of model resolution for a single Agent turn. */
export interface ResolvedModel {
  model: ModelInstance | undefined;
  modelProvider?: string;
  modelId?: string;
  /** Cache profile used by context-transform: 'deepseek' triggers prefix-cache-aware compaction. */
  cacheProfile: 'deepseek' | 'default';
  thinkingLevel: string;
  fallbackModels: ModelInstance[];
  /** Resolved context window size in tokens (0 if unknown). */
  contextWindow: number;
}

// ── Helpers ──

/**
 * Resolve a "provider/modelId" ref string into a ModelInstance.
 * Encapsulates the runtime string-split + getModel call so callers
 * don't need their own `as any` casts.
 */
export function resolveModelRef(ref: string, config?: AppConfig): ModelInstance | undefined {
  const idx = ref.indexOf('/');
  if (idx === -1) return undefined;
  const provider = ref.slice(0, idx);
  const modelId = ref.slice(idx + 1);
  // Custom-provider models picked from a provider's live model list may not be
  // in the provider's `models:` config — synthesize + register them on demand.
  if (config) {
    const dynamic = ensureModelRegistered(config, provider, modelId);
    if (dynamic) return dynamic as ModelInstance;
  }
  return getModel(
    provider as KnownProvider,
    modelId as never,
  ) as ModelInstance | undefined;
}

/**
 * Access a loosely-typed property on a model instance.
 * pi-mono Model<> carries opaque generics; concrete fields like .provider,
 * .id, .baseUrl exist at runtime but aren't exposed in the type signature.
 */
function modelProp<T>(model: ModelInstance | undefined, prop: string): T | undefined {
  return (model as unknown as Record<string, unknown>)?.[prop] as T | undefined;
}

/**
 * Check whether a model object belongs to a DeepSeek-family provider.
 * Used to select the cache profile (DeepSeek's automatic prefix-cache
 * benefits from different compaction heuristics).
 */
export function isDeepSeekLikeModel(model: ModelInstance | undefined): boolean {
  const provider = String(modelProp<string>(model, 'provider') ?? '').toLowerCase();
  const id = String(modelProp<string>(model, 'id') ?? '').toLowerCase();
  const baseUrl = String(modelProp<string>(model, 'baseUrl') ?? '').toLowerCase();
  return provider.includes('deepseek') || id.includes('deepseek') || baseUrl.includes('deepseek');
}

/**
 * Resolve the context window size from the model object.
 * Tries common property names; returns 0 if none found (fallback in threshold.ts).
 *
 * `maxTokens` is deliberately NOT a fallback here: it caps the model's OUTPUT,
 * so a model with an 8k completion limit would have been treated as an 8k
 * *context window* — which makes the compression trigger fire on almost every
 * turn. 0 means "unknown" and callers already handle it that way.
 */
export function resolveModelContextLength(model: ModelInstance | undefined): number {
  const contextWindow = modelProp<number>(model, 'contextWindow');
  if (typeof contextWindow === 'number') return contextWindow;
  const contextLength = modelProp<number>(model, 'context_length');
  if (typeof contextLength === 'number') return contextLength;
  return 0;
}

/**
 * Resolve the model for an Agent turn.
 *
 * Priority chain:
 *   1. Explicit model override from AgentCreateOptions
 *   2. Agent config model.primary (resolved via getModel)
 *   3. Default model from pi-ai-setup (provider default)
 *   4. Services default model (set at factory creation time)
 */
export function resolveModel(options: {
  explicitModel?: ModelInstance;
  agentConfig?: ResolvedAgentConfig;
  servicesDefaultModel?: ModelInstance;
  config: AppConfig;
}): ResolvedModel {
  const { explicitModel, agentConfig, servicesDefaultModel, config } = options;

  // 1. Start with explicit override → provider default → services default
  let model: ModelInstance | undefined = explicitModel ?? getDefaultModel(config) ?? servicesDefaultModel;

  // 2. Agent config model.primary overrides the default (but NOT an explicit override)
  if (agentConfig?.model.primary && !explicitModel) {
    const agentModel = resolveModelRef(agentConfig.model.primary, config);
    if (agentModel) {
      model = agentModel;
    } else {
      // Primary ref is unresolvable (bad provider/model name, or a model not
      // registered under its provider's `models:` list). Don't fail silently —
      // surface it so a typo'd primary doesn't get swallowed by the default model.
      logger.warn(
        { primary: agentConfig.model.primary },
        `Primary model "${agentConfig.model.primary}" could not be resolved; falling back to default model`,
      );
    }
  }

  // 3. Derive metadata from the resolved model
  const modelProvider = modelProp<string>(model, 'provider');
  const modelId = modelProp<string>(model, 'id');
  const cacheProfile = isDeepSeekLikeModel(model) ? 'deepseek' as const : 'default' as const;

  // 4. Look up custom model config for reasoning / thinking level
  const customModelCfg = config.customProviders
    ?.find(p => p.provider === modelProvider)
    ?.models.find(m => m.id === modelId);
  const thinkingLevel =
    customModelCfg?.reasoningLevel ??
    config.defaultReasoningLevel ??
    'off';

  // 5. Resolve fallback model chain.
  // A fallback ref that fails to resolve (e.g. a model listed in fallback_models
  // but not registered under its provider's `models:` list, or a provider with no
  // key) is dropped — but we warn so the silent degradation is visible.
  const fallbackModels: ModelInstance[] = [];
  for (const ref of config.fallbackModels ?? []) {
    const m = resolveModelRef(ref, config);
    if (m === undefined) {
      logger.warn({ ref }, `Fallback model "${ref}" could not be resolved and will be dropped from the fallback chain`);
    } else {
      fallbackModels.push(m);
    }
  }

  // 6. Resolve context window size
  const contextWindow = resolveModelContextLength(model);

  // 7. Apply config overrides to the resolved model.
  if (model) {
    // getModel() hands out the registry's own object for registered models, and
    // everything below is this agent's configuration. Writing it through would
    // leak a baseUrl/header/reasoning change into every other agent sharing the
    // model and keep serving stale values after a config hot-reload, so the
    // overrides run on a copy.
    const owned = { ...model } as unknown as Record<string, unknown>;
    if (owned.headers && typeof owned.headers === 'object') {
      owned.headers = { ...(owned.headers as Record<string, string>) };
    }
    model = owned as unknown as ModelInstance;
    // 7a. baseUrl override — priority mirrors getApiKey in agent-factory.ts.
    //    Dynamically-cloned models (from getModel's fallback path) inherit the
    //    template's built-in baseUrl, which may differ from the user's gateway.
    //    Normalize OpenAI-compatible URLs so a missing `/v1` segment is added
    //    (some built-in provider base URLs omit it, e.g. opencode).
    const cp = config.customProviders?.find(p => p.provider === modelProvider);
    let resolvedBaseUrl = (model as any).baseUrl as string | undefined;
    if (cp?.baseUrl) {
      // 1. Custom provider baseUrl
      resolvedBaseUrl = cp.baseUrl;
    } else {
      const pk = config.providerKeys?.[modelProvider ?? ''];
      if (pk?.baseUrl) {
        // 2. Built-in provider_keys baseUrl
        resolvedBaseUrl = pk.baseUrl;
      } else if (modelProvider === config.piAi.provider && config.piAi.baseUrl) {
        // 3. piAi.baseUrl (only for the primary provider)
        resolvedBaseUrl = config.piAi.baseUrl;
      }
    }
    if (resolvedBaseUrl) {
      (model as any).baseUrl = ensureV1BaseUrl(resolvedBaseUrl, (model as any).api as string | undefined);
    }

    // 7b. Strip NVCF-POLL-SECONDS header inherited from the template model.
    //    This header triggers NVIDIA NIM async long-polling, which is NOT
    //    supported by many models on the standard API catalog endpoint
    //    (e.g. minimaxai/minimax-m3). Models that need it have it set
    //    explicitly in models.generated.ts. Dynamic clones should not
    //    inherit it because their support for async inference is unknown.
    const headers = (model as any).headers as Record<string, string> | undefined;
    if (headers && 'NVCF-POLL-SECONDS' in headers) {
      delete headers['NVCF-POLL-SECONDS'];
    }

    // 7c. Patch NVIDIA model reasoning and compat.
    //    Dynamic model clones (from getModel's fallback path) inherit
    //    reasoning:false from the first registered template model
    //    (meta/llama-3.1-70b-instruct). Use custom provider config as
    //    the authoritative source for reasoning support.
    //    Also, all NVIDIA models have supportsReasoningEffort:false by
    //    default in compat — but models with reasoning:true need it set
    //    to actually send reasoning_effort via the OpenAI-compatible API.
    if (modelProvider === 'nvidia') {
      // reasoning override from custom provider model config
      if (customModelCfg?.reasoning !== undefined) {
        (model as any).reasoning = customModelCfg.reasoning;
      }
      // Enable reasoning_effort in compat for models that support reasoning
      if ((model as any).reasoning) {
        const currentCompat = (model as any).compat || {};
        if (!currentCompat.supportsReasoningEffort) {
          (model as any).compat = { ...currentCompat, supportsReasoningEffort: true };
        }
      }
    }
  }

  return { model, modelProvider, modelId, cacheProfile, thinkingLevel, fallbackModels, contextWindow };
}
