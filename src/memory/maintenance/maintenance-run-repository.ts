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
    this.db.prepare(`
      INSERT INTO maintenance_runs (id, job_name, status, dry_run)
      VALUES (?, ?, 'running', ?)
    `).run(id, jobName, dryRun ? 1 : 0);
    return id;
  }

  finishRun(id: string, affectedRows: number, error?: string): void {
    this.db.prepare(`
      UPDATE maintenance_runs
      SET status = ?, finished_at = cast(strftime('%s','now') as integer) * 1000, affected_rows = ?, error = ?
      WHERE id = ?
    `).run(error ? 'failed' : 'success', affectedRows, error ?? null, id);
  }

  getLastRun(jobName: string): MaintenanceRunRecord | undefined {
    const row = this.db.prepare(
      'SELECT * FROM maintenance_runs WHERE job_name = ? ORDER BY started_at DESC LIMIT 1'
    ).get(jobName) as MaintenanceRunRecord | undefined;
    return row ?? undefined;
  }

  getRecentRuns(limit: number = 50): MaintenanceRunRecord[] {
    return this.db.prepare(
      'SELECT * FROM maintenance_runs ORDER BY started_at DESC LIMIT ?'
    ).all(limit) as MaintenanceRunRecord[];
  }
}
