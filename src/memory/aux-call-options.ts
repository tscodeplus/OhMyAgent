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
import { getModel } from '@earendil-works/pi-ai';
import type { AuxModelConfig } from './aux-llm-client.js';

export type AuxThinkingMode = 'auto' | 'off';

/** The notes layer can additionally inherit whatever the aux chain says. */
export type NotesThinkingMode = AuxThinkingMode | 'inherit';

export type AuxChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

/**
 * Fields this module may add to a request, and may therefore have to take back out.
 *
 * The thinking switch is not one field: which one carries it depends on the gateway
 * (`compat.thinkingFormat`), so every shape it can take has to be strippable too.
 */
const OPTIONAL_FIELDS = [
  'temperature',
  'thinking',
  'chat_template_kwargs',
  'chat_template_args',
  'reasoning',
  'enable_thinking',
] as const;
export type AuxOptionalField = (typeof OPTIONAL_FIELDS)[number];

export interface AuxCapabilities {
  /** False when the model is absent from the catalog (custom provider) — unknown, not false. */
  known: boolean;
  /** False when the catalog says the model rejects `temperature`. */
  supportsTemperature: boolean;
  /**
   * `compat.thinkingFormat`: which request field this gateway reads as "stop
   * thinking". `undefined` for a model the catalog does not describe.
   *
   * Load-bearing rather than cosmetic, because the field is not portable: measured
   * on a fixed extraction prompt at `max_tokens: 400`,
   *
   *   - `chat_template_kwargs: { enable_thinking: false }` switched thinking off on
   *     all four gateways tried (agnes 61→35 tokens, opencode-go deepseek 178→46);
   *   - `thinking: { type: "disabled" }` switched it off on the deepseek/glm/qwen
   *     gateways (178→66) and switched it **on** at agnes (61→265 tokens, 787
   *     characters of `reasoning_content`, indistinguishable from sending
   *     `{ type: "enabled" }`).
   *
   * So the shape cannot be chosen by taste, and "send `thinking` and let unknown
   * gateways ignore it" is wrong: this one does not ignore it, it reads the presence
   * of the object as a request to think.
   */
  thinkingFormat?: string;
  /**
   * Whether the catalog gives us any reason to believe the model's thinking can be
   * switched off at all.
   *
   * Advisory only, never a gate: the operator's `off` reaches the wire either way.
   * It decides the warning, and `false` is what an unknown model gets — including
   * every `custom_providers` entry.
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
  thinkingFormat?: string;
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
    thinkingFormat: typeof compat.thinkingFormat === 'string' ? compat.thinkingFormat : undefined,
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
    // Imported statically on purpose: the dynamic `import()` here cost ~7.5s on the
    // first call, which is invisible in production (the module is already loaded) and
    // fatal in a test that measures the call against a 10s timeout.
    const model = getModel(provider, modelId);
    if (!model) return UNKNOWN_CAPABILITIES;
    const compat = compatOf(model);
    const map = compat.thinkingLevelMap;
    const mapExcludesOff = !!map && !('off' in map);
    return {
      known: true,
      supportsTemperature: compat.supportsTemperature !== false,
      canDisableThinking: !compat.forceAdaptiveThinking && !mapExcludesOff,
      thinkingFormat: compat.thinkingFormat,
    };
  } catch {
    // No catalog access (standalone test, stripped build): unknown. Temperature is
    // still sent — it is a plain OpenAI field, and the field-retry handles a
    // provider that rejects it.
    return UNKNOWN_CAPABILITIES;
  }
}

/**
 * Whether the request asks for thinking to be off at all.
 *
 * The operator's word is the whole rule. Catalog knowledge decides *which field*
 * carries it and what we say about the call, never whether it is sent — a
 * `thinking: off` that quietly turns itself back on for models the catalog does not
 * describe is worse than one that is sent in a shape the gateway may not read,
 * because the first is invisible from the config.
 */
export function sendsThinkingField(thinking: AuxThinkingMode): boolean {
  return thinking === 'off';
}

/**
 * The body fields that ask *this* gateway to stop thinking.
 *
 * Mirrors pi-mono's `openai-completions` format table (the agent path and the aux
 * path must not disagree about how a provider is told to be quiet), reduced to the
 * "off" half. `default` is not a fallback in the sloppy sense: for a gateway we know
 * nothing about, the vLLM/Qwen template switch is the only one measured to work
 * everywhere tried *and* to be ignored rather than inverted where it means nothing.
 */
export function thinkingOffFields(capabilities: {
  thinkingFormat?: string;
}): Record<string, unknown> {
  switch (capabilities.thinkingFormat) {
    case 'deepseek':
    case 'zai':
      return { thinking: { type: 'disabled' } };
    case 'qwen':
      return { enable_thinking: false };
    case 'qwen-chat-template':
      return { chat_template_kwargs: { enable_thinking: false, preserve_thinking: true } };
    case 'chat-template':
      return { chat_template_kwargs: { enable_thinking: false } };
    case 'baseten':
      return { chat_template_args: { enable_thinking: false } };
    case 'openrouter':
      return { reasoning: { effort: 'none' } };
    case 'together':
      return { reasoning: { enabled: false } };
    case 'string-thinking':
      return { thinking: 'none' };
    default:
      return { chat_template_kwargs: { enable_thinking: false } };
  }
}

export interface AuxChatParamsInput {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /**
   * Omitted = the field is not sent at all and the gateway applies its own default.
   * Left unset by the notes distiller on purpose: a budget we compute is a guess
   * about the model, and a wrong guess cuts the answer mid-object.
   */
  maxTokens?: number;
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
    ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
    ...(sendTemperature ? { temperature: input.temperature } : {}),
    ...(sendsThinkingField(input.thinking) ? thinkingOffFields(input.capabilities) : {}),
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

/**
 * Did the provider stop because the output budget ran out instead of finishing?
 *
 * The one signal that distinguishes "the model wrote a bad answer" from "we cut its
 * answer in half". Without it, a truncated JSON body reaches the parser and is
 * reported as the model's fault — which is how a request-shaping bug survived as an
 * `invalid_json` metric. `finish_reason` is the OpenAI-compatible spelling; `length`
 * is why `stopReason: 'length'` exists in pi-ai's own type.
 */
export function wasTruncated(completion: unknown): boolean {
  const choice = (completion as { choices?: Array<{ finish_reason?: string | null }> } | null)
    ?.choices?.[0];
  return choice?.finish_reason === 'length';
}
