/**
 * Auto-archive maintenance job.
 *
 * Flags conversations whose last activity is older than `archive.auto.days` as
 * archived, so a long-lived gateway's sidebar does not accumulate every chat it
 * has ever had. This is housekeeping, not deletion: the rows keep their owner,
 * their transcript and their memories, and 归档 is exactly the shelf a manual
 * archive puts them on.
 *
 * Why a maintenance job and not a query-time filter on the list endpoints: an
 * archive is a *durable* fact with a timestamp. Computing it at read time would
 * silently un-archive a conversation the moment anything touches `updated_at`,
 * and would leave the archive's owner counts, its `archived_at` ordering and
 * multi-select semantics with nothing to order by.
 *
 * Two settings are read live on every run rather than captured at bootstrap:
 * the scheduler is built once, before the operator can flip the switch, so a
 * captured snapshot would mean "restart to apply" — the exact failure mode this
 * feature was added to avoid. With `enabled: false` the job reports `skipped`
 * and writes nothing; the scheduler still records the run, which is how the
 * operator can see that the job is alive but idle.
 */

import type Database from 'better-sqlite3';
import { SessionRepository } from '../../repositories/session-repository.js';
import type { MaintenanceJob, MaintenanceJobResult } from '../maintenance-job.js';

const JOB_NAME = 'session_auto_archive';
/** One hour: archiving is not real-time, and a shorter tick buys nothing. */
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
/**
 * Rows per run. Enabling the feature on a long-lived install can make thousands
 * of conversations eligible at once; capping the batch keeps the first tick from
 * becoming a multi-second write burst, and `hitCap` tells the operator another
 * run is queued behind it (the next tick finishes the backlog).
 */
const BATCH_LIMIT = 500;

export interface ArchiveAutoConfig {
  enabled: boolean;
  days: number;
}

export function createSessionAutoArchiveJob(
  db: Database.Database,
  /**
   * Live getter — NOT a config snapshot. Returns `undefined` for a config.yaml
   * without an `archive:` section, which counts as disabled.
   */
  getConfig: () => ArchiveAutoConfig | undefined,
  /** A conversation with a turn in flight must not be yanked out of its list. */
  isRunning: (sessionId: string) => boolean = () => false,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): MaintenanceJob {
  const sessions = new SessionRepository(db);

  return {
    name: JOB_NAME,
    enabled: true,
    intervalMs,
    async run({ dryRun }): Promise<MaintenanceJobResult> {
      const started = Date.now();
      const base = { name: JOB_NAME, dryRun, affectedRows: 0 };
      const config = getConfig();

      if (!config?.enabled || !Number.isFinite(config.days) || config.days <= 0) {
        return {
          ...base,
          status: 'skipped',
          durationMs: Date.now() - started,
          details: { reason: 'disabled' },
        };
      }

      const candidates = sessions.listAutoArchiveCandidates(config.days, BATCH_LIMIT);
      // A conversation that is mid-reply is either the operator's current screen
      // or an IM chat that will be auto-restored by its own next message anyway;
      // skipping it keeps the run from fighting the turn path.
      const ids = candidates.filter((id) => !isRunning(id));
      const hitCap = candidates.length === BATCH_LIMIT;

      if (dryRun) {
        return {
          ...base,
          status: 'success',
          affectedRows: ids.length,
          durationMs: Date.now() - started,
          details: { thresholdDays: config.days, hitCap, dryRun: true },
        };
      }

      const archived = ids.length > 0 ? sessions.setArchived(ids, true) : 0;
      return {
        ...base,
        status: 'success',
        affectedRows: archived,
        durationMs: Date.now() - started,
        details: {
          thresholdDays: config.days,
          candidates: candidates.length,
          skippedRunning: candidates.length - ids.length,
          hitCap,
        },
      };
    },
  };
}
