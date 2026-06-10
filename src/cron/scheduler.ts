import type { Logger } from 'pino';
import { CronExpressionParser } from 'cron-parser';
import type { CronStore } from './store.js';
import type { JobRunner } from './job-runner.js';
import type { CronJob, JobRunResult } from './types.js';

const STUCK_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
const DEFAULT_MAX_CONCURRENCY = 4;

export interface CronSchedulerOptions {
  tickIntervalMs: number;
  logger: Logger;
  /**
   * Max number of due jobs executed concurrently within a single tick.
   * Previously jobs ran strictly serially, so one slow/hung job delayed every
   * other job in the same batch until the 2h stuck threshold. Default 4.
   */
  maxConcurrency?: number;
}

export class CronScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private store: CronStore,
    private runner: JobRunner,
    private options: CronSchedulerOptions,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.options.tickIntervalMs);
    this.timer.unref();
    // Kick off immediately
    setImmediate(() => { void this.tick(); });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async trigger(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    if (this.ticking) return; // prevent overlapping ticks
    this.ticking = true;

    try {
      const now = Date.now();
      const dueJobs = this.store.getDueJobs(now);

      // Partition: expired jobs are completed synchronously (cheap, no run);
      // the rest are dispatched with bounded concurrency so one slow/hung job
      // no longer blocks the whole batch.
      const runnable: CronJob[] = [];
      for (const job of dueJobs) {
        if (job.endAt && now >= job.endAt) {
          this.store.update(job.id, {
            state: 'completed',
            enabled: false,
            nextRunAt: null,
            updatedAt: now,
            lastError: 'Job expired (endAt reached)',
          });
          this.options.logger.info({ jobId: job.id, jobName: job.name }, 'Cron job expired, auto-completed');
          continue;
        }

        // At-most-once: advance nextRunAt and mark running BEFORE execution.
        this.advanceNextRun(job);
        this.store.update(job.id, {
          state: 'running',
          lastRunAt: now,
          nextRunAt: job.nextRunAt,
        });
        runnable.push(job);
      }

      await this.runWithConcurrency(runnable);

      // Stuck detection + expired job cleanup
      this.detectStuckAndExpiredJobs(now);
    } finally {
      this.ticking = false;
    }
  }

  /** Execute jobs concurrently, capped at maxConcurrency. */
  private async runWithConcurrency(jobs: CronJob[]): Promise<void> {
    if (jobs.length === 0) return;

    const limit = Math.max(1, this.options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        const result = await this.runner.run(job).catch(err => ({
          jobId: job.id,
          status: 'error' as const,
          output: '',
          durationMs: 0,
          error: err instanceof Error ? err.message : String(err),
          deliveredToChat: false,
        }));
        this.handleResult(job, result);
      }
    };

    const workers = Array.from({ length: Math.min(limit, jobs.length) }, () => worker());
    await Promise.all(workers);
  }

  private advanceNextRun(job: CronJob): void {
    switch (job.schedule.type) {
      case 'oneshot':
        break;
      case 'interval': {
        const next = Date.now() + job.schedule.intervalMs;
        job.nextRunAt = (job.endAt && next >= job.endAt) ? null : next;
        break;
      }
      case 'cron':
        try {
          const interval = CronExpressionParser.parse(job.schedule.expression);
          const next = interval.next().getTime();
          job.nextRunAt = (job.endAt && next >= job.endAt) ? null : next;
        } catch {
          job.nextRunAt = null;
        }
        break;
    }
  }

  private handleResult(job: CronJob, result: JobRunResult): void {
    const patch: Partial<CronJob> = {
      lastStatus: result.status,
      lastError: result.error,
      updatedAt: Date.now(),
    };

    if (result.status === 'success') {
      patch.retryCount = 0;
      if (job.schedule.type === 'oneshot') {
        // Oneshot done — null nextRunAt so it won't fire again on recovery
        patch.nextRunAt = null;
        patch.state = 'completed';
      } else {
        patch.state = 'idle';
      }
    } else if (result.status === 'error') {
      // Transient error — apply exponential backoff
      const newRetryCount = job.retryCount + 1;
      patch.retryCount = newRetryCount;
      const backoffMs = this.runner.applyBackoff({ ...job, retryCount: newRetryCount });
      patch.nextRunAt = backoffMs ?? job.nextRunAt;
      patch.state = job.schedule.type === 'oneshot' ? 'idle' : 'idle';
    } else {
      // timeout / cancelled
      if (job.schedule.type === 'oneshot') {
        // Keep nextRunAt so stuck detection can re-fire after recovery
        patch.nextRunAt = job.nextRunAt;
      }
      patch.state = 'idle';
    }

    this.store.update(job.id, patch);
  }

  private detectStuckAndExpiredJobs(now: number): void {
    for (const job of this.store.list()) {
      // Clean up expired jobs that were missed (e.g. service was down)
      if (job.endAt && job.enabled && job.state !== 'completed' && now >= job.endAt) {
        this.options.logger.info({ jobId: job.id, jobName: job.name }, 'Cron job expired during downtime, auto-completing');
        this.store.update(job.id, {
          state: 'completed',
          enabled: false,
          nextRunAt: null,
          lastError: 'Job expired (endAt reached while service was down)',
          updatedAt: now,
        });
        continue;
      }

      if (
        job.state === 'running' &&
        job.lastRunAt !== null &&
        now - job.lastRunAt > STUCK_THRESHOLD_MS
      ) {
        this.options.logger.warn({ jobId: job.id }, 'Detected stuck cron job, resetting');
        this.store.update(job.id, {
          state: 'idle',
          lastStatus: 'timeout',
          lastError: 'Stuck detection: exceeded 2h running time',
          updatedAt: now,
        });
      }
    }
  }
}
