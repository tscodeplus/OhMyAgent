import { describe, it, expect, beforeEach } from 'vitest';
import { routeModel, getModelForRole } from '../../src/provider/model-router';
import { loadConfig, resetConfig } from '../../src/app/config';

describe('routeModel', () => {
  it('returns default for <= 10 messages without tool results', () => {
    expect(routeModel(5, false)).toBe('default');
    expect(routeModel(10, false)).toBe('default');
  });

  it('returns reasoning for > 10 messages', () => {
    expect(routeModel(11, false)).toBe('reasoning');
    expect(routeModel(100, false)).toBe('reasoning');
  });

  it('returns reasoning when tool results present', () => {
    expect(routeModel(1, true)).toBe('reasoning');
    expect(routeModel(5, true)).toBe('reasoning');
  });
});

describe('getModelForRole', () => {
  beforeEach(() => { resetConfig(); });

  const validEnv = {
    CONFIG_FILE: '',
    FEISHU_APP_ID: 'cli_test',
    FEISHU_APP_SECRET: 'secret',
    PI_AI_API_KEY: 'sk-test',
    PI_AI_PROVIDER: 'deepseek',
    PI_AI_MODEL: 'deepseek-chat',
    PI_AI_REASONING_MODEL: 'deepseek-reasoner',
    EMBEDDING_API_KEY: 'sk-embed',
  };

  it('returns default model', () => {
    const config = loadConfig(validEnv);
    const result = getModelForRole(config, 'default');
    expect(result.model).toBe('deepseek-chat');
    expect(result.provider).toBe('deepseek');
  });

  it('returns reasoning model', () => {
    const config = loadConfig(validEnv);
    const result = getModelForRole(config, 'reasoning');
    expect(result.model).toBe('deepseek-reasoner');
    expect(result.provider).toBe('deepseek');
  });
});
