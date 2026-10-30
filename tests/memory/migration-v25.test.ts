/**
 * Migration v25: `knowledge_log.note`.
 *
 * The reviewer's own words go beside the reason code rather than into it, so the
 * column has to exist for `archiveKnowledgePage`'s note to land anywhere. The two
 * things worth pinning are the ones a replaying migration gets wrong: it must be
 * a no-op on the second open (it runs on *every* open, not once per version bump),
 * and it must not blow up a database that has not reached v14 — where the log
 * table does not exist at all.
 */

import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/memory/db.js';
import { migrateV25 } from '../../src/memory/migration-v25.js';

function columns(db: ReturnType<typeof openDatabase>, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

describe('migration v25', () => {
  it('adds knowledge_log.note and keeps the existing rows readable', () => {
    const db = openDatabase(':memory:');
    try {
      // `openDatabase` already ran every migration, so the column exists; drop it
      // to model a database upgraded from v24 and prove the ALTER is guarded by
      // inspection rather than by luck.
      db.exec('ALTER TABLE knowledge_log DROP COLUMN note');
      expect(columns(db, 'knowledge_log')).not.toContain('note');

      const result = migrateV25(db);
      expect(result.added).toEqual(['knowledge_log.note']);
      expect(columns(db, 'knowledge_log')).toContain('note');

      // A row written before the column existed reads back as NULL, not undefined.
      db.prepare(
        `INSERT INTO knowledge_log (id, page_id, action, actor, version, reason, created_at)
         VALUES ('log-1', NULL, 'create', 'agent', 1, 'status: pending -> active', 1)`,
      ).run();
      const row = db.prepare(`SELECT note FROM knowledge_log WHERE id = 'log-1'`).get() as {
        note: string | null;
      };
      expect(row.note).toBeNull();
    } finally {
      db.close();
    }
  });

  it('is a no-op on a second run', () => {
    const db = openDatabase(':memory:');
    try {
      const second = migrateV25(db);
      expect(second.added).toEqual([]);
      // The index statement is `IF NOT EXISTS`, so it reports nothing new either.
      expect(columns(db, 'knowledge_log')).toContain('note');
    } finally {
      db.close();
    }
  });

  it('does nothing on a database without the log table', () => {
    const db = openDatabase(':memory:');
    try {
      db.exec('DROP TABLE knowledge_log');
      expect(() => migrateV25(db)).not.toThrow();
      expect(migrateV25(db).added).toEqual([]);
    } finally {
      db.close();
    }
  });
});
