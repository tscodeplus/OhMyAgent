import { describe, it, expect, beforeEach } from 'vitest';
import { getModelInstance, getDefaultModel, getReasoningModel, ensureModelRegistered } from '../../src/provider/pi-ai-setup';
import { loadConfig, resetConfig } from '../../src/app/config';

describe('pi-ai-setup', () => {
  beforeEach(() => {
    resetConfig();
  });

  const validEnv = {
    FEISHU_APP_ID: 'cli_test',
    FEISHU_APP_SECRET: 'secret',
    PI_AI_API_KEY: 'sk-test',
    PI_AI_PROVIDER: 'deepseek',
    PI_AI_MODEL: 'deepseek-chat',
    EMBEDDING_API_KEY: 'sk-embed',
  };

  it('getModelInstance returns a model from the registry', () => {
    const model = getModelInstance('deepseek', 'deepseek-v4-flash');
    expect(model).toBeDefined();
    expect(model.id).toBe('deepseek-v4-flash');
  });

  it('getModelInstance returns undefined for unknown provider', () => {
    const model = getModelInstance('nonexistent-provider', 'nonexistent-model');
    expect(model).toBeUndefined();
  });

  it('getDefaultModel returns model from config', () => {
    const config = loadConfig({
      ...validEnv,
      PI_AI_MODEL: 'deepseek-v4-flash',
    });
    const model = getDefaultModel(config);
    expect(model).toBeDefined();
    expect(model.id).toBe('deepseek-v4-flash');
    expect(model.provider).toBe('deepseek');
  });

  it('getReasoningModel returns reasoning model from config', () => {
    const config = loadConfig({
      ...validEnv,
      PI_AI_REASONING_MODEL: 'deepseek-v4-pro',
    });
    const model = getReasoningModel(config);
    expect(model).toBeDefined();
    expect(model.id).toBe('deepseek-v4-pro');
  });

  it('getDefaultModel respects custom provider/model from env', () => {
    const config = loadConfig({
      ...validEnv,
      PI_AI_PROVIDER: 'openai',
      PI_AI_MODEL: 'gpt-4o',
    });
    const model = getDefaultModel(config);
    expect(model).toBeDefined();
    expect(model.id).toBe('gpt-4o');
    expect(model.provider).toBe('openai');
  });
});

describe('ensureModelRegistered', () => {
  beforeEach(() => {
    resetConfig();
  });

  const validEnv = {
    FEISHU_APP_ID: 'cli_test',
    FEISHU_APP_SECRET: 'secret',
    PI_AI_API_KEY: 'sk-test',
    PI_AI_PROVIDER: 'deepseek',
    PI_AI_MODEL: 'deepseek-chat',
    EMBEDDING_API_KEY: 'sk-embed',
  };

  const makeConfig = () => {
    const config = loadConfig(validEnv) as any;
    config.customProviders = [
      {
        provider: 'agnes',
        apiKey: 'sk-agnes',
        baseUrl: 'https://apihub.agnes-ai.com/v1',
        models: [
          { id: 'agnes-2.5-flash', name: 'Agnes 2.5 Flash', api: 'openai-completions', reasoning: true },
        ],
      },
    ];
    return config;
  };

  it('returns the existing model when already resolvable', () => {
    const config = makeConfig();
    const model = ensureModelRegistered(config, 'deepseek', 'deepseek-v4-flash');
    expect(model).toBeDefined();
    expect(model.id).toBe('deepseek-v4-flash');
  });

  it('returns undefined for providers that are not configured custom providers', () => {
    const config = makeConfig();
    expect(ensureModelRegistered(config, 'nonexistent-provider', 'nonexistent-model')).toBeUndefined();
  });

  it('returns undefined when provider or modelId is missing', () => {
    const config = makeConfig();
    expect(ensureModelRegistered(config, undefined, 'm')).toBeUndefined();
    expect(ensureModelRegistered(config, 'agnes', undefined)).toBeUndefined();
  });

  it('synthesizes and registers an unlisted custom-provider model (live model list pick)', () => {
    const config = makeConfig();

    // Before: not resolvable
    expect(getModelInstance('agnes', 'agnes-2.0-flash')).toBeUndefined();

    const model = ensureModelRegistered(config, 'agnes', 'agnes-2.0-flash');
    expect(model).toBeDefined();
    expect(model.id).toBe('agnes-2.0-flash');
    expect(model.provider).toBe('agnes');
    // API type inherited from the provider's configured model
    expect(model.api).toBe('openai-completions');
    expect(model.baseUrl).toBe('https://apihub.agnes-ai.com/v1');
    expect(model.apiKey).toBe('sk-agnes');
    expect(model.reasoning).toBe(false);
    expect(model.contextWindow).toBeGreaterThan(0);

    // After: resolvable via the regular registry (idempotent lookups)
    const again = getModelInstance('agnes', 'agnes-2.0-flash');
    expect(again).toBeDefined();
    expect(again.id).toBe('agnes-2.0-flash');
  });

  it('getDefaultModel resolves an unlisted custom-provider model ref', () => {
    const config = makeConfig();
    config.piAi = { ...config.piAi, provider: 'agnes', model: 'agnes-2.0-flash' };

    const model = getDefaultModel(config);
    expect(model).toBeDefined();
    expect(model.id).toBe('agnes-2.0-flash');
    expect(model.provider).toBe('agnes');
    expect(model.api).toBe('openai-completions');
  });

  it('synthesizes an unlisted model for a built-in provider configured via provider_keys', () => {
    const config = loadConfig(validEnv) as any;
    config.customProviders = [];
    config.providerKeys = {
      deepseek: { apiKey: 'sk-ds', baseUrl: 'https://api.deepseek.com' },
    };

    // Before: not in the pi-mono catalog → unresolvable
    expect(getModelInstance('deepseek', 'deepseek-chat-v5-new')).toBeUndefined();

    const model = ensureModelRegistered(config, 'deepseek', 'deepseek-chat-v5-new');
    expect(model).toBeDefined();
    expect(model.id).toBe('deepseek-chat-v5-new');
    expect(model.provider).toBe('deepseek');
    // API type + default baseUrl inherited from the built-in catalog
    expect(model.api).toBe('openai-completions');
    // ensureV1BaseUrl appended /v1 to the catalog default
    expect(model.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(model.apiKey).toBe('sk-ds');
    expect(model.contextWindow).toBeGreaterThan(0);

    // After: resolvable via the regular registry
    expect(getModelInstance('deepseek', 'deepseek-chat-v5-new')).toBeDefined();
  });

  it('synthesizes for the piAi primary provider even without a provider_keys entry', () => {
    const config = loadConfig(validEnv) as any; // deepseek is primary with PI_AI_API_KEY
    config.customProviders = [];
    config.providerKeys = {};

    const model = ensureModelRegistered(config, 'deepseek', 'deepseek-chat-v6-beta');
    expect(model).toBeDefined();
    expect(model.apiKey).toBe('sk-test');
    expect(model.api).toBe('openai-completions');
  });

  it('returns undefined for a built-in provider without credentials (graceful fallback)', () => {
    const config = loadConfig(validEnv) as any;
    config.customProviders = [];
    config.providerKeys = {};
    // deepseek is the piAi primary (has PI_AI_API_KEY) — use a non-primary
    // provider with no provider_keys entry
    expect(ensureModelRegistered(config, 'openrouter', 'some-unlisted-model')).toBeUndefined();
  });
});
