/**
 * `POST /api/projects/ensure-default` carries the sidebar's first page.
 *
 * The WebUI cannot list a project's chats before it knows the project, so the
 * sidebar's first page used to cost a second round trip after the bootstrap —
 * and behind a Cloudflare Tunnel a round trip is about a second. The bootstrap
 * therefore ships the page it already had to read, and the list renders it.
 * These tests pin both halves: the page rides along when a lister is wired, and
 * an older caller (no lister) still gets the bare `{ project, created }` answer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../../src/memory/db';
import { ProjectStore } from '../../../src/app/webui/project-store';
import { registerProjectRoutes } from '../../../src/app/webui/project-routes';

describe('POST /api/projects/ensure-default', () => {
  let db: Database.Database;
  let app: ReturnType<typeof Fastify>;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(async () => {
    await app?.close();
    db.close();
  });

  async function build(
    listSessions?: (projectId: string) => {
      items: Array<Record<string, unknown>>;
      hasMore: boolean;
    },
  ): Promise<void> {
    app = Fastify({ logger: false });
    registerProjectRoutes(app, new ProjectStore(db), listSessions ? { listSessions } : {});
    await app.ready();
  }

  it('returns the project and its first chat page', async () => {
    const page = {
      items: [{ id: 's1', project_id: 'p1', title: 'hello' }],
      hasMore: false,
    };
    let asked: string | undefined;
    await build((projectId) => {
      asked = projectId;
      return page;
    });

    const res = await app.inject({ method: 'POST', url: '/api/projects/ensure-default' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { project: { id: string }; created: boolean; sessions: unknown };
    expect(body.created).toBe(true);
    expect(body.sessions).toEqual(page);
    // The page belongs to the project that was just ensured, not to a guess.
    expect(asked).toBe(body.project.id);
  });

  it('omits the page when no lister is wired', async () => {
    await build();

    const res = await app.inject({ method: 'POST', url: '/api/projects/ensure-default' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('sessions');
  });

  it('is idempotent: a second call keeps the same project and re-reads its page', async () => {
    let calls = 0;
    await build(() => {
      calls += 1;
      return { items: [], hasMore: false };
    });

    const first = (
      await app.inject({ method: 'POST', url: '/api/projects/ensure-default' })
    ).json();
    const second = (
      await app.inject({
        method: 'POST',
        url: '/api/projects/ensure-default',
      })
    ).json();

    expect(second.project.id).toBe(first.project.id);
    expect(second.created).toBe(false);
    expect(calls).toBe(2);
  });
});
