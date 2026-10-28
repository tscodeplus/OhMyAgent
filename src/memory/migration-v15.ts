/**
 * Migration v15: `memory_links` grows an explicit subject.
 *
 * A `memory_links` row used to be "this memory mentioned this entity": the
 * subject was missing, so the graph projection had to invent one — it took the
 * highest-confidence link as the subject and, with only one link, created a
 * `memory:<id>` placeholder node. Measured on the real database: 9 of 22
 * entities were those placeholders, and `SQLite` became the subject of a
 * memory about vector search. Writing the subject where it is actually known
 * (at extraction time) removes the guess instead of tuning it.
 *
 * `subject_entity_type` / `target_entity_type` carry the type the producer
 * asserted, replacing name-shape inference (`inferEntityType`), which typed
 * "Power Query" as a person.
 *
 * `memory_links` stays a weak "memory × mentioned entity" association and is
 * not what the graph draws; `entity_edges` is fed by links that have a subject
 * and a relation.
 *
 * Existing rows keep NULL — "subject unknown", the truthful answer. The
 * projection must skip those rather than guess again.
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

export interface MigrateV15Result {
  /** Columns this call added (empty on a re-run, and on a fresh database). */
  added: string[];
}

const COLUMNS = ['subject_entity', 'subject_entity_type', 'target_entity_type'] as const;

/**
 * Apply the v15 columns. Safe to call on every startup.
 */
export function migrateV15(db: Database.Database): MigrateV15Result {
  const existing = new Set(
    (db.pragma('table_info(memory_links)') as Array<{ name: string }>).map((c) => c.name),
  );

  // Fresh database: DDL_MEMORY_LINKS in schema.ts already declares the columns
  // and applySchema (which runs right after) creates the table.
  if (existing.size === 0) return { added: [] };

  const added: string[] = [];
  for (const column of COLUMNS) {
    if (existing.has(column)) continue;
    db.exec(`ALTER TABLE memory_links ADD COLUMN ${column} TEXT`);
    added.push(column);
  }

  if (added.length > 0) {
    logger.info(`[migration-v15] Added columns: ${added.join(', ')}`);
  }

  return { added };
}
