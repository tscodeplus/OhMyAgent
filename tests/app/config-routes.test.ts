/**
 * Tests for config-routes.ts
 *
 * Verifies /api/providers endpoint.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
