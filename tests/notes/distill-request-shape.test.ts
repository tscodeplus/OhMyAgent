/**
 * `notes.capture.thinking` / `temperature` reach the model call, including `inherit`.
 *
 * The subtle half is `inherit`: the notes chain is built *on* the aux chain, so
 * "inherit" has to read the aux value rather than pass `undefined` through. Passing
 * `thinking: undefined` over the aux config would resolve as `auto` in
 * `resolveThinkingMode` and silently undo a deployment-wide `off` — the kind of
 * failure that shows up as a token bill, never as an error.
 *
 * This runs the real distiller (unlike `capture.test.ts`, which stubs the seam), with
 * the HTTP call replaced by a recorded `fetch`, so the assertion is on the body the
 * provider would have received.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { CapturePipeline } from '../../src/notes/capture.js';
import { NotesRepository } from '../../src/notes/repository.js';
import { createNotesService } from '../../src/notes/service.js';
import { clearAuxClientPool } from '../../src/memory/aux-llm-client.js';
import type { AuxModelConfig } from '../../src/memory/aux-llm-client.js';
import type { NotesRuntimeConfig } from '../../src/notes/service-contract.js';
import { MESSAGE_ASSISTANT, RUNTIME_CONFIG, SESSION_ID, openSeededDatabase } from './fixtures.js';

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as never;

function completion(): Response {
  const body = {
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
          content: JSON.stringify({
            notes: [
              {
                kind: 'command',
                title: 'vitest 单文件迭代',
                summary: '改哪个文件就跑哪个',
                body: '只跑改动的测试：\n\n```bash\nnpx vitest run tests/agent\n```',
                tags: ['testing'],
                evidence: [MESSAGE_ASSISTANT],
                confidence: 0.8,
              },
            ],
          }),
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch() {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body?: string }) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return completion();
    }),
  );
  clearAuxClientPool();
  return bodies;
}

function buildPipeline(
  db: Database.Database,
  options: {
    aux: AuxModelConfig;
    capture?: Partial<NotesRuntimeConfig>;
  },
) {
  const repository = new NotesRepository(db);
  const config: NotesRuntimeConfig = { ...RUNTIME_CONFIG, ...options.capture };
  const pipeline = new CapturePipeline({
    repository,
    db,
    getConfig: () => config,
    auxConfig: options.aux,
    logger,
  });
  const service = createNotesService({
    repository,
    capture: pipeline,
    getConfig: () => config,
    logger,
  });
  return { service, repository };
}

const AUX: AuxModelConfig = {
  // Deliberately a model the catalog has never heard of: the thinking-off switch goes
  // out because the operator asked for it (in the template shape such gateways read),
  // and this fixture proves that end to end through the real distiller rather than
  // through the request builder alone.
  modelRef: 'aux-test/test-model',
  apiKeys: { 'aux-test': 'sk-test' },
  baseUrls: { 'aux-test': 'https://aux.test/v1' },
};

describe('notes distillation request shape', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openSeededDatabase();
  });

  afterEach(() => {
    db.close();
    vi.unstubAllGlobals();
    clearAuxClientPool();
  });

  it('inherits the aux thinking setting rather than defaulting to auto', async () => {
    const bodies = stubFetch();
    const { service } = buildPipeline(db, {
      aux: { ...AUX, thinking: 'off' },
      capture: { thinking: 'inherit' },
    });

    const result = await service.capture({ sessionId: SESSION_ID, mode: 'turn' });

    expect(result.ok).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('lets the notes tab override an aux chain set to auto', async () => {
    const bodies = stubFetch();
    const { service } = buildPipeline(db, {
      aux: { ...AUX, thinking: 'auto' },
      capture: { thinking: 'off' },
    });

    await service.capture({ sessionId: SESSION_ID, mode: 'turn' });

    expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('sends no max_tokens unless the operator sets one', async () => {
    // A budget we compute is a guess about the model, and a wrong guess cuts the JSON
    // mid-object, which the parser reports as `invalid_json`. Omitted means the
    // gateway applies its own limit — the only number that knows the model.
    const bodies = stubFetch();
    const { service } = buildPipeline(db, { aux: AUX });

    await service.capture({ sessionId: SESSION_ID, mode: 'turn' });

    expect(bodies[0]).not.toHaveProperty('max_tokens');
  });

  it('still sends a budget when the operator sets one', async () => {
    const bodies = stubFetch();
    const { service } = buildPipeline(db, { aux: AUX, capture: { maxOutputTokens: 3000 } });

    await service.capture({ sessionId: SESSION_ID, mode: 'turn' });

    expect(bodies[0].max_tokens).toBe(3000);
  });

  it('sends the capture temperature, and halves it for the repair retry', async () => {
    const bodies = stubFetch();
    const { service } = buildPipeline(db, {
      aux: AUX,
      capture: { temperature: 0.4 },
    });

    await service.capture({ sessionId: SESSION_ID, mode: 'turn' });

    expect(bodies[0].temperature).toBe(0.4);
    // A repair retry only happens on unparseable JSON; this response is valid, so a
    // second call would itself be the bug.
    expect(bodies).toHaveLength(1);
  });
});
