/**
 * Paged reads of a project's own chats and of one transcript.
 *
 * Both are ordered by "last activity" (`updated_at`) and read newest first, and
 * both use the `(timestamp, id)` cursor. The timestamp alone is not a key: a
 * batch write (`setArchived`) stamps several rows with one `Date.now()`, and a
 * turn can persist several messages inside one millisecond. A cursor that
 * compares only the timestamp therefore loses every sibling of the row at a page
 * boundary — which is the bug these tests pin, in both directions: `beforeId`
 * walks the whole group, `before` alone does not.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../../src/memory/db';
import { registerSessionRoutes } from '../../../src/app/webui/session-routes';

describe('project session list paging', () => {
  let db: Database.Database;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    app = Fastify({ logger: false });
    registerSessionRoutes(app, db);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  function seedSession(
    id: string,
    options: { projectId?: string; updatedAt?: number; archived?: boolean } = {},
  ): void {
    db.prepare(
      `INSERT INTO sessions (id, chat_id, user_id, project_id, title, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      `webui:${options.projectId ?? 'proj-1'}`,
      'webui-user',
      options.projectId ?? 'proj-1',
      id,
      options.archived ? '999' : null,
      String(options.updatedAt ?? 1000),
      String(options.updatedAt ?? 1000),
    );
  }

  function seedMessage(id: string, sessionId: string, createdAt: number, content: string): void {
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at)
       VALUES (?, ?, 'user', ?, ?)`,
    ).run(id, sessionId, content, String(createdAt));
  }

  const ids = (body: { items: Array<{ id: string }> }) => body.items.map((row) => row.id);

  it('pages newest activity first', async () => {
    seedSession('a', { updatedAt: 1000 });
    seedSession('b', { updatedAt: 2000 });
    seedSession('c', { updatedAt: 3000 });

    const first = (
      await app.inject({ method: 'GET', url: '/api/projects/proj-1/sessions?limit=2' })
    ).json();
    expect(ids(first)).toEqual(['c', 'b']);
    expect(first.hasMore).toBe(true);

    const next = (
      await app.inject({
        method: 'GET',
        url: `/api/projects/proj-1/sessions?limit=2&before=${first.items[1].updated_at}&beforeId=${first.items[1].id}`,
      })
    ).json();
    expect(ids(next)).toEqual(['a']);
    expect(next.hasMore).toBe(false);
  });

  it('keeps rows that share the cursor timestamp reachable', async () => {
    // Same millisecond for all three: the group the old cursor could not finish.
    seedSession('a', { updatedAt: 5000 });
    seedSession('b', { updatedAt: 5000 });
    seedSession('c', { updatedAt: 5000 });

    const first = (
      await app.inject({ method: 'GET', url: '/api/projects/proj-1/sessions?limit=2' })
    ).json();
    expect(ids(first)).toEqual(['c', 'b']);
    expect(first.hasMore).toBe(true);

    const cursorRow = first.items[1];
    const next = (
      await app.inject({
        method: 'GET',
        url: `/api/projects/proj-1/sessions?limit=2&before=${cursorRow.updated_at}&beforeId=${cursorRow.id}`,
      })
    ).json();
    expect(ids(next)).toEqual(['a']);
    expect(next.hasMore).toBe(false);

    // Timestamp alone: the rest of the tie group is unreachable. That endpoint
    // still accepts the old shape, which is why the WebUI sends both values.
    const legacy = (
      await app.inject({
        method: 'GET',
        url: `/api/projects/proj-1/sessions?limit=2&before=${cursorRow.updated_at}`,
      })
    ).json();
    expect(legacy.items).toEqual([]);
  });

  it('resolves one session by id, archived included', async () => {
    seedSession('open', { updatedAt: 2000 });
    seedSession('put-away', { updatedAt: 1000, archived: true });

    // Archived rows stay out of the list...
    const listed = (
      await app.inject({ method: 'GET', url: '/api/projects/proj-1/sessions' })
    ).json();
    expect(ids(listed)).toEqual(['open']);

    // ...but a caller that already knows the id (the desktop caption) can still
    // resolve it: a page of 50 cannot be counted on to contain that row.
    const looked = (
      await app.inject({
        method: 'GET',
        url: '/api/projects/proj-1/sessions?id=put-away&includeArchived=1',
      })
    ).json();
    expect(ids(looked)).toEqual(['put-away']);
    expect(looked.hasMore).toBe(false);
  });

  it('does not leak another project’s sessions into a page', async () => {
    seedSession('mine', { updatedAt: 2000 });
    seedSession('theirs', { projectId: 'proj-2', updatedAt: 3000 });

    const body = (await app.inject({ method: 'GET', url: '/api/projects/proj-1/sessions' })).json();
    expect(ids(body)).toEqual(['mine']);
  });

  it('pages a transcript that shares one millisecond', async () => {
    seedSession('s1', { updatedAt: 2000 });
    seedMessage('m1', 's1', 1000, 'first');
    seedMessage('m2', 's1', 1000, 'second');
    seedMessage('m3', 's1', 1000, 'third');

    const first = (
      await app.inject({ method: 'GET', url: '/api/projects/proj-1/sessions/s1?limit=2' })
    ).json();
    // Newest-last: the tail is returned, oldest first.
    expect(first.messages.map((m: { content: string }) => m.content)).toEqual(['second', 'third']);
    expect(first.hasMore).toBe(true);

    const oldest = first.messages[0];
    const next = (
      await app.inject({
        method: 'GET',
        url: `/api/projects/proj-1/sessions/s1?limit=2&before=${oldest.created_at}&beforeId=${oldest.id}`,
      })
    ).json();
    expect(next.messages.map((m: { content: string }) => m.content)).toEqual(['first']);
    expect(next.hasMore).toBe(false);
  });
});
