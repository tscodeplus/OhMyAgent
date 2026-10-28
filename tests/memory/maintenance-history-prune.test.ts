/**
 * Maintenance-history pruning (maintenance-history-prune-job.ts + pruneOlderThan).
 *
 * `maintenance_runs` is append-only and nothing reads old rows, so the only thing
 * to get wrong is deleting too much: the newest row per job is what `getLastRun`
 * (job scheduling) and the pipeline status (dreamcycle phases) depend on.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db';
import { MaintenanceRunRepository } from '../../src/memory/maintenance/maintenance-run-repository';
import {
  createMaintenanceHistoryPruneJob,
  HISTORY_RETENTION_DAYS,
} from '../../src/memory/maintenance/jobs/maintenance-history-prune-job';

const DAY = 86_400_000;

describe('maintenance history prune', () => {
  let db: Database.Database;
  let runRepo: MaintenanceRunRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runRepo = new MaintenanceRunRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  /** Insert a finished run as if it had started `ageDays` ago. */
  function seedRun(jobName: string, ageDays: number): void {
    const startedAt = String(Date.now() - ageDays * DAY);
    db.prepare(
      `INSERT INTO maintenance_runs (id, job_name, status, dry_run, started_at, finished_at, affected_rows)
       VALUES (?, ?, 'success', 0, ?, ?, 0)`,
    ).run(
      `${jobName}-${ageDays}-${Math.random().toString(36).slice(2, 8)}`,
      jobName,
      startedAt,
      startedAt,
    );
  }

  function countAll(): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM maintenance_runs').get() as { n: number }).n;
  }

  it('defaults to a 90 day window', () => {
    expect(HISTORY_RETENTION_DAYS).toBe(90);
  });

  it('deletes only rows past the retention window', async () => {
    seedRun('old_job', 120); // past the window, and not its newest row
    seedRun('old_job', 95); // past the window, but the newest of its job
    seedRun('recent_job', 89);
    seedRun('recent_job', 1);

    const job = createMaintenanceHistoryPruneJob(runRepo, DAY, 90);
    const result = await job.run({ dryRun: false });

    expect(result.status).toBe('success');
    expect(result.affectedRows).toBe(1);
    expect(countAll()).toBe(3);
    expect(
      (
        db
          .prepare('SELECT job_name FROM maintenance_runs ORDER BY CAST(started_at AS INTEGER)')
          .all() as Array<{ job_name: string }>
      ).map((row) => row.job_name),
    ).toEqual(['old_job', 'recent_job', 'recent_job']);
  });

  it('keeps the newest row of a job that has been dormant past the window', async () => {
    seedRun('dormant_job', 400);
    seedRun('dormant_job', 200);
    seedRun('mixed_job', 120);
    seedRun('mixed_job', 1);

    const job = createMaintenanceHistoryPruneJob(runRepo, DAY, 90);
    await job.run({ dryRun: false });

    // Time window, but never at the cost of a job's last known run: dropping it
    // would leave the status view blank instead of "last ran 200 days ago".
    const dormant = runRepo.getLastRun('dormant_job');
    expect(dormant).toBeDefined();
    expect(Math.round((Date.now() - Number(dormant!.started_at)) / DAY)).toBe(200);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM maintenance_runs WHERE job_name = 'dormant_job'")
          .get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM maintenance_runs WHERE job_name = 'mixed_job'")
          .get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

  it('writes nothing on a dry run but reports what it would delete', async () => {
    seedRun('old_job', 120);
    seedRun('old_job', 130);

    const job = createMaintenanceHistoryPruneJob(runRepo, DAY, 90);
    const result = await job.run({ dryRun: true });

    expect(result.affectedRows).toBe(2);
    expect(result.dryRun).toBe(true);
    expect(countAll()).toBe(2);
  });

  it('prunes a large table in one statement', () => {
    for (let i = 0; i < 300; i += 1) seedRun('noisy_job', 100);
    seedRun('noisy_job', 5);

    const cutoff = Date.now() - 90 * DAY;
    expect(runRepo.pruneOlderThan(cutoff)).toBe(300);
    expect(countAll()).toBe(1);
  });
});
