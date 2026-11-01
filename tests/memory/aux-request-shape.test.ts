/**
 * The aux request shape: thinking, temperature, and the retry that removes a field
 * a provider does not accept.
 *
 * Three bugs are pinned here, all of which were invisible from the outside:
 *
 * 1. `thinking: { type: "disabled" }` was sent as `extraBody: {...}`, which the
 *    OpenAI SDK serializes verbatim — the provider saw a field named `extraBody`
 *    and ignored it, so `disable_thinking` did nothing at all.
 * 2. `temperature` was unconditional, so a model the catalog marks
 *    `supportsTemperature: false` answered 400 to every aux call.
 * 3. With thinking off, a reasoning-only response was still accepted as the answer
 *    (the old `content || reasoning_content` fallback), which handed a paragraph of
 *    deliberation to a JSON parser and reported the failure as an invalid model
 *    response.
 *
 * The stub is a `fetch` on the OpenAI client, so the assertions are on the bytes the
 * provider would actually receive, not on an intermediate object.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  auxLLMCall,
  clearAuxClientPool,
  type AuxModelConfig,
} from '../../src/memory/aux-llm-client.js';
import {
  buildAuxChatParams,
  isFieldRejection,
  lookupAuxCapabilities,
  resolveThinkingMode,
} from '../../src/memory/aux-call-options.js';

const PROVIDER = 'aux-test';
const BASE_URL = 'https://aux.test/v1';
/**
 * A model the shipped catalog marks as thinking-switchable (`glm-5.3-flash` has
 * `off` in its `thinkingLevelMap`). The thinking field is only sent to such a
 * model, so every "the field went out" assertion needs one of these rather than
 * the synthetic `aux-test/test-model`, which is deliberately unknown.
 */
const KNOWN_PROVIDER = 'opencode-go';
const KNOWN_MODEL = `${KNOWN_PROVIDER}/glm-5.3-flash`;

interface Capture {
  body: Record<string, unknown>;
}

function loggerStub() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A chat-completions answer; `content` may be empty to simulate "thought only". */
function completion(content: string, reasoning?: string, completionTokens = 12) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content,
          ...(reasoning === undefined ? {} : { reasoning_content: reasoning }),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: completionTokens, total_tokens: 22 },
  };
}

/**
 * Install a fetch that records each request body and replies through `responder`.
 * The client is created inside `auxLLMCall`, so the pool must be cleared first for
 * the stub to be picked up.
 */
function stubFetch(responder: (body: Record<string, unknown>, call: number) => Response) {
  const captured: Capture[] = [];
  const fetchStub = vi.fn(async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    captured.push({ body });
    return responder(body, captured.length);
  });
  vi.stubGlobal('fetch', fetchStub);
  clearAuxClientPool();
  return { captured, fetchStub };
}

const baseConfig = (overrides: Partial<AuxModelConfig> = {}): AuxModelConfig => ({
  modelRef: `${PROVIDER}/test-model`,
  apiKeys: { [PROVIDER]: 'sk-test' },
  baseUrls: { [PROVIDER]: BASE_URL },
  ...overrides,
});

/** Same call, against a model the catalog knows to be switchable. */
const knownConfig = (overrides: Partial<AuxModelConfig> = {}): AuxModelConfig => ({
  modelRef: KNOWN_MODEL,
  apiKeys: { [KNOWN_PROVIDER]: 'sk-test' },
  baseUrls: { [KNOWN_PROVIDER]: BASE_URL },
  ...overrides,
});

const callOptions = (logger: ReturnType<typeof loggerStub>) => ({
  systemPrompt: 'system',
  userPrompt: 'material',
  logger: logger as never,
});

describe('aux request shape', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearAuxClientPool();
  });

  it('sends thinking as a top-level body field, never as extraBody', async () => {
    const { captured } = stubFetch(() => jsonResponse(completion('{"ok":true}')));

    await auxLLMCall(knownConfig({ thinking: 'off' }), callOptions(loggerStub()) as never);

    expect(captured).toHaveLength(1);
    expect(captured[0].body.thinking).toEqual({ type: 'disabled' });
    // The old spelling: a field the provider never understands.
    expect(captured[0].body.extraBody).toBeUndefined();
  });

  it('withholds thinking from a model the catalog has never heard of', async () => {
    // `agnes/agnes-3.0-flash` is a `custom_providers` entry, so nothing tells us
    // whether its gateway understands the field. Measured: it does not — sending it
    // produced 4.9k-6.3k characters of reasoning and 3x the completion tokens of the
    // identical call without it. Guessing "send anyway" was the expensive choice.
    const { captured } = stubFetch(() => jsonResponse(completion('{"ok":true}')));

    await auxLLMCall(baseConfig({ thinking: 'off' }), callOptions(loggerStub()) as never);

    expect(captured[0].body.thinking).toBeUndefined();
    expect(captured[0].body.temperature).toBe(0.3);
  });

  it('withholds thinking from a catalog model that cannot stop thinking', async () => {
    const { captured } = stubFetch(() => jsonResponse(completion('{"ok":true}')));

    await auxLLMCall(
      {
        modelRef: 'opencode-go/claude-haiku-5-5',
        apiKeys: { [KNOWN_PROVIDER]: 'sk-test' },
        baseUrls: { [KNOWN_PROVIDER]: BASE_URL },
        thinking: 'off',
      },
      callOptions(loggerStub()) as never,
    );

    expect(captured[0].body.thinking).toBeUndefined();
  });

  it('says once per model why the field was withheld', async () => {
    const logger = loggerStub();
    stubFetch(() => jsonResponse(completion('{"ok":true}')));

    await auxLLMCall(baseConfig({ thinking: 'off' }), callOptions(logger) as never);
    await auxLLMCall(baseConfig({ thinking: 'off' }), callOptions(logger) as never);

    const withheld = logger.warn.mock.calls.filter((c: unknown[]) =>
      String(c[1]).includes('not in the model catalog'),
    );
    expect(withheld).toHaveLength(1);
  });

  it('omits both fields on `auto` when the model is unknown to the catalog', async () => {
    const { captured } = stubFetch(() => jsonResponse(completion('{"ok":true}')));

    await auxLLMCall(baseConfig(), callOptions(loggerStub()) as never);

    expect(captured[0].body.thinking).toBeUndefined();
    // An unlisted model is "assume the plain OpenAI surface", so temperature is sent.
    expect(captured[0].body.temperature).toBe(0.3);
  });

  it('honours the configured temperature and lets the call site override it', async () => {
    const { captured } = stubFetch(() => jsonResponse(completion('ok')));

    await auxLLMCall(baseConfig({ temperature: 0.15 }), callOptions(loggerStub()) as never);
    await auxLLMCall(baseConfig({ temperature: 0.15 }), {
      ...callOptions(loggerStub()),
      temperature: 0.05,
    } as never);

    expect(captured[0].body.temperature).toBe(0.15);
    expect(captured[1].body.temperature).toBe(0.05);
  });

  it('treats the legacy disable_thinking boolean as thinking: off', () => {
    expect(resolveThinkingMode({ disableThinking: true })).toBe('off');
    expect(resolveThinkingMode({})).toBe('auto');
    // The new key wins over the deprecated one, in both directions.
    expect(resolveThinkingMode({ thinking: 'auto', disableThinking: true })).toBe('auto');
    expect(resolveThinkingMode({ thinking: 'off', disableThinking: false })).toBe('off');
  });
});

describe('aux field rejection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearAuxClientPool();
  });

  it('retries once without a temperature the provider refuses to understand', async () => {
    const { captured } = stubFetch((body, call) =>
      call === 1 && 'temperature' in body
        ? jsonResponse(
            {
              error: {
                message: 'Unsupported parameter: temperature is not supported with this model.',
                type: 'invalid_request_error',
              },
            },
            400,
          )
        : jsonResponse(completion('{"ok":true}')),
    );

    const answer = await auxLLMCall(
      baseConfig({ temperature: 0.2 }),
      callOptions(loggerStub()) as never,
    );

    expect(answer).toBe('{"ok":true}');
    expect(captured).toHaveLength(2);
    expect(captured[0].body.temperature).toBe(0.2);
    expect(captured[1].body.temperature).toBeUndefined();
    // Dropping one field must not drop the other.
    expect(captured[1].body.model).toBe('test-model');
  });

  it('does not retry a generic 400 that happens to mention the field', () => {
    const generic = Object.assign(new Error('model test-model not found'), { status: 400 });
    expect(isFieldRejection(generic, 'temperature')).toBe(false);
    const named = Object.assign(new Error('unknown field: temperature'), { status: 400 });
    expect(isFieldRejection(named, 'temperature')).toBe(true);
    // A 500 is never a field problem, however it is worded.
    expect(
      isFieldRejection(
        Object.assign(new Error('unsupported temperature'), { status: 500 }),
        'temperature',
      ),
    ).toBe(false);
  });
});

describe('aux reasoning fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearAuxClientPool();
  });

  it('accepts reasoning text as the answer when thinking was allowed', async () => {
    stubFetch(() => jsonResponse(completion('', 'the answer, in prose')));

    const answer = await auxLLMCall(baseConfig(), callOptions(loggerStub()) as never);

    expect(answer).toBe('the answer, in prose');
  });

  it('treats a reasoning-only response as empty when thinking was off', async () => {
    // Otherwise a paragraph of deliberation is handed to a JSON parser and the
    // capture is recorded as an invalid model response.
    stubFetch(() => jsonResponse(completion('', 'deliberation', 400)));
    const logger = loggerStub();

    await expect(
      auxLLMCall(baseConfig({ thinking: 'off' }), callOptions(logger) as never),
    ).rejects.toThrow(/All aux models failed/);
  });

  it('warns when a thinking-off model still returns reasoning', async () => {
    // Only meaningful for a model we actually sent the field to: an unknown one was
    // never asked, so "it ignored us" would be the wrong diagnosis.
    stubFetch(() => jsonResponse(completion('{"ok":true}', 'still thinking', 300)));
    const logger = loggerStub();

    const answer = await auxLLMCall(knownConfig({ thinking: 'off' }), callOptions(logger) as never);

    expect(answer).toBe('{"ok":true}');
    expect(logger.warn.mock.calls.map((c: unknown[]) => String(c[1]))).toContainEqual(
      expect.stringContaining('ignored thinking=disabled'),
    );
  });

  it('logs completion tokens and reasoning length so the switch can be audited', async () => {
    stubFetch(() => jsonResponse(completion('{"ok":true}', undefined, 42)));
    const logger = loggerStub();

    await auxLLMCall(baseConfig({ thinking: 'off' }), callOptions(logger) as never);

    const debugPayloads = logger.debug.mock.calls.map((c: unknown[]) => c[0]);
    expect(debugPayloads).toContainEqual(
      expect.objectContaining({ completionTokens: 42, reasoningChars: 0, thinking: 'off' }),
    );
  });
});

describe('catalog capabilities', () => {
  it('knows a model that refuses temperature and cannot stop thinking', async () => {
    // Shipped data, not a fixture: `opencode-go/claude-haiku-5-5` has
    // `supportsTemperature: false` and a thinkingLevelMap without `off`.
    const caps = await lookupAuxCapabilities('opencode-go', 'claude-haiku-5-5');
    expect(caps).toMatchObject({
      known: true,
      supportsTemperature: false,
      canDisableThinking: false,
    });
  });

  it('reads a model whose levels include off as switchable', async () => {
    const caps = await lookupAuxCapabilities('opencode-go', 'glm-5.3-flash');
    expect(caps.known).toBe(true);
    expect(caps.canDisableThinking).toBe(true);
    expect(caps.supportsTemperature).toBe(true);
  });

  it('withholds the thinking field for a model outside the catalog', async () => {
    const caps = await lookupAuxCapabilities('agnes', 'agnes-3.0-flash');
    // Unknown is not permissive: `canDisableThinking: false` is what stops the field
    // from being sent to a gateway that answers it by thinking harder.
    expect(caps).toEqual({ known: false, supportsTemperature: true, canDisableThinking: false });
  });

  it('drops temperature from the body when the catalog forbids it', () => {
    const params = buildAuxChatParams({
      model: 'claude-haiku-5-5',
      systemPrompt: 's',
      userPrompt: 'u',
      maxTokens: 100,
      temperature: 0.3,
      thinking: 'off',
      capabilities: { known: true, supportsTemperature: false, canDisableThinking: false },
    });
    expect('temperature' in params).toBe(false);
    // And no thinking field either: a model that cannot stop thinking is not asked to.
    expect('thinking' in params).toBe(false);
  });
});

beforeEach(() => {
  clearAuxClientPool();
});
