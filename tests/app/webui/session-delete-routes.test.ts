/**
 * Batch delete API (session-delete-routes.ts).
 *
 * One endpoint serves 删除 in all three sidebar lists, because a multi-select in
 * 归档 can hold both project chats and IM transcripts. What matters:
 *   - project chats and IM transcripts both disappear, with their messages;
 *   - a batch is partial by design: a row mid-reply or already gone is reported
 *     in `skipped`, it does not fail the other rows;
 *   - deleting the *current* IM transcript opens a replacement, so incoming
 *     messages cannot resume the conversation that was just removed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../../src/memory/db';
import { registerSessionDeleteRoutes } from '../../../src/app/webui/session-delete-routes';

interface Seed {
  id: string;
  chat_id?: string;
  channel?: string | null;
  title?: string | null;
  project_id?: string | null;
  updated_at?: number;
}

describe('batch session delete', () => {
  let db: Database.Database;
  let app: ReturnType<typeof Fastify>;
  let running: Set<string>;
  let destroyed: string[];

  beforeEach(async () => {
    db = openDatabase(':memory:');
    running = new Set();
    destroyed = [];
    app = Fastify({ logger: false });
    db.prepare(
      "INSERT INTO projects (id, name, agent_id) VALUES ('proj-1', 'OMA', 'default')",
    ).run();
    const server = app;
    registerSessionDeleteRoutes(server, db, {
      isRunning: (id) => running.has(id),
      destroyRuntime: (id) => destroyed.push(id),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  function seedSession(seed: Seed): void {
    db.prepare(
      `INSERT INTO sessions
         (id, chat_id, user_id, project_id, channel, external_chat_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      seed.id,
      seed.chat_id ?? seed.id,
      seed.project_id ? 'webui-user' : 'unknown',
      seed.project_id ?? null,
      seed.channel ?? null,
      seed.chat_id ?? seed.id,
      seed.title ?? null,
      String(seed.updated_at ?? 1000),
      String(seed.updated_at ?? 1000),
    );
  }

  function seedMessage(sessionId: string, id: string): void {
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at)
       VALUES (?, ?, 'user', 'hello', ?)`,
    ).run(id, sessionId, String(1000));
  }

  function sessionIds(): string[] {
    return (db.prepare('SELECT id FROM sessions ORDER BY id').all() as Array<{ id: string }>).map(
      (row) => row.id,
    );
  }

  function deleteBatch(ids: string[]) {
    return app.inject({ method: 'POST', url: '/api/sessions/delete', payload: { ids } });
  }

  it('rejects an empty or malformed id list', async () => {
    expect((await deleteBatch([])).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: '/api/sessions/delete', payload: { ids: 'x' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/sessions/delete',
          payload: { ids: [''] },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('deletes project chats and IM transcripts with their messages', async () => {
    seedSession({ id: 'p1', project_id: 'proj-1' });
    seedSession({ id: 'oc_1', channel: 'feishu' });
    seedMessage('p1', 'm1');
    seedMessage('oc_1', 'm2');

    const res = await deleteBatch(['p1', 'oc_1']);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, deleted: 2, skipped: [] });
    // The project chat is gone outright; the IM transcript is replaced by the
    // next generation of its slot (asserted separately) rather than left empty.
    const remaining = sessionIds();
    expect(remaining).not.toContain('p1');
    expect(remaining).not.toContain('oc_1');
    expect(remaining).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
    // Every deleted transcript loses its in-memory twin, or the next reply would
    // answer from history the operator just deleted.
    expect(destroyed.sort()).toEqual(['oc_1', 'p1']);
  });

  it('reports a skipped row instead of failing the batch', async () => {
    seedSession({ id: 'p1', project_id: 'proj-1' });
    seedSession({ id: 'p2', project_id: 'proj-1' });
    running.add('p2');

    const body = (await deleteBatch(['p1', 'p2', 'gone'])).json();
    expect(body.deleted).toBe(1);
    expect(body.skipped).toEqual(
      expect.arrayContaining([
        { id: 'p2', reason: 'running' },
        { id: 'gone', reason: 'not_found' },
      ]),
    );
    // The busy row survives, the idle one does not.
    expect(sessionIds()).toEqual(['p2']);
  });

  it('opens a replacement transcript when the deleted IM row is the current one', async () => {
    seedSession({ id: 'oc_1', chat_id: 'oc_1', channel: 'feishu' });

    const body = (await deleteBatch(['oc_1'])).json();
    expect(body.deleted).toBe(1);
    // A replacement keeps "current" moving forward: messages arriving for the
    // slot after the delete must not reopen the transcript that was removed.
    const replacement = body.replacements.oc_1;
    expect(typeof replacement).toBe('string');
    expect(replacement).not.toBe('oc_1');
    expect(sessionIds()).toEqual([replacement]);
  });

  it('deletes an archived row too — 归档 has no separate delete path', async () => {
    seedSession({ id: 'p1', project_id: 'proj-1' });
    db.prepare('UPDATE sessions SET archived_at = ? WHERE id = ?').run('2000', 'p1');

    const body = (await deleteBatch(['p1'])).json();
    expect(body.deleted).toBe(1);
    expect(sessionIds()).toEqual([]);
  });

  it('deletes an id listed twice only once', async () => {
    seedSession({ id: 'p1', project_id: 'proj-1' });

    const body = (await deleteBatch(['p1', 'p1'])).json();
    expect(body.deleted).toBe(1);
    expect(body.skipped).toEqual([]);
  });
});
