import { describe, it, expect } from 'vitest';
import { loadVisionBridgeConfig, resolveVisionModel } from '../../src/vision-bridge/vision-bridge-config.js';
import type { CustomProviderConfig } from '../../src/app/types.js';

describe('loadVisionBridgeConfig', () => {
  it('returns disabled by default', () => {
    const config = loadVisionBridgeConfig({});
    expect(config.enabled).toBe(false);
  });

  it('parses enabled flag', () => {
    const config = loadVisionBridgeConfig({ VISION_BRIDGE_ENABLED: 'true' });
    expect(config.enabled).toBe(true);
  });

  it('parses modelRef', () => {
    const config = loadVisionBridgeConfig({
      VISION_BRIDGE_ENABLED: 'true',
      VISION_BRIDGE_MODEL_REF: 'openai/gpt-4o-mini',
    });
    expect(config.modelRef).toBe('openai/gpt-4o-mini');
  });

  it('parses optional overrides', () => {
    const config = loadVisionBridgeConfig({
      VISION_BRIDGE_ENABLED: 'true',
      VISION_BRIDGE_MODEL_REF: 'nvidia/kimi-k2.6',
      VISION_BRIDGE_API_KEY: 'sk-override',
      VISION_BRIDGE_BASE_URL: 'https://proxy.example.com/v1',
      VISION_BRIDGE_TIMEOUT_MS: '60000',
      VISION_BRIDGE_MAX_NOTE_CHARS: '2000',
      VISION_BRIDGE_MAX_CACHE_ENTRIES: '128',
    });

    expect(config.apiKey).toBe('sk-override');
    expect(config.baseUrl).toBe('https://proxy.example.com/v1');
    expect(config.timeoutMs).toBe(60000);
    expect(config.maxNoteChars).toBe(2000);
    expect(config.maxCacheEntries).toBe(128);
  });

  it('uses defaults when optional values are missing', () => {
    const config = loadVisionBridgeConfig({ VISION_BRIDGE_ENABLED: 'true' });
    expect(config.timeoutMs).toBe(120_000);
    expect(config.maxNoteChars).toBe(3200);
    expect(config.maxCacheEntries).toBe(256);
    expect(config.apiKey).toBeUndefined();
    expect(config.baseUrl).toBeUndefined();
  });
});

describe('resolveVisionModel', () => {
  it('throws if modelRef is missing', () => {
    const config = loadVisionBridgeConfig({ VISION_BRIDGE_ENABLED: 'true' });
    expect(() => resolveVisionModel(config, [])).toThrow('VISION_BRIDGE_MODEL_REF');
  });

  it('throws for invalid modelRef format', () => {
    const config = loadVisionBridgeConfig({
      VISION_BRIDGE_ENABLED: 'true',
      VISION_BRIDGE_MODEL_REF: 'invalid-format',
    });
    expect(() => resolveVisionModel(config, [])).toThrow('Invalid VISION_BRIDGE_MODEL_REF');
  });

  it('throws if model is not found', () => {
    const config = loadVisionBridgeConfig({
      VISION_BRIDGE_ENABLED: 'true',
      VISION_BRIDGE_MODEL_REF: 'nonexistent/model-id',
    });
    expect(() => resolveVisionModel(config, [])).toThrow('Vision model not found');
  });

  it('resolves deepseek models (text-only) — validation catches lack of image support', () => {
    const config = loadVisionBridgeConfig({
      VISION_BRIDGE_ENABLED: 'true',
      VISION_BRIDGE_MODEL_REF: 'deepseek/deepseek-v4-flash',
    });
    // deepseek models are text-only — should throw about missing image support
    expect(() => resolveVisionModel(config, [])).toThrow('does not support image input');
  });
});
