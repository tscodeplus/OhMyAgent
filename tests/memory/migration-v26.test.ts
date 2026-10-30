/**
 * Migration v26: the index on `memory_links.subject_entity`.
 *
 * The migration is a replayed `CREATE INDEX IF NOT EXISTS`, so the only properties
 * worth testing are the ones a replay can break: it exists afterwards, running it
 * twice changes nothing, and a database that predates `memory_links` does not throw.
 */

import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/memory/db';
import { migrateV26 } from '../../src/memory/migration-v26';

function indexNames(db: ReturnType<typeof openDatabase>, table: string): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
    .all(table) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe('migration v26', () => {
  it('indexes the subject half of every "which memories name X" query', () => {
    const db = openDatabase(':memory:');
    try {
      expect(indexNames(db, 'memory_links')).toContain('idx_memory_links_subject');
      // Both halves of the OR are indexed, which is what turns the plan's
      // `SCAN ml` into a MULTI-INDEX OR. Asserting the plan rather than the name
      // because the name is the mechanism, the plan is the point.
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT COUNT(*) FROM memory_links
            WHERE target_entity = 'Alice' OR subject_entity = 'Alice'`,
        )
        .all() as Array<{ detail: string }>;
      const details = plan.map((row) => row.detail).join(' | ');
      expect(details).toMatch(/MULTI-INDEX OR/);
      expect(details).not.toMatch(/SCAN ml\b/);
    } finally {
      db.close();
    }
  });

  it('is idempotent across re-runs', () => {
    const db = openDatabase(':memory:');
    try {
      const before = indexNames(db, 'memory_links').sort();
      const result = migrateV26(db);
      expect(result.createdIndexes).toEqual(['idx_memory_links_subject']);
      expect(indexNames(db, 'memory_links').sort()).toEqual(before);
      expect(migrateV26(db)).toEqual({ createdIndexes: ['idx_memory_links_subject'] });
    } finally {
      db.close();
    }
  });

  it('does nothing on a database without a link table', () => {
    const db = openDatabase(':memory:');
    try {
      db.exec('DROP TABLE memory_links');
      expect(migrateV26(db)).toEqual({ createdIndexes: [] });
    } finally {
      db.close();
    }
  });
});
