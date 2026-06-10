import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import { loadConfig, resetConfig, startConfigWatcher, stopConfigWatcher } from '../../src/app/config';

describe('loadConfig', () => {
  beforeEach(() => {
    resetConfig();
    stopConfigWatcher();
  });

  afterEach(() => {
    stopConfigWatcher();
  });

  const validEnv = {
    FEISHU_APP_ID: 'cli_test',
    FEISHU_APP_SECRET: 'secret',
    PI_AI_API_KEY: 'sk-test',
    EMBEDDING_API_KEY: 'sk-embed',
    CONFIG_FILE: '',  // skip config.yaml — test uses env-only path
  };

  it('loads valid config with defaults', () => {
    const config = loadConfig(validEnv);
    expect(config.feishu.appId).toBe('cli_test');
    expect(config.piAi.provider).toBe('');
    expect(config.piAi.model).toBe('');
    expect(config.database.path).toBe('~/.ohmyagent/data/app.db');
    expect(config.tools.shellEnabled).toBe(true);
    expect(config.tools.shellApprovalMode).toBe('balanced');
  });

  it('loads empty config with all defaults', () => {
    // Empty config is valid — all model fields default to empty strings.
    // Explicitly disable CONFIG_FILE to prevent loading from disk.
    const config = loadConfig({ CONFIG_FILE: '' });
    expect(config.piAi.provider).toBe('');
    expect(config.piAi.model).toBe('');
  });

  it('validates empty config as valid', () => {
    expect(() => loadConfig({ CONFIG_FILE: '' })).not.toThrow();
  });

  it('overrides defaults from env', () => {
    const config = loadConfig({
      ...validEnv,
      PI_AI_PROVIDER: 'openai',
      PI_AI_MODEL: 'gpt-4o',
      DATABASE_PATH: '/custom/path.db',
      SHELL_ENABLED: 'false',
      SHELL_COMMAND_TIMEOUT_MS: '30000',
      SHELL_APPROVAL_MODE: 'strict',
      MEMORY_AUTO_RECALL: 'true',
      MEMORY_RECALL_TOP_K: '5',
      MEMORY_OUTPUT_LANGUAGE: 'zh-CN',
    });
    expect(config.piAi.provider).toBe('openai');
    expect(config.piAi.model).toBe('gpt-4o');
    expect(config.database.path).toBe('/custom/path.db');
    expect(config.tools.shellEnabled).toBe(false);
    expect(config.tools.defaultTimeoutMs).toBe(30000);
    expect(config.tools.shellApprovalMode).toBe('strict');
    expect(config.memory.autoRecall).toBe(true);
    expect(config.memory.recallTopK).toBe(5);
    expect(config.memory.outputLanguage).toBe('Simplified Chinese');
  });

  it('defaults memory.expansion to disabled with conservative gate', () => {
    const config = loadConfig(validEnv);
    expect(config.memory.expansion.enabled).toBe(false);
    expect(config.memory.expansion.minQueryLength).toBe(15);
    expect(config.memory.expansion.minScoreTrigger).toBe(0.3);
    expect(config.memory.expansion.maxVariants).toBe(4);
  });

  it('overrides memory.expansion from env', () => {
    const config = loadConfig({
      ...validEnv,
      MEMORY_EXPANSION_ENABLED: 'true',
      MEMORY_EXPANSION_MIN_QUERY_LENGTH: '8',
      MEMORY_EXPANSION_MIN_SCORE_TRIGGER: '0.45',
      MEMORY_EXPANSION_MAX_VARIANTS: '6',
    });
    expect(config.memory.expansion.enabled).toBe(true);
    expect(config.memory.expansion.minQueryLength).toBe(8);
    expect(config.memory.expansion.minScoreTrigger).toBe(0.45);
    expect(config.memory.expansion.maxVariants).toBe(6);
  });

  it('rejects an out-of-range expansion minScoreTrigger', () => {
    expect(() => loadConfig({
      ...validEnv,
      MEMORY_EXPANSION_MIN_SCORE_TRIGGER: '1.5',
    })).toThrow();
  });

  it('overrides footer usage display from env', () => {
    const config = loadConfig({
      ...validEnv,
      FOOTER_SHOW_USAGE: 'true',
      FOOTER_SHOW_CACHE_HIT_RATE: 'true',
    });
    expect(config.footer.showUsage).toBe(true);
    expect(config.footer.showCacheHitRate).toBe(true);
  });

  it('sets wsEnabled based on connection mode', () => {
    const ws = loadConfig({ ...validEnv, FEISHU_CONNECTION_MODE: 'websocket' });
    expect(ws.feishu.wsEnabled).toBe(true);

    resetConfig();
    const webhook = loadConfig({ ...validEnv, FEISHU_CONNECTION_MODE: 'webhook' });
    expect(webhook.feishu.wsEnabled).toBe(false);
  });

  it('resolves MEMORY_OUTPUT_LANGUAGE Auto → language based on uiLanguage', () => {
    // Default uiLanguage is 'en', so Auto resolves to 'English'
    const config = loadConfig(validEnv);
    expect(config.memory.outputLanguage).toBe('English');
  });

  it('defaults persona distillation to batched catch-up settings', () => {
    const config = loadConfig(validEnv);
    expect(config.memory.persona?.distillThreshold).toBe(3);
    expect(config.memory.persona?.minDistillIntervalHours).toBe(0);
  });

  it('accepts zero minimum persona distillation interval', () => {
    const config = loadConfig({
      ...validEnv,
      PERSONA_MIN_DISTILL_INTERVAL_HOURS: '0',
    });
    expect(config.memory.persona?.minDistillIntervalHours).toBe(0);
  });

  it('rejects unsupported MEMORY_OUTPUT_LANGUAGE values', () => {
    expect(() => loadConfig({
      ...validEnv,
      MEMORY_OUTPUT_LANGUAGE: 'Klingon',
    })).toThrow('Invalid MEMORY_OUTPUT_LANGUAGE');
  });

  it('rejects unsupported SHELL_APPROVAL_MODE values', () => {
    expect(() => loadConfig({
      ...validEnv,
      SHELL_APPROVAL_MODE: 'unsafe',
    })).toThrow('Configuration validation failed');
  });
});

describe('startConfigWatcher', () => {
  beforeEach(() => {
    resetConfig();
    stopConfigWatcher();
  });

  afterEach(() => {
    stopConfigWatcher();
    resetConfig();
  });

  it('does not throw when config.yaml is absent', () => {
    const missingPath = join(tmpdir(), `ohmyagent-missing-${Date.now()}`, 'config.yaml');

    expect(() => startConfigWatcher(missingPath, vi.fn())).not.toThrow();
  });

  it('reloads from the watched config path', async () => {
    const dir = join(tmpdir(), `ohmyagent-config-${Date.now()}`);
    const configPath = join(dir, 'config.yaml');
    mkdirSync(dir, { recursive: true });

    const writeConfig = (model: string) => writeFileSync(configPath, `
logging:
  level: info
ui_language: en
provider:
  primary: deepseek/${model}
  reasoning: deepseek/deepseek-reasoner
  api_key: sk-test
channels:
  feishu:
    enabled: true
    app_id: app
    app_secret: secret
embedding:
  api_key: sk-embed
database:
  path: ':memory:'
`, 'utf-8');

    writeConfig('deepseek-chat');
    const onReload = vi.fn();
    startConfigWatcher(configPath, onReload);

    await new Promise(resolve => setTimeout(resolve, 20));
    writeConfig('deepseek-coder');

    await expect.poll(() => onReload.mock.calls.length, {
      timeout: 2000,
      interval: 50,
    }).toBeGreaterThan(0);
    expect(onReload.mock.calls.at(-1)?.[0].piAi.model).toBe('deepseek-coder');

    stopConfigWatcher();
    rmSync(dir, { recursive: true, force: true });
  });
});
