import { describe, it, expect, beforeEach } from 'vitest';
import { getModelInstance, getDefaultModel, getReasoningModel } from '../../src/provider/pi-ai-setup';
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
