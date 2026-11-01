/**
 * Auxiliary LLM client — shared-connection modelRef + fallback chain logic.
 *
 * Follows the exact same pattern as MemorySummarizer.callLLM():
 *   1. Try config.modelRef (if set)
 *   2. Try config.fallbackRefs in order
 *   3. Throw if all fail — caller catches and falls back to rule-based logic.
 *
 * All memory aux tasks (query expansion, memory merge, summary, notes capture)
 * share a single connection pool via AuxLLMClientPool, reusing
 * OpenAI client instances when apiKey + baseUrl match.
 */

import type { Logger } from 'pino';
import { resolveSummaryModelConnection } from './memory-summarizer.js';
import {
  buildAuxChatParams,
  createWithFieldFallback,
  lookupAuxCapabilities,
  observeAuxUsage,
  resolveThinkingMode,
  sendsThinkingField,
  thinkingOffFields,
  wasTruncated,
  type AuxThinkingMode,
} from './aux-call-options.js';

export interface AuxModelConfig {
  modelRef?: string;
  fallbackRefs?: string[];
  apiKeys?: Record<string, string>;
  baseUrls?: Record<string, string>;
  baseUrl?: string;
  /**
   * Whether these cheap extraction calls may think.
   *
   * `off` sends a top-level `thinking: { type: "disabled" }` (DeepSeek/Zhipu/
   * MiniMax/Qwen style). Reasoning models burn completion tokens deliberating even
   * when the answer is a few lines of JSON, and those tokens come out of
   * `max_tokens` — at a small budget the JSON is truncated mid-object, which the
   * consumer reports as an invalid model response. `auto` leaves the provider
   * default alone.
   *
   * Default: `auto`.
   */
  thinking?: AuxThinkingMode;
  /** Default sampling temperature for aux calls; a call-site value wins. */
  temperature?: number;
  /**
   * @deprecated Use `thinking: 'off'`. Kept because existing `config.yaml` files
   * carry it; `resolveThinkingMode` is its only reader.
   */
  disableThinking?: boolean;
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

/**
 * OpenCode's gateway needs a per-conversation routing header and lives under
 * `/v1`; a plain OpenAI client otherwise gets `MissingSessionID` (or, without
 * `/v1`, an HTML 404). The agent path gets both from `pi-mono`
 * (`withOpenCodeSessionHeader`), but the memory aux path builds its own client,
 * so a `memory_aux_models.primary: opencode-go/...` config silently fell through
 * its whole fallback chain and the memory layer degraded without saying so.
 */
const AUX_SESSION_ID = `oma-aux-${Math.random().toString(36).slice(2, 10)}`;

function isOpenCodeProvider(provider: string, baseUrl: string): boolean {
  return provider.startsWith('opencode') || /opencode\.ai/.test(baseUrl);
}

/** `https://opencode.ai/zen/go` → `https://opencode.ai/zen/go/v1`. */
export function normalizeAuxBaseUrl(provider: string, baseUrl: string): string {
  if (!isOpenCodeProvider(provider, baseUrl)) return baseUrl;
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (/\/v\d+$/.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

async function getClient(apiKey: string, baseUrl: string, provider: string) {
  const key = poolKey(baseUrl, apiKey);
  const cached = clientPool.get(key);
  if (cached) return cached;
  const OpenAI = await getOpenAI();
  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl,
    maxRetries: 1,
    ...(isOpenCodeProvider(provider, baseUrl)
      ? { defaultHeaders: { 'x-opencode-session': AUX_SESSION_ID } }
      : {}),
  });
  clientPool.set(key, client);
  return client;
}

/** For testing: clear the shared client pool. */
export function clearAuxClientPool(): void {
  clientPool.clear();
  thinkingWarned.clear();
}

/**
 * Model refs already warned about withholding `thinking: disabled`.
 *
 * Module scope, like the client pool: the warning is about the deployment's
 * configuration, and repeating it on every memory write would bury it.
 */
const thinkingWarned = new Set<string>();

function warnThinkingUnverifiedOnce(
  logger: Logger,
  modelRef: string,
  known: boolean,
  field: string,
): void {
  if (thinkingWarned.has(modelRef)) return;
  thinkingWarned.add(modelRef);
  logger.warn(
    { modelRef, known, field },
    known
      ? `Aux model has no switchable thinking level according to the catalog; thinking=off is still sent as "${field}", so the budget may still be spent on reasoning`
      : `Aux model is not in the model catalog; thinking=off is sent as "${field}" (the vLLM/Qwen template switch), which is the shape unlisted gateways usually read`,
  );
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
  const thinking = resolveThinkingMode(config);

  for (const modelRef of modelRefs) {
    const resolved = await resolveSummaryModelConnection(
      { modelRef, apiKeys: config.apiKeys, baseUrls: config.baseUrls, baseUrl: config.baseUrl },
      modelRef,
    );
    const { modelId, apiKey } = resolved;
    const baseUrl = normalizeAuxBaseUrl(resolved.provider, resolved.baseUrl);

    if (!apiKey) {
      const msg = `No API key resolved for model ${modelRef}`;
      options.logger.warn({ modelRef }, msg);
      lastError = msg;
      continue;
    }

    try {
      const client = await getClient(apiKey, baseUrl, resolved.provider);
      const capabilities = await lookupAuxCapabilities(resolved.provider, modelId);
      if (thinking === 'off' && !capabilities.canDisableThinking) {
        // The field goes out regardless — the operator set the switch. Say once per
        // model that the catalog has no evidence this one honours it, so the reading
        // of a token bill later is not a mystery.
        warnThinkingUnverifiedOnce(
          options.logger,
          modelRef,
          capabilities.known,
          Object.keys(thinkingOffFields(capabilities)).join('+'),
        );
      }

      const params = buildAuxChatParams({
        model: modelId,
        systemPrompt: options.systemPrompt,
        userPrompt: options.userPrompt,
        temperature: options.temperature ?? config.temperature ?? 0.3,
        // Passthrough, not a default: an unset budget must stay unset so the field is
        // absent from the request and the gateway's own limit applies.
        maxTokens: options.maxTokens,
        thinking,
        capabilities,
      });

      const completion = await createWithFieldFallback(
        params,
        (body) => client.chat.completions.create(body),
        { logger: options.logger, label: 'Aux LLM', modelRef },
      );

      const usage = observeAuxUsage(completion);
      if (wasTruncated(completion)) {
        // Loud on purpose: this is the only trace that separates "the model answered
        // badly" from "we ran out of output budget", and the downstream parser
        // reports the former for both. It also answers, without a provider invoice,
        // what an omitted `max_tokens` actually resolves to on this gateway.
        options.logger.warn(
          { modelRef, ...usage },
          'Aux model output hit the provider limit (finish_reason=length); the answer is cut short',
        );
      }
      // The only way to answer "is the thinking switch doing anything?" without
      // reading the provider's invoice: completion tokens plus whether hidden
      // reasoning came back at all.
      options.logger.debug(
        { modelRef, thinking, ...usage },
        'aux LLM call completed (completion tokens / reasoning chars)',
      );
      if (usage.reasoningChars > 0 && sendsThinkingField(thinking)) {
        // We asked and the model thought anyway. Worth saying on every call rather
        // than once: this is the line that turns "the bill went up" into "agnes
        // ignores the switch", and it is the only signal that it is happening.
        options.logger.warn(
          { modelRef, reasoningChars: usage.reasoningChars },
          'Aux model ignored the thinking-off fields; output budget is still paying for reasoning',
        );
      }

      const msg = completion.choices[0]?.message;
      const content = (msg?.content ?? '').trim();
      if (content) return content;

      // Reasoning-only answers are only tolerated when we *asked* for thinking: with
      // `thinking: 'off'` this text is the failure itself, and handing a paragraph of
      // deliberation to a JSON parser turns a budget problem into a fake schema bug.
      const reasoning =
        thinking === 'auto'
          ? ((msg as { reasoning_content?: string } | undefined)?.reasoning_content ?? '').trim()
          : '';
      if (reasoning) return reasoning;

      options.logger.debug({ modelRef }, 'Model returned no usable content');
      lastError = `Model ${modelRef} returned empty response`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      options.logger.debug({ modelRef, err: msg.slice(0, 100) }, 'Aux LLM attempt failed');
      lastError = msg;
    }
  }

  throw new AuxLLMError(`All aux models failed. Last error: ${lastError}`);
}
