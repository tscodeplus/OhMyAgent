// ---------------------------------------------------------------------------
// Tests for productivity tools (P3-T3)
// ask_user_question, brief, todo_write, sleep, config
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAskUserQuestionToolDefinition } from '../../../src/tools/builtins/session/ask-definition.js';
import { createBriefToolDefinition } from '../../../src/tools/builtins/session/brief-definition.js';
import { createTodoWriteToolDefinition } from '../../../src/tools/builtins/session/todo-definition.js';
import { createSleepToolDefinition } from '../../../src/tools/builtins/shell/sleep-definition.js';
import { createConfigToolDefinition } from '../../../src/tools/builtins/config/config-definition.js';
import type { ToolExecutionContext } from '../../../src/tools/platform/tool-context.js';
import type { AppConfig } from '../../../src/app/types.js';
import { extractToolText, expectToolResultContains } from '../../helpers/tool-result.js';

// ---------------------------------------------------------------------------
// Minimal context factory
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    cwd: '/tmp',
    policyScope: { agentId: 'test' } as any,
    services: {} as any,
    ...overrides,
  };
}

// ===========================================================================
// ask_user_question
// ===========================================================================

const askDef = createAskUserQuestionToolDefinition();

describe('ask_user_question', () => {
  it('returns question with [User interaction required] prefix', async () => {
    const result = await askDef.execute({ question: 'How are you?' }, makeCtx());
    expect(result.isError).toBeFalsy();
    expectToolResultContains(result, '[User interaction required]');
    expectToolResultContains(result, 'How are you?');
  });

  it('formats numbered options when provided', async () => {
    const result = await askDef.execute(
      { question: 'Which color?', options: ['Red', 'Blue', 'Green'] },
      makeCtx(),
    );
    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('1. Red');
    expect(text).toContain('2. Blue');
    expect(text).toContain('3. Green');
    expect(text).toContain('Options:');
  });

  it('works with 2 options (minimum)', async () => {
    const result = await askDef.execute(
      { question: 'Yes or no?', options: ['Yes', 'No'] },
      makeCtx(),
    );
    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('1. Yes');
    expect(text).toContain('2. No');
  });
});

// ===========================================================================
// brief
// ===========================================================================

const briefDef = createBriefToolDefinition();

describe('brief', () => {
  it('uses default instruction when none provided', async () => {
    const result = await briefDef.execute({}, makeCtx());
    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('[BRIEF REQUEST]');
    expect(text).toContain('Summarize the current session');
    expect(text).toContain('[The agent should now respond');
  });

  it('uses custom instruction when provided', async () => {
    const result = await briefDef.execute(
      { instruction: 'summarize what I have done today' },
      makeCtx(),
    );
    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('[BRIEF REQUEST]');
    expect(text).toContain('summarize what I have done today');
  });
});

// ===========================================================================
// todo_write
// ===========================================================================

describe('todo_write', () => {
  it('stores and formats todos, grouped by status', async () => {
    const def = createTodoWriteToolDefinition();
    const result = await def.execute(
      {
        todos: [
          { id: 'T-1', subject: 'Implement login', status: 'in_progress' },
          { id: 'T-2', subject: 'Add tests', status: 'pending' },
        ],
      },
      makeCtx({ sessionId: 'todo-test-1' }),
    );
    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('## Todo List');
    expect(text).toContain('### In Progress (1)');
    expect(text).toContain('[T-1] Implement login');
    expect(text).toContain('### Pending (1)');
    expect(text).toContain('[T-2] Add tests');
    expect(text).toContain('### Completed (0)');
  });

  it('merges new todos with existing when merge=true', async () => {
    const def = createTodoWriteToolDefinition();
    const sessionId = 'todo-test-merge';

    // First call: add two todos
    await def.execute(
      {
        todos: [
          { id: 'A', subject: 'Task A', status: 'pending' },
          { id: 'B', subject: 'Task B', status: 'in_progress' },
        ],
      },
      makeCtx({ sessionId }),
    );

    // Second call: merge one new + update existing
    const result = await def.execute(
      {
        todos: [
          { id: 'A', subject: 'Task A', status: 'completed' },
          { id: 'C', subject: 'Task C', status: 'pending' },
        ],
        merge: true,
      },
      makeCtx({ sessionId }),
    );

    const text = extractToolText(result);
    expect(text).toContain('### Completed (1)');
    expect(text).toContain('[A] Task A');
    expect(text).toContain('### In Progress (1)');
    expect(text).toContain('[B] Task B');
    expect(text).toContain('### Pending (1)');
    expect(text).toContain('[C] Task C');
  });

  it('replaces all todos when merge=false (default)', async () => {
    const def = createTodoWriteToolDefinition();
    const sessionId = 'todo-test-replace';

    // First call
    await def.execute(
      { todos: [{ id: 'X', subject: 'Old task', status: 'pending' }] },
      makeCtx({ sessionId }),
    );

    // Replace with new set
    const result = await def.execute(
      { todos: [{ id: 'Y', subject: 'New task', status: 'in_progress' }] },
      makeCtx({ sessionId }),
    );

    const text = extractToolText(result);
    expect(text).toContain('[Y] New task');
    expect(text).not.toContain('[X]');
  });
});

// ===========================================================================
// sleep
// ===========================================================================

const sleepDef = createSleepToolDefinition();

describe('sleep', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sleeps for the specified duration and returns confirmation', async () => {
    vi.useFakeTimers();
    const resultPromise = sleepDef.execute({ seconds: 5 }, makeCtx());
    vi.advanceTimersByTime(5000);
    const result = await resultPromise;
    expect(result.isError).toBeFalsy();
    expect(extractToolText(result)).toBe('Slept for 5s');
  });

  it('clamps seconds to max 300', async () => {
    vi.useFakeTimers();
    const resultPromise = sleepDef.execute({ seconds: 500 }, makeCtx());
    vi.advanceTimersByTime(300 * 1000);
    const result = await resultPromise;
    expect(result.isError).toBeFalsy();
    expect(extractToolText(result)).toBe('Slept for 300s');
  });
});

// ===========================================================================
// config
// ===========================================================================

describe('config', () => {
  const minimalConfig: AppConfig = {
    logging: { level: 'info' },
    uiLanguage: 'zh-CN',
    showToolCalls: true,
    feishu: {
      enabled: false,
      appId: 'test-app',
      appSecret: 'sensitive-secret',
      verificationToken: 'vtoken',
      encryptKey: 'ekey',
      wsEnabled: false,
    },
    piAi: {
      provider: 'openai',
      model: 'gpt-4',
      reasoningModel: 'gpt-4',
      apiKey: 'sk-secret',
    },
    fallbackModels: [],
    embedding: {
      baseUrl: 'http://localhost',
      apiKey: 'emb-key',
      model: 'text-embedding-3-small',
      dimension: 1536,
    },
    database: { path: '/tmp/test.db' },
    rateLimit: { webhookMaxRequests: 10, webhookWindowMs: 60000 },
    tools: {
      shellEnabled: true,
      defaultTimeoutMs: 30000,
      maxOutputLength: 10000,
      toolsProfile: 'standard',
      shellExecMode: 'balanced',
      shellAllowlist: [],
      shellApprovalMode: 'balanced',
      shellApprovalWhitelist: [],
      shellApprovalTimeoutSec: 120,
      shellApprovalTimeoutAction: 'deny',
      fileRead: { allowedRoots: [], deniedPatterns: [] },
    },
    memory: {
      autoRecall: true,
      autoCapture: false,
      recallTopK: 5,
      recallMinScore: 0.01,
      captureMaxChars: 2000,
      summarizeInterval: 10,
      outputLanguage: 'zh-CN',
      decayHalfLifeDays: 0,
      embeddingCacheMaxEntries: 1000,
      hygiene: { enabled: true, retentionDays: 30 },
      embeddingCircuitBreaker: { failureThreshold: 5, cooldownSec: 60 },
    },
    cron: {
      enabled: false,
      tickIntervalMs: 60000,
      dataDir: '/tmp/cron',
      executionTimeoutMs: 300000,
    },
    webSearch: {
      providerOrder: ['tavily'],
      searchTimeoutMs: 10000,
      maxResults: 5,
    },
    extensions: { directory: '/tmp/ext' },
    footer: { showAgentName: true, showModel: true, showCompleted: true, showElapsed: true },
  };

  const configCtx: ToolExecutionContext = {
    cwd: '/tmp',
    policyScope: { agentId: 'test' } as any,
    services: { config: minimalConfig } as any,
  };

  it('returns summary when no key is provided', async () => {
    const def = createConfigToolDefinition();
    const result = await def.execute({}, configCtx);
    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('Configuration Summary');
    expect(text).toContain('**logging**');
    expect(text).toContain('**feishu**');
    expect(text).toContain('**tools**');
    expect(text).toContain('**memory**');
  });

  it('resolves a nested config key', async () => {
    const def = createConfigToolDefinition();
    const result = await def.execute({ key: 'tools.toolsProfile' }, configCtx);
    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('standard');
  });

  it('returns [REDACTED] for sensitive field direct lookup', async () => {
    const def = createConfigToolDefinition();
    const result = await def.execute({ key: 'feishu.appSecret' }, configCtx);
    expect(result.isError).toBeFalsy();
    expect(extractToolText(result)).toBe('[REDACTED]');
  });

  it('returns [REDACTED] for apiKey field', async () => {
    const def = createConfigToolDefinition();
    const result = await def.execute({ key: 'piAi.apiKey' }, configCtx);
    expect(result.isError).toBeFalsy();
    expect(extractToolText(result)).toBe('[REDACTED]');
  });

  it('returns "not found" for nonexistent key', async () => {
    const def = createConfigToolDefinition();
    const result = await def.execute({ key: 'nonexistent.key' }, configCtx);
    expect(result.isError).toBeFalsy();
    expectToolResultContains(result, 'not found');
  });
});
