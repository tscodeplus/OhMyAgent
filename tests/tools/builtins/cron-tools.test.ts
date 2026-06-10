// ---------------------------------------------------------------------------
// Tests for v4 cron tools: create, list, delete, toggle
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { createCronCreateToolDefinition } from '../../../src/tools/builtins/cron/create-definition.js';
import { createCronListToolDefinition } from '../../../src/tools/builtins/cron/list-definition.js';
import { createCronDeleteToolDefinition } from '../../../src/tools/builtins/cron/delete-definition.js';
import { createCronToggleToolDefinition } from '../../../src/tools/builtins/cron/toggle-definition.js';
import type { ToolExecutionContext } from '../../../src/tools/platform/tool-context.js';
import type { CronJob } from '../../../src/cron/types.js';
import { extractToolText, expectToolResultContains } from '../../helpers/tool-result.js';

// ---------------------------------------------------------------------------
// Mock CronService
// ---------------------------------------------------------------------------

function createMockCronService(jobs: CronJob[] = []) {
  const store = [...jobs];
  return {
    add: (input: { name: string; schedule: string; prompt: string; channel: string; chatId: string }) => {
      const job: CronJob = {
        id: `job_${store.length + 1}`,
        name: input.name,
        schedule: { type: 'cron', expression: input.schedule },
        scheduleText: input.schedule,
        prompt: input.prompt,
        chatId: input.chatId,
        channel: input.channel,
        enabled: true,
        state: 'idle' as const,
        nextRunAt: Date.now() + 3600000,
        lastRunAt: null,
        lastStatus: null,
        retryCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      store.push(job);
      return job;
    },
    list: () => [...store],
    get: (id: string) => store.find(j => j.id === id),
    remove: (id: string) => {
      const idx = store.findIndex(j => j.id === id);
      if (idx === -1) return false;
      store.splice(idx, 1);
      return true;
    },
    listByChannel: (channel: string, chatId: string) =>
      store.filter(j => j.channel === channel && j.chatId === chatId),
    toggle: (id: string, enabled: boolean) => {
      const job = store.find(j => j.id === id);
      if (!job) return false;
      job.enabled = enabled;
      job.state = enabled ? 'idle' as const : 'paused' as const;
      return true;
    },
    pause: () => true,
    resume: () => true,
    runOnce: async () => ({ jobId: '', status: 'success' as const, output: '', durationMs: 0, deliveredToChat: true }),
  };
}

// ---------------------------------------------------------------------------
// Context factory
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<ToolExecutionContext>): ToolExecutionContext {
  return {
    cwd: '/tmp',
    sessionId: 'feishu:oc_test123',
    channel: 'feishu',
    policyScope: { agentId: 'test' } as any,
    services: {
      cronService: createMockCronService(),
    } as any,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// cron_create
// ---------------------------------------------------------------------------

const createDef = createCronCreateToolDefinition();

describe('cron_create', () => {
  it('creates a cron job with valid parameters', async () => {
    const ctx = makeCtx();
    const result = await createDef.execute(
      { name: 'Morning briefing', schedule: '0 8 * * *', prompt: 'Give me a summary of today\'s news' },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('Cron job created');
    expect(text).toContain('Morning briefing');
    expect(text).toContain('0 8 * * *');
  });

  it('returns error when sessionId cannot be derived', async () => {
    const ctx = makeCtx({ sessionId: undefined, channel: undefined });
    const result = await createDef.execute(
      { name: 'Test', schedule: '0 8 * * *', prompt: 'test' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'Cannot determine channel');
  });

  it('falls back to ctx.channel when sessionId has no colon separator', async () => {
    const mockService = createMockCronService();
    const ctx = makeCtx({
      sessionId: 'plain-session-id',
      channel: 'qq',
      services: { cronService: mockService } as any,
    });
    const result = await createDef.execute(
      { name: 'Test', schedule: '0 9 * * *', prompt: 'hello' },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expectToolResultContains(result, 'Cron job created');
  });
});

// ---------------------------------------------------------------------------
// cron_list
// ---------------------------------------------------------------------------

const listDef = createCronListToolDefinition();

describe('cron_list', () => {
  it('returns empty list when no jobs exist', async () => {
    const ctx = makeCtx();
    const result = await listDef.execute({}, ctx);
    expect(result.isError).toBeFalsy();
    expectToolResultContains(result, 'No cron jobs found');
  });

  it('lists jobs for the current channel', async () => {
    const mockService = createMockCronService([
      {
        id: 'job_a', name: 'Morning news', schedule: { type: 'cron', expression: '0 8 * * *' },
        scheduleText: '0 8 * * *', prompt: 'news summary', chatId: 'oc_test123', channel: 'feishu',
        enabled: true, state: 'idle', nextRunAt: Date.now() + 3600000,
        lastRunAt: null, lastStatus: null, retryCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
      },
    ]);
    const ctx = makeCtx({ services: { cronService: mockService } as any });
    const result = await listDef.execute({}, ctx);
    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('Morning news');
    expect(text).toContain('job_a');
  });

  it('filters out disabled jobs by default', async () => {
    const mockService = createMockCronService([
      {
        id: 'job_a', name: 'Enabled job', schedule: { type: 'cron', expression: '0 8 * * *' },
        scheduleText: '0 8 * * *', prompt: 'enabled', chatId: 'oc_test123', channel: 'feishu',
        enabled: true, state: 'idle', nextRunAt: Date.now() + 3600000,
        lastRunAt: null, lastStatus: null, retryCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
      },
      {
        id: 'job_b', name: 'Disabled job', schedule: { type: 'cron', expression: '0 9 * * *' },
        scheduleText: '0 9 * * *', prompt: 'disabled', chatId: 'oc_test123', channel: 'feishu',
        enabled: false, state: 'paused', nextRunAt: null,
        lastRunAt: null, lastStatus: null, retryCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
      },
    ]);
    const ctx = makeCtx({ services: { cronService: mockService } as any });
    const result = await listDef.execute({}, ctx);
    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('Enabled job');
    expect(text).not.toContain('Disabled job');
  });

  it('includes disabled jobs when includeDisabled is true', async () => {
    const mockService = createMockCronService([
      {
        id: 'job_a', name: 'Enabled job', schedule: { type: 'cron', expression: '0 8 * * *' },
        scheduleText: '0 8 * * *', prompt: 'enabled', chatId: 'oc_test123', channel: 'feishu',
        enabled: true, state: 'idle', nextRunAt: Date.now() + 3600000,
        lastRunAt: null, lastStatus: null, retryCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
      },
      {
        id: 'job_b', name: 'Disabled job', schedule: { type: 'cron', expression: '0 9 * * *' },
        scheduleText: '0 9 * * *', prompt: 'disabled', chatId: 'oc_test123', channel: 'feishu',
        enabled: false, state: 'paused', nextRunAt: null,
        lastRunAt: null, lastStatus: null, retryCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
      },
    ]);
    const ctx = makeCtx({ services: { cronService: mockService } as any });
    const result = await listDef.execute({ includeDisabled: true }, ctx);
    expect(result.isError).toBeFalsy();
    const text = extractToolText(result);
    expect(text).toContain('Enabled job');
    expect(text).toContain('Disabled job');
  });
});

// ---------------------------------------------------------------------------
// cron_delete
// ---------------------------------------------------------------------------

const deleteDef = createCronDeleteToolDefinition();

describe('cron_delete', () => {
  it('deletes a job that belongs to the same channel and chatId', async () => {
    const mockService = createMockCronService([
      {
        id: 'job_a', name: 'Test job', schedule: { type: 'cron', expression: '0 8 * * *' },
        scheduleText: '0 8 * * *', prompt: 'test', chatId: 'oc_test123', channel: 'feishu',
        enabled: true, state: 'idle', nextRunAt: Date.now() + 3600000,
        lastRunAt: null, lastStatus: null, retryCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
      },
    ]);
    const ctx = makeCtx({ services: { cronService: mockService } as any });
    const result = await deleteDef.execute({ jobId: 'job_a' }, ctx);
    expect(result.isError).toBeFalsy();
    expectToolResultContains(result, 'deleted successfully');
  });

  it('returns error for non-existent job', async () => {
    const ctx = makeCtx();
    const result = await deleteDef.execute({ jobId: 'nonexistent' }, ctx);
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'not found');
  });

  it('returns error when job belongs to a different channel', async () => {
    const mockService = createMockCronService([
      {
        id: 'job_a', name: 'Other channel job', schedule: { type: 'cron', expression: '0 8 * * *' },
        scheduleText: '0 8 * * *', prompt: 'test', chatId: 'other_chat', channel: 'telegram',
        enabled: true, state: 'idle', nextRunAt: Date.now() + 3600000,
        lastRunAt: null, lastStatus: null, retryCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
      },
    ]);
    const ctx = makeCtx({ services: { cronService: mockService } as any });
    const result = await deleteDef.execute({ jobId: 'job_a' }, ctx);
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'Deletion denied');
  });
});

// ---------------------------------------------------------------------------
// cron_toggle
// ---------------------------------------------------------------------------

const toggleDef = createCronToggleToolDefinition();

describe('cron_toggle', () => {
  it('enables a disabled job', async () => {
    const mockService = createMockCronService([
      {
        id: 'job_a', name: 'Test job', schedule: { type: 'cron', expression: '0 8 * * *' },
        scheduleText: '0 8 * * *', prompt: 'test', chatId: 'oc_test123', channel: 'feishu',
        enabled: false, state: 'paused', nextRunAt: null,
        lastRunAt: null, lastStatus: null, retryCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
      },
    ]);
    const ctx = makeCtx({ services: { cronService: mockService } as any });
    const result = await toggleDef.execute({ jobId: 'job_a', enabled: true }, ctx);
    expect(result.isError).toBeFalsy();
    expectToolResultContains(result, 'enabled');
  });

  it('disables an enabled job', async () => {
    const mockService = createMockCronService([
      {
        id: 'job_a', name: 'Test job', schedule: { type: 'cron', expression: '0 8 * * *' },
        scheduleText: '0 8 * * *', prompt: 'test', chatId: 'oc_test123', channel: 'feishu',
        enabled: true, state: 'idle', nextRunAt: Date.now() + 3600000,
        lastRunAt: null, lastStatus: null, retryCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
      },
    ]);
    const ctx = makeCtx({ services: { cronService: mockService } as any });
    const result = await toggleDef.execute({ jobId: 'job_a', enabled: false }, ctx);
    expect(result.isError).toBeFalsy();
    expectToolResultContains(result, 'disabled');
  });

  it('returns error when job belongs to a different channel', async () => {
    const mockService = createMockCronService([
      {
        id: 'job_a', name: 'Other channel job', schedule: { type: 'cron', expression: '0 8 * * *' },
        scheduleText: '0 8 * * *', prompt: 'test', chatId: 'other_chat', channel: 'telegram',
        enabled: true, state: 'idle', nextRunAt: Date.now() + 3600000,
        lastRunAt: null, lastStatus: null, retryCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
      },
    ]);
    const ctx = makeCtx({ services: { cronService: mockService } as any });
    const result = await toggleDef.execute({ jobId: 'job_a', enabled: true }, ctx);
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'Operation denied');
  });

  it('returns error for non-existent job', async () => {
    const ctx = makeCtx();
    const result = await toggleDef.execute({ jobId: 'nonexistent', enabled: true }, ctx);
    expect(result.isError).toBe(true);
    expectToolResultContains(result, 'not found');
  });
});
