/**
 * Tests for config-routes.ts
 *
 * Verifies /api/providers endpoint.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import Fastify from 'fastify';

// ─── Mock pi-mono compat before importing the routes ───

const mockGetProviders = vi.fn(() => ['openai', 'deepseek', 'nvidia']);
const mockGetBuiltinProviders = vi.fn(() => ['openai', 'deepseek', 'nvidia']);
const mockGetModels = vi.fn((provider: string) => {
  const models: Record<string, any[]> = {
    openai: [{ id: 'gpt-4', baseUrl: 'https://api.openai.com/v1' }],
    deepseek: [{ id: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' }],
    nvidia: [{ id: 'meta/llama-3.1-70b', baseUrl: 'https://integrate.api.nvidia.com/v1' }],
  };
  return models[provider] ?? [];
});

vi.mock('../../src/pi-mono/ai/compat.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/pi-mono/ai/compat.js')>();
  return {
    ...actual,
    getProviders: (...args: any[]) => mockGetProviders(...args),
    getBuiltinProviders: (...args: any[]) => mockGetBuiltinProviders(...args),
    getModels: (...args: any[]) => mockGetModels(...args),
  };
});

// ─── Import routes after mocks ───

import { registerConfigRoutes } from '../../src/app/webui/config-routes.js';
import { MASKED_SECRET } from '../../src/mcp/masking.js';

// ─── Tests ───

describe('GET /api/providers', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();

    app = Fastify({ logger: false });

    registerConfigRoutes(app, {
      getConfig: () => ({ piAi: { provider: 'openai', model: 'gpt-4' } }) as any,
      configPath: '/tmp/test-config.yaml',
    });

    await app.ready();
  });

  it('returns list of providers with ids and names', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/providers' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.providers).toHaveLength(3);
    expect(body.providers[0]).toEqual({
      id: 'openai',
      name: 'openai',
      baseUrl: 'https://api.openai.com/v1',
    });
  });

  it('includes baseUrl from first model of each provider', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/providers' });
    const body = JSON.parse(res.body);

    expect(body.providers[1].baseUrl).toBe('https://api.deepseek.com/v1');
    expect(body.providers[2].baseUrl).toBe('https://integrate.api.nvidia.com/v1');
  });

  it('returns undefined baseUrl when provider has no models', async () => {
    mockGetBuiltinProviders.mockReturnValue(['empty-provider']);
    mockGetModels.mockReturnValue([]);

    const res = await app.inject({ method: 'GET', url: '/api/providers' });
    const body = JSON.parse(res.body);

    expect(body.providers[0].baseUrl).toBeUndefined();
  });

  it('returns empty providers array when no providers registered', async () => {
    mockGetBuiltinProviders.mockReturnValue([]);

    const res = await app.inject({ method: 'GET', url: '/api/providers' });
    const body = JSON.parse(res.body);

    expect(body.providers).toEqual([]);
  });
});

describe('GET /api/providers/:id/models', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();

    app = Fastify({ logger: false });

    registerConfigRoutes(app, {
      getConfig: () => ({ piAi: { provider: 'openai', model: 'gpt-4' } }) as any,
      configPath: '/tmp/test-config.yaml',
    });

    await app.ready();
  });

  it('returns serialized model catalog for a known provider', async () => {
    mockGetModels.mockReturnValue([
      {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        api: 'openai-completions',
        baseUrl: 'https://api.deepseek.com',
        reasoning: true,
        input: ['text'],
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        thinkingLevelMap: { low: 'low' },
        cost: { input: 0.14 },
        compat: { maxTokensField: 'max_tokens' },
      },
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/providers/deepseek/models' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.provider).toBe('deepseek');
    expect(body.models).toHaveLength(1);
    // Known metadata fields are surfaced…
    expect(body.models[0]).toMatchObject({
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      api: 'openai-completions',
      baseUrl: 'https://api.deepseek.com',
      reasoning: true,
      input: ['text'],
      contextWindow: 1_000_000,
      maxTokens: 384_000,
    });
    // …while heavy internals (cost/compat) are stripped out.
    expect(body.models[0].cost).toBeUndefined();
    expect(body.models[0].compat).toBeUndefined();
  });

  it('normalizes missing fields (reasoning false, input empty array)', async () => {
    mockGetModels.mockReturnValue([
      { id: 'bare-model', name: undefined, api: 'openai-completions' },
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/providers/x/models' });
    const body = JSON.parse(res.body);

    expect(body.models[0]).toEqual({
      id: 'bare-model',
      name: 'bare-model',
      api: 'openai-completions',
      baseUrl: undefined,
      reasoning: false,
      input: [],
      contextWindow: undefined,
      maxTokens: undefined,
      thinkingLevelMap: undefined,
    });
  });

  it('returns empty models array for unknown provider', async () => {
    mockGetModels.mockImplementation(() => {
      throw new Error('unknown provider');
    });

    const res = await app.inject({ method: 'GET', url: '/api/providers/nope/models' });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.provider).toBe('nope');
    expect(body.models).toEqual([]);
  });
});

describe('PUT /api/config', () => {
  let app: ReturnType<typeof Fastify>;
  let dir: string;
  let configPath: string;
  let onConfigSaved: ReturnType<typeof vi.fn>;
  let previousConfigFile: string | undefined;

  function readConfig(): Record<string, unknown> {
    return (parseYaml(readFileSync(configPath, 'utf-8')) ?? {}) as Record<string, unknown>;
  }

  beforeEach(async () => {
    vi.clearAllMocks();

    dir = mkdtempSync(join(tmpdir(), 'oma-config-routes-'));
    configPath = join(dir, 'config.yaml');
    previousConfigFile = process.env.CONFIG_FILE;
    process.env.CONFIG_FILE = configPath;
    onConfigSaved = vi.fn();

    app = Fastify({ logger: false });

    registerConfigRoutes(app, {
      getConfig: () => ({ piAi: { provider: 'openai', model: 'gpt-4' } }) as any,
      // Deliberately missing: startConfigWatcher() only watches existing files,
      // so the test does not leave a real watcher behind.
      configPath: join(dir, 'watched-config.yaml'),
      onConfigSaved: (newConfig) => onConfigSaved(newConfig),
    });

    await app.ready();
  });

  afterEach(() => {
    if (previousConfigFile === undefined) {
      delete process.env.CONFIG_FILE;
    } else {
      process.env.CONFIG_FILE = previousConfigFile;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes updates to config.yaml and preserves comments', async () => {
    writeFileSync(configPath, '# OhMyAgent config\nui_language: zh-CN\n', 'utf-8');

    const res = await app.inject({
      method: 'PUT',
      url: '/api/config',
      payload: { logging: { level: 'debug' } },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(readConfig()).toEqual({ ui_language: 'zh-CN', log_level: 'debug' });
    expect(readFileSync(configPath, 'utf-8')).toContain('# OhMyAgent config');
    expect(onConfigSaved).toHaveBeenCalled();
  });

  it('rejects a non-object body', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config',
      headers: { 'content-type': 'application/json' },
      payload: 'null',
    });

    expect(res.statusCode).toBe(400);
  });

  it('keeps concurrent saves of different fields', async () => {
    writeFileSync(configPath, 'log_level: info\n', 'utf-8');

    const [first, second] = await Promise.all([
      app.inject({
        method: 'PUT',
        url: '/api/config',
        payload: { uiLanguage: 'en' },
      }),
      app.inject({
        method: 'PUT',
        url: '/api/config',
        payload: { logging: { level: 'debug' } },
      }),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(readConfig()).toEqual({ log_level: 'debug', ui_language: 'en' });
  });
});

// ─── mcp masking on the generic config endpoint ───

describe('GET /api/config — mcp credential masking', () => {
  let app: ReturnType<typeof Fastify>;
  let dir: string;
  let configPath: string;
  let previousConfigFile: string | undefined;

  const liveConfig = {
    piAi: { provider: 'openai', model: 'gpt-4' },
    mcp: {
      enabled: true,
      connectTimeoutSec: 15,
      requestTimeoutSec: 60,
      maxOutputBytes: 20480,
      maxConcurrentConnects: 4,
      injectSystemPrompt: true,
      allowServers: [],
      denyServers: [],
      servers: {
        filesystem: {
          name: 'filesystem',
          enabled: true,
          exposure: 'deferred',
          toolExposure: {},
          description: 'fs',
          transport: 'stdio',
          command: 'npx',
          args: [],
          env: { GITHUB_TOKEN: 'ghp_realtoken', LOG_LEVEL: 'debug' },
          cwd: '',
        },
        docs: {
          name: 'docs',
          enabled: true,
          exposure: 'deferred',
          toolExposure: {},
          description: 'docs',
          transport: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer realtoken' },
        },
      },
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();

    // `rawMaskedServers()` reads the raw `config.yaml` the process resolves
    // (`CONFIG_FILE`, else CWD) — without an override a developer machine that
    // has a real `mcp:` section would leak its servers into the masked payload
    // and clobber the fixture below. Point it at an empty temp file.
    dir = mkdtempSync(join(tmpdir(), 'oma-config-masking-'));
    configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, '', 'utf-8');
    previousConfigFile = process.env.CONFIG_FILE;
    process.env.CONFIG_FILE = configPath;

    app = Fastify({ logger: false });
    registerConfigRoutes(app, {
      getConfig: () => liveConfig as any,
      configPath,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    if (previousConfigFile === undefined) {
      delete process.env.CONFIG_FILE;
    } else {
      process.env.CONFIG_FILE = previousConfigFile;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('masks mcp secrets, so /api/config cannot defeat /api/mcp masking', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.mcp.servers.filesystem.env.GITHUB_TOKEN).toBe(MASKED_SECRET);
    expect(body.mcp.servers.filesystem.env.LOG_LEVEL).toBe('debug');
    expect(body.mcp.servers.docs.headers.Authorization).toBe(MASKED_SECRET);

    // The strongest assertion: no raw secret survives anywhere in the payload.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('ghp_realtoken');
    expect(raw).not.toContain('Bearer realtoken');
  });

  it('does not mutate the live config object', async () => {
    await app.inject({ method: 'GET', url: '/api/config' });

    // Mutating the live object would silently destroy the user's credentials
    // for the running process, so this is a correctness guarantee, not style.
    expect(liveConfig.mcp.servers.filesystem.env.GITHUB_TOKEN).toBe('ghp_realtoken');
    expect(liveConfig.mcp.servers.docs.headers.Authorization).toBe('Bearer realtoken');
  });
});
