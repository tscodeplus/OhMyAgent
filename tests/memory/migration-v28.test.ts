/**
 * Migration v28: redact credentials already stored as memories.
 *
 * The properties worth testing are the ones a replay can break: a secret-bearing
 * row ends up masked, a masked row is left alone (so running it twice changes
 * nothing), ordinary prose is untouched, and a database without `memories` does
 * not throw.
 */

import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/memory/db';
import { migrateV28 } from '../../src/memory/migration-v28';

const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJleGFtSWQiOiJleGFtLWlkLTEyMyIsInN1YiI6InUifQ.c2lnbmF0dXJlLWJ5dGVz';

function insertMemory(
  db: ReturnType<typeof openDatabase>,
  id: string,
  content: string,
  kind = 'preference',
): void {
  db.prepare(
    `INSERT INTO memories (id, scope, scope_key, kind, content, status, confidence)
     VALUES (?, 'user', 'u1', ?, ?, 'active', 1)`,
  ).run(id, kind, content);
}

describe('migration v28', () => {
  it('masks the credential and keeps the sentence around it', () => {
    const db = openDatabase(':memory:');
    try {
      insertMemory(
        db,
        'mem-api-key',
        '用户使用API密钥sk-G373KTHTGrMYgwp7mUTQxRt25Tb5DL2yMKs10etTrKemLJAx进行查询',
      );
      insertMemory(db, 'mem-jwt', `Clawvard exam token saved: ${JWT}`);
      insertMemory(db, 'mem-plain', '用户偏好简短回答');

      const result = migrateV28(db);

      expect(result.redacted).toBe(2);
      const read = (id: string) =>
        (db.prepare('SELECT content FROM memories WHERE id = ?').get(id) as { content: string })
          .content;
      expect(read('mem-api-key')).toContain('[secret:api-key]');
      expect(read('mem-api-key')).not.toContain('sk-G373');
      expect(read('mem-jwt')).toBe('Clawvard exam token saved: [secret:jwt]');
      expect(read('mem-plain')).toBe('用户偏好简短回答');
    } finally {
      db.close();
    }
  });

  it('is a no-op on the second run, which is what makes it replayable', () => {
    const db = openDatabase(':memory:');
    try {
      insertMemory(db, 'mem-1', `token ${JWT}`);
      expect(migrateV28(db).redacted).toBe(1);
      const second = migrateV28(db);
      expect(second.redacted).toBe(0);
    } finally {
      db.close();
    }
  });

  it('re-indexes the row so the index holds the masked text', () => {
    const db = openDatabase(':memory:');
    try {
      insertMemory(
        db,
        'mem-1',
        '用户使用API密钥sk-G373KTHTGrMYgwp7mUTQxRt25Tb5DL2yMKs10etTrKemLJAx进行查询',
      );
      migrateV28(db);
      // `memories_fts` (unicode61) follows the row through SQL triggers, but
      // `memories_fts_jieba` is written explicitly — and an index that keeps the
      // secret is the same leak by another door.
      const indexed = db
        .prepare('SELECT content_original FROM memories_fts_jieba WHERE memory_id = ?')
        .get('mem-1') as { content_original: string } | undefined;
      expect(indexed).toBeDefined();
      expect(indexed!.content_original).toContain('[secret:api-key]');
      expect(indexed!.content_original).not.toContain('sk-G373');
      const triggerIndexed = db
        .prepare(
          'SELECT content FROM memories_fts WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)',
        )
        .get('mem-1') as { content: string };
      expect(triggerIndexed.content).not.toContain('sk-G373');
    } finally {
      db.close();
    }
  });

  it('does not throw on a database without the memories table', () => {
    const db = openDatabase(':memory:');
    try {
      db.exec('DROP TABLE memories');
      expect(migrateV28(db)).toEqual({ scanned: 0, redacted: 0, kinds: [] });
    } finally {
      db.close();
    }
  });
});
