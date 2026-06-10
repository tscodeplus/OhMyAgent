// ---------------------------------------------------------------------------
// Tests for speech_to_text v4 ToolDefinition
// ---------------------------------------------------------------------------

import { describe, it, expect, afterAll, vi } from 'vitest';
import { writeFileSync, unlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSpeechToTextToolDefinition } from '../../../../src/tools/builtins/multimodal/speech-to-text-definition.js';
import type { ToolExecutionContext } from '../../../../src/tools/platform/tool-context.js';
import type { AppConfig } from '../../../../src/app/types.js';
import { extractToolText, expectToolResultContains } from '../../../helpers/tool-result.js';

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

describe('speech_to_text', () => {
  let tmpAudioPath: string;

  afterAll(() => {
    try { unlinkSync(tmpAudioPath); } catch {}
  });

  it('rejects when STT is not enabled', async () => {
    const config = createMockConfig({
      multimodal: {
        stt: { enabled: false, providers: [{ id: 'openai-whisper', apiKey: 'sk-test' }] },
      },
    });
    const ctx = createMockCtx(config);
    const toolDef = createSpeechToTextToolDefinition();

    const result = await toolDef.execute({ audioPath: '/nonexistent/audio.ogg' }, ctx);
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'not enabled');
  });

  it('rejects when no providers are configured', async () => {
    const config = createMockConfig({
      multimodal: {
        stt: { enabled: true, providers: [] },
      },
    });
    const ctx = createMockCtx(config);
    const toolDef = createSpeechToTextToolDefinition();

    // providers check happens before file check, so file path doesn't matter
    const result = await toolDef.execute({ audioPath: './nonexistent.ogg' }, ctx);
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'No STT provider configured');
  });

  it('rejects when audio file does not exist', async () => {
    const config = createMockConfig({
      multimodal: {
        stt: { enabled: true, providers: [{ id: 'openai-whisper', apiKey: 'sk-test' }] },
      },
    });
    const ctx = createMockCtx(config);
    const toolDef = createSpeechToTextToolDefinition();

    const result = await toolDef.execute({ audioPath: '/nonexistent/audio.ogg' }, ctx);
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'Cannot read audio file');
  });

  it('rejects when audio file is too large', async () => {
    tmpAudioPath = join(tmpdir(), `stt-test-large-${Date.now()}.opus`);
    const bigBuffer = Buffer.alloc(26 * 1024 * 1024); // 26MB
    writeFileSync(tmpAudioPath, bigBuffer);
    const realSize = statSync(tmpAudioPath).size;

    const config = createMockConfig({
      multimodal: {
        stt: {
          enabled: true,
          maxFileSizeMb: 25,
          providers: [{ id: 'openai-whisper', apiKey: 'sk-test' }],
        },
      },
    });
    const ctx = createMockCtx(config);
    const toolDef = createSpeechToTextToolDefinition();

    const result = await toolDef.execute({ audioPath: tmpAudioPath }, ctx);
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'too large');
  });
});
