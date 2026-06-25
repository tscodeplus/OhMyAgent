/**
 * Tests for config-routes.ts
 *
 * Verifies /api/providers endpoint.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// ─── Mock pi-mono models before importing the routes ───

const mockGetProviders = vi.fn(() => ['openai', 'deepseek', 'nvidia']);
const mockGetModels = vi.fn((provider: string) => {
  const models: Record<string, any[]> = {
    openai: [{ id: 'gpt-4', baseUrl: 'https://api.openai.com/v1' }],
    deepseek: [{ id: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' }],
    nvidia: [{ id: 'meta/llama-3.1-70b', baseUrl: 'https://integrate.api.nvidia.com/v1' }],
  };
  return models[provider] ?? [];
});

vi.mock('../../src/pi-mono/ai/models.js', () => ({
  getProviders: (...args: any[]) => mockGetProviders(...args),
  getModels: (...args: any[]) => mockGetModels(...args),
}));

// ─── Import routes after mocks ───

import { registerConfigRoutes } from '../../src/app/webui/config-routes.js';

// ─── Tests ───

describe('GET /api/providers', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();

    app = Fastify({ logger: false });

    registerConfigRoutes(app, {
      getConfig: () => ({ piAi: { provider: 'openai', model: 'gpt-4' } } as any),
      saveConfig: vi.fn(),
      onConfigReload: vi.fn(),
      log: { info: vi.fn(), warn: vi.fn() } as any,
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
    mockGetProviders.mockReturnValue(['empty-provider']);
    mockGetModels.mockReturnValue([]);

    const res = await app.inject({ method: 'GET', url: '/api/providers' });
    const body = JSON.parse(res.body);

    expect(body.providers[0].baseUrl).toBeUndefined();
  });

  it('returns empty providers array when no providers registered', async () => {
    mockGetProviders.mockReturnValue([]);

    const res = await app.inject({ method: 'GET', url: '/api/providers' });
    const body = JSON.parse(res.body);

    expect(body.providers).toEqual([]);
  });
});
