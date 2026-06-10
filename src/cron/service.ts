import { CronExpressionParser } from 'cron-parser';
import { CronStore } from './store.js';
import type { CronJob, CronSchedule, JobRunResult, ScheduleInput } from './types.js';
import type { JobRunner } from './job-runner.js';
import type { CronScheduler } from './scheduler.js';
import { shortId } from '../shared/ids.js';

// ── Schedule parsing ──

export interface ParseResult {
  schedule: CronSchedule;
  scheduleText: string;
  nextRunAt: number;
}

/**
 * Parse a user-facing schedule input string into a CronSchedule and the first
 * next-run timestamp.
 *
 * Accepted formats (checked in order):
 *   "every 30m" | "every 2h" | "every 1d"   → interval
 *   "at YYYY-MM-DDTHH:mm:ss" | "at HH:mm"   → oneshot
 *   "30m" | "2h" | "1d" (bare duration)      → oneshot
 *   "m h dom mon dow" (5-field cron)          → cron expression
 */
export function parseSchedule(input: string): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Schedule input is empty');

  // "every X" — interval
  const everyMatch = trimmed.match(/^every\s+(\d+)\s*(m|h|d)$/i);
  if (everyMatch) {
    const value = parseInt(everyMatch[1]!, 10);
    const unit = everyMatch[2]!.toLowerCase();
    const intervalMs = durationMs(value, unit);
    if (intervalMs < MIN_INTERVAL_MS) {
      throw new Error(`Interval too short. Minimum is ${MIN_INTERVAL_MS / 1000}s.`);
    }
    return {
      schedule: { type: 'interval', intervalMs },
      scheduleText: trimmed,
      nextRunAt: Date.now() + intervalMs,
    };
  }

  // "at <ISO timestamp>" — oneshot
  const atIsoMatch = trimmed.match(/^at\s+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?)/i);
  if (atIsoMatch) {
    const ts = Date.parse(atIsoMatch[1]!);
    if (isNaN(ts)) throw new Error(`Cannot parse timestamp: ${atIsoMatch[1]}`);
    const now = Date.now();
    if (ts <= now) throw new Error('Scheduled time is in the past');
    return {
      schedule: { type: 'oneshot', timestampMs: ts },
      scheduleText: trimmed,
      nextRunAt: ts,
    };
  }

  // "at HH:mm" — oneshot today
  const atTimeMatch = trimmed.match(/^at\s+(\d{1,2}):(\d{2})$/i);
  if (atTimeMatch) {
    const hour = parseInt(atTimeMatch[1]!, 10);
    const minute = parseInt(atTimeMatch[2]!, 10);
    if (hour > 23 || minute > 59) throw new Error('Invalid time');
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
    if (target.getTime() <= Date.now()) {
      throw new Error('Scheduled time is in the past');
    }
    return {
      schedule: { type: 'oneshot', timestampMs: target.getTime() },
      scheduleText: trimmed,
      nextRunAt: target.getTime(),
    };
  }

  // Bare duration: "30m", "2h", "1d"
  const bareMatch = trimmed.match(/^(\d+)\s*(m|h|d)$/i);
  if (bareMatch) {
    const value = parseInt(bareMatch[1]!, 10);
    const unit = bareMatch[2]!.toLowerCase();
    const intervalMs = durationMs(value, unit);
    return {
      schedule: { type: 'oneshot', timestampMs: Date.now() + intervalMs },
      scheduleText: trimmed,
      nextRunAt: Date.now() + intervalMs,
    };
  }

  // Cron expression (5 fields)
  try {
    const interval = CronExpressionParser.parse(trimmed);
    const next = interval.next();
    return {
      schedule: { type: 'cron', expression: trimmed },
      scheduleText: trimmed,
      nextRunAt: next.getTime(),
    };
  } catch {
    throw new Error(
      `Cannot parse schedule: "${trimmed}". ` +
      'Expected: "every 30m", "at 15:00", "30m", or a cron expression like "0 8 * * *".',
    );
  }
}

function durationMs(value: number, unit: string): number {
  switch (unit) {
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    case 'd': return value * 86_400_000;
    default: return value * 60_000;
  }
}

export const MIN_INTERVAL_MS = 60_000; // 1 minute minimum

// ── Next-run computation for cron expressions ──

export function recomputeNextRun(job: CronJob): number | null {
  switch (job.schedule.type) {
    case 'oneshot':
      return job.nextRunAt; // already set, don't change
    case 'interval':
      return Date.now() + job.schedule.intervalMs;
    case 'cron': {
      try {
        const interval = CronExpressionParser.parse(job.schedule.expression);
        const next = interval.next();
        return next.getTime();
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}

// ── CronService ──

export class CronService {
  constructor(
    private store: CronStore,
    private scheduler: CronScheduler,
    private runner: JobRunner,
  ) {}

  start(): void {
    this.scheduler.start();
  }

  stop(): void {
    this.scheduler.stop();
  }

  /** Trigger an immediate tick (for manual run or testing). */
  async tick(): Promise<void> {
    await this.scheduler.trigger();
  }

  add(input: {
    name: string;
    schedule: ScheduleInput;
    prompt: string;
    chatId: string;
    channel: string;
    agentName?: string;
    agentId?: string;
    computerUseAllowed?: boolean;
    endAt?: number;
  }): CronJob {
    const { schedule, scheduleText, nextRunAt } = parseSchedule(input.schedule);
    const job: CronJob = {
      id: shortId(),
      name: input.name,
      schedule,
      scheduleText,
      prompt: input.prompt,
      chatId: input.chatId,
      channel: input.channel,
      agentName: input.agentName,
      agentId: input.agentId,
      computerUseAllowed: input.computerUseAllowed ?? false,
      enabled: true,
      state: 'idle',
      nextRunAt,
      lastRunAt: null,
      lastStatus: null,
      retryCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      endAt: input.endAt,
    };
    this.store.add(job);
    return job;
  }

  list(): CronJob[] {
    return this.store.list();
  }

  get(id: string): CronJob | undefined {
    return this.store.get(id);
  }

  remove(id: string): boolean {
    return this.store.remove(id);
  }

  pause(id: string): boolean {
    return this.store.update(id, { enabled: false, state: 'paused' });
  }

  resume(id: string): boolean {
    const job = this.store.get(id);
    if (!job) return false;
    const nextRunAt = recomputeNextRun(job);
    return this.store.update(id, { enabled: true, state: 'idle', nextRunAt });
  }

  /**
   * Immediately run a single job regardless of its schedule.
   */
  async runOnce(id: string): Promise<JobRunResult> {
    const job = this.store.get(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    return this.runner.run(job);
  }

  /** List jobs scoped to a specific channel + chatId. */
  listByChannel(channel: string, chatId: string): CronJob[] {
    return this.store.list().filter(j => j.channel === channel && j.chatId === chatId);
  }

  /** General-purpose update for any job fields. */
  update(id: string, patch: Partial<CronJob>): boolean {
    return this.store.update(id, patch);
  }

  /** Set a job's enabled state (true = resume, false = pause). */
  toggle(id: string, enabled: boolean): boolean {
    const job = this.store.get(id);
    if (!job) return false;
    const patch: Partial<CronJob> = { enabled, state: enabled ? 'idle' : 'paused' };
    if (enabled) {
      patch.nextRunAt = recomputeNextRun(job);
    }
    return this.store.update(id, patch);
  }
}
