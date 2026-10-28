import type Database from 'better-sqlite3';
import { generateId } from '../../shared/ids.js';
import type { PersonaOutputDiff } from './provenance-query.js';

export interface DistillationRun {
  id: string;
  mode: string;
  status: string;
  active_preference_count: number;
  /** JSON array of memory ids this run distilled from (v16). */
  input_memory_ids: string | null;
  /** JSON field-level diff this run wrote (v16). */
  output_diff: string | null;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

export class PersonaDistillationLog {
  constructor(private db: Database.Database) {}

  startRun(mode: string, activePrefCount: number): string {
    const id = generateId();
    this.db
      .prepare(
        `
      INSERT INTO persona_distillation_runs (id, mode, status, active_preference_count)
      VALUES (?, ?, 'running', ?)
    `,
      )
      .run(id, mode, activePrefCount);
    return id;
  }

  finishRun(id: string, error?: string): void {
    this.db
      .prepare(
        `
      UPDATE persona_distillation_runs
      SET status = ?, finished_at = cast(strftime('%s','now') as integer) * 1000, error = ?
      WHERE id = ?
    `,
      )
      .run(error ? 'failed' : 'success', error ?? null, id);
  }

  /**
   * Record what the run distilled from and what it changed (v16 columns).
   *
   * Separate from `finishRun` so the inputs are visible even when the run ends
   * `failed` — "which memories were in play" is worth more than the status for
   * debugging, and a reader that wants a succeeded run can filter on status.
   */
  recordProvenance(
    id: string,
    provenance: { inputMemoryIds: string[]; outputDiff: PersonaOutputDiff },
  ): void {
    this.db
      .prepare(
        `
      UPDATE persona_distillation_runs
      SET input_memory_ids = ?, output_diff = ?
      WHERE id = ?
    `,
      )
      .run(JSON.stringify(provenance.inputMemoryIds), JSON.stringify(provenance.outputDiff), id);
  }

  getLastRun(mode?: string): DistillationRun | undefined {
    const sql = mode
      ? 'SELECT * FROM persona_distillation_runs WHERE mode = ? ORDER BY started_at DESC LIMIT 1'
      : 'SELECT * FROM persona_distillation_runs ORDER BY started_at DESC LIMIT 1';
    const params = mode ? [mode] : [];
    const row = this.db.prepare(sql).get(...params) as DistillationRun | undefined;
    return row ?? undefined;
  }

  getRecentRuns(limit: number = 10): DistillationRun[] {
    return this.db
      .prepare('SELECT * FROM persona_distillation_runs ORDER BY started_at DESC LIMIT ?')
      .all(limit) as DistillationRun[];
  }
}
