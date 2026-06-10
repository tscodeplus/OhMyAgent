import { describe, it, expect, beforeEach, vi } from 'vitest';
import { parseSchedule, recomputeNextRun, CronService } from '../../src/cron/service.js';
import { CronStore } from '../../src/cron/store.js';
import type { CronJob, CronSchedule } from '../../src/cron/types.js';
import { CronScheduler } from '../../src/cron/scheduler.js';
import type { JobRunner, JobRunnerOptions } from '../../src/cron/job-runner.js';
import { CollectingReplyDispatcher } from '../../src/cron/collecting-dispatcher.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ── parseSchedule ──

describe('parseSchedule', () => {
  it('parses "every 30m" as interval', () => {
    const result = parseSchedule('every 30m');
    expect(result.schedule).toEqual({ type: 'interval', intervalMs: 1_800_000 });
    expect(result.nextRunAt).toBeGreaterThan(Date.now());
  });

  it('parses "every 2h" as interval', () => {
    const result = parseSchedule('every 2h');
    expect(result.schedule).toEqual({ type: 'interval', intervalMs: 7_200_000 });
  });

  it('parses "every 1d" as interval', () => {
    const result = parseSchedule('every 1d');
    expect(result.schedule).toEqual({ type: 'interval', intervalMs: 86_400_000 });
  });

  it('parses "30m" as oneshot', () => {
    const now = Date.now();
    const result = parseSchedule('30m');
    expect(result.schedule.type).toBe('oneshot');
    expect((result.schedule as { type: 'oneshot'; timestampMs: number }).timestampMs)
      .toBeGreaterThanOrEqual(now + 1_800_000 - 1000);
  });

  it('parses "2h" as oneshot', () => {
    const result = parseSchedule('2h');
    expect(result.schedule.type).toBe('oneshot');
  });

  it('parses "0 8 * * *" as cron expression', () => {
    const result = parseSchedule('0 8 * * *');
    expect(result.schedule.type).toBe('cron');
    expect((result.schedule as { type: 'cron'; expression: string }).expression).toBe('0 8 * * *');
    expect(result.nextRunAt).toBeGreaterThan(Date.now());
  });

  it('parses "0 8,15 * * *" (multi-hour) as cron', () => {
    const result = parseSchedule('0 8,15 * * *');
    expect(result.schedule.type).toBe('cron');
  });

  it('rejects empty input', () => {
    expect(() => parseSchedule('')).toThrow('empty');
  });

  it('rejects interval shorter than minimum', () => {
    expect(() => parseSchedule('every 30s')).toThrow();
  });

  it('rejects malformed schedule', () => {
    expect(() => parseSchedule('not a schedule')).toThrow('Cannot parse schedule');
  });

  it('parses "at 15:00" as oneshot today', () => {
    // Can only test this reliably if the time is in the future
    const now = new Date();
    const targetHour = 23;
    const targetMin = 59;
    const result = parseSchedule(`at ${targetHour}:${targetMin}`);
    expect(result.schedule.type).toBe('oneshot');
    const sched = result.schedule as { type: 'oneshot'; timestampMs: number };
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), targetHour, targetMin);
    expect(sched.timestampMs).toBe(target.getTime());
  });

  it('rejects "at HH:MM" that is in the past', () => {
    expect(() => parseSchedule('at 00:01')).toThrow('past');
  });

  it('parses ISO timestamp oneshot', () => {
    const future = new Date(Date.now() + 86_400_000);
    const iso = future.toISOString().slice(0, 16).replace('T', ' ');
    const result = parseSchedule(`at ${iso}`);
    expect(result.schedule.type).toBe('oneshot');
  });
});

// ── recomputeNextRun ──

describe('recomputeNextRun', () => {
  it('keeps existing nextRunAt for oneshot', () => {
    const job: CronJob = {
      id: 'test', name: 'test', schedule: { type: 'oneshot', timestampMs: 999 },
      scheduleText: '30m', prompt: 'test', chatId: '', enabled: true, state: 'idle',
      nextRunAt: 123_456, retryCount: 0, lastRunAt: null, lastStatus: null,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    expect(recomputeNextRun(job)).toBe(123_456);
  });

  it('computes future timestamp for interval', () => {
    const job: CronJob = {
      id: 'test', name: 'test', schedule: { type: 'interval', intervalMs: 60_000 },
      scheduleText: 'every 1m', prompt: 'test', chatId: '', enabled: true, state: 'idle',
      nextRunAt: null, retryCount: 0, lastRunAt: null, lastStatus: null,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    const next = recomputeNextRun(job);
    expect(next).toBeGreaterThan(Date.now());
    expect(next).toBeLessThanOrEqual(Date.now() + 120_000);
  });

  it('computes next cron fire for cron type', () => {
    const job: CronJob = {
      id: 'test', name: 'test', schedule: { type: 'cron', expression: '0 8 * * *' },
      scheduleText: '0 8 * * *', prompt: 'test', chatId: '', enabled: true, state: 'idle',
      nextRunAt: null, retryCount: 0, lastRunAt: null, lastStatus: null,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    const next = recomputeNextRun(job);
    expect(next).toBeGreaterThan(Date.now());
  });
});

// ── CollectingReplyDispatcher ──

describe('CollectingReplyDispatcher', () => {
  it('collects text deltas', () => {
    const d = new CollectingReplyDispatcher();
    d.onStart();
    d.onTextDelta('Hello');
    d.onTextDelta(' World');
    d.onComplete();
    expect(d.getOutput()).toBe('Hello World');
    expect(d.getError()).toBeNull();
  });

  it('ignores reasoning deltas', () => {
    const d = new CollectingReplyDispatcher();
    d.onReasoningDelta('thinking...');
    d.onTextDelta('answer');
    d.onComplete();
    expect(d.getOutput()).toBe('answer');
  });

  it('captures error from onError', () => {
    const d = new CollectingReplyDispatcher();
    d.onError(new Error('fail'));
    expect(d.getError()?.message).toBe('fail');
  });

  it('captures error from onAborted', () => {
    const d = new CollectingReplyDispatcher();
    d.onAborted();
    expect(d.getError()?.message).toBe('aborted');
  });

  it('returns empty string when no text', () => {
    const d = new CollectingReplyDispatcher();
    d.onStart();
    d.onComplete();
    expect(d.getOutput()).toBe('');
  });

  it('tracks approval records', () => {
    const d = new CollectingReplyDispatcher();
    d.setApprovalRecords([{
      requestId: 'r1', command: 'rm -rf /', risk: 'high', status: 'pending',
      updatedAt: Date.now(),
    }], true);
    expect(d.hasApprovals()).toBe(true);
  });
});

// ── CronStore ──

describe('CronStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'cron-test-'));
  });

  afterAll(() => {
    // cleanup handled by OS tmpdir
  });

  it('creates empty store', () => {
    const store = new CronStore(tmpDir);
    expect(store.list()).toEqual([]);
  });

  it('adds and retrieves jobs', () => {
    const store = new CronStore(tmpDir);
    const job: CronJob = {
      id: 'abcd1234', name: 'test', schedule: { type: 'oneshot', timestampMs: Date.now() + 60000 },
      scheduleText: '1m', prompt: 'hello', chatId: 'chat1', enabled: true, state: 'idle',
      nextRunAt: Date.now() + 60000, retryCount: 0, lastRunAt: null, lastStatus: null,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    store.add(job);
    expect(store.list()).toHaveLength(1);
    expect(store.get('abcd1234')).toMatchObject({ id: 'abcd1234', prompt: 'hello' });
  });

  it('lists due jobs', () => {
    const store = new CronStore(tmpDir);
    const pastJob: CronJob = {
      id: 'due1', name: 'past', schedule: { type: 'oneshot', timestampMs: Date.now() - 1000 },
      scheduleText: 'past', prompt: '', chatId: '', enabled: true, state: 'idle',
      nextRunAt: Date.now() - 1000, retryCount: 0, lastRunAt: null, lastStatus: null,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    const futureJob: CronJob = {
      id: 'future1', name: 'future', schedule: { type: 'oneshot', timestampMs: Date.now() + 3600000 },
      scheduleText: 'future', prompt: '', chatId: '', enabled: true, state: 'idle',
      nextRunAt: Date.now() + 3600000, retryCount: 0, lastRunAt: null, lastStatus: null,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    const disabledJob: CronJob = {
      id: 'disabled1', name: 'disabled', schedule: { type: 'oneshot', timestampMs: Date.now() - 1000 },
      scheduleText: 'past', prompt: '', chatId: '', enabled: false, state: 'idle',
      nextRunAt: Date.now() - 1000, retryCount: 0, lastRunAt: null, lastStatus: null,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    store.add(pastJob);
    store.add(futureJob);
    store.add(disabledJob);

    const due = store.getDueJobs(Date.now());
    expect(due).toHaveLength(1);
    expect(due[0]!.id).toBe('due1');
  });

  it('updates a job', () => {
    const store = new CronStore(tmpDir);
    const job: CronJob = {
      id: 'test', name: 'test', schedule: { type: 'oneshot', timestampMs: 0 },
      scheduleText: '', prompt: '', chatId: '', enabled: true, state: 'idle',
      nextRunAt: 0, retryCount: 0, lastRunAt: null, lastStatus: null,
      createdAt: 0, updatedAt: 0,
    };
    store.add(job);
    expect(store.update('test', { name: 'renamed', retryCount: 3 })).toBe(true);
    expect(store.get('test')).toMatchObject({ name: 'renamed', retryCount: 3 });
  });

  it('removes a job', () => {
    const store = new CronStore(tmpDir);
    const job: CronJob = {
      id: 'test', name: 'test', schedule: { type: 'oneshot', timestampMs: 0 },
      scheduleText: '', prompt: '', chatId: '', enabled: true, state: 'idle',
      nextRunAt: 0, retryCount: 0, lastRunAt: null, lastStatus: null,
      createdAt: 0, updatedAt: 0,
    };
    store.add(job);
    expect(store.remove('test')).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it('returns false for non-existent update/remove', () => {
    const store = new CronStore(tmpDir);
    expect(store.update('nope', { name: 'x' })).toBe(false);
    expect(store.remove('nope')).toBe(false);
  });

  it('persists and reloads from disk', async () => {
    const store1 = new CronStore(tmpDir);
    store1.add({
      id: 'persist', name: 'persist', schedule: { type: 'oneshot', timestampMs: 0 },
      scheduleText: '', prompt: '', chatId: '', enabled: true, state: 'idle',
      nextRunAt: 0, retryCount: 0, lastRunAt: null, lastStatus: null,
      createdAt: 0, updatedAt: 0,
    });
    await store1.flush();

    const store2 = new CronStore(tmpDir);
    expect(store2.list()).toHaveLength(1);
    expect(store2.get('persist')?.id).toBe('persist');
  });
});

describe('CronScheduler', () => {
  it('does not create duplicate timers when started twice', () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const scheduler = new CronScheduler(
      {
        getDueJobs: () => [],
        list: () => [],
        update: vi.fn(),
      } as any,
      {} as any,
      {
        tickIntervalMs: 60_000,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      },
    );

    scheduler.start();
    scheduler.start();
    scheduler.stop();

    expect(setIntervalSpy).toHaveBeenCalledOnce();
    setIntervalSpy.mockRestore();
  });
});

// ── CronService (with mock store/scheduler/runner) ──

function createMockRunner(): JobRunner {
  return {
    run: async (job: CronJob) => ({
      jobId: job.id, status: 'success' as const, output: 'done',
      durationMs: 100, deliveredToChat: true,
    }),
    applyBackoff: () => null,
  } as unknown as JobRunner;
}

function createMockScheduler() {
  return {
    start: () => {},
    stop: () => {},
    trigger: async () => {},
  } as unknown as CronScheduler;
}

describe('CronService', () => {
  let store: CronStore;
  let service: CronService;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'cron-service-test-'));
    store = new CronStore(tmpDir);
    service = new CronService(store, createMockScheduler(), createMockRunner());
  });

  it('adds a job with schedule parsing', () => {
    const job = service.add({
      name: 'News briefing',
      schedule: '0 8 * * *',
      prompt: 'Send morning news',
      chatId: 'chat123',
    });
    expect(job.id).toHaveLength(8);
    expect(job.schedule.type).toBe('cron');
    expect(job.prompt).toBe('Send morning news');
    expect(job.chatId).toBe('chat123');
    expect(job.state).toBe('idle');
  });

  it('lists and gets jobs', () => {
    service.add({
      name: 'J1', schedule: '30m', prompt: 'p1', chatId: 'c1',
    });
    service.add({
      name: 'J2', schedule: '1h', prompt: 'p2', chatId: 'c2',
    });
    expect(service.list()).toHaveLength(2);
    expect(service.get(service.list()[0]!.id)?.name).toBe('J1');
  });

  it('pauses and resumes a job', () => {
    const job = service.add({
      name: 'J', schedule: '1h', prompt: 'p', chatId: 'c',
    });
    expect(service.pause(job.id)).toBe(true);
    expect(service.get(job.id)?.enabled).toBe(false);
    expect(service.get(job.id)?.state).toBe('paused');

    expect(service.resume(job.id)).toBe(true);
    expect(service.get(job.id)?.enabled).toBe(true);
    expect(service.get(job.id)?.state).toBe('idle');
  });

  it('removes a job', () => {
    const job = service.add({
      name: 'J', schedule: '1h', prompt: 'p', chatId: 'c',
    });
    expect(service.remove(job.id)).toBe(true);
    expect(service.list()).toHaveLength(0);
  });

  it('runs a job once immediately', async () => {
    const job = service.add({
      name: 'J', schedule: '1h', prompt: 'hello', chatId: 'c',
    });
    const result = await service.runOnce(job.id);
    expect(result.status).toBe('success');
    expect(result.output).toBe('done');
  });

  it('throws on runOnce for non-existent job', async () => {
    await expect(service.runOnce('nope')).rejects.toThrow('Job not found');
  });
});
