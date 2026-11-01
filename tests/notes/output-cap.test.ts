/**
 * No derived output budget, and a truncation that says so.
 *
 * The notes distiller used to cap one call at `bodyMaxChars x maxNotes + 400`. The
 * arithmetic was not a measurement of anything: the response carries more than bodies,
 * and a reasoning model spends from the same `max_tokens` pool before it writes a
 * character. So the cap is gone — the request now carries no `max_tokens` at all and
 * the gateway decides.
 *
 * That trade only works with the second half: a gateway limit still exists, and when it
 * fires the answer is cut mid-object. `finish_reason: 'length'` is what separates
 * "the model answered badly" from "we cut it in half", so it has to be noticed and
 * logged rather than left to the JSON parser to misreport.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildAuxChatParams, wasTruncated } from '../../src/memory/aux-call-options.js';
import { auxLLMCall, clearAuxClientPool } from '../../src/memory/aux-llm-client.js';
import type { AuxModelConfig } from '../../src/memory/aux-llm-client.js';

const CAPABILITIES = { known: false, supportsTemperature: true, canDisableThinking: false };

function params(maxTokens?: number) {
  return buildAuxChatParams({
    model: 'test-model',
    systemPrompt: 'system',
    userPrompt: 'user',
    ...(maxTokens === undefined ? {} : { maxTokens }),
    thinking: 'off',
    capabilities: CAPABILITIES,
  });
}

describe('aux request body', () => {
  it('carries no max_tokens when the caller does not set one', () => {
    // The field has to be *absent*, not zero and not a default: a body without it is
    // one a gateway cannot validate its way out of.
    expect(params()).not.toHaveProperty('max_tokens');
  });

  it('carries the budget when the caller sets one', () => {
    expect(params(3000).max_tokens).toBe(3000);
  });
});

describe('wasTruncated', () => {
  it('is true only for finish_reason length', () => {
    expect(wasTruncated({ choices: [{ finish_reason: 'length' }] })).toBe(true);
    expect(wasTruncated({ choices: [{ finish_reason: 'stop' }] })).toBe(false);
    expect(wasTruncated({ choices: [{}] })).toBe(false);
    expect(wasTruncated(null)).toBe(false);
  });
});

describe('aux call truncation reporting', () => {
  const config: AuxModelConfig = {
    modelRef: 'aux-test/test-model',
    apiKeys: { 'aux-test': 'sk-test' },
    baseUrls: { 'aux-test': 'https://aux.test/v1' },
  } as AuxModelConfig;

  function stubFetch(finishReason: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 'chatcmpl-test',
              object: 'chat.completion',
              created: 0,
              model: 'test-model',
              choices: [
                {
                  index: 0,
                  finish_reason: finishReason,
                  message: { role: 'assistant', content: '{"notes":[' },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 8192, total_tokens: 8202 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    clearAuxClientPool();
  }

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearAuxClientPool();
  });

  it('warns when the provider stopped on its own limit', async () => {
    stubFetch('length');
    const warns: Array<{ context?: unknown; message?: string }> = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (context: unknown, message: string) => warns.push({ context, message }),
      error: () => {},
    } as never;

    const content = await auxLLMCall(config, {
      systemPrompt: 's',
      userPrompt: 'u',
      logger,
    });

    // The half-object still comes back — the point is that it is *labelled*, so the
    // parser's `invalid_json` has a cause next to it in the log.
    expect(content).toBe('{"notes":[');
    expect(warns.map((item) => item.message).join()).toContain('finish_reason=length');
  });

  it('says nothing when the model finished normally', async () => {
    stubFetch('stop');
    const warns: string[] = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (_context: unknown, message: string) => warns.push(message),
      error: () => {},
    } as never;

    await auxLLMCall(config, { systemPrompt: 's', userPrompt: 'u', logger });

    expect(warns.join()).not.toContain('finish_reason=length');
  });
});
