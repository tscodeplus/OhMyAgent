/**
 * Request shaping for the aux ("cheap extraction") model calls.
 *
 * Every aux task — query expansion, memory merge, session summary, notes
 * distillation, context compression — is the same shape of work: material in, a
 * short machine-readable answer out. Two request fields decide whether that work
 * costs what it should:
 *
 *   - **`thinking`** — a reasoning model spends completion tokens deliberating
 *     *before* it writes the answer, and those tokens come out of the same
 *     `max_tokens` budget. Measured on `opencode-go/qwen3.8-flash` with a 1200-token
 *     budget: 419 tokens to produce the same JSON a non-thinking model produced in
 *     99, and at `max_tokens: 20` the whole budget went to reasoning and the JSON
 *     came back cut mid-object — which the notes validator reports as the model's
 *     fault (`invalid_json`) when the real cause was our own request.
 *   - **`temperature`** — the aux tasks want near-deterministic output, but a few
 *     models reject the field outright (the catalog marks them
 *     `compat.supportsTemperature: false`), so sending it unconditionally turns a
 *     usable model into a 400.
 *
 * Two consequences, both load-bearing:
 *
 *   1. `thinking: { type: "disabled" }` has to be a **top-level body field**. It
 *      used to be sent as `extraBody: {...}`, which the OpenAI JS SDK serializes
 *      verbatim into the JSON body — the provider saw a field named `extraBody` and
 *      ignored it, so `disable_thinking` was inert (probe: 63 prompt tokens with
 *      reasoning present; the same call with the top-level field returned 1 token).
 *   2. A field a provider does not accept must be **removable and retried**, because
 *      the request is otherwise correct: one 400 with "unknown field temperature"
 *      should cost one retry, not the whole aux chain.
 *
 * Capabilities are read from the embedded catalog (`getModel`), so this module
 * carries no per-provider table that could drift from pi-mono.
 */

import type { Logger } from 'pino';
import type OpenAI from 'openai';
import type { AuxModelConfig } from './aux-llm-client.js';

export type AuxThinkingMode = 'auto' | 'off';

/** The notes layer can additionally inherit whatever the aux chain says. */
export type NotesThinkingMode = AuxThinkingMode | 'inherit';

export type AuxChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

/** Fields this module may add to a request, and may therefore have to take back out. */
const OPTIONAL_FIELDS = ['temperature', 'thinking'] as const;
export type AuxOptionalField = (typeof OPTIONAL_FIELDS)[number];

export interface AuxCapabilities {
  /** False when the model is absent from the catalog (custom provider) — unknown, not false. */
  known: boolean;
  /** False when the catalog says the model rejects `temperature`. */
  supportsTemperature: boolean;
  /**
   * Whether the catalog gives us any reason to believe the model accepts
   * `thinking: { type: "disabled" }`.
   *
   * Advisory only, and never a gate: an operator who sets `thinking: off` gets the
   * field on the wire, because a switch that silently depends on catalog data the
   * operator cannot see is a switch nobody can reason about. What this flag does buy
   * is the warning, and it is `false` for an unknown model — including every
   * `custom_providers` entry, which is where sending it is a genuine gamble:
   * measured on `agnes/agnes-3.0-flash`, the field produced 4.9k-6.3k characters of
   * `reasoning_content` on every call and 1432 completion tokens against 480 for the
   * identical call without it. A gateway that does not understand the field can
   * answer it by thinking harder, and the response is a 200, so nothing downstream
   * notices.
   */
  canDisableThinking: boolean;
}

const UNKNOWN_CAPABILITIES: AuxCapabilities = {
  known: false,
  supportsTemperature: true,
  canDisableThinking: false,
};

/**
 * `thinking: "off"` if asked for, else the legacy `disable_thinking` boolean.
 *
 * The legacy key is still honoured because it is what existing `config.yaml` files
 * carry; it is read here and nowhere else, so the deprecated spelling has exactly
 * one reader and cannot drift into a second meaning.
 */
export function resolveThinkingMode(
  config: Pick<AuxModelConfig, 'thinking' | 'disableThinking'>,
): AuxThinkingMode {
  if (config.thinking) return config.thinking;
  return config.disableThinking ? 'off' : 'auto';
}

function compatOf(model: unknown): {
  supportsTemperature?: boolean;
  forceAdaptiveThinking?: boolean;
  thinkingLevelMap?: Record<string, unknown> | null;
} {
  const candidate = model as {
    compat?: Record<string, unknown>;
    thinkingLevelMap?: Record<string, unknown> | null;
  };
  const compat = (candidate.compat ?? {}) as Record<string, unknown>;
  return {
    supportsTemperature:
      typeof compat.supportsTemperature === 'boolean' ? compat.supportsTemperature : undefined,
    forceAdaptiveThinking: compat.forceAdaptiveThinking === true,
    thinkingLevelMap: candidate.thinkingLevelMap ?? undefined,
  };
}

/**
 * What the catalog says about a model's request surface.
 *
 * Three states matter, and they are not the same fact:
 *
 *   - **unknown** (no catalog entry, which is every `custom_providers` model and
 *     every live-discovered one) → `canDisableThinking: false`, i.e. no evidence.
 *     The field is still sent (see `sendsThinkingField`), so this only decides what
 *     the warning says.
 *   - **no `thinkingLevelMap`** → still switchable. An absent map means "this
 *     build has no level names for it", not "this model always thinks", and
 *     `opencode-go/qwen3.8-flash` (map `null`) honours the field: 419 completion
 *     tokens with thinking on, 34 with it off.
 *   - **a map that lacks `off`** → the catalog saying the model always thinks
 *     (`opencode-go/claude-haiku-5-5`), which is worth a warning but not a veto.
 */
export async function lookupAuxCapabilities(
  provider: string,
  modelId: string,
): Promise<AuxCapabilities> {
  try {
    const { getModel } = await import('@earendil-works/pi-ai');
    const model = getModel(provider, modelId);
    if (!model) return UNKNOWN_CAPABILITIES;
    const compat = compatOf(model);
    const map = compat.thinkingLevelMap;
    const mapExcludesOff = !!map && !('off' in map);
    return {
      known: true,
      supportsTemperature: compat.supportsTemperature !== false,
      canDisableThinking: !compat.forceAdaptiveThinking && !mapExcludesOff,
    };
  } catch {
    // No catalog access (standalone test, stripped build): unknown. Temperature is
    // still sent — it is a plain OpenAI field, and the field-retry handles a
    // provider that rejects it.
    return UNKNOWN_CAPABILITIES;
  }
}

/**
 * Whether the request carries `thinking: { type: "disabled" }`.
 *
 * The operator's word is the whole rule. Catalog knowledge decides what we *say*
 * about the call, never whether the switch is honoured — a `thinking: off` that
 * quietly turns itself back on for models the catalog does not know is worse than
 * one that is sent and ignored, because the first is invisible from the config.
 */
export function sendsThinkingField(thinking: AuxThinkingMode): boolean {
  return thinking === 'off';
}

export interface AuxChatParamsInput {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  /** Call-site temperature; omitted when the provider must not receive one. */
  temperature?: number;
  thinking: AuxThinkingMode;
  capabilities: AuxCapabilities;
}

/**
 * Build the chat-completions body for one aux call.
 *
 * Both optional fields are added through object spread rather than assigned, which
 * is what keeps TypeScript's excess-property check out of the way *and* makes the
 * resulting body exactly the bytes sent — the earlier `extraBody` bug was a field
 * that existed only in our source, not in the request the provider understood.
 */
export function buildAuxChatParams(input: AuxChatParamsInput): AuxChatParams {
  const sendTemperature = input.temperature !== undefined && input.capabilities.supportsTemperature;
  return {
    model: input.model,
    messages: [
      { role: 'system', content: input.systemPrompt },
      { role: 'user', content: input.userPrompt },
    ],
    max_tokens: input.maxTokens,
    ...(sendTemperature ? { temperature: input.temperature } : {}),
    ...(sendsThinkingField(input.thinking) ? { thinking: { type: 'disabled' } } : {}),
  } as AuxChatParams;
}

/** True when a request body carries the field at all (used for logging/tests). */
export function auxParamsHaveField(params: AuxChatParams, field: AuxOptionalField): boolean {
  return field in (params as unknown as Record<string, unknown>);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Does this error look like "your request had a field I don't understand"?
 *
 * Deliberately narrow: only a 400/422 that *names* the field counts. A generic 400
 * (bad model id, oversized prompt) must not be retried without half its body — that
 * turns one clear failure into two confusing ones.
 */
export function isFieldRejection(err: unknown, field: AuxOptionalField): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (status !== 400 && status !== 422) return false;
  const text = errorMessage(err).toLowerCase();
  if (!text.includes(field)) return false;
  return /(unsupported|unknown|unrecognized|unexpected|not support|invalid|extra)/.test(text);
}

function withoutField(params: AuxChatParams, field: AuxOptionalField): AuxChatParams {
  const body = { ...(params as unknown as Record<string, unknown>) };
  delete body[field];
  return body as unknown as AuxChatParams;
}

/**
 * Call `create` once, and at most twice more when the provider rejects an optional
 * field we added. Each field is retried once, never in a loop: a provider that
 * rejects both is telling us the model surface is wrong, not that we should keep
 * asking.
 */
export async function createWithFieldFallback<T>(
  params: AuxChatParams,
  create: (params: AuxChatParams) => Promise<T>,
  context: { logger: Logger; label: string; modelRef: string },
): Promise<T> {
  try {
    return await create(params);
  } catch (err) {
    for (const field of OPTIONAL_FIELDS) {
      if (!auxParamsHaveField(params, field) || !isFieldRejection(err, field)) continue;
      context.logger.warn(
        { modelRef: context.modelRef, field, err: errorMessage(err).slice(0, 200) },
        `${context.label}: model rejected "${field}", retrying without it`,
      );
      return await create(withoutField(params, field));
    }
    throw err;
  }
}

export interface AuxUsageObservation {
  /** Completion tokens, when the provider reports them. */
  completionTokens?: number;
  /** Whether the response carried hidden reasoning text. */
  reasoningChars: number;
}

/** Pull the two numbers that make "did the thinking switch work" answerable. */
export function observeAuxUsage(completion: unknown): AuxUsageObservation {
  const usage = (completion as { usage?: { completion_tokens?: number } } | null)?.usage;
  const message = (
    completion as { choices?: Array<{ message?: { reasoning_content?: string } }> } | null
  )?.choices?.[0]?.message;
  return {
    completionTokens: usage?.completion_tokens,
    reasoningChars: (message?.reasoning_content ?? '').length,
  };
}
