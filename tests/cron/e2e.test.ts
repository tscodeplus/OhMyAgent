/**
 * E2E tests: full cron lifecycle.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { CronStore } from '../../src/cron/store.js';
import { CronService, parseSchedule } from '../../src/cron/service.js';
import { CronScheduler } from '../../src/cron/scheduler.js';
import { JobRunner } from '../../src/cron/job-runner.js';
import { CollectingReplyDispatcher } from '../../src/cron/collecting-dispatcher.js';
import type { CronJob } from '../../src/cron/types.js';
import type { AgentRunner, AgentRunResult } from '../../src/cron/job-runner.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => logger } as any;

const stubFeishuClient = {
  sendMessage: async () => ({ code: 0, data: { message_id: 'msg_test' } }),
};

const stubAgentRunner: AgentRunner = {
  async run(_prompt: string, _sessionId: string, _chatId: string, _agentId?: string): Promise<AgentRunResult> {
    return { text: 'Test cron response', modelLabel: 'test/model' };
  },
  cleanup(_sessionId: string): void {},
};

describe('Cron E2E', () => {
  let tmpDir: string;
  let service: CronService;
  let store: CronStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'cron-e2e-'));
    store = new CronStore(tmpDir);
    const runner = new JobRunner(stubFeishuClient, stubAgentRunner, {
      executionTimeoutMs: 600_000, logger,
    });
    const scheduler = new CronScheduler(store, runner, { tickIntervalMs: 30_000, logger });
    service = new CronService(store, scheduler, runner);
  });

  afterAll(() => {
    // cleanup handled by OS
  });

  // ── Schedule parsing ──
  describe('schedule parsing', () => {
    it('parses oneshot "30m"', () => {
      const r = parseSchedule('30m');
      expect(r.schedule.type).toBe('oneshot');
    });

    it('parses interval "every 2h"', () => {
      const r = parseSchedule('every 2h');
      expect(r.schedule).toEqual({ type: 'interval', intervalMs: 7_200_000 });
    });

    it('parses cron "0 8 * * *"', () => {
      const r = parseSchedule('0 8 * * *');
      expect(r.schedule.type).toBe('cron');
    });

    it('parses cron "0 8,15 * * 1-5"', () => {
      const r = parseSchedule('0 8,15 * * 1-5');
      expect(r.schedule.type).toBe('cron');
    });

    it('rejects invalid schedule', () => {
      expect(() => parseSchedule('not a schedule')).toThrow('Cannot parse schedule');
    });
  });

  // ── Create + List + Get ──
  describe('CRUD', () => {
    it('creates multiple job types', () => {
      const j1 = service.add({ name: 'Cron job', schedule: '0 8 * * *', prompt: 'p1', chatId: 'c1' });
      const j2 = service.add({ name: 'Oneshot', schedule: '30m', prompt: 'p2', chatId: 'c2' });
      const j3 = service.add({ name: 'Interval', schedule: 'every 1h', prompt: 'p3', chatId: 'c3' });

      expect(j1.schedule.type).toBe('cron');
      expect(j2.schedule.type).toBe('oneshot');
      expect(j3.schedule.type).toBe('interval');
      expect(service.list()).toHaveLength(3);
    });

    it('lists jobs with correct fields', () => {
      service.add({ name: 'Test', schedule: '1h', prompt: 'hello', chatId: 'chat' });
      const jobs = service.list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.name).toBe('Test');
      expect(jobs[0]!.prompt).toBe('hello');
      expect(jobs[0]!.state).toBe('idle');
    });

    it('returns undefined for non-existent job', () => {
      expect(service.get('nope')).toBeUndefined();
    });

    it('removes a job', () => {
      const j = service.add({ name: 'Del', schedule: '1h', prompt: 'p', chatId: 'c' });
      expect(service.remove(j.id)).toBe(true);
      expect(service.list()).toHaveLength(0);
    });
  });

  // ── Pause / Resume ──
  describe('pause / resume', () => {
    it('pauses and resumes a job', () => {
      const j = service.add({ name: 'P', schedule: '1h', prompt: 'p', chatId: 'c' });
      expect(service.pause(j.id)).toBe(true);
      expect(service.get(j.id)?.enabled).toBe(false);
      expect(service.get(j.id)?.state).toBe('paused');

      expect(service.resume(j.id)).toBe(true);
      expect(service.get(j.id)?.enabled).toBe(true);
      expect(service.get(j.id)?.state).toBe('idle');
    });

    it('returns false for non-existent pause/resume', () => {
      expect(service.pause('nope')).toBe(false);
      expect(service.resume('nope')).toBe(false);
    });
  });

  // ── Run job immediately ──
  describe('runOnce', () => {
    it('runs a job successfully', async () => {
      const j = service.add({ name: 'R', schedule: '1h', prompt: 'test prompt', chatId: 'c' });
      const result = await service.runOnce(j.id);
      expect(result.status).toBe('success');
      expect(result.jobId).toBe(j.id);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('throws for non-existent job', async () => {
      await expect(service.runOnce('nope')).rejects.toThrow('Job not found');
    });
  });

  // ── Scheduler tick ──
  describe('scheduler tick', () => {
    it('advances nextRunAt on tick', async () => {
      const j = service.add({ name: 'T', schedule: '0 8 * * *', prompt: 'p', chatId: 'c' });
      const originalNext = j.nextRunAt;
      // Simulate a due job
      store.update(j.id, { nextRunAt: Date.now() - 1000 });
      const due = store.getDueJobs(Date.now());
      expect(due).toHaveLength(1);

      await service.tick();

      // After tick, job should have advanced
      const updated = service.get(j.id);
      expect(updated?.lastStatus).toBeTruthy();
      // Due list should be empty now
      expect(store.getDueJobs(Date.now())).toHaveLength(0);
    });

    it('completes oneshot after execution', async () => {
      const j = service.add({ name: 'OS', schedule: '1m', prompt: 'p', chatId: 'c' });
      store.update(j.id, { nextRunAt: Date.now() - 1000 });
      await service.tick();
      const updated = service.get(j.id);
      expect(updated?.state).toBe('completed');
      expect(updated?.nextRunAt).toBeNull();
    });
  });

  // ── Persistence ──
  describe('persistence', () => {
    it('survives store reload', async () => {
      const j = service.add({ name: 'Persist', schedule: '0 8 * * *', prompt: 'p', chatId: 'c' });
      await store.flush();

      const store2 = new CronStore(tmpDir);
      expect(store2.list()).toHaveLength(1);
      expect(store2.get(j.id)?.name).toBe('Persist');
    });

    it('handles corrupt file gracefully', () => {
      // Write invalid JSON directly to the store path
      const fs = require('node:fs');
      const filePath = path.join(tmpDir, 'cron-jobs.json');
      fs.writeFileSync(filePath, 'this is not json{', 'utf-8');

      const freshStore = new CronStore(tmpDir);
      expect(freshStore.list()).toEqual([]);
    });
  });

  // ── CollectingReplyDispatcher ──
  describe('CollectingReplyDispatcher', () => {
    it('collects multi-segment text', () => {
      const d = new CollectingReplyDispatcher();
      d.onStart();
      d.onTextDelta('Part 1');
      d.onTextDelta(' Part 2');
      d.onComplete();
      expect(d.getOutput()).toBe('Part 1 Part 2');
    });

    it('ignores reasoning and tool events', () => {
      const d = new CollectingReplyDispatcher();
      d.onReasoningDelta('thinking...');
      d.onToolStart('shell', { command: 'ls' });
      d.onToolEnd('shell', { stdout: 'ok' });
      d.onTextDelta('final answer');
      d.onComplete();
      expect(d.getOutput()).toBe('final answer');
    });

    it('captures aborted state', () => {
      const d = new CollectingReplyDispatcher();
      d.onAborted();
      expect(d.getError()?.message).toBe('aborted');
    });
  });

  // ── Store error cases ──
  describe('CronStore edge cases', () => {
    it('getDueJobs filters correctly', () => {
      const now = Date.now();
      const due: CronJob = {
        id: 'due1', name: 'd', schedule: { type: 'oneshot', timestampMs: now - 1000 },
        scheduleText: '', prompt: '', chatId: '', enabled: true, state: 'idle',
        nextRunAt: now - 1000, retryCount: 0, lastRunAt: null, lastStatus: null,
        createdAt: 0, updatedAt: 0,
      };
      const future: CronJob = {
        id: 'fut1', name: 'f', schedule: { type: 'oneshot', timestampMs: now + 999999 },
        scheduleText: '', prompt: '', chatId: '', enabled: true, state: 'idle',
        nextRunAt: now + 999999, retryCount: 0, lastRunAt: null, lastStatus: null,
        createdAt: 0, updatedAt: 0,
      };
      const running: CronJob = {
        id: 'run1', name: 'r', schedule: { type: 'oneshot', timestampMs: now - 1000 },
        scheduleText: '', prompt: '', chatId: '', enabled: true, state: 'running',
        nextRunAt: now - 1000, retryCount: 0, lastRunAt: null, lastStatus: null,
        createdAt: 0, updatedAt: 0,
      };
      store.add(due);
      store.add(future);
      store.add(running);
      const dueJobs = store.getDueJobs(now);
      expect(dueJobs).toHaveLength(1);
      expect(dueJobs[0]!.id).toBe('due1');
    });

    it('update returns false for non-existent job', () => {
      expect(store.update('nope', { name: 'x' })).toBe(false);
    });
  });
});
