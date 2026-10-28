/**
 * Migration v16: `persona_distillation_runs` becomes traceable.
 *
 * Distillation already works (`memory.persona.enabled`), but the run row only
 * recorded `active_preference_count` — so the persona could not answer "which
 * memories are you based on", and a contradiction between persona and a newer
 * memory was undetectable after the fact. Both columns hold JSON:
 *
 *   input_memory_ids  ["mem_…"] — the memories this run distilled from
 *   output_diff       field-level changes, e.g. {"ts_stack":{"from":…,"to":…}}
 *
 * A future `/persona why` answers from `input_memory_ids`; `output_diff` is what
 * makes "the persona changed on this run, and here is how" answerable without
 * diffing snapshots. NULL on older rows means "not recorded", not "no input".
 *
 * Runs BEFORE applySchema (same ordering constraint as v4/v9/v11/v12): the
 * columns are declared in schema.ts, and `CREATE TABLE IF NOT EXISTS` cannot
 * add a column to an existing table.
 *
 * Idempotent: each column add is skipped when `PRAGMA table_info` lists it.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../app/logger.js';

const logger = createLogger();

export interface MigrateV16Result {
  /** Columns this call added (empty on a re-run, and on a fresh database). */
  added: string[];
}

const COLUMNS = ['input_memory_ids', 'output_diff'] as const;

/**
 * Apply the v16 columns. Safe to call on every startup.
 */
export function migrateV16(db: Database.Database): MigrateV16Result {
  const existing = new Set(
    (db.pragma('table_info(persona_distillation_runs)') as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );

  // Fresh database: DDL_PERSONA_DISTILLATION_RUNS in schema.ts already declares
  // the columns and applySchema (which runs right after) creates the table.
  if (existing.size === 0) return { added: [] };

  const added: string[] = [];
  for (const column of COLUMNS) {
    if (existing.has(column)) continue;
    db.exec(`ALTER TABLE persona_distillation_runs ADD COLUMN ${column} TEXT`);
    added.push(column);
  }

  if (added.length > 0) {
    logger.info(`[migration-v16] Added columns: ${added.join(', ')}`);
  }

  return { added };
}
