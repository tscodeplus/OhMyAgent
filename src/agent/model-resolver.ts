/**
 * Model Resolver
 *
 * Extracted from agent-factory.ts (Phase 8). Resolves the model to use for
 * an Agent turn: picks the correct model from agent config / explicit override /
 * default, determines cache profile (deepseek vs default), resolves thinking
 * level, and builds the fallback model chain.
 */

import { getModel } from '@earendil-works/pi-ai';
import { getDefaultModel } from '../provider/pi-ai-setup.js';
import type { AppConfig } from '../app/types.js';
import type { ResolvedAgentConfig } from './config-types.js';

/** Result of model resolution for a single Agent turn. */
export interface ResolvedModel {
  model: any;
  modelProvider?: string;
  modelId?: string;
  /** Cache profile used by context-transform: 'deepseek' triggers prefix-cache-aware compaction. */
  cacheProfile: 'deepseek' | 'default';
  thinkingLevel: string;
  fallbackModels: any[];
  /** Resolved context window size in tokens (0 if unknown). */
  contextWindow: number;
}

/**
 * Check whether a model object belongs to a DeepSeek-family provider.
 * Used to select the cache profile (DeepSeek's automatic prefix-cache
 * benefits from different compaction heuristics).
 */
export function isDeepSeekLikeModel(model: any): boolean {
  const provider = String(model?.provider ?? '').toLowerCase();
  const id = String(model?.id ?? '').toLowerCase();
  const baseUrl = String(model?.baseUrl ?? '').toLowerCase();
  return provider.includes('deepseek') || id.includes('deepseek') || baseUrl.includes('deepseek');
}

/**
 * Resolve the context window size from the model object.
 * Tries common property names; returns 0 if none found (fallback in threshold.ts).
 */
export function resolveModelContextLength(model: any): number {
  if (typeof model?.contextWindow === 'number') return model.contextWindow;
  if (typeof model?.context_length === 'number') return model.context_length;
  if (typeof model?.maxTokens === 'number') return model.maxTokens;
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
  explicitModel?: any;
  agentConfig?: ResolvedAgentConfig;
  servicesDefaultModel?: any;
  config: AppConfig;
}): ResolvedModel {
  const { explicitModel, agentConfig, servicesDefaultModel, config } = options;

  // 1. Start with explicit override → provider default → services default
  let model = explicitModel ?? getDefaultModel(config) ?? servicesDefaultModel;

  // 2. Agent config model.primary overrides the default (but NOT an explicit override)
  if (agentConfig?.model.primary && !explicitModel) {
    const ref = agentConfig.model.primary;
    const idx = ref.indexOf('/');
    if (idx !== -1) {
      const agentModel = getModel(ref.slice(0, idx) as any, ref.slice(idx + 1) as any) as any;
      if (agentModel) model = agentModel;
    }
  }

  // 3. Derive metadata from the resolved model
  const modelProvider = model?.provider as string | undefined;
  const modelId = model?.id as string | undefined;
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
  const fallbackModels = (config.fallbackModels ?? [])
    .map(ref => {
      const idx = ref.indexOf('/');
      if (idx === -1) return undefined;
      const provider = ref.slice(0, idx);
      const modelId = ref.slice(idx + 1);
      return getModel(provider as any, modelId as any) as any;
    })
    .filter(Boolean);

  // 6. Resolve context window size
  const contextWindow = resolveModelContextLength(model);

  return { model, modelProvider, modelId, cacheProfile, thinkingLevel, fallbackModels, contextWindow };
}
