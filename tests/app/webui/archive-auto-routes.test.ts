/**
 * Auto-archive endpoints (archive-routes.ts: /api/archive/auto/*).
 *
 * These exist so the settings switch can state the blast radius before it is
 * saved. The one thing they must never do is disagree with the maintenance job,
 * which is why the preview runs the repository's own eligibility query instead of
 * re-deriving "older than N days" in the route.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../../src/memory/db';
import { registerArchiveRoutes } from '../../../src/app/webui/archive-routes';
import type { ArchiveAutoSettings } from '../../../src/app/webui/archive-routes';

const DAY = 86_400_000;

describe('archive auto routes', () => {
  let db: Database.Database;
  let app: ReturnType<typeof Fastify>;
  let autoConfig: ArchiveAutoSettings | undefined;
  let running: Set<string>;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    autoConfig = undefined;
    running = new Set();
    app = Fastify({ logger: false });
    db.prepare(
      "INSERT INTO projects (id, name, agent_id) VALUES ('proj-1', 'OMA', 'default')",
    ).run();
    registerArchiveRoutes(app, db, undefined, {
      getAutoConfig: () => autoConfig,
      isRunning: (id) => running.has(id),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  function seedSession(id: string, ageDays: number, projectId: string | null = 'proj-1'): void {
    const when = String(Date.now() - ageDays * DAY);
    db.prepare(
      `INSERT INTO sessions
         (id, chat_id, user_id, project_id, channel, external_chat_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      id,
      projectId ? 'webui-user' : 'unknown',
      projectId,
      projectId ? null : 'feishu',
      id,
      when,
      when,
    );
  }

  function archivedIds(): string[] {
    return (
      db
        .prepare('SELECT id FROM sessions WHERE archived_at IS NOT NULL ORDER BY id')
        .all() as Array<{
        id: string;
      }>
    ).map((row) => row.id);
  }

  it('counts eligible conversations with the configured threshold', async () => {
    seedSession('old', 45);
    seedSession('inbox-old', 60, null);
    seedSession('fresh', 3);
    autoConfig = { enabled: false, days: 30 };

    const body = (await app.inject({ method: 'GET', url: '/api/archive/auto/preview' })).json();
    expect(body).toMatchObject({ days: 30, enabled: false, count: 2 });
    expect(typeof body.cutoff).toBe('number');
  });

  it('honours an unsaved days value from the form', async () => {
    seedSession('ten', 10);
    seedSession('eighty', 80);
    autoConfig = { enabled: true, days: 90 };

    expect(
      (await app.inject({ method: 'GET', url: '/api/archive/auto/preview?days=7' })).json().count,
    ).toBe(2);
    expect(
      (await app.inject({ method: 'GET', url: '/api/archive/auto/preview?days=30' })).json().count,
    ).toBe(1);
  });

  it('falls back to the stored threshold for an unparsable days value', async () => {
    autoConfig = { enabled: true, days: 14 };
    const body = (
      await app.inject({ method: 'GET', url: '/api/archive/auto/preview?days=abc' })
    ).json();
    expect(body.days).toBe(14);
  });

  it('refuses to run while the feature is disabled', async () => {
    seedSession('old', 45);
    autoConfig = { enabled: false, days: 30 };

    const res = await app.inject({ method: 'POST', url: '/api/archive/auto/run' });
    expect(res.statusCode).toBe(409);
    expect(archivedIds()).toEqual([]);
  });

  it('clears a backlog larger than one batch in a single call', async () => {
    // 620 > the 500-row batch: one click must finish the queue, not move a page
    // and leave the operator clicking again.
    for (let i = 0; i < 620; i += 1) seedSession(`old-${i}`, 45);
    autoConfig = { enabled: true, days: 30 };

    const body = (await app.inject({ method: 'POST', url: '/api/archive/auto/run' })).json();
    expect(body).toMatchObject({ archived: 620, remaining: 0, truncated: false });
    expect(body.batches).toBe(2);
  });

  it('returns instead of spinning when every candidate is mid-reply', async () => {
    seedSession('busy-1', 45);
    seedSession('busy-2', 45);
    running.add('busy-1');
    running.add('busy-2');
    autoConfig = { enabled: true, days: 30 };

    const body = (await app.inject({ method: 'POST', url: '/api/archive/auto/run' })).json();
    expect(body).toMatchObject({ archived: 0, remaining: 2, skippedRunning: 2, truncated: false });
    expect(archivedIds()).toEqual([]);
  });

  it('archives the eligible rows and reports what is left', async () => {
    seedSession('old', 45);
    seedSession('inbox-old', 60, null);
    seedSession('fresh', 1);
    autoConfig = { enabled: true, days: 30 };

    const body = (await app.inject({ method: 'POST', url: '/api/archive/auto/run' })).json();
    expect(body).toMatchObject({ ok: true, archived: 2, days: 30, remaining: 0, truncated: false });
    expect(archivedIds()).toEqual(['inbox-old', 'old']);
  });

  it('never archives a conversation that is answering right now', async () => {
    seedSession('busy', 90);
    seedSession('idle', 90);
    running.add('busy');
    autoConfig = { enabled: true, days: 30 };

    const body = (await app.inject({ method: 'POST', url: '/api/archive/auto/run' })).json();
    expect(body.archived).toBe(1);
    expect(archivedIds()).toEqual(['idle']);
  });

  it('does not sweep a conversation the operator just restored by hand', async () => {
    // Old enough to be auto-archived, then archived and restored by hand: the next
    // sweep must leave it alone instead of bouncing it back into 归档.
    seedSession('old', 200);
    autoConfig = { enabled: true, days: 30 };
    await app.inject({
      method: 'POST',
      url: '/api/archive',
      payload: { ids: ['old'], archived: true },
    });
    await app.inject({
      method: 'POST',
      url: '/api/archive',
      payload: { ids: ['old'], archived: false },
    });

    const preview = (await app.inject({ method: 'GET', url: '/api/archive/auto/preview' })).json();
    expect(preview.count).toBe(0);

    const run = (await app.inject({ method: 'POST', url: '/api/archive/auto/run' })).json();
    expect(run.archived).toBe(0);
    expect(archivedIds()).toEqual([]);
  });

  it('lets a restored conversation age back into eligibility', async () => {
    seedSession('old', 200);
    autoConfig = { enabled: true, days: 30 };
    await app.inject({
      method: 'POST',
      url: '/api/archive',
      payload: { ids: ['old'], archived: true },
    });
    await app.inject({
      method: 'POST',
      url: '/api/archive',
      payload: { ids: ['old'], archived: false },
    });

    // Exemption is one inactivity window, not a permanent shield: push it into the
    // past and the conversation is eligible again.
    db.prepare('UPDATE sessions SET archive_exempt_until = ? WHERE id = ?').run(
      String(Date.now() - 31 * DAY),
      'old',
    );

    const run = (await app.inject({ method: 'POST', url: '/api/archive/auto/run' })).json();
    expect(run.archived).toBe(1);
    expect(archivedIds()).toEqual(['old']);
  });

  it('leaves the count at zero once the backlog is archived', async () => {
    seedSession('old', 45);
    autoConfig = { enabled: true, days: 30 };

    await app.inject({ method: 'POST', url: '/api/archive/auto/run' });
    const preview = (await app.inject({ method: 'GET', url: '/api/archive/auto/preview' })).json();
    // Already-archived rows are excluded, so the preview reflects a drained queue
    // instead of offering to archive them again.
    expect(preview.count).toBe(0);
  });
});
