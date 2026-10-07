/**
 * Custom relay judge contract test — deterministic (mock HTTP, no live relay).
 *
 * Pins the M5 wiring (plan §8.1 `judge.judges` + supervisor decision):
 *  - `judges.<name>` refs are first-class chain members; every `judge.judges`
 *    entry NOT referenced in any chain (routes / main / fallbackTiers) is
 *    auto-prepended ABOVE the built-in chain (config record order), including
 *    above any routes[pointId] override;
 *  - judgeId = entry name; wire model id = entry `model` (default 'jev-latest');
 *  - `typesafe` entries speak the typesafe-system-one envelope
 *    (POST `<baseUrl>/systemone` with `{ model, state, questions }`);
 *  - `http` entries speak the plain System One wire
 *    (POST `baseUrl` verbatim with `{ state, questions }`);
 *  - the key comes ONLY from the entry's `apiKeyEnv` env var (scoped opts.env
 *    is the only source in tests — no process.env, no provider_keys probing);
 *  - missing key → the entry is dropped with a `judges.<name>` noKeyRef and a
 *    once-per-startup warn, never silently skipped;
 *  - fail-closed: a relay that answers junk cascades to the next tier.
 */

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JudgeEngine } from '../../src/judge/engine.js';
import { JudgeLedger } from '../../src/judge/ledger.js';
import { JudgeResolver } from '../../src/judge/judge-resolver.js';
import { goldenSampleSpec, GOLDEN_SAMPLE_STATE } from '../../src/judge/golden-sample.js';
import type { JudgeSectionConfig } from '../../src/judge/types.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as import('pino').Logger;

/** Confident, non-gray golden-sample answers in the raw System One wire shape. */
const CLEAR_WIRE_ANSWERS = {
  q1_domain: {
    type: 'choice',
    choice: 'code',
    probabilities: { code: 0.9, web: 0.05, other: 0.05 },
    confidence: 0.9,
  },
  q2_keep: { type: 'noul', noul: 0.9 },
  q3_difficulty: { type: 'score', score: 0.8, confidence: 0.9 },
};

interface RecordedRequest {
  url: string;
  body: Record<string, unknown>;
}

let server: Server;
let baseUrl = ''; // http://127.0.0.1:<port>
const requests: RecordedRequest[] = [];
/** Per-test responder: takes the request path, returns the response payload. */
let respond: (url: string) => unknown;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
        string,
        unknown
      >;
      const url = req.url ?? '';
      requests.push({ url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(respond(url)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'judge-relay-contract-'));
  requests.length = 0;
  respond = () => ({ answers: CLEAR_WIRE_ANSWERS, usage: { input_tokens: 10, output_tokens: 5 } });
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

function baseConfig(overrides: Partial<JudgeSectionConfig> = {}): JudgeSectionConfig {
  return {
    enabled: true,
    modes: { default: 'shadow' },
    features: { testLogFold: 'off', admission: { chunkSizeChars: 2000, keepThreshold: 0.75 } },
    timeoutMs: 4000,
    recordState: false,
    ...overrides,
  };
}

function relayEngine(config: JudgeSectionConfig, env: Record<string, string | undefined>) {
  const resolver = new JudgeResolver({ config, logger, env });
  const engine = new JudgeEngine({
    config,
    resolver: (pointId) => resolver.resolveChain(pointId),
    ledger: new JudgeLedger({ dir: tmpDir, ringMax: 200 }),
    logger,
  });
  return { resolver, engine };
}

describe('contract: custom relay judges (deterministic mock HTTP)', () => {
  it('custom tiers sit ABOVE the built-in chain, including above routes overrides', () => {
    // Built-in fall-through tier uses the keyless free Jev so no key is needed.
    const config = baseConfig({
      judges: { relay: { type: 'typesafe', baseUrl: `${baseUrl}/v1`, apiKeyEnv: 'RELAY_KEY' } },
      fallbackTiers: ['opencode/jev-1.13-free'],
      routes: { 'tool.risk': ['opencode/jev-1.13-free'] },
    });
    const { resolver } = relayEngine(config, { RELAY_KEY: 'k' });
    expect(resolver.resolveChain('test').tiers.map((t) => t.judgeId)).toEqual([
      'relay',
      'opencode/jev-1.13-free',
    ]);
    // routes[pointId] replaces the BUILT-IN chain; the custom tier stays on top.
    expect(resolver.resolveChain('tool.risk').tiers.map((t) => t.judgeId)).toEqual([
      'relay',
      'opencode/jev-1.13-free',
    ]);
    // Multiple entries keep config record order.
    const two = new JudgeResolver({
      config: baseConfig({
        judges: {
          a: { type: 'typesafe', baseUrl: `${baseUrl}/a`, apiKeyEnv: 'RELAY_KEY' },
          b: { type: 'http', baseUrl: `${baseUrl}/b`, apiKeyEnv: 'RELAY_KEY' },
        },
      }),
      logger,
      env: { RELAY_KEY: 'k' },
    });
    expect(two.resolveChain('test').tiers.map((t) => t.judgeId)).toEqual(['a', 'b']);
  });

  it('no apiKeyEnv value → entry dropped with judges.<name> noKeyRef, warned once per startup', () => {
    const config = baseConfig({
      judges: {
        relay: { type: 'typesafe', baseUrl: `${baseUrl}/v1`, apiKeyEnv: 'MISSING_RELAY_KEY' },
      },
      fallbackTiers: ['opencode/jev-1.13-free'],
    });
    const { resolver } = relayEngine(config, {});
    const chain = resolver.resolveChain('test');
    expect(chain.tiers.map((t) => t.judgeId)).toEqual(['opencode/jev-1.13-free']);
    expect(chain.noKeyRefs).toEqual(['judges.relay']);
    resolver.resolveChain('test'); // second call: no duplicate warn
    const relayWarns = vi
      .mocked(logger.warn)
      .mock.calls.filter((c) => (c[0] as { ref?: string })?.ref === 'judges.relay');
    expect(relayWarns).toHaveLength(1);
  });

  it('entry without baseUrl is unresolvable and never reaches the wire', () => {
    const config = baseConfig({ judges: { broken: { type: 'http', apiKeyEnv: 'RELAY_KEY' } } });
    const { resolver } = relayEngine(config, { RELAY_KEY: 'k' });
    const chain = resolver.resolveChain('test');
    expect(chain.tiers).toHaveLength(0);
    expect(chain.unresolvableRefs).toEqual(['judges.broken']);
    expect(requests).toHaveLength(0);
  });

  it('typesafe entry: envelope at <baseUrl>/systemone, payload model defaults to jev-latest', async () => {
    const config = baseConfig({
      judges: { relay: { type: 'typesafe', baseUrl: `${baseUrl}/v1`, apiKeyEnv: 'RELAY_KEY' } },
    });
    const { engine } = relayEngine(config, { RELAY_KEY: 'k' });
    const verdict = await engine.decide(goldenSampleSpec(), {
      state: GOLDEN_SAMPLE_STATE,
      sessionId: 'relay-contract-typesafe',
    });
    expect(verdict.mode).toBe('shadow');
    expect(verdict.source).toBe('judge');
    expect(verdict.judgeId).toBe('relay');
    expect(Object.keys(verdict.answers).sort()).toEqual(['q1_domain', 'q2_keep', 'q3_difficulty']);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/v1/systemone');
    expect(requests[0].body.model).toBe('jev-latest'); // default model id
    expect(requests[0].body.state).toEqual(GOLDEN_SAMPLE_STATE);
    // Public noul travels as wire-level `noul` (bool is the public type only).
    expect(requests[0].body.questions).toMatchObject({
      q1_domain: { type: 'choice' },
      q2_keep: { type: 'noul' },
      q3_difficulty: { type: 'score' },
    });
  });

  it('entry `model` overrides the default System One model id', async () => {
    const config = baseConfig({
      judges: {
        relay: {
          type: 'typesafe',
          baseUrl: `${baseUrl}/v1`,
          apiKeyEnv: 'RELAY_KEY',
          model: 'my-jev',
        },
      },
    });
    const { engine } = relayEngine(config, { RELAY_KEY: 'k' });
    const verdict = await engine.decide(goldenSampleSpec(), { state: GOLDEN_SAMPLE_STATE });
    expect(verdict.source).toBe('judge');
    expect(requests[0].body.model).toBe('my-jev');
  });

  it('http entry: plain System One wire — state/questions verbatim at baseUrl, no model envelope', async () => {
    const config = baseConfig({
      judges: {
        wire: { type: 'http', baseUrl: `${baseUrl}/systemone-wire`, apiKeyEnv: 'RELAY_KEY' },
      },
    });
    const { engine } = relayEngine(config, { RELAY_KEY: 'k' });
    const verdict = await engine.decide(goldenSampleSpec(), { state: GOLDEN_SAMPLE_STATE });
    expect(verdict.source).toBe('judge');
    expect(verdict.judgeId).toBe('wire');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/systemone-wire'); // baseUrl used exactly, no suffix
    expect(requests[0].body).toEqual({
      state: GOLDEN_SAMPLE_STATE,
      questions: expect.any(Object),
    });
    expect(requests[0].body.model).toBeUndefined(); // plain wire carries no model envelope
  });

  it('judges.<name> refs are chain-resolvable: explicit placement, no auto-prepend', () => {
    const config = baseConfig({
      judges: { relay: { type: 'typesafe', baseUrl: `${baseUrl}/v1`, apiKeyEnv: 'RELAY_KEY' } },
      provider: 'opencode',
      modelRef: 'jev-1.13-free',
      fallbackTiers: ['judges.relay'],
    });
    const { resolver } = relayEngine(config, { RELAY_KEY: 'k' });
    // The entry sits at its fallbackTiers position (position 2), NOT prepended.
    expect(resolver.resolveChain('test').tiers.map((t) => t.judgeId)).toEqual([
      'opencode/jev-1.13-free',
      'relay',
    ]);
    expect(resolver.resolveChain('test').noKeyRefs).toEqual([]);
    expect(resolver.resolveChain('test').unresolvableRefs).toEqual([]);
  });

  it('fail-closed: a relay answering junk cascades to the next custom tier', async () => {
    const config = baseConfig({
      judges: {
        junky: { type: 'typesafe', baseUrl: `${baseUrl}/junk`, apiKeyEnv: 'RELAY_KEY' },
        good: { type: 'typesafe', baseUrl: `${baseUrl}/good`, apiKeyEnv: 'RELAY_KEY' },
      },
    });
    const { engine } = relayEngine(config, { RELAY_KEY: 'k' });
    respond = (url) =>
      url.startsWith('/junk') ? { answers: {} } : { answers: CLEAR_WIRE_ANSWERS };
    const verdict = await engine.decide(goldenSampleSpec(), { state: GOLDEN_SAMPLE_STATE });
    // First tier's empty answer bag is parse-rejected, second tier answers.
    expect(verdict.judgeId).toBe('good');
    expect(requests.map((r) => r.url)).toEqual(['/junk/systemone', '/good/systemone']);
  });
});
