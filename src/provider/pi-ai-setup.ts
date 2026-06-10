/**
 * pi-ai Provider Setup
 *
 * Convenience wrappers around the pi-ai model registry.
 * Provides typed access to configured models.
 */

import { getModel } from '@earendil-works/pi-ai';
import type { AppConfig } from '../app/types.js';

// Model<TApi> is generic — use 'any' for convenience wrappers
type AnyModel = any;

/**
 * Get a model instance from the pi-ai registry.
 */
export function getModelInstance(provider: string, modelId: string): AnyModel {
  return getModel(provider as any, modelId as any);
}

/**
 * Get the default model from config.
 */
export function getDefaultModel(config: AppConfig): AnyModel {
  return getModel(config.piAi.provider as any, config.piAi.model as any);
}

/**
 * Get the reasoning model from config.
 */
export function getReasoningModel(config: AppConfig): AnyModel {
  return getModel(config.piAi.provider as any, config.piAi.reasoningModel as any);
}
