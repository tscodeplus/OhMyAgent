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
import { getDefaultModel } from '../provider/pi-ai-setup.js';
import type { AppConfig } from '../app/types.js';
import type { ResolvedAgentConfig } from './config-types.js';

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
function resolveModelRef(ref: string): ModelInstance | undefined {
  const idx = ref.indexOf('/');
  if (idx === -1) return undefined;
  return getModel(
    ref.slice(0, idx) as KnownProvider,
    ref.slice(idx + 1) as never,
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
 */
export function resolveModelContextLength(model: ModelInstance | undefined): number {
  const contextWindow = modelProp<number>(model, 'contextWindow');
  if (typeof contextWindow === 'number') return contextWindow;
  const contextLength = modelProp<number>(model, 'context_length');
  if (typeof contextLength === 'number') return contextLength;
  const maxTokens = modelProp<number>(model, 'maxTokens');
  if (typeof maxTokens === 'number') return maxTokens;
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
    const agentModel = resolveModelRef(agentConfig.model.primary);
    if (agentModel) model = agentModel;
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

  // 5. Resolve fallback model chain
  const fallbackModels: ModelInstance[] = (config.fallbackModels ?? [])
    .map(ref => resolveModelRef(ref))
    .filter((m): m is ModelInstance => m !== undefined);

  // 6. Resolve context window size
  const contextWindow = resolveModelContextLength(model);

  return { model, modelProvider, modelId, cacheProfile, thinkingLevel, fallbackModels, contextWindow };
}
