/**
 * Shared helpers for E2E integration tests.
 *
 * Provides mock factories, database setup, and common utilities
 * for wiring up real internal modules with mocked external dependencies.
 */

import { vi } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema.js';
import type { AppConfig, ReplyDispatcher } from '../../src/app/types.js';

// ─── Config ──────────────────────────────────────────────────────────────────

export function makeTestConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    feishu: {
      appId: 'test-app-id',
      appSecret: 'test-app-secret',
      verificationToken: '',
      encryptKey: '',
      wsEnabled: true,
    },
    piAi: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      reasoningModel: 'deepseek-reasoner',
      apiKey: 'test-api-key',
    },
    embedding: {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-emb-key',
      model: 'test-emb-model',
      dimension: 1024,
    },
    database: { path: ':memory:' },
    tools: {
      shellEnabled: true,
      defaultTimeoutMs: 60000,
      maxOutputLength: 12000,
      shellApprovalWhitelist: [],
      shellApprovalMode: 'balanced',
      fileRead: {
        allowedRoots: [],
        deniedPatterns: [],
        allowPathTraversal: false,
        allowHomeReference: false,
      },
    },
    memory: {
      autoRecall: false,
      autoRecallFrequency: 'first',
      autoCapture: false,
      recallTopK: 3,
      captureMaxChars: 500,
      summarizeInterval: 20,
      outputLanguage: 'Auto',
    },
    fallbackModels: [],
    rateLimit: {
      webhookMaxRequests: 100,
      webhookWindowMs: 60000,
    },
    ...overrides,
  };
}

// ─── Database ────────────────────────────────────────────────────────────────

export function createTestDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applySchema(db);
  return db;
}

// ─── Mock Embedding Client ───────────────────────────────────────────────────

export function createMockEmbeddingClient() {
  const stored = new Map<string, Float32Array>();

  function textToVector(text: string): Float32Array {
    const DIM = 8;
    const vec = new Float32Array(DIM);
    for (let d = 0; d < DIM; d++) {
      let h = (d + 1) * 0x9e3779b9;
      for (let i = 0; i < text.length; i++) {
        h = ((h << 5) - h + text.charCodeAt(i)) | 0;
      }
      vec[d] = (h & 0xffff) / 0x7fff - 1;
    }
    let norm = 0;
    for (let i = 0; i < DIM; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < DIM; i++) vec[i] /= norm;
    return vec;
  }

  return {
    isConfigured: vi.fn(() => true),
    model: 'default',
    embedOne: vi.fn(async (text: string) => {
      if (!stored.has(text)) {
        stored.set(text, textToVector(text));
      }
      return stored.get(text)!;
    }),
    stored,
  };
}

// ─── Mock Tool ───────────────────────────────────────────────────────────────

export function makeMockTool(name: string, output?: string) {
  return {
    name,
    label: name,
    description: `Tool: ${name}`,
    parameters: {},
    execute: vi.fn(async () => ({
      content: [{ type: 'text', text: output ?? `${name} executed` }],
      details: null,
    })),
  };
}

// ─── Mock Dispatcher ─────────────────────────────────────────────────────────

export function createMockDispatcher(): ReplyDispatcher & {
  calls: string[];
} {
  const calls: string[] = [];
  const dispatcher: ReplyDispatcher & { calls: string[] } = {
    calls,
    onStart: vi.fn(() => { calls.push('onStart'); }),
    onTextDelta: vi.fn((delta: string) => { calls.push(`onTextDelta:${delta}`); }),
    onReasoningDelta: vi.fn((delta: string) => { calls.push(`onReasoningDelta:${delta}`); }),
    onToolStart: vi.fn((name: string) => { calls.push(`onToolStart:${name}`); }),
    onToolEnd: vi.fn((name: string) => { calls.push(`onToolEnd:${name}`); }),
    setApprovalStatus: vi.fn((status: string | null) => { calls.push(`setApprovalStatus:${status ?? 'null'}`); }),
    setModel: vi.fn((_model: string) => {}),
    onComplete: vi.fn(() => { calls.push('onComplete'); }),
    onError: vi.fn((err: Error) => { calls.push(`onError:${err.message}`); }),
    onAborted: vi.fn(() => { calls.push('onAborted'); }),
  };
  return dispatcher;
}

// ─── Mock Feishu Client ──────────────────────────────────────────────────────

export function createMockFeishuClient() {
  return {
    sendApprovalCard: vi.fn(async () => 'approval-msg-1'),
    updateMessage: vi.fn(async () => {}),
  };
}

// ─── Mock pi-ai model ────────────────────────────────────────────────────────

export function makeMockModel() {
  return {
    id: 'test-model',
    name: 'Test Model',
    api: 'openai-completions',
    provider: 'test-provider',
    baseUrl: '',
    reasoning: false,
    input: [],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 2048,
  };
}

// ─── StreamFn helpers ────────────────────────────────────────────────────────

import { AssistantMessageEventStream } from '../../src/pi-mono/ai/utils/event-stream.js';
import type { AssistantMessage } from '../../src/pi-mono/ai/types.js';

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Create a mock streamFn that returns a simple text response.
 */
export function createTextStreamFn(responseText: string) {
  return (_model: any, _context: any, _options?: any): AssistantMessageEventStream => {
    const stream = new AssistantMessageEventStream();

    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: responseText }],
      api: 'openai-completions',
      provider: 'test-provider',
      model: 'test-model',
      usage: EMPTY_USAGE,
      stopReason: 'stop',
      timestamp: Date.now(),
    };

    stream.push({
      type: 'start',
      partial: { ...message },
    });
    stream.push({
      type: 'text_start',
      contentIndex: 0,
      partial: { ...message },
    });
    stream.push({
      type: 'text_delta',
      contentIndex: 0,
      delta: responseText,
      partial: { ...message },
    });
    stream.push({
      type: 'text_end',
      contentIndex: 0,
      content: responseText,
      partial: { ...message },
    });
    stream.push({
      type: 'done',
      reason: 'stop',
      message,
    });

    return stream;
  };
}

/**
 * Create a mock streamFn that makes a tool call, then returns text after tool result.
 *
 * The streamFn is called twice in the agent loop:
 * 1. First call: returns a tool call
 * 2. Second call (after tool result): returns text response
 */
export function createToolCallStreamFn(
  toolName: string,
  toolArgs: Record<string, any>,
  responseText: string,
) {
  let callCount = 0;

  return (_model: any, context: any, _options?: any): AssistantMessageEventStream => {
    callCount++;
    const stream = new AssistantMessageEventStream();

    if (callCount === 1) {
      // First call: return a tool call
      const message: AssistantMessage = {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'tc-1',
            name: toolName,
            arguments: toolArgs,
          },
        ],
        api: 'openai-completions',
        provider: 'test-provider',
        model: 'test-model',
        usage: EMPTY_USAGE,
        stopReason: 'toolUse',
        timestamp: Date.now(),
      };

      stream.push({ type: 'start', partial: { ...message } });
      stream.push({
        type: 'toolcall_start',
        contentIndex: 0,
        partial: { ...message },
      });
      stream.push({
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: JSON.stringify(toolArgs),
        partial: { ...message },
      });
      stream.push({
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: {
          type: 'toolCall',
          id: 'tc-1',
          name: toolName,
          arguments: toolArgs,
        },
        partial: { ...message },
      });
      stream.push({
        type: 'done',
        reason: 'toolUse',
        message,
      });
    } else {
      // Second call: return text response
      const message: AssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: responseText }],
        api: 'openai-completions',
        provider: 'test-provider',
        model: 'test-model',
        usage: EMPTY_USAGE,
        stopReason: 'stop',
        timestamp: Date.now(),
      };

      stream.push({ type: 'start', partial: { ...message } });
      stream.push({
        type: 'text_start',
        contentIndex: 0,
        partial: { ...message },
      });
      stream.push({
        type: 'text_delta',
        contentIndex: 0,
        delta: responseText,
        partial: { ...message },
      });
      stream.push({
        type: 'text_end',
        contentIndex: 0,
        content: responseText,
        partial: { ...message },
      });
      stream.push({
        type: 'done',
        reason: 'stop',
        message,
      });
    }

    return stream;
  };
}
