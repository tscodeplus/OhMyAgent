// ---------------------------------------------------------------------------
// Tests for image_to_text v4 ToolDefinition tool
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImageToTextToolDefinition } from '../../../../src/tools/builtins/multimodal/image-to-text-definition.js';
import type { ToolExecutionContext } from '../../../../src/tools/platform/tool-context.js';
import type { AppConfig } from '../../../../src/app/types.js';
import { extractToolText, expectToolResultContains } from '../../../helpers/tool-result.js';

// ---------------------------------------------------------------------------
// Setup: minimal mocks
// ---------------------------------------------------------------------------

const toolDef = createImageToTextToolDefinition();

/** Minimal valid AppConfig with vision bridge enabled. */
function createMockConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    logging: { level: 'info' },
    uiLanguage: 'en',
    showToolCalls: true,
    feishu: { enabled: false, appId: '', appSecret: '', verificationToken: '', encryptKey: '', wsEnabled: false },
    piAi: { provider: 'openai', model: 'gpt-4o', reasoningModel: 'o3-mini', apiKey: 'sk-test' },
    embedding: { baseUrl: 'https://test.com', apiKey: 'sk-test', model: 'text-embedding-ada-002', dimension: 1536 },
    database: { path: ':memory:' },
    rateLimit: { webhookMaxRequests: 100, webhookWindowMs: 60000 },
    tools: {
      shellEnabled: false,
      defaultTimeoutMs: 30000,
      maxOutputLength: 5000,
      toolsProfile: 'standard',
      shellExecMode: 'safe',
      shellAllowlist: [],
      shellApprovalMode: 'balanced',
      shellApprovalWhitelist: [],
      shellApprovalTimeoutSec: 120,
      shellApprovalTimeoutAction: 'deny',
      fileRead: { allowedRoots: [], deniedPatterns: [] },
    },
    memory: {
      autoRecall: false,
      autoCapture: false,
      recallTopK: 3,
      recallMinScore: 0.01,
      captureMaxChars: 500,
      summarizeInterval: 20,
      outputLanguage: 'Auto',
      decayHalfLifeDays: 0,
      embeddingCacheMaxEntries: 100,
      hygiene: { enabled: false, retentionDays: 90 },
      embeddingCircuitBreaker: { failureThreshold: 5, cooldownSec: 30 },
    },
    cron: { enabled: false, tickIntervalMs: 30000, dataDir: './cron', executionTimeoutMs: 600000 },
    webSearch: { providerOrder: ['tavily'], searchTimeoutMs: 10000, maxResults: 3 },
    extensions: { directory: 'extensions' },
    fallbackModels: [],
    footer: { showAgentName: true, showModel: true, showCompleted: true, showElapsed: true },
    ...overrides,
  };
}

function createMockCtx(config: AppConfig, cwd?: string): ToolExecutionContext {
  return {
    cwd: cwd ?? process.cwd(),
    services: {
      config,
    } as any,
    policyScope: null as any,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('image_to_text', () => {
  let tmpDir: string;
  let testImagePath: string;

  beforeAll(() => {
    // Create a minimal valid PNG (1x1 pixel) for testing
    tmpDir = mkdtempSync(join(tmpdir(), 'img-test-'));
    // Minimal valid PNG: 1x1 white pixel (IHDR + IDAT + IEND)
    const minimalPng = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk header
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 pixel
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // grayscale
      0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, // IDAT chunk header
      0x54, 0x08, 0xD7, 0x63, 0x60, 0x60, 0x00, 0x00, // compressed data
      0x00, 0x02, 0x00, 0x01, 0xE5, 0x27, 0xD2, 0x4D, // (continued)
      0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, // IEND chunk
      0xAE, 0x42, 0x60, 0x82,
    ]);
    testImagePath = join(tmpDir, 'test.png');
    writeFileSync(testImagePath, minimalPng);
  });

  afterAll(() => {
    try { unlinkSync(testImagePath); } catch {}
    try { rmdirSync(tmpDir); } catch {}
  });

  it('rejects a non-existent image file', async () => {
    const config = createMockConfig({
      visionBridge: { enabled: true, modelRef: 'openai/gpt-4o', timeoutMs: 30000, maxNoteChars: 3200, maxCacheEntries: 256 },
    });
    const ctx = createMockCtx(config, tmpDir);
    const result = await toolDef.execute({ imagePath: 'does-not-exist.png' }, ctx);
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'Cannot read image file');
  });

  it('rejects unsupported file format', async () => {
    const config = createMockConfig();
    const ctx = createMockCtx(config, tmpDir);
    const result = await toolDef.execute({ imagePath: testImagePath.replace('.png', '.xyz') }, ctx);
    // Since the image doesn't exist, it will first fail on file read
    // Create a file with unsupported extension
    const badPath = join(tmpDir, 'test.tiff');
    writeFileSync(badPath, Buffer.from([0x00]));
    try {
      const result2 = await toolDef.execute({ imagePath: 'test.tiff' }, ctx);
      expect(result2.isError).toBe(true);
      expectToolResultContains(result2, 'Unsupported image format');
    } finally {
      try { unlinkSync(badPath); } catch {}
    }
  });

  it('rejects when vision bridge is not enabled', async () => {
    const config = createMockConfig(); // visionBridge not set -> undefined
    const ctx = createMockCtx(config, tmpDir);
    const result = await toolDef.execute({ imagePath: testImagePath }, ctx);
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'Vision Bridge is not enabled');
  });

  it('rejects when no vision bridge model is configured', async () => {
    const config = createMockConfig({
      visionBridge: { enabled: true, modelRef: undefined, timeoutMs: 30000, maxNoteChars: 3200, maxCacheEntries: 256 },
    });
    const ctx = createMockCtx(config, tmpDir);
    const result = await toolDef.execute({ imagePath: testImagePath }, ctx);
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'No vision bridge model configured');
  });

  it('rejects an invalid model reference format', async () => {
    const config = createMockConfig({
      visionBridge: { enabled: true, modelRef: 'invalid-ref-no-slash', timeoutMs: 30000, maxNoteChars: 3200, maxCacheEntries: 256 },
    });
    const ctx = createMockCtx(config, tmpDir);
    const result = await toolDef.execute({ imagePath: testImagePath }, ctx);
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'Invalid model reference format');
  });

  it('rejects a model that is not registered in pi-mono', async () => {
    const config = createMockConfig({
      visionBridge: { enabled: true, modelRef: 'nonexistent/fake-model', timeoutMs: 30000, maxNoteChars: 3200, maxCacheEntries: 256 },
    });
    const ctx = createMockCtx(config, tmpDir);
    const result = await toolDef.execute({ imagePath: testImagePath }, ctx);
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'Vision model not found');
  });
});
