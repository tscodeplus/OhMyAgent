/**
 * Migration v15: `memory_links` subject columns.
 *
 * Same invariant as v11–v13: an in-place upgrade ends with the schema a fresh
 * install gets, and the upgrade changes no behaviour — existing links keep NULL
 * subjects, i.e. "subject unknown", which the graph projection must skip rather
 * than guess (guessing is what produced `memory:<id>` placeholder nodes).
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrateV15 } from '../../src/memory/migration-v15';
import { applySchema } from '../../src/memory/schema';

/** memory_links table as written by releases before v15. */
const V14_MEMORY_LINKS_DDL = `
CREATE TABLE memory_links (
  id TEXT PRIMARY KEY,
  source_memory_id TEXT NOT NULL,
  target_entity TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000)
)`;

const V15_COLUMNS = ['subject_entity', 'subject_entity_type', 'target_entity_type'];

function columnNames(db: Database.Database, table: string): string[] {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return cols.map((c) => c.name).sort();
}

describe('migration-v15: memory_links subject columns', () => {
  it('adds the three columns, then reports nothing on a re-run', () => {
    const db = new Database(':memory:');
    db.exec(V14_MEMORY_LINKS_DDL);

    expect(migrateV15(db)).toEqual({ added: V15_COLUMNS });
    expect(columnNames(db, 'memory_links')).toEqual(expect.arrayContaining(V15_COLUMNS));

    // Idempotent: a second run must not throw on the duplicate columns.
    expect(migrateV15(db)).toEqual({ added: [] });
    db.close();
  });

  it('leaves existing links with no subject', () => {
    const db = new Database(':memory:');
    db.exec(V14_MEMORY_LINKS_DDL);
    db.prepare(
      `INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type, created_at)
       VALUES ('l1', 'mem-1', 'SQLite', 'MENTIONED', '1000')`,
    ).run();

    migrateV15(db);

    expect(
      db
        .prepare(
          'SELECT subject_entity, subject_entity_type, target_entity_type FROM memory_links WHERE id = ?',
        )
        .get('l1'),
    ).toEqual({ subject_entity: null, subject_entity_type: null, target_entity_type: null });
    db.close();
  });

  it('a migrated table has the same column set as a fresh one', () => {
    const migratedDb = new Database(':memory:');
    migratedDb.exec(V14_MEMORY_LINKS_DDL);
    migrateV15(migratedDb);

    const freshDb = new Database(':memory:');
    applySchema(freshDb);

    expect(columnNames(migratedDb, 'memory_links')).toEqual(columnNames(freshDb, 'memory_links'));
    expect(columnNames(freshDb, 'memory_links')).toEqual(expect.arrayContaining(V15_COLUMNS));

    migratedDb.close();
    freshDb.close();
  });

  it('does nothing on a fresh database, where applySchema declares the columns', () => {
    const db = new Database(':memory:');

    expect(migrateV15(db)).toEqual({ added: [] });
    applySchema(db);
    expect(columnNames(db, 'memory_links')).toEqual(expect.arrayContaining(V15_COLUMNS));
    db.close();
  });
});
