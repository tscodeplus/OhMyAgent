import type { AppConfig } from '../app/types.js';

export type ModelRole = 'default' | 'reasoning';

/**
 * Determine which model role to use based on conversation state.
 * Uses reasoning model when:
 * - Message count > 10, OR
 * - Messages contain tool results (indicating multi-step reasoning)
 */
export function routeModel(
  messageCount: number,
  hasToolResults: boolean,
): ModelRole {
  if (messageCount > 10 || hasToolResults) {
    return 'reasoning';
  }
  return 'default';
}

/**
 * Get the model ID for a given role from config.
 */
export function getModelForRole(config: AppConfig, role: ModelRole): {
  provider: string;
  model: string;
} {
  if (role === 'reasoning') {
    return {
      provider: config.piAi.provider,
      model: config.piAi.reasoningModel,
    };
  }
  return {
    provider: config.piAi.provider,
    model: config.piAi.model,
  };
}
