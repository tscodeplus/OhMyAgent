import type { Logger } from 'pino';
import type { MaintenanceJob, MaintenanceJobResult } from './maintenance-job.js';
import type { MaintenanceRunRepository } from './maintenance-run-repository.js';

export interface SchedulerConfig {
  enabled: boolean;
  intervalMs: number;
}

export class MaintenanceScheduler {
  private jobs: Map<string, MaintenanceJob> = new Map();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private runningDue = false;
  private runningJobs: Set<string> = new Set();

  constructor(
    private config: SchedulerConfig,
    private runRepo: MaintenanceRunRepository,
    private logger: Logger,
  ) {}

  register(job: MaintenanceJob): void {
    this.jobs.set(job.name, job);
    this.logger.info({ job: job.name, enabled: job.enabled }, 'Maintenance job registered');
  }

  start(): void {
    if (!this.config.enabled) return;
    this.running = true;
    this.logger.info({ intervalMs: this.config.intervalMs, jobCount: this.jobs.size }, 'MaintenanceScheduler started');
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.info('MaintenanceScheduler stopped');
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.runDue().catch(err => {
        this.logger.error({ err }, 'MaintenanceScheduler runDue failed');
      });
      this.scheduleNext();
    }, this.config.intervalMs);
    this.timer.unref();
  }

  async runDue(): Promise<MaintenanceJobResult[]> {
    // Guard against overlapping runDue calls
    if (this.runningDue) return [];
    this.runningDue = true;
    try {
      const results: MaintenanceJobResult[] = [];
      for (const job of this.jobs.values()) {
        if (!job.enabled) continue;
        const lastRun = this.runRepo.getLastRun(job.name);
        if (lastRun) {
          const lastMs = new Date(lastRun.started_at).getTime();
          if (Date.now() - lastMs < job.intervalMs) continue;
        }
        const result = await this.runJob(job.name, false);
        results.push(result);
      }
      return results;
    } finally {
      this.runningDue = false;
    }
  }

  async runJob(name: string, dryRun: boolean = false): Promise<MaintenanceJobResult> {
    const job = this.jobs.get(name);
    if (!job) {
      return { name, status: 'failed', dryRun, affectedRows: 0, durationMs: 0, error: `Job not found: ${name}` };
    }

    // Prevent concurrent execution of the same job
    if (this.runningJobs.has(name)) {
      this.logger.info({ job: name }, 'Job already running, skipping');
      return { name, status: 'skipped', dryRun, affectedRows: 0, durationMs: 0, details: { reason: 'already_running' } };
    }
    this.runningJobs.add(name);

    const runId = this.runRepo.startRun(name, dryRun);
    const start = Date.now();
    try {
      const result = await job.run({ dryRun, signal: AbortSignal.timeout(60_000) });
      this.runRepo.finishRun(runId, result.affectedRows, result.error);
      this.logger.info({ job: name, dryRun, affectedRows: result.affectedRows, durationMs: Date.now() - start }, 'Maintenance job complete');
      return { ...result, durationMs: Date.now() - start };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.runRepo.finishRun(runId, 0, error);
      this.logger.warn({ job: name, dryRun, error }, 'Maintenance job failed');
      return { name, status: 'failed', dryRun, affectedRows: 0, durationMs: Date.now() - start, error };
    } finally {
      this.runningJobs.delete(name);
    }
  }

  listJobs(): Array<{ name: string; enabled: boolean; intervalMs: number }> {
    return Array.from(this.jobs.values()).map(j => ({
      name: j.name,
      enabled: j.enabled,
      intervalMs: j.intervalMs,
    }));
  }
}
