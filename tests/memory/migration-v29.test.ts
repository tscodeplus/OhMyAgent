/**
 * Migration v29: one active session summary per session.
 *
 * What a replay can break is what is worth testing — a session with two summaries
 * ends up with one, the newest survives, the chain is readable, another kind or
 * another session is untouched, and a second run changes nothing.
 */

import { describe, it, expect } from 'vitest';
import { openDatabase } from '../../src/memory/db';
import { migrateV29 } from '../../src/memory/migration-v29';

function insertMemory(
  db: ReturnType<typeof openDatabase>,
  id: string,
  input: { content: string; scope?: string; scopeKey?: string; kind?: string },
): void {
  db.prepare(
    `INSERT INTO memories (id, scope, scope_key, kind, content, status, confidence)
     VALUES (?, ?, ?, ?, ?, 'active', 1)`,
  ).run(
    id,
    input.scope ?? 'session',
    input.scopeKey ?? 'sess-1',
    input.kind ?? 'summary',
    input.content,
  );
}

function status(db: ReturnType<typeof openDatabase>, id: string) {
  return db.prepare('SELECT status, supersedes_id FROM memories WHERE id = ?').get(id) as {
    status: string;
    supersedes_id: string | null;
  };
}

describe('migration v29', () => {
  it('keeps the newest summary and closes the older ones', () => {
    const db = openDatabase(':memory:');
    try {
      insertMemory(db, 'sum-old', { content: '摘要：旧的监控结果' });
      insertMemory(db, 'sum-new', { content: '摘要：新的监控结果，覆盖旧摘要' });

      const result = migrateV29(db);

      expect(result.sessions).toBe(1);
      expect(result.superseded).toBe(1);
      expect(status(db, 'sum-old').status).toBe('superseded');
      expect(status(db, 'sum-new').status).toBe('active');
      // The chain lives on the survivor (`supersedes_id` = the row it replaced).
      expect(status(db, 'sum-new').supersedes_id).toBe('sum-old');
    } finally {
      db.close();
    }
  });

  it('leaves other kinds, other scopes and other sessions alone', () => {
    const db = openDatabase(':memory:');
    try {
      insertMemory(db, 'sum-a', { content: '摘要 A' });
      insertMemory(db, 'sum-b', { content: '摘要 B' });
      insertMemory(db, 'pref', { content: '偏好：简短回答', kind: 'preference' });
      insertMemory(db, 'user-scope', { content: '用户级摘要', scope: 'user', kind: 'summary' });
      insertMemory(db, 'other-session', { content: '另一个会话的摘要', scopeKey: 'sess-2' });

      migrateV29(db);

      expect(status(db, 'pref').status).toBe('active');
      expect(status(db, 'user-scope').status).toBe('active');
      expect(status(db, 'other-session').status).toBe('active');
      // Two summaries in sess-1 → the newer survives.
      expect(status(db, 'sum-a').status).toBe('superseded');
      expect(status(db, 'sum-b').status).toBe('active');
    } finally {
      db.close();
    }
  });

  it('is a no-op on the second run', () => {
    const db = openDatabase(':memory:');
    try {
      insertMemory(db, 'sum-old', { content: '摘要：旧' });
      insertMemory(db, 'sum-new', { content: '摘要：新' });
      expect(migrateV29(db).superseded).toBe(1);
      expect(migrateV29(db)).toEqual({ sessions: 0, superseded: 0 });
    } finally {
      db.close();
    }
  });

  it('does not throw on a database without the memories table', () => {
    const db = openDatabase(':memory:');
    try {
      db.exec('DROP TABLE memories');
      expect(migrateV29(db)).toEqual({ sessions: 0, superseded: 0 });
    } finally {
      db.close();
    }
  });
});
