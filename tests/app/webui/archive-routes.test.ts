/**
 * Archive API (archive-routes.ts).
 *
 * The contract the WebUI depends on:
 *   GET  /api/archive      — both trees, ordered by last activity, grouped by
 *                            the owner each row had BEFORE archiving
 *   POST /api/archive      — batch archive / restore of ids from either tree
 *   GET  /api/inbox        — archived conversations are gone from it
 *   GET  /api/projects/:p/sessions — same, for project chats
 *
 * The feature is a WebUI list-visibility flag only: memory, search and IM
 * delivery are untouched, so nothing here asserts on those.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../../src/memory/db';
import { registerArchiveRoutes } from '../../../src/app/webui/archive-routes';
import { registerInboxRoutes } from '../../../src/app/webui/inbox-routes';
import { registerSessionRoutes } from '../../../src/app/webui/session-routes';

interface Seed {
  id: string;
  chat_id?: string;
  channel?: string | null;
  title?: string | null;
  project_id?: string | null;
  updated_at?: number;
}

describe('archive routes', () => {
  let db: Database.Database;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    app = Fastify({ logger: false });
    registerInboxRoutes(app, db);
    registerSessionRoutes(app, db);
    // A bot name per channel, so the group label can be asserted: the archive
    // must reuse the inbox's label, not invent its own.
    registerArchiveRoutes(app, db, (channel) => (channel === 'feishu' ? '小书' : undefined));
    await app.ready();

    db.prepare(
      "INSERT INTO projects (id, name, agent_id) VALUES ('proj-1', 'OMA 开发', 'default')",
    ).run();
    db.prepare(
      "INSERT INTO projects (id, name, agent_id) VALUES ('proj-2', '文档站', 'default')",
    ).run();
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

  async function archive(ids: string[], archived = true) {
    return app.inject({ method: 'POST', url: '/api/archive', payload: { ids, archived } });
  }

  it('starts empty rather than 404ing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/archive' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], hasMore: false, owners: [] });
  });

  it('archives a batch across both trees and returns the pre-archive owner', async () => {
    seedSession({ id: 'p1', project_id: 'proj-1', title: '上下文压缩', updated_at: 1000 });
    seedSession({ id: 'p2', project_id: 'proj-2', title: 'README 重写', updated_at: 2000 });
    seedSession({ id: 'oc_1', channel: 'feishu', title: '公众号文案', updated_at: 3000 });
    seedSession({ id: 'tg_1', channel: 'telegram', title: '临时问询', updated_at: 4000 });

    const res = await archive(['p1', 'oc_1']);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, updated: 2 });

    const body = (await app.inject({ method: 'GET', url: '/api/archive' })).json();
    expect(body.items).toHaveLength(2);

    const inboxRow = body.items.find((row: { id: string }) => row.id === 'oc_1');
    expect(inboxRow).toMatchObject({
      kind: 'inbox',
      project_id: null,
      channel: 'feishu',
      title: '公众号文案',
      message_count: 0,
      preview: '',
    });
    const projectRow = body.items.find((row: { id: string }) => row.id === 'p1');
    expect(projectRow).toMatchObject({
      kind: 'project',
      project_id: 'proj-1',
      project_name: 'OMA 开发',
      channel: null,
    });

    // Owners carry the grouping label, and the channel one carries the bot name
    // the inbox would have shown.
    expect(body.owners).toEqual(
      expect.arrayContaining([
        {
          kind: 'project',
          project_id: 'proj-1',
          project_name: 'OMA 开发',
          channel: null,
          count: 1,
        },
        {
          kind: 'inbox',
          project_id: null,
          project_name: null,
          channel: 'feishu',
          count: 1,
          bot_name: '小书',
        },
      ]),
    );
  });

  it('removes archived rows from the inbox and from the project session list', async () => {
    seedSession({ id: 'p1', project_id: 'proj-1', title: 'a', updated_at: 1000 });
    seedSession({ id: 'p2', project_id: 'proj-1', title: 'b', updated_at: 2000 });
    seedSession({ id: 'oc_1', channel: 'feishu', updated_at: 3000 });

    await archive(['p1', 'oc_1']);

    const inbox = (await app.inject({ method: 'GET', url: '/api/inbox' })).json();
    expect(inbox.items).toHaveLength(0);
    // The channel badge count follows the list, otherwise the header would show
    // a group with no rows under it.
    expect(inbox.channels).toEqual([]);

    const sessions = (
      await app.inject({ method: 'GET', url: '/api/projects/proj-1/sessions' })
    ).json();
    expect(sessions.items.map((s: { id: string }) => s.id)).toEqual(['p2']);

    // The transcript itself stays readable: archiving is not deletion.
    const detail = await app.inject({ method: 'GET', url: '/api/projects/proj-1/sessions/p1' });
    expect(detail.statusCode).toBe(200);
    const imDetail = await app.inject({ method: 'GET', url: '/api/inbox/oc_1/messages' });
    expect(imDetail.statusCode).toBe(200);
  });

  it('restores rows back into their own list', async () => {
    seedSession({ id: 'p1', project_id: 'proj-1', title: 'a', updated_at: 1000 });
    seedSession({ id: 'oc_1', channel: 'feishu', updated_at: 3000 });
    await archive(['p1', 'oc_1']);

    const res = await archive(['p1', 'oc_1'], false);
    expect(res.json()).toEqual({ ok: true, updated: 2 });

    expect((await app.inject({ method: 'GET', url: '/api/archive' })).json().items).toEqual([]);
    expect(
      (await app.inject({ method: 'GET', url: '/api/projects/proj-1/sessions' })).json().items,
    ).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/inbox' })).json().items).toHaveLength(1);
  });

  it('treats a redundant archive/restore as a no-op instead of an error', async () => {
    seedSession({ id: 'p1', project_id: 'proj-1', updated_at: 1000 });
    await archive(['p1']);
    // Another device already moved it: the batch still succeeds, 0 rows changed.
    expect((await archive(['p1'])).json()).toEqual({ ok: true, updated: 0 });
    expect((await archive(['missing-id'])).json()).toEqual({ ok: true, updated: 0 });
  });

  it('orders by last activity and pages on an exclusive cursor', async () => {
    seedSession({ id: 'a', project_id: 'proj-1', updated_at: 1000 });
    seedSession({ id: 'b', project_id: 'proj-1', updated_at: 2000 });
    seedSession({ id: 'c', project_id: 'proj-1', updated_at: 3000 });
    await archive(['a', 'b', 'c']);
    // Archive instants deliberately the *opposite* of activity order, so an
    // ordering by archive time could not produce the expected page.
    db.prepare("UPDATE sessions SET archived_at = '300' WHERE id = 'a'").run();
    db.prepare("UPDATE sessions SET archived_at = '200' WHERE id = 'b'").run();
    db.prepare("UPDATE sessions SET archived_at = '100' WHERE id = 'c'").run();

    const first = (await app.inject({ method: 'GET', url: '/api/archive?limit=2' })).json();
    expect(first.items.map((i: { id: string }) => i.id)).toEqual(['c', 'b']);
    expect(first.items.map((i: { updated_at: number }) => i.updated_at)).toEqual([3000, 2000]);
    expect(first.hasMore).toBe(true);
    // `owners` counts the whole archive, not the page.
    expect(first.owners).toEqual([
      { kind: 'project', project_id: 'proj-1', project_name: 'OMA 开发', channel: null, count: 3 },
    ]);

    const next = (
      await app.inject({
        method: 'GET',
        url: `/api/archive?limit=2&before=${first.items[1].updated_at}&beforeId=${first.items[1].id}`,
      })
    ).json();
    expect(next.items.map((i: { id: string }) => i.id)).toEqual(['a']);
    expect(next.hasMore).toBe(false);
  });

  it('keeps rows that share the cursor timestamp reachable', async () => {
    // `setArchived` stamps a whole batch with one `Date.now()`, so a page
    // boundary inside such a group is the normal case, not an edge case.
    seedSession({ id: 'a', project_id: 'proj-1', updated_at: 5000 });
    seedSession({ id: 'b', project_id: 'proj-1', updated_at: 5000 });
    seedSession({ id: 'c', project_id: 'proj-1', updated_at: 5000 });
    await archive(['a', 'b', 'c']);

    const first = (await app.inject({ method: 'GET', url: '/api/archive?limit=2' })).json();
    expect(first.items.map((i: { id: string }) => i.id)).toEqual(['c', 'b']);
    expect(first.hasMore).toBe(true);

    const cursorRow = first.items[1];
    const next = (
      await app.inject({
        method: 'GET',
        url: `/api/archive?limit=2&before=${cursorRow.updated_at}&beforeId=${cursorRow.id}`,
      })
    ).json();
    expect(next.items.map((i: { id: string }) => i.id)).toEqual(['a']);
    expect(next.hasMore).toBe(false);

    // Timestamp alone: the rest of the tie group is unreachable. This endpoint
    // still accepts the old cursor shape, which is exactly why the UI sends both.
    const legacy = (
      await app.inject({
        method: 'GET',
        url: `/api/archive?limit=2&before=${cursorRow.updated_at}`,
      })
    ).json();
    expect(legacy.items).toEqual([]);
  });

  it('narrows to one tree with `kind`', async () => {
    seedSession({ id: 'p1', project_id: 'proj-1', updated_at: 1000 });
    seedSession({ id: 'oc_1', channel: 'feishu', updated_at: 2000 });
    await archive(['p1', 'oc_1']);

    expect(
      (await app.inject({ method: 'GET', url: '/api/archive?kind=project' }))
        .json()
        .items.map((i: { id: string }) => i.id),
    ).toEqual(['p1']);
    expect(
      (await app.inject({ method: 'GET', url: '/api/archive?kind=inbox' }))
        .json()
        .items.map((i: { id: string }) => i.id),
    ).toEqual(['oc_1']);
    expect((await app.inject({ method: 'GET', url: '/api/archive?kind=nope' })).statusCode).toBe(
      400,
    );
  });

  it('rejects malformed batch payloads', async () => {
    expect(
      (await app.inject({ method: 'POST', url: '/api/archive', payload: {} })).statusCode,
    ).toBe(400);
    expect((await archive([])).statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: '/api/archive', payload: { ids: ['a', 3] } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/archive',
          payload: { ids: ['a'], archived: 'yes' },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('can still resolve an archived title by id for the caption lookup', async () => {
    // The desktop caption asks for this list to find the open session's title;
    // without the opt-in an archived chat's caption would collapse to a generic
    // label while the transcript is open on screen.
    seedSession({ id: 'p1', project_id: 'proj-1', title: '上下文压缩', updated_at: 1000 });
    // The project list still reads the title out of metadata (v9 added the
    // column, the WebUI projection kept the old source), so seed both.
    db.prepare('UPDATE sessions SET metadata = ? WHERE id = ?').run(
      JSON.stringify({ title: '上下文压缩' }),
      'p1',
    );
    await archive(['p1']);

    expect(
      (await app.inject({ method: 'GET', url: '/api/projects/proj-1/sessions' })).json().items,
    ).toEqual([]);
    const withArchived = (
      await app.inject({ method: 'GET', url: '/api/projects/proj-1/sessions?includeArchived=1' })
    ).json();
    expect(withArchived.items.map((s: { id: string; title: string }) => [s.id, s.title])).toEqual([
      ['p1', '上下文压缩'],
    ]);
  });

  it('does not touch other rows when archiving one', async () => {
    seedSession({ id: 'p1', project_id: 'proj-1', updated_at: 1000 });
    seedSession({ id: 'p2', project_id: 'proj-1', updated_at: 2000 });
    await archive(['p1']);

    // Archiving must not reorder the list it leaves behind.
    expect(
      (await app.inject({ method: 'GET', url: '/api/projects/proj-1/sessions' }))
        .json()
        .items.map((s: { id: string; updated_at: number }) => [s.id, s.updated_at]),
    ).toEqual([['p2', 2000]]);
  });
});
