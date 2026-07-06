/**
 * Auxiliary LLM client — shared-connection modelRef + fallback chain logic.
 *
 * Follows the exact same pattern as MemorySummarizer.callLLM():
 *   1. Try config.modelRef (if set)
 *   2. Try config.fallbackRefs in order
 *   3. Throw if all fail — caller catches and falls back to rule-based logic.
 *
 * All four aux tasks (query_expansion, entity_extraction, memory_merge,
 * summary) share a single connection pool via AuxLLMClientPool, reusing
 * OpenAI client instances when apiKey + baseUrl match.
 */

import type { Logger } from 'pino';
import { resolveSummaryModelConnection } from './memory-summarizer.js';

export interface AuxModelConfig {
  modelRef?: string;
  fallbackRefs?: string[];
  apiKeys?: Record<string, string>;
  baseUrls?: Record<string, string>;
  baseUrl?: string;
}

export interface AuxLLMCallOptions {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  logger: Logger;
}

export class AuxLLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuxLLMError';
  }
}

// ─── Shared connection pool ────────────────────────────────────────

type ClientKey = string; // "baseUrl::apiKey"

let _OpenAI: typeof import('openai').default | undefined;
async function getOpenAI(): Promise<typeof import('openai').default> {
  if (!_OpenAI) _OpenAI = (await import('openai')).default;
  return _OpenAI;
}

const clientPool = new Map<ClientKey, InstanceType<typeof import('openai').default>>();

function poolKey(baseUrl: string, apiKey: string): ClientKey {
  return `${baseUrl}::${apiKey.slice(0, 8)}`;
}

async function getClient(apiKey: string, baseUrl: string) {
  const key = poolKey(baseUrl, apiKey);
  const cached = clientPool.get(key);
  if (cached) return cached;
  const OpenAI = await getOpenAI();
  const client = new OpenAI({ apiKey, baseURL: baseUrl, maxRetries: 1 });
  clientPool.set(key, client);
  return client;
}

/** For testing: clear the shared client pool. */
export function clearAuxClientPool(): void {
  clientPool.clear();
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Call an LLM through the modelRef → fallbackRefs chain.
 * Reuses OpenAI client instances from a shared pool when apiKey + baseUrl match.
 * Compatible with reasoning models (minimax, o1, etc.) that put output in
 * reasoning_content instead of content.
 */
export async function auxLLMCall(
  config: AuxModelConfig,
  options: AuxLLMCallOptions,
): Promise<string> {
  const modelRefs: string[] = [
    ...(config.modelRef ? [config.modelRef] : []),
    ...(config.fallbackRefs ?? []),
  ];

  if (modelRefs.length === 0) {
    throw new AuxLLMError('No aux model configured');
  }

  let lastError: string | null = null;

  for (const modelRef of modelRefs) {
    const { modelId, apiKey, baseUrl } = await resolveSummaryModelConnection(
      { modelRef, apiKeys: config.apiKeys, baseUrls: config.baseUrls, baseUrl: config.baseUrl },
      modelRef,
    );

    if (!apiKey) {
      const msg = `No API key resolved for model ${modelRef}`;
      options.logger.warn({ modelRef }, msg);
      lastError = msg;
      continue;
    }

    try {
      const client = await getClient(apiKey, baseUrl);

      const completion = await client.chat.completions.create({
        model: modelId,
        messages: [
          { role: 'system', content: options.systemPrompt },
          { role: 'user', content: options.userPrompt },
        ],
        temperature: options.temperature ?? 0.3,
        max_tokens: options.maxTokens ?? 2000,
      });

      const msg = completion.choices[0]?.message;
      // Reasoning models (minimax, o1, etc.) put output in reasoning_content
      const content = (msg?.content || (msg as any)?.reasoning_content)?.trim();
      if (content) return content;

      options.logger.debug({ modelRef }, 'Model %s returned empty response', modelRef);
      lastError = `Model ${modelRef} returned empty response`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      options.logger.debug({ modelRef, err: msg.slice(0, 100) }, 'Aux LLM attempt failed');
      lastError = msg;
    }
  }

  throw new AuxLLMError(`All aux models failed. Last error: ${lastError}`);
}
