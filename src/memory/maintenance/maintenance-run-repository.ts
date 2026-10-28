import type Database from 'better-sqlite3';
import { generateId } from '../../shared/ids.js';

export interface MaintenanceRunRecord {
  id: string;
  job_name: string;
  status: string;
  dry_run: number;
  affected_rows: number;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  duration_ms?: number;
}

export class MaintenanceRunRepository {
  constructor(private db: Database.Database) {}

  startRun(jobName: string, dryRun: boolean): string {
    const id = generateId();
    this.db
      .prepare(
        `
      INSERT INTO maintenance_runs (id, job_name, status, dry_run, started_at)
      VALUES (?, ?, 'running', ?, ?)
    `,
      )
      .run(id, jobName, dryRun ? 1 : 0, String(Date.now()));
    return id;
  }

  finishRun(id: string, affectedRows: number, error?: string): void {
    this.db
      .prepare(
        `
      UPDATE maintenance_runs
      SET status = ?, finished_at = cast(strftime('%s','now') as integer) * 1000, affected_rows = ?, error = ?
      WHERE id = ?
    `,
      )
      .run(error ? 'failed' : 'success', affectedRows, error ?? null, id);
  }

  getLastRun(jobName: string): MaintenanceRunRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM maintenance_runs WHERE job_name = ? ORDER BY started_at DESC LIMIT 1')
      .get(jobName) as MaintenanceRunRecord | undefined;
    return row ?? undefined;
  }

  /** Last run across all job names sharing a prefix (e.g. `dreamcycle_`). */
  getLastRunByPrefix(prefix: string): MaintenanceRunRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM maintenance_runs WHERE job_name LIKE ? || '%' ORDER BY started_at DESC LIMIT 1",
      )
      .get(prefix) as MaintenanceRunRecord | undefined;
    return row ?? undefined;
  }

  getRecentRuns(limit: number = 50): MaintenanceRunRecord[] {
    return this.db
      .prepare('SELECT * FROM maintenance_runs ORDER BY started_at DESC LIMIT ?')
      .all(limit) as MaintenanceRunRecord[];
  }

  /**
   * Delete run history older than `olderThanMs` (epoch ms) and report how many
   * rows went — always sparing the newest row of every job.
   *
   * Nothing reads old runs — `getLastRun` wants the newest row per job and the
   * pipeline status wants the newest per dreamcycle phase — so this table only
   * grows. It is pruned by time rather than "keep the last N per job" on purpose:
   * a fixed row count gives a 2-hourly job ~41 days of history and a daily one
   * ~500 days from the same setting, so "how far back can I look" would depend on
   * each job's cadence. A time window answers that question the same way for all
   * of them.
   *
   * The newest row per job survives regardless of age: a job that has not run in a
   * year is exactly the case where "when did this last run, and did it fail?" is
   * worth answering, and dropping it would leave the status view blank rather than
   * saying "last ran 400 days ago".
   *
   * `started_at` is TEXT holding epoch-ms digit strings, hence the CAST.
   */
  pruneOlderThan(olderThanMs: number): number {
    const result = this.db
      .prepare(
        `DELETE FROM maintenance_runs
          WHERE CAST(started_at AS INTEGER) < ?
            AND id NOT IN (
              SELECT id FROM (
                SELECT id,
                       ROW_NUMBER() OVER (
                         PARTITION BY job_name
                         ORDER BY CAST(started_at AS INTEGER) DESC, rowid DESC
                       ) AS rn
                  FROM maintenance_runs
              )
               WHERE rn = 1
            )`,
      )
      .run(olderThanMs);
    return result.changes;
  }
}
