import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { applySchema } from '../../src/memory/schema';
import { MaintenanceScheduler } from '../../src/memory/maintenance/maintenance-scheduler';
import { MaintenanceRunRepository } from '../../src/memory/maintenance/maintenance-run-repository';
import type { MaintenanceJob } from '../../src/memory/maintenance/maintenance-job';

/**
 * Regression tests for report #9: started_at is a TEXT column holding epoch
 * millis (see the schema DEFAULT). The old code parsed it with
 * `new Date(str).getTime()`, which is NaN for a pure digit string, so the
 * interval check was always false and every job re-ran on every tick.
 */

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

function makeJob(name: string, intervalMs: number, runs: string[]): MaintenanceJob {
  return {
    name,
    enabled: true,
    intervalMs,
    run: async () => {
      runs.push(name);
      return { name, status: 'success', dryRun: false, affectedRows: 1, durationMs: 0 };
    },
  };
}

function setup() {
  const db = new Database(':memory:');
  applySchema(db);
  const runRepo = new MaintenanceRunRepository(db);
  const scheduler = new MaintenanceScheduler(
    { enabled: false, intervalMs: 60_000 },
    runRepo,
    logger,
  );
  return { db, runRepo, scheduler };
}

describe('MaintenanceScheduler started_at parsing', () => {
  it('runs a job that has never run', async () => {
    const { db, scheduler } = setup();
    const runs: string[] = [];
    scheduler.register(makeJob('job-a', 60_000, runs));
    const results = await scheduler.runDue();
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('success');
    db.close();
  });

  it('skips a job whose last run (numeric epoch-ms TEXT) is inside the interval', async () => {
    const { db, runRepo, scheduler } = setup();
    const runs: string[] = [];
    scheduler.register(makeJob('job-a', 60_000, runs));

    // Simulate a completed run 10s ago — started_at stored as a digit string.
    const runId = runRepo.startRun('job-a', false);
    runRepo.finishRun(runId, 1);
    db.prepare('UPDATE maintenance_runs SET started_at = ? WHERE id = ?').run(
      String(Date.now() - 10_000),
      runId,
    );

    const results = await scheduler.runDue();
    expect(results).toHaveLength(0);
    expect(runs).toHaveLength(0);
    db.close();
  });

  it('re-runs a job whose numeric last run is older than the interval', async () => {
    const { db, runRepo, scheduler } = setup();
    const runs: string[] = [];
    scheduler.register(makeJob('job-a', 60_000, runs));

    const runId = runRepo.startRun('job-a', false);
    runRepo.finishRun(runId, 1);
    db.prepare('UPDATE maintenance_runs SET started_at = ? WHERE id = ?').run(
      String(Date.now() - 120_000),
      runId,
    );

    const results = await scheduler.runDue();
    expect(results).toHaveLength(1);
    expect(runs).toEqual(['job-a']);
    db.close();
  });

  it('parses legacy ISO strings via Date.parse and re-runs stale ones', async () => {
    const { db, runRepo, scheduler } = setup();
    const runs: string[] = [];
    scheduler.register(makeJob('job-a', 60_000, runs));

    const runId = runRepo.startRun('job-a', false);
    runRepo.finishRun(runId, 1);
    db.prepare('UPDATE maintenance_runs SET started_at = ? WHERE id = ?').run(
      new Date(Date.now() - 120_000).toISOString(),
      runId,
    );

    const results = await scheduler.runDue();
    expect(results).toHaveLength(1);
    expect(runs).toEqual(['job-a']);
    db.close();
  });
});
