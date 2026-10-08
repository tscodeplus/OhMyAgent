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
    getModels: (provider: string) => mockGetModels(provider),
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
                model: 'jev-1.13',
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
      // Optional relay `model` (M5) must survive save/echo (round-trip).
      expect(body.config.judges.relay.model).toBe('jev-1.13');
      const judgeYaml = (savedYaml().judge ?? {}) as Record<string, any>;
      expect(judgeYaml.judges?.relay?.model).toBe('jev-1.13');
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
    it('merges a single provider key without dropping other providers (snake_case YAML)', async () => {
      // Pre-seed an unrelated provider key via a rich config the route reads:
      // the merge path runs on the raw yaml document, so simulate by writing
      // the file first.
      writeFileSync(configPath, 'provider_keys:\n  openai:\n    api_key: sk-test\n');
      const res = await app.inject({
        method: 'POST',
        url: '/api/judge/key',
        payload: { provider: 'opencode', apiKey: 'oc-key-123' },
      });
      expect(res.statusCode).toBe(200);
      const pk = (savedYaml().provider_keys ?? {}) as Record<string, { api_key?: string }>;
      // Stored keys are snake_case in config.yaml — camelCase apiKey would be
      // silently dropped by the config loader's yaml→JS mapping.
      expect(pk.openai?.api_key).toBe('sk-test');
      expect(pk.opencode?.api_key).toBe('oc-key-123');
      expect(Object.keys(pk.opencode ?? {})).toContain('api_key');
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      // keyStatus echoes the harness's getConfig() (yaml writes are verified above);
      // here only the shape is meaningful in this harness.
      expect(Array.isArray(body.keyStatus.opencode.envVars)).toBe(true);
    });

    it('empty apiKey clears the stored key (other keys survive)', async () => {
      writeFileSync(
        configPath,
        'provider_keys:\n  openai:\n    api_key: sk-test\n  opencode:\n    api_key: oc-key-123\n',
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/judge/key',
        payload: { provider: 'opencode', apiKey: '' },
      });
      expect(res.statusCode).toBe(200);
      const pk = (savedYaml().provider_keys ?? {}) as Record<string, { api_key?: string }>;
      expect(pk.openai?.api_key).toBe('sk-test');
      expect(pk.opencode).toBeUndefined();
    });

    it('cloudflare key + accountId saves BOTH snake_case fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/judge/key',
        payload: { provider: 'cloudflare-workers-ai', apiKey: 'cf-key', accountId: 'cf-acct' },
      });
      expect(res.statusCode).toBe(200);
      const pk = (savedYaml().provider_keys ?? {}) as Record<
        string,
        { api_key?: string; account_id?: string }
      >;
      expect(pk['cloudflare-workers-ai']?.api_key).toBe('cf-key');
      expect(pk['cloudflare-workers-ai']?.account_id).toBe('cf-acct');
    });

    it('accountId-only update leaves the stored api_key untouched', async () => {
      writeFileSync(configPath, 'provider_keys:\n  cloudflare-workers-ai:\n    api_key: cf-key\n');
      const res = await app.inject({
        method: 'POST',
        url: '/api/judge/key',
        payload: { provider: 'cloudflare-workers-ai', accountId: 'cf-acct' },
      });
      expect(res.statusCode).toBe(200);
      const pk = (savedYaml().provider_keys ?? {}) as Record<
        string,
        { api_key?: string; account_id?: string }
      >;
      expect(pk['cloudflare-workers-ai']?.api_key).toBe('cf-key');
      expect(pk['cloudflare-workers-ai']?.account_id).toBe('cf-acct');
    });

    it('empty accountId clears account_id but keeps the stored api_key', async () => {
      writeFileSync(
        configPath,
        'provider_keys:\n  cloudflare-workers-ai:\n    api_key: cf-key\n    account_id: cf-acct\n',
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/judge/key',
        payload: { provider: 'cloudflare-workers-ai', accountId: '' },
      });
      expect(res.statusCode).toBe(200);
      const pk = (savedYaml().provider_keys ?? {}) as Record<
        string,
        { api_key?: string; account_id?: string }
      >;
      expect(pk['cloudflare-workers-ai']?.api_key).toBe('cf-key');
      expect(pk['cloudflare-workers-ai']?.account_id).toBeUndefined();
    });

    it('deletes the provider entry when all fields are empty (base_url survives alone)', async () => {
      writeFileSync(
        configPath,
        'provider_keys:\n  cloudflare-workers-ai:\n    api_key: cf-key\n    account_id: cf-acct\n  opencode:\n    base_url: https://api.opencode.example\n',
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/judge/key',
        payload: { provider: 'cloudflare-workers-ai', apiKey: '', accountId: '' },
      });
      expect(res.statusCode).toBe(200);
      const pk = (savedYaml().provider_keys ?? {}) as Record<
        string,
        { api_key?: string; account_id?: string; base_url?: string }
      >;
      // Fully emptied entry is gone…
      expect(pk['cloudflare-workers-ai']).toBeUndefined();
      // …while a different-provider entry with a base_url keeps its entry AND
      // an emptied single-field clear must not remove a surviving base_url.
      expect(pk.opencode?.base_url).toBe('https://api.opencode.example');
    });

    it('rejects a missing provider with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/judge/key',
        payload: { apiKey: 'x' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a payload with neither apiKey nor accountId being a string with 400', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/judge/key',
        payload: { provider: 'opencode' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/judge/ledger', () => {
    it('returns the exact { entries, total, page, pageSize } contract through ledger.query', async () => {
      const querySpy = vi.fn(() => ({
        entries: [{ ts: '2026-01-15T10:00:00.000Z', pointId: 'tool.admission' }],
        total: 42,
        page: 2,
        pageSize: 20,
      }));
      const app2 = Fastify({ logger: false });
      registerJudgeRoutes(app2, {
        getConfig: baseConfig,
        getJudge: () => ({ ledger: { query: querySpy } }) as never,
        onConfigSaved: vi.fn(),
      });
      await app2.ready();
      const res = await app2.inject({
        method: 'GET',
        url: '/api/judge/ledger?page=2&pageSize=30&pointId=tool.admission&mode=shadow&outcome=judged&from=2026-01-15&to=2026-01-16&session=sess-1',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        entries: [{ ts: '2026-01-15T10:00:00.000Z', pointId: 'tool.admission' }],
        total: 42,
        page: 2,
        pageSize: 20,
      });
      expect(querySpy).toHaveBeenCalledWith({
        page: 2,
        pageSize: 30,
        pointId: 'tool.admission',
        mode: 'shadow',
        outcome: 'judged',
        from: '2026-01-15',
        to: '2026-01-16',
        session: 'sess-1',
      });
    });

    it('judge disabled → empty ledger, envelope shape intact', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/judge/ledger',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ entries: [], total: 0, page: 1, pageSize: 20 });
    });
  });
});
