/**
 * Migration v30: undo v29's assumption that session summaries supersede.
 *
 * They are incremental windows (the summarizer only feeds messages since the last
 * episode), so the property to test is restoration: a closed summary comes back
 * `active`, its pointer is cleared, it is searchable again, and nothing else in
 * the table is touched.
 */

import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/memory/db';
import { migrateV30 } from '../../src/memory/migration-v30';

function insertSummary(
  db: ReturnType<typeof openDatabase>,
  id: string,
  content: string,
  status = 'superseded',
  kind = 'summary',
): void {
  db.prepare(
    `INSERT INTO memories (id, scope, scope_key, kind, content, status, confidence, supersedes_id, invalidated_at)
     VALUES (?, 'session', 'sess-1', ?, ?, ?, 1, 'newer-row', 123)`,
  ).run(id, kind, content, status);
}

describe('migration v30', () => {
  it('restores a closed incremental summary and clears its pointer', () => {
    const db = openDatabase(':memory:');
    try {
      insertSummary(db, 'sum-closed', '摘要：第四小时的监控结果');
      insertSummary(db, 'sum-other-session-kept', '摘要：仍在忙', 'active');

      const result = migrateV30(db);

      expect(result.restored).toBe(1);
      const row = db
        .prepare('SELECT status, supersedes_id, invalidated_at FROM memories WHERE id = ?')
        .get('sum-closed') as {
        status: string;
        supersedes_id: string | null;
        invalidated_at: number | null;
      };
      expect(row.status).toBe('active');
      expect(row.supersedes_id).toBeNull();
      expect(row.invalidated_at).toBeNull();
    } finally {
      db.close();
    }
  });

  it('re-indexes the restored row so it is searchable again', () => {
    const db = openDatabase(':memory:');
    try {
      insertSummary(db, 'sum-closed', '摘要：老板询问了乒乓球平台的部署进度');
      expect(
        db
          .prepare('SELECT COUNT(*) AS n FROM memories_fts_jieba WHERE memory_id = ?')
          .get('sum-closed'),
      ).toEqual({ n: 0 });

      migrateV30(db);

      expect(
        db
          .prepare('SELECT COUNT(*) AS n FROM memories_fts_jieba WHERE memory_id = ?')
          .get('sum-closed'),
      ).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it('leaves other kinds and scopes alone', () => {
    const db = openDatabase(':memory:');
    try {
      insertSummary(db, 'pref-closed', '偏好：简短回答', 'superseded', 'preference');
      insertSummary(db, 'deleted-summary', '摘要：用户删掉了', 'deleted');

      expect(migrateV30(db)).toEqual({ restored: 0 });
      const statuses = db.prepare('SELECT id, status FROM memories ORDER BY id').all() as Array<{
        id: string;
        status: string;
      }>;
      expect(statuses).toEqual([
        { id: 'deleted-summary', status: 'deleted' },
        { id: 'pref-closed', status: 'superseded' },
      ]);
    } finally {
      db.close();
    }
  });

  it('is a no-op on the second run and on a database without memories', () => {
    const db = openDatabase(':memory:');
    try {
      insertSummary(db, 'sum-closed', '摘要：一次窗口');
      expect(migrateV30(db).restored).toBe(1);
      expect(migrateV30(db)).toEqual({ restored: 0 });
      db.exec('DROP TABLE memories');
      expect(migrateV30(db)).toEqual({ restored: 0 });
    } finally {
      db.close();
    }
  });
});
