/**
 * Migration v16: `persona_distillation_runs` provenance columns.
 *
 * Same invariant as v11–v15: an in-place upgrade ends with the schema a fresh
 * install gets, and existing runs keep NULL in both columns — "not recorded",
 * which is the truthful answer for a run that happened before the columns
 * existed (not "distilled from nothing").
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrateV16 } from '../../src/memory/migration-v16';
import { applySchema } from '../../src/memory/schema';

/** persona_distillation_runs table as written by releases before v16. */
const V15_PERSONA_RUNS_DDL = `
CREATE TABLE persona_distillation_runs (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  active_preference_count INTEGER NOT NULL,
  started_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
  finished_at TEXT,
  error TEXT
)`;

const V16_COLUMNS = ['input_memory_ids', 'output_diff'];

function columnNames(db: Database.Database, table: string): string[] {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return cols.map((c) => c.name).sort();
}

describe('migration-v16: persona_distillation_runs provenance columns', () => {
  it('adds both columns, then reports nothing on a re-run', () => {
    const db = new Database(':memory:');
    db.exec(V15_PERSONA_RUNS_DDL);

    expect(migrateV16(db)).toEqual({ added: V16_COLUMNS });
    expect(columnNames(db, 'persona_distillation_runs')).toEqual(
      expect.arrayContaining(V16_COLUMNS),
    );

    // Idempotent: a second run must not throw on the duplicate columns.
    expect(migrateV16(db)).toEqual({ added: [] });
    db.close();
  });

  it('leaves existing runs unrecorded', () => {
    const db = new Database(':memory:');
    db.exec(V15_PERSONA_RUNS_DDL);
    db.prepare(
      `INSERT INTO persona_distillation_runs (id, mode, status, active_preference_count, started_at)
       VALUES ('run-1', 'auto', 'completed', 19, '1000')`,
    ).run();

    migrateV16(db);

    expect(
      db
        .prepare('SELECT input_memory_ids, output_diff FROM persona_distillation_runs WHERE id = ?')
        .get('run-1'),
    ).toEqual({ input_memory_ids: null, output_diff: null });
    db.close();
  });

  it('a migrated table has the same column set as a fresh one', () => {
    const migratedDb = new Database(':memory:');
    migratedDb.exec(V15_PERSONA_RUNS_DDL);
    migrateV16(migratedDb);

    const freshDb = new Database(':memory:');
    applySchema(freshDb);

    expect(columnNames(migratedDb, 'persona_distillation_runs')).toEqual(
      columnNames(freshDb, 'persona_distillation_runs'),
    );
    expect(columnNames(freshDb, 'persona_distillation_runs')).toEqual(
      expect.arrayContaining(V16_COLUMNS),
    );

    migratedDb.close();
    freshDb.close();
  });

  it('does nothing on a fresh database, where applySchema declares the columns', () => {
    const db = new Database(':memory:');

    expect(migrateV16(db)).toEqual({ added: [] });
    applySchema(db);
    expect(columnNames(db, 'persona_distillation_runs')).toEqual(
      expect.arrayContaining(V16_COLUMNS),
    );
    db.close();
  });
});
