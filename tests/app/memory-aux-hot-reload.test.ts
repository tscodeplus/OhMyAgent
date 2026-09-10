import { describe, expect, it } from 'vitest';
import { createMemoryServices } from '../../src/app/composers/memory-services.js';
import { configEventBus } from '../../src/app/config-event-bus.js';
import { openDatabase } from '../../src/memory/db.js';
import { loadConfig, resetConfig, stopConfigWatcher } from '../../src/app/config.js';
import type { AppConfig } from '../../src/app/types.js';

const baseEnv = {
  PI_AI_API_KEY: 'sk-main-key',
  PI_AI_PROVIDER: 'agnes',
  PI_AI_MODEL: 'agnes-2.5-flash',
  EMBEDDING_API_KEY: 'sk-embed',
  EMBEDDING_MODEL: 'text-embedding-3-small',
  EMBEDDING_DIMENSION: '1024',
  DATABASE_PATH: ':memory:',
  CONFIG_FILE: '', // skip config.yaml — env-only path
};

function baseConfig(): AppConfig {
  return loadConfig(baseEnv) as AppConfig;
}

describe('memory aux model config hot reload', () => {
  it('mutates the shared auxModelConfig in place on configEventBus reload', async () => {
    const logger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => logger,
    } as never;

    const db = openDatabase(':memory:');
    const memory = await createMemoryServices(baseConfig(), logger, db);

    // Initial: memory_aux_models unset → primary falls back to the main model
    const aux = memory.auxModelConfig;
    expect(aux.modelRef).toBe('agnes/agnes-2.5-flash');

    // Reload with an explicit memory_aux_models primary → same object, new chain
    const reloaded = baseConfig();
    (reloaded as Record<string, unknown>).memoryAuxModels = {
      primary: 'deepseek/deepseek-chat',
      fallback_models: ['opencode/nemotron-3.5-lightning-free'],
    };
    (reloaded as Record<string, unknown>).providerKeys = {
      deepseek: { apiKey: 'sk-deepseek', baseUrl: 'https://api.deepseek.com' },
      opencode: { apiKey: 'sk-opencode', baseUrl: 'https://opencode.ai/zen' },
    };

    await configEventBus.emit(reloaded);

    // Same identity — consumers holding references (MemoryWriter mergeConfig,
    // query expansion, entity extraction, DreamCycle) see the update
    expect(memory.auxModelConfig).toBe(aux);
    expect(aux.modelRef).toBe('deepseek/deepseek-chat');
    expect(aux.fallbackRefs).toEqual(['opencode/nemotron-3.5-lightning-free']);
    // provider_keys participate in key/baseUrl resolution
    expect(aux.apiKeys?.['deepseek']).toBe('sk-deepseek');
    expect(aux.baseUrls?.['deepseek']).toBe('https://api.deepseek.com');
    expect(aux.apiKeys?.['opencode']).toBe('sk-opencode');
  });
});

afterEach(() => {
  resetConfig();
  stopConfigWatcher();
});
