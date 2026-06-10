import type { VisionBridgeConfig, ResolvedVisionModel } from './vision-bridge-types.js';
import type { CustomProviderConfig } from '../app/types.js';
import { getModel } from '@earendil-works/pi-ai';
import { getEnvApiKey } from '../pi-mono/ai/env-api-keys.js';
import { envBool } from '../shared/env.js';

export function loadVisionBridgeConfig(
  env: Record<string, string | undefined>,
): VisionBridgeConfig {
  return {
    enabled: envBool(env.VISION_BRIDGE_ENABLED, false),
    modelRef: env.VISION_BRIDGE_MODEL_REF?.trim() || undefined,
    apiKey: env.VISION_BRIDGE_API_KEY?.trim() || undefined,
    baseUrl: env.VISION_BRIDGE_BASE_URL?.trim() || undefined,
    timeoutMs: Number(env.VISION_BRIDGE_TIMEOUT_MS) || 120_000,
    maxNoteChars: Number(env.VISION_BRIDGE_MAX_NOTE_CHARS) || 3200,
    maxCacheEntries: Number(env.VISION_BRIDGE_MAX_CACHE_ENTRIES) || 256,
  };
}

/**
 * Hybrid resolution: MODEL_REF identifies the model, API_KEY/BASE_URL act as overrides.
 *
 *  1. MODEL_REF → getModel(provider, modelId) → built-in registry + custom_providers.yaml
 *  2. API Key:  explicit config > custom_providers.yaml > env var (OPENAI_API_KEY etc.)
 *  3. Base URL: explicit config > custom_providers.yaml > model built-in default
 */
export function resolveVisionModel(
  config: VisionBridgeConfig,
  customProviders: CustomProviderConfig[],
): ResolvedVisionModel {
  if (!config.modelRef) {
    throw new Error('VISION_BRIDGE_MODEL_REF is required when Vision Bridge is enabled');
  }

  const idx = config.modelRef.indexOf('/');
  if (idx === -1) {
    throw new Error(`Invalid VISION_BRIDGE_MODEL_REF format: ${config.modelRef}. Expected "provider/model-id"`);
  }
  const provider = config.modelRef.slice(0, idx);
  const modelId = config.modelRef.slice(idx + 1);

  // 1. Resolve model object from built-in registry
  const model = getModel(provider as any, modelId as any);
  if (!model) {
    throw new Error(
      `Vision model not found: ${config.modelRef}. Check that the model exists in built-in registry or custom_providers.yaml.`,
    );
  }

  if (!model.input?.includes('image')) {
    throw new Error(
      `Vision model ${config.modelRef} does not support image input. Its declared inputs are: ${JSON.stringify(model.input)}. Choose a multimodal model.`,
    );
  }

  // 2. Resolve API Key: explicit > custom provider yaml > env var (auto-mapped by pi-mono)
  let apiKey = config.apiKey;
  if (!apiKey) {
    const cp = customProviders.find(p => p.provider === provider);
    apiKey = cp?.apiKey;
  }
  if (!apiKey) {
    apiKey = getEnvApiKey(provider);
  }

  // 3. Resolve Base URL: explicit > custom provider yaml > model default
  let baseUrl = config.baseUrl;
  if (!baseUrl) {
    const cp = customProviders.find(p => p.provider === provider);
    baseUrl = cp?.baseUrl;
  }
  if (!baseUrl) {
    baseUrl = (model as any).baseUrl;
  }

  if (!apiKey) {
    throw new Error(
      `No API key found for vision model ${config.modelRef}. ` +
      `Set VISION_BRIDGE_API_KEY or the ${provider.toUpperCase()}_API_KEY env var, or define the provider in custom_providers.yaml.`,
    );
  }

  return { model, apiKey, baseUrl: baseUrl ?? '' };
}
