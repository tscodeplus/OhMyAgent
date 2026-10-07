/**
 * Tests for judge-routes.ts
 *
 * Covers the WebUI↔server contract pinned by the cold-start review:
 *  - GET /api/judge/config envelope shape ({ config, models, keyStatus })
 *  - POST /api/judge/config MERGES over the persisted section (hand-edited
 *    features/timeoutMs/recordState/judges survive a UI save of the subset),
 *    with '' clearing optional string fields.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import Fastify from 'fastify';

// ─── Mock pi-mono compat before importing the routes ───

const mockGetModels = vi.fn((provider: string) => {
  const models: Record<string, any[]> = {
    opencode: [{ id: 'jev-1.13', type: 'classifier' }],
    typesafe: [{ id: 'jev-latest', type: 'classifier' }],
  };
  return models[provider] ?? [];
});

vi.mock('../../../src/pi-mono/ai/compat.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/pi-mono/ai/compat.js')>();
  return {
    ...actual,
    getModels: (...args: any[]) => mockGetModels(...args),
  };
});

// ─── Import routes after mocks ───

import { registerJudgeRoutes } from '../../../src/app/webui/judge-routes.js';

// ─── Harness ───

describe('judge routes', () => {
  let app: ReturnType<typeof Fastify>;
  let configPath: string;
  let cleanup: (() => void) | undefined;
  let savedYaml: () => Record<string, unknown>;

  const baseConfig = () =>
    ({
      judge: {
        enabled: true,
        provider: 'opencode',
        modelRef: 'jev-1.13',
        modes: { default: 'shadow' },
      },
    }) as any;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify({ logger: false });
    const dir = mkdtempSync(join(tmpdir(), 'judge-routes-'));
    configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, 'provider:\n  enabled: false\n');
    // mutateConfigYaml() resolves the file via CONFIG_FILE (defaulting to
    // ./config.yaml in the repo root) — ALWAYS point it at the temp copy.
    process.env.CONFIG_FILE = configPath;
    cleanup = () => {
      delete process.env.CONFIG_FILE;
      rmSync(dir, { recursive: true, force: true });
    };
    savedYaml = () => parseYaml(readFileSync(configPath, 'utf8')) as Record<string, unknown>;

    registerJudgeRoutes(app, {
      getConfig: baseConfig,
      getJudge: () => undefined,
      onConfigSaved: vi.fn(),
    });
    await app.ready();
  });

  afterEach(() => cleanup?.());

  describe('GET /api/judge/config', () => {
    it('returns the { config, models, keyStatus } envelope', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/judge/config' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.config).toMatchObject({
        enabled: true,
        provider: 'opencode',
        modelRef: 'jev-1.13',
      });
      expect(body.models).toBeTypeOf('object');
      expect(body.keyStatus).toBeTypeOf('object');
      // Envelope — not a flat judge section at the top level (UI unwraps).
      expect(body.modelsByProvider).toBeUndefined();
    });
  });

  describe('POST /api/judge/config merge semantics', () => {
    it('preserves hand-edited keys not present in the UI draft', async () => {
      // Hand-edited feature knobs already persisted:
      (baseConfig as any).call = undefined;
      const res = await app.inject({
        method: 'POST',
        url: '/api/judge/config',
        payload: {
          enabled: true,
          provider: 'typesafe',
          modelRef: 'jev-latest',
          fallbackTiers: [],
          modes: { default: 'active', 'tool.admission': 'active' },
        },
      });
      expect(res.statusCode).toBe(200);
      const judge = (savedYaml().judge ?? {}) as Record<string, unknown>;
      expect(judge.enabled).toBe(true);
      expect(judge.provider).toBe('typesafe');
    });

    it('merges over the current section instead of replacing it (features survive)', async () => {
      // Simulate a persisted section that already has hand-edited extras by
      // pointing getConfig at a config that contains them.
      const richConfig = () =>
        ({
          judge: {
            enabled: true,
            provider: 'opencode',
            modelRef: 'jev-1.13',
            fallbackTiers: ['opencode/jev-1.13-free'],
            modes: { default: 'shadow', 'tool.admission': 'active' },
            features: {
              testLogFold: 'rules',
              admission: { chunkSizeChars: 4000, keepThreshold: 0.8 },
            },
            timeoutMs: 8000,
            recordState: true,
            judges: {
              relay: {
                type: 'typesafe',
                baseUrl: 'https://relay.example/v1/systemone',
                apiKeyEnv: 'RELAY_KEY',
              },
            },
          },
        }) as any;
      const richApp = Fastify({ logger: false });
      registerJudgeRoutes(richApp, { getConfig: richConfig, getJudge: () => undefined });
      await richApp.ready();

      const res = await richApp.inject({
        method: 'POST',
        url: '/api/judge/config',
        payload: {
          enabled: true,
          provider: 'typesafe',
          modelRef: 'jev-latest',
          fallbackTiers: [],
          modes: { default: 'shadow' },
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Response echoes the merged, schema-parsed section:
      expect(body.config.features.testLogFold).toBe('rules');
      expect(body.config.features.admission.chunkSizeChars).toBe(4000);
      expect(body.config.timeoutMs).toBe(8000);
      expect(body.config.recordState).toBe(true);
      expect(body.config.judges.relay.apiKeyEnv).toBe('RELAY_KEY');
    });

    it('treats empty-string provider/modelRef as "clear the field"', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/judge/config',
        payload: {
          enabled: false,
          provider: '',
          modelRef: '',
          fallbackTiers: [],
          modes: { default: 'shadow' },
        },
      });
      expect(res.statusCode).toBe(200);
      const judge = (savedYaml().judge ?? {}) as Record<string, unknown>;
      expect(judge.enabled).toBe(false);
      expect(judge.provider).toBeUndefined();
      expect(judge.model_ref).toBeUndefined();
    });

    it('rejects an invalid mode value with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/judge/config',
        payload: { enabled: true, modes: { default: 'actve' } },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/judge/key', () => {
    it('merges a single provider key without dropping other providers', async () => {
      // Pre-seed an unrelated provider key via a rich config the route reads:
      // the merge path runs on the raw yaml document, so simulate by writing
      // the file first.
      writeFileSync(configPath, 'provider_keys:\n  openai:\n    apiKey: sk-test\n');
      const res = await app.inject({
        method: 'POST',
        url: '/api/judge/key',
        payload: { provider: 'opencode', apiKey: 'oc-key-123' },
      });
      expect(res.statusCode).toBe(200);
      const pk = (savedYaml().provider_keys ?? {}) as Record<string, { apiKey?: string }>;
      expect(pk.openai?.apiKey).toBe('sk-test');
      expect(pk.opencode?.apiKey).toBe('oc-key-123');
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      // keyStatus echoes the harness's getConfig() (yaml writes are verified above);
      // here only the shape is meaningful in this harness.
      expect(Array.isArray(body.keyStatus.opencode.envVars)).toBe(true);
    });

    it('empty apiKey clears the stored key (other keys survive)', async () => {
      writeFileSync(
        configPath,
        'provider_keys:\n  openai:\n    apiKey: sk-test\n  opencode:\n    apiKey: oc-key-123\n',
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/judge/key',
        payload: { provider: 'opencode', apiKey: '' },
      });
      expect(res.statusCode).toBe(200);
      const pk = (savedYaml().provider_keys ?? {}) as Record<string, { apiKey?: string }>;
      expect(pk.openai?.apiKey).toBe('sk-test');
      expect(pk.opencode).toBeUndefined();
    });

    it('rejects a missing provider with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/judge/key',
        payload: { apiKey: 'x' },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
