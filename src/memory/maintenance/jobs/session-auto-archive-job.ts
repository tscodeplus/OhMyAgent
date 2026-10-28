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
 * and would leave the archive's owner counts, its archive ordering and
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
/** Every two hours: archiving is not real-time, so a tighter tick buys nothing. */
const DEFAULT_INTERVAL_MS = 2 * 60 * 60 * 1000;
/** Rows per UPDATE statement. */
const BATCH_SIZE = 500;
/**
 * Per-tick ceiling. A scheduler tick runs every due job sequentially, so a first
 * tick that archived a 50k-row backlog in one go would starve the jobs behind it.
 * The next tick continues from where this one stopped (`remaining` says how much
 * is left), which is why the job drains a little and stops.
 */
const JOB_MAX_ROWS = 2_000;
const JOB_TIME_BUDGET_MS = 5_000;
/**
 * Ceilings for an interactive 立即执行一次, which has no reason to be polite: the
 * caller is waiting for exactly this and asked for one click to finish the job.
 * Still bounded, so a pathological install cannot hold a request open forever.
 */
export const INTERACTIVE_MAX_ROWS = 100_000;
export const INTERACTIVE_TIME_BUDGET_MS = 60_000;

export interface ArchiveAutoConfig {
  enabled: boolean;
  days: number;
}

export interface AutoArchiveBudget {
  /** Rows per UPDATE statement. */
  batchSize?: number;
  /** Stop after archiving this many rows in one call. */
  maxRows?: number;
  /** Hard wall-clock stop, so a caller with a deadline stays inside it. */
  timeBudgetMs?: number;
}

export interface AutoArchiveSweep {
  archived: number;
  /** UPDATE rounds that ran. */
  batches: number;
  /** Candidates still queued afterwards (includes any skipped as running). */
  remaining: number;
  /** Stopped on `maxRows` / `timeBudgetMs` instead of on an empty queue. */
  truncated: boolean;
  /** Eligible conversations left alone because a turn was in flight. */
  skippedRunning: number;
}

/**
 * Archive eligible conversations until the queue is empty or the budget runs out.
 *
 * Shared by the maintenance job and the manual "run now" endpoint, so the two
 * cannot disagree about what a sweep does — only the budget differs. Draining in
 * rounds instead of one capped UPDATE is what makes the button clear a backlog
 * rather than moving 500 rows and asking the operator to click again.
 *
 * Each round re-queries: archived rows leave the candidate set, and a round that
 * archives nothing has to end the loop — a queue made entirely of conversations
 * with a turn in flight would otherwise spin forever.
 */
export function archiveInactiveSessions(
  sessions: SessionRepository,
  config: ArchiveAutoConfig,
  isRunning: (sessionId: string) => boolean,
  budget: AutoArchiveBudget = {},
): AutoArchiveSweep {
  const batchSize = budget.batchSize ?? BATCH_SIZE;
  const maxRows = budget.maxRows ?? JOB_MAX_ROWS;
  const deadline = Date.now() + (budget.timeBudgetMs ?? JOB_TIME_BUDGET_MS);

  let archived = 0;
  let batches = 0;
  let truncated = false;
  // Deduped: each round re-reads the queue, so a conversation that is still busy
  // would otherwise be counted once per round.
  const skipped = new Set<string>();

  for (;;) {
    const candidates = sessions.listAutoArchiveCandidates(config.days, batchSize);
    if (candidates.length === 0) break;

    const ids: string[] = [];
    for (const id of candidates) {
      if (isRunning(id)) skipped.add(id);
      else ids.push(id);
    }
    if (ids.length === 0) break; // nothing archivable left in the queue

    const changed = sessions.setArchived(ids, true);
    batches += 1;
    archived += changed;

    // Another device already archived these rows: nothing moved, nothing to do.
    if (changed === 0) break;
    if (archived >= maxRows) {
      truncated = true;
      break;
    }
    if (Date.now() >= deadline) {
      truncated = true;
      break;
    }
  }

  return {
    archived,
    batches,
    remaining: sessions.countAutoArchiveCandidates(config.days),
    truncated,
    skippedRunning: skipped.size,
  };
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

      if (dryRun) {
        // Same eligibility query, no writes — the count a caller would act on.
        const candidates = sessions.listAutoArchiveCandidates(config.days, BATCH_SIZE);
        const archivable = candidates.filter((id) => !isRunning(id));
        return {
          ...base,
          status: 'success',
          affectedRows: archivable.length,
          durationMs: Date.now() - started,
          details: { thresholdDays: config.days, dryRun: true },
        };
      }

      const sweep = archiveInactiveSessions(sessions, config, isRunning, {
        maxRows: JOB_MAX_ROWS,
        timeBudgetMs: JOB_TIME_BUDGET_MS,
      });

      return {
        ...base,
        status: 'success',
        affectedRows: sweep.archived,
        durationMs: Date.now() - started,
        details: {
          thresholdDays: config.days,
          batches: sweep.batches,
          skippedRunning: sweep.skippedRunning,
          // Non-zero means the backlog outlived one tick; the next one continues.
          remaining: sweep.remaining,
          truncated: sweep.truncated,
        },
      };
    },
  };
}
