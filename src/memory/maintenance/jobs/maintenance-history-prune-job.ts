/**
 * Maintenance-history pruning job.
 *
 * `maintenance_runs` is append-only: every job run writes a row, nothing deletes
 * them, and the only readers want the *newest* row (`getLastRun`, and the
 * pipeline status per dreamcycle phase). Left alone the table grows by ~12 rows a
 * day on a stock install — small, but unbounded, and each row is written twice
 * (insert + finish update).
 *
 * Retention is a **time window** rather than "keep the last N per job": a fixed
 * row count would mean ~41 days of history for the 2-hourly auto-archive job and
 * ~500 days for the daily memory doctor from the same setting, so the answer to
 * "how far back can I look" would depend on the job. 90 days is uniform and still
 * leaves room for quarter-over-quarter questions.
 */

import type { MaintenanceJob, MaintenanceJobResult } from '../maintenance-job.js';
import type { MaintenanceRunRepository } from '../maintenance-run-repository.js';

const JOB_NAME = 'maintenance_history_prune';
/** Daily is plenty: the table grows by rows per day, not per minute. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const HISTORY_RETENTION_DAYS = 90;

export function createMaintenanceHistoryPruneJob(
  runRepo: MaintenanceRunRepository,
  intervalMs: number = DEFAULT_INTERVAL_MS,
  retentionDays: number = HISTORY_RETENTION_DAYS,
): MaintenanceJob {
  return {
    name: JOB_NAME,
    enabled: true,
    intervalMs,
    async run({ dryRun }): Promise<MaintenanceJobResult> {
      const started = Date.now();
      const base = { name: JOB_NAME, dryRun, affectedRows: 0 };

      if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
        return {
          ...base,
          status: 'skipped',
          durationMs: Date.now() - started,
          details: { reason: 'invalid_retention' },
        };
      }

      const cutoff = started - retentionDays * 86_400_000;
      if (dryRun) {
        // Counting is the honest dry run here; the DELETE is the only work.
        const row = runRepo
          .getRecentRuns(100_000)
          .filter((run) => Number(run.started_at) < cutoff).length;
        return {
          ...base,
          status: 'success',
          affectedRows: row,
          durationMs: Date.now() - started,
          details: { retentionDays, cutoff, dryRun: true },
        };
      }

      const deleted = runRepo.pruneOlderThan(cutoff);
      return {
        ...base,
        status: 'success',
        affectedRows: deleted,
        durationMs: Date.now() - started,
        details: { retentionDays, cutoff },
      };
    },
  };
}
