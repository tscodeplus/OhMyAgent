/**
 * pi-ai Provider Setup
 *
 * Convenience wrappers around the pi-ai model registry.
 * Provides typed access to configured models.
 */

import { getModel, getModels, registerModel } from '@earendil-works/pi-ai';
import type { AppConfig } from '../app/types.js';
import { createLogger } from '../app/logger.js';
import { ensureV1BaseUrl } from '../utils/base-url.js';

const logger = createLogger();

// Model<TApi> is generic — use 'any' for convenience wrappers
type AnyModel = any;

/**
 * Get a model instance from the pi-ai registry.
 */
export function getModelInstance(provider: string, modelId: string): AnyModel {
  return getModel(provider as any, modelId as any);
}

/**
 * Resolve a model ref against the registry, synthesizing a model definition
 * for unlisted models.
 *
 * Models picked from a provider's live model list (Settings → 获取模型列表)
 * are not necessarily present in the provider's configured `models:` list
 * (custom providers) or pi-mono's static catalog (built-in providers), so
 * `getModel()` returns undefined — the agent then runs with the pi-mono
 * DEFAULT_MODEL (api: "unknown") and every call fails with
 * "No API provider registered for api: unknown".
 *
 * Two synthesis paths:
 *
 * 1. Custom providers (`custom_providers`): synthesize from the provider
 *    config (API type inherited from the provider's first configured model,
 *    defaulting to the OpenAI completions API).
 *
 * 2. Built-in providers: only when the provider has credentials configured
 *    (`provider_keys` entry, or it is the `piAi` primary) — mirroring the
 *    requirement of the live model-list fetch. The built-in catalog's first
 *    model supplies the API type / baseUrl defaults. Returning undefined
 *    without credentials keeps the graceful fallback-to-default-model
 *    behavior for typo'd provider refs.
 *
 * Synthesized models are registered via `registerModel`, so every subsequent
 * `getModel()` caller resolves them. Returns undefined when the ref cannot
 * be synthesized.
 */
export function ensureModelRegistered(
  config: AppConfig,
  provider: string | undefined,
  modelId: string | undefined,
): AnyModel {
  if (!provider || !modelId) return undefined;

  // Already resolvable (custom registry or builtin catalog) → nothing to do.
  const existing = getModelInstance(provider, modelId);
  if (existing) return existing;

  // ── Path 1: custom provider (custom_providers config) ──
  const cp = config.customProviders?.find((p) => p.provider === provider);
  if (cp) {
    return synthesizeAndRegister(provider, modelId, {
      apiKey: cp.apiKey,
      baseUrl: cp.baseUrl,
      api: cp.models.find((m) => m.api)?.api,
      template: cp.models[0],
    });
  }

  // ── Path 2: built-in provider with credentials configured ──
  const pk = config.providerKeys?.[provider];
  const isPrimary = provider === config.piAi?.provider;
  const apiKey = pk?.apiKey || (isPrimary ? config.piAi?.apiKey : undefined);
  const baseUrlOverride = pk?.baseUrl || (isPrimary ? config.piAi?.baseUrl : undefined);
  if (!apiKey && !baseUrlOverride) return undefined;

  // Catalog models of this provider (builtin + any custom-registered) supply
  // the API type and default baseUrl. Unknown providers yield [] → fall back
  // to the OpenAI completions API / no baseUrl.
  const catalog = getModels(provider) as AnyModel[];
  return synthesizeAndRegister(provider, modelId, {
    apiKey,
    baseUrl: baseUrlOverride || catalog[0]?.baseUrl,
    api: catalog[0]?.api,
    template: catalog[0],
  });
}

interface SynthesisSource {
  apiKey?: string;
  baseUrl?: string;
  api?: string;
  template?: { contextWindow?: number; maxTokens?: number; input?: string[] };
}

function synthesizeAndRegister(
  provider: string,
  modelId: string,
  source: SynthesisSource,
): AnyModel {
  // Inherit the API type from the source template; virtually all custom
  // gateways and live /models endpoints are OpenAI-compatible, so that is
  // the default.
  const api = source.api ?? 'openai-completions';
  const template = source.template;

  const baseUrl = source.baseUrl ? ensureV1BaseUrl(source.baseUrl, api) : undefined;

  const model: Record<string, unknown> = {
    id: modelId,
    name: modelId,
    api,
    apiKey: source.apiKey,
    provider,
    baseUrl,
    reasoning: false,
    input: template?.input ?? ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: template?.contextWindow ?? 128000,
    maxTokens: template?.maxTokens ?? 16000,
  };
  // Match bootstrap's withCustomProviderCacheCompat session-affinity defaults.
  if (api === 'openai-completions') {
    model.compat = { sendSessionAffinityHeaders: true };
  } else if (api === 'openai-responses') {
    model.compat = { sessionAffinityFormat: 'openai' };
  }

  registerModel(provider, modelId, model as unknown as Parameters<typeof registerModel>[2]);
  logger.info(
    { provider, model: modelId, api, baseUrl },
    'Dynamically registered unlisted model (selected from live model list)',
  );
  return model;
}

/**
 * Get the default model from config. Falls back to a dynamically-synthesized
 * model when the configured ref is a custom-provider model that was picked
 * from the live model list and is not in the provider's `models:` list.
 */
export function getDefaultModel(config: AppConfig): AnyModel {
  return (
    ensureModelRegistered(config, config.piAi?.provider, config.piAi?.model) ??
    getModelInstance(config.piAi.provider, config.piAi.model)
  );
}

/**
 * Get the reasoning model from config. Uses the same dynamic fallback as
 * {@link getDefaultModel}.
 */
export function getReasoningModel(config: AppConfig): AnyModel {
  return (
    ensureModelRegistered(config, config.piAi?.provider, config.piAi?.reasoningModel) ??
    getModelInstance(config.piAi.provider, config.piAi.reasoningModel)
  );
}
