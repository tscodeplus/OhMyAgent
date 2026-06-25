/**
 * Tests for model-resolver.ts
 *
 * Verifies model resolution logic: deepseek detection, context window
 * resolution, model priority chain, config overrides, and NVIDIA patching.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───

const mockGetModel = vi.fn();
const mockGetModels = vi.fn();

vi.mock('@earendil-works/pi-ai', () => ({
  getModel: (...args: any[]) => mockGetModel(...args),
}));

vi.mock('../../src/provider/pi-ai-setup.js', () => ({
  getDefaultModel: vi.fn(),
}));

// ─── Helpers ───

function makeModel(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'openai',
    id: 'gpt-4',
    baseUrl: 'https://api.openai.com/v1',
    contextWindow: 128000,
    ...overrides,
  };
}

// ─── Imports (after mocks) ───

import {
  isDeepSeekLikeModel,
  resolveModelContextLength,
  resolveModel,
  type ResolvedModel,
} from '../../src/agent/model-resolver.js';

describe('isDeepSeekLikeModel', () => {
  it('returns true when provider contains deepseek', () => {
    expect(isDeepSeekLikeModel(makeModel({ provider: 'deepseek' }))).toBe(true);
    expect(isDeepSeekLikeModel(makeModel({ provider: 'DeepSeek-V3' }))).toBe(true);
  });

  it('returns true when id contains deepseek', () => {
    expect(isDeepSeekLikeModel(makeModel({ id: 'deepseek-chat' }))).toBe(true);
    expect(isDeepSeekLikeModel(makeModel({ id: 'DeepSeek-R1' }))).toBe(true);
  });

  it('returns true when baseUrl contains deepseek', () => {
    expect(isDeepSeekLikeModel(makeModel({ baseUrl: 'https://api.deepseek.com/v1' }))).toBe(true);
  });

  it('returns false for non-deepseek models', () => {
    expect(isDeepSeekLikeModel(makeModel())).toBe(false);
    expect(isDeepSeekLikeModel(makeModel({ provider: 'nvidia', id: 'llama-3.1-70b', baseUrl: 'https://api.nvcf.nvidia.com' }))).toBe(false);
  });

  it('returns false for undefined model', () => {
    expect(isDeepSeekLikeModel(undefined)).toBe(false);
  });
});

describe('resolveModelContextLength', () => {
  it('returns contextWindow when present', () => {
    expect(resolveModelContextLength(makeModel({ contextWindow: 128000 }))).toBe(128000);
  });

  it('falls back to context_length when contextWindow is absent', () => {
    expect(resolveModelContextLength(makeModel({ contextWindow: undefined, context_length: 64000 }))).toBe(64000);
  });

  it('falls back to maxTokens when both contextWindow and context_length are absent', () => {
    expect(resolveModelContextLength(makeModel({ contextWindow: undefined, context_length: undefined, maxTokens: 32000 }))).toBe(32000);
  });

  it('returns 0 when no context info is present', () => {
    expect(resolveModelContextLength(makeModel({ contextWindow: undefined }))).toBe(0);
  });

  it('returns 0 for undefined model', () => {
    expect(resolveModelContextLength(undefined)).toBe(0);
  });
});

describe('resolveModel', () => {
  const baseConfig: any = {
    piAi: { provider: 'deepseek', model: 'deepseek-chat', reasoningModel: 'deepseek-reasoner' },
    customProviders: [],
    fallbackModels: [],
    providerKeys: {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns explicit model when provided', () => {
    const explicit = makeModel({ provider: 'nvidia', id: 'meta/llama-3.1-70b' });
    const result = resolveModel({ explicitModel: explicit, config: baseConfig });

    expect(result.modelProvider).toBe('nvidia');
    expect(result.modelId).toBe('meta/llama-3.1-70b');
  });

  it('applies baseUrl override from customProvider', () => {
    const config = {
      ...baseConfig,
      customProviders: [
        { provider: 'nvidia', baseUrl: 'https://custom.nvidia.com/v1', models: [] },
      ],
    };
    const model = makeModel({ provider: 'nvidia', id: 'meta/llama-3.1-70b' });
    const result = resolveModel({ explicitModel: model, config });

    expect((result.model as any).baseUrl).toBe('https://custom.nvidia.com/v1');
  });

  it('applies baseUrl override from providerKeys', () => {
    const config = {
      ...baseConfig,
      providerKeys: { nvidia: { baseUrl: 'https://keys.nvidia.com/v1', apiKey: 'sk-xxx' } },
    };
    const model = makeModel({ provider: 'nvidia', id: 'meta/llama-3.1-70b' });
    const result = resolveModel({ explicitModel: model, config });

    expect((result.model as any).baseUrl).toBe('https://keys.nvidia.com/v1');
  });

  it('prefers customProvider baseUrl over providerKeys', () => {
    const config = {
      ...baseConfig,
      customProviders: [
        { provider: 'nvidia', baseUrl: 'https://custom.nvidia.com/v1', models: [] },
      ],
      providerKeys: { nvidia: { baseUrl: 'https://keys.nvidia.com/v1', apiKey: 'sk-xxx' } },
    };
    const model = makeModel({ provider: 'nvidia', id: 'meta/llama-3.1-70b' });
    const result = resolveModel({ explicitModel: model, config });

    expect((result.model as any).baseUrl).toBe('https://custom.nvidia.com/v1');
  });

  it('applies piAi.baseUrl when provider matches primary', () => {
    const config = {
      ...baseConfig,
      piAi: { provider: 'openai', model: 'gpt-4', baseUrl: 'https://proxy.openai.com/v1' },
    };
    const model = makeModel({ provider: 'openai', id: 'gpt-4' });
    const result = resolveModel({ explicitModel: model, config });

    expect((result.model as any).baseUrl).toBe('https://proxy.openai.com/v1');
  });

  it('does NOT apply piAi.baseUrl to non-primary providers', () => {
    const config = {
      ...baseConfig,
      piAi: { provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://proxy.ds.com/v1' },
    };
    const model = makeModel({ provider: 'nvidia', id: 'meta/llama-3.1-70b' });
    const result = resolveModel({ explicitModel: model, config });

    expect((result.model as any).baseUrl).toBe('https://api.openai.com/v1');
  });

  it('strips NVCF-POLL-SECONDS header', () => {
    const model = makeModel({
      provider: 'nvidia',
      id: 'minimaxai/minimax-m3',
      headers: { 'NVCF-POLL-SECONDS': '30', 'Content-Type': 'application/json' },
    });
    const result = resolveModel({ explicitModel: model, config: baseConfig });

    expect((result.model as any).headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('does not crash when model has no headers', () => {
    const model = makeModel({ provider: 'nvidia', id: 'meta/llama-3.1-70b' });
    expect(() => resolveModel({ explicitModel: model, config: baseConfig })).not.toThrow();
  });

  it('patches NVIDIA reasoning from customProviders config', () => {
    const config = {
      ...baseConfig,
      customProviders: [
        {
          provider: 'nvidia',
          models: [{ id: 'meta/llama-3.1-70b', reasoning: true, reasoningLevel: 'medium' }],
        },
      ],
    };
    const model = makeModel({ provider: 'nvidia', id: 'meta/llama-3.1-70b', reasoning: false });
    const result = resolveModel({ explicitModel: model, config });

    expect((result.model as any).reasoning).toBe(true);
    expect((result.model as any).compat?.supportsReasoningEffort).toBe(true);
  });

  it('does NOT patch non-NVIDIA models for reasoning', () => {
    const config = {
      ...baseConfig,
      customProviders: [
        { provider: 'openai', models: [{ id: 'gpt-4', reasoning: true }] },
      ],
    };
    const model = makeModel({ provider: 'openai', id: 'gpt-4', reasoning: false, compat: {} });
    const result = resolveModel({ explicitModel: model, config });

    expect((result.model as any).reasoning).toBe(false);
    expect((result.model as any).compat).toEqual({});
  });

  it('resolves thinkingLevel from custom model config', () => {
    const config = {
      ...baseConfig,
      customProviders: [
        { provider: 'nvidia', models: [{ id: 'meta/llama-3.1-70b', reasoningLevel: 'high' }] },
      ],
    };
    const model = makeModel({ provider: 'nvidia', id: 'meta/llama-3.1-70b' });
    const result = resolveModel({ explicitModel: model, config });

    expect(result.thinkingLevel).toBe('high');
  });

  it('falls back to defaultReasoningLevel', () => {
    const config = { ...baseConfig, defaultReasoningLevel: 'low' };
    const model = makeModel();
    const result = resolveModel({ explicitModel: model, config });

    expect(result.thinkingLevel).toBe('low');
  });

  it('uses deepseek cache profile for deepseek models', () => {
    const model = makeModel({ provider: 'deepseek', id: 'deepseek-chat' });
    const result = resolveModel({ explicitModel: model, config: baseConfig });

    expect(result.cacheProfile).toBe('deepseek');
  });

  it('resolves fallback model chain from config', () => {
    const fallbackModel = makeModel({ provider: 'openai', id: 'gpt-3.5-turbo' });
    mockGetModel.mockReturnValue(fallbackModel);

    const config = { ...baseConfig, fallbackModels: ['openai/gpt-3.5-turbo'] };
    const model = makeModel();
    const result = resolveModel({ explicitModel: model, config });

    expect(result.fallbackModels).toHaveLength(1);
    expect((result.fallbackModels[0] as any).id).toBe('gpt-3.5-turbo');
  });
});
