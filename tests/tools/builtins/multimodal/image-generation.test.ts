// ---------------------------------------------------------------------------
// Tests for image_generation v4 ToolDefinition tool
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImageGenerationToolDefinition } from '../../../../src/tools/builtins/multimodal/image-generation-definition.js';
import type { ImageGenerationProvider, ImageGenerationInput, ImageGenerationOutput } from '../../../../src/tools/builtins/multimodal/image-generation-provider.js';
import type { ToolExecutionContext } from '../../../../src/tools/platform/tool-context.js';
import type { AppConfig } from '../../../../src/app/types.js';
import { extractToolText, expectToolResultContains } from '../../../helpers/tool-result.js';

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

class MockImageGenerationProvider implements ImageGenerationProvider {
  async generate(input: ImageGenerationInput): Promise<ImageGenerationOutput> {
    return { data: Buffer.from('fake-image-data'), mimeType: 'image/png' };
  }
}

class FailingImageGenerationProvider implements ImageGenerationProvider {
  async generate(): Promise<ImageGenerationOutput> {
    throw new Error('Provider failed');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      shellEnabled: false, defaultTimeoutMs: 30000, maxOutputLength: 5000,
      toolsProfile: 'standard', shellExecMode: 'safe', shellAllowlist: [],
      shellApprovalMode: 'balanced', shellApprovalWhitelist: [],
      shellApprovalTimeoutSec: 120, shellApprovalTimeoutAction: 'deny',
      fileRead: { allowedRoots: [], deniedPatterns: [] },
    },
    memory: {
      autoRecall: false, autoCapture: false, recallTopK: 3, recallMinScore: 0.01,
      captureMaxChars: 500, summarizeInterval: 20, outputLanguage: 'Auto',
      decayHalfLifeDays: 0, embeddingCacheMaxEntries: 100,
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
    services: { config } as any,
    policyScope: null as any,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('image_generation', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'img-gen-test-'));
  });

  afterAll(() => {
    try { rmdirSync(tmpDir); } catch {}
  });

  it('rejects when image generation is not enabled', async () => {
    const config = createMockConfig({
      multimodal: { imageGeneration: { enabled: false, modelRef: 'dall-e-3', outputDir: tmpDir, maxPromptChars: 4000 } },
    });
    const ctx = createMockCtx(config, tmpDir);
    const toolDef = createImageGenerationToolDefinition(new MockImageGenerationProvider());

    const result = await toolDef.execute({ prompt: 'a cat' }, ctx);
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'not enabled');
  });

  it('rejects when no model ref is configured', async () => {
    const config = createMockConfig({
      multimodal: { imageGeneration: { enabled: true, outputDir: tmpDir, maxPromptChars: 4000 } },
    });
    const ctx = createMockCtx(config, tmpDir);
    const toolDef = createImageGenerationToolDefinition(new MockImageGenerationProvider());

    const result = await toolDef.execute({ prompt: 'a cat' }, ctx);
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'No image generation model configured');
  });

  it('generates and saves an image file with custom output name', async () => {
    const config = createMockConfig({
      multimodal: { imageGeneration: { enabled: true, modelRef: 'openai/dall-e-3', outputDir: tmpDir, maxPromptChars: 4000 } },
    });
    const ctx = createMockCtx(config, tmpDir);
    const toolDef = createImageGenerationToolDefinition(new MockImageGenerationProvider());

    const result = await toolDef.execute({ prompt: 'a cat', outputFileName: 'my_cat_image' }, ctx);
    expect(result.isError).toBeFalsy();
    expectToolResultContains(result, 'my_cat_image.png');

    const outputPath = join(tmpDir, 'my_cat_image.png');
    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath).toString()).toBe('fake-image-data');

    try { unlinkSync(outputPath); } catch {}
  });

  it('rejects when PolicyCenter denies write access to the output file', async () => {
    const config = createMockConfig({
      multimodal: { imageGeneration: { enabled: true, modelRef: 'openai/dall-e-3', outputDir: tmpDir, maxPromptChars: 4000 } },
    });
    const policyCenter = {
      evaluatePathAccess: vi.fn(() => ({
        allowed: false,
        reason: 'output path denied by test policy',
      })),
    };
    const ctx = {
      ...createMockCtx(config, tmpDir),
      sessionId: 'session-1',
      agentId: 'agent-1',
      services: { config, policyCenter } as any,
      policyScope: {
        toolsProfile: 'advanced',
        readRoots: [],
        writeRoots: [],
        deniedPatterns: [],
        shellExecMode: 'balanced',
        sessionApprovals: [],
        appApprovals: [],
        readOnly: false,
        computerUseEnabled: false,
      },
    };
    const toolDef = createImageGenerationToolDefinition(new MockImageGenerationProvider());

    const result = await toolDef.execute({ prompt: 'a cat', outputFileName: 'blocked' }, ctx);

    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'output path denied by test policy');
    expect(policyCenter.evaluatePathAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'write',
        sessionId: 'session-1',
        agentId: 'agent-1',
        path: join(tmpDir, 'blocked.png'),
      }),
    );
  });

  it('sanitizes unsafe characters in output file name', async () => {
    const config = createMockConfig({
      multimodal: { imageGeneration: { enabled: true, modelRef: 'openai/dall-e-3', outputDir: tmpDir, maxPromptChars: 4000 } },
    });
    const ctx = createMockCtx(config, tmpDir);
    const toolDef = createImageGenerationToolDefinition(new MockImageGenerationProvider());

    const result = await toolDef.execute({ prompt: 'a cat', outputFileName: '../../evil/name<script>' }, ctx);
    expect(result.isError).toBeFalsy();

    // The basename is 'name<script>' which after sanitization becomes 'name_script_'
    expectToolResultContains(result, 'name_script_');

    // Verify the actual file exists with sanitized name
    const outputPath = join(tmpDir, 'name_script_.png');
    expect(existsSync(outputPath)).toBe(true);

    try { unlinkSync(outputPath); } catch {}
  });

  it('generates auto-named file when no outputFileName is given', async () => {
    const config = createMockConfig({
      multimodal: { imageGeneration: { enabled: true, modelRef: 'openai/dall-e-3', outputDir: tmpDir, maxPromptChars: 4000 } },
    });
    const ctx = createMockCtx(config, tmpDir);
    const toolDef = createImageGenerationToolDefinition(new MockImageGenerationProvider());

    const result = await toolDef.execute({ prompt: 'a cat' }, ctx);
    expect(result.isError).toBeFalsy();
    expectToolResultContains(result, 'generated_');

    // Should have written a file
    const files = await (await import('node:fs/promises')).readdir(tmpDir);
    const genFiles = files.filter(f => f.startsWith('generated_'));
    expect(genFiles.length).toBe(1);

    try { unlinkSync(join(tmpDir, genFiles[0])); } catch {}
  });

  it('propagates provider failures as error results', async () => {
    const config = createMockConfig({
      multimodal: { imageGeneration: { enabled: true, modelRef: 'openai/dall-e-3', outputDir: tmpDir, maxPromptChars: 4000 } },
    });
    const ctx = createMockCtx(config, tmpDir);
    const toolDef = createImageGenerationToolDefinition(new FailingImageGenerationProvider());

    const result = await toolDef.execute({ prompt: 'a cat' }, ctx);
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'Provider failed');
  });

  it('rejects prompt exceeding maxPromptChars', async () => {
    const config = createMockConfig({
      multimodal: { imageGeneration: { enabled: true, modelRef: 'openai/dall-e-3', outputDir: tmpDir, maxPromptChars: 10 } },
    });
    const ctx = createMockCtx(config, tmpDir);
    const toolDef = createImageGenerationToolDefinition(new MockImageGenerationProvider());

    const result = await toolDef.execute({ prompt: 'a very long prompt that exceeds limit' }, ctx);
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'exceeds maximum length');
  });
});
