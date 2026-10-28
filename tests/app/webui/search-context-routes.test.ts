/**
 * Tests for `GET /api/search/context` — the conversation window behind one
 * search hit — and for the extra provenance fields `/api/search` now carries.
 *
 * The payoff being protected: a search snippet must be inspectable in place. If
 * this route silently degrades (no anchor, no session metadata, a window that
 * loses the hit), the WebUI panel shows an empty or misleading conversation and
 * the user has to re-find the message by hand.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../../src/memory/db';
import { registerGraphRoutes } from '../../../src/app/webui/graph-routes';
import { loadMessageContext } from '../../../src/app/webui/session-message-view';
import { MessageRepository } from '../../../src/memory/repositories/message-repository';

const SESSION = 'feishu:oc_demo';
/** Distinct, orderable timestamps — the window maths is purely comparative. */
const T0 = 1_790_000_000_000;
const step = (n: number) => T0 + n * 1000;

describe('search context route', () => {
  let db: Database.Database;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    seed();
    app = Fastify({ logger: false });
    registerGraphRoutes(app, { db });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  function seed(): void {
    db.prepare(
      `INSERT INTO sessions (id, chat_id, user_id, channel, title, created_at, updated_at)
       VALUES (?, ?, 'unknown', 'feishu', '目录检查', ?, ?)`,
    ).run(SESSION, 'oc_demo', step(0), step(20));

    // Through the repository, so the jieba index is written as production does —
    // raw INSERTs would leave /api/search with nothing to find.
    const repo = new MessageRepository(db);
    // 1..21: message 11 is the hit, so both sides are non-empty.
    for (let n = 1; n <= 21; n += 1) {
      repo.create({
        id: `m${String(n).padStart(2, '0')}`,
        session_id: SESSION,
        role: n % 2 === 1 ? 'user' : 'assistant',
        content: n === 11 ? '关于 Excel 的讨论' : `消息 ${n}`,
        created_at: step(n),
      });
    }
  }

  it('returns the hit with its surrounding messages, in reading order', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/search/context?session_id=${SESSION}&message_id=m11&radius=3`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.focus_id).toBe('m11');
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual([
      'm08',
      'm09',
      'm10',
      'm11',
      'm12',
      'm13',
      'm14',
    ]);
    // Ordering is oldest→newest: that is how a transcript reads.
    expect(body.messages[3].content).toBe('关于 Excel 的讨论');
    expect(body.truncated_start).toBe(true);
    expect(body.truncated_end).toBe(true);
  });

  it('does not claim truncation at the head or tail of the session', async () => {
    const first = await app.inject({
      method: 'GET',
      url: `/api/search/context?session_id=${SESSION}&message_id=m01&radius=2`,
    });
    expect(first.json().truncated_start).toBe(false);
    expect(first.json().truncated_end).toBe(true);

    const last = await app.inject({
      method: 'GET',
      url: `/api/search/context?session_id=${SESSION}&message_id=m21&radius=2`,
    });
    expect(last.json().truncated_start).toBe(true);
    expect(last.json().truncated_end).toBe(false);
    expect(last.json().messages.at(-1).id).toBe('m21');
  });

  it('falls back to the newest page when the message id is stale', async () => {
    // A rebuilt FTS index can outlive its source row; that must not 500 the panel.
    const response = await app.inject({
      method: 'GET',
      url: `/api/search/context?session_id=${SESSION}&message_id=gone&radius=2`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.focus_id).toBeNull();
    // radius 2 → the newest 2*2+1 messages, same window size as an anchored call.
    expect(body.messages.map((m: { id: string }) => m.id)).toEqual([
      'm17',
      'm18',
      'm19',
      'm20',
      'm21',
    ]);
    expect(body.truncated_start).toBe(true);
  });

  it('reports whether the session is an IM session so the UI can route it', async () => {
    const im = await app.inject({
      method: 'GET',
      url: `/api/search/context?session_id=${SESSION}&message_id=m11`,
    });
    expect(im.json().session).toMatchObject({
      id: SESSION,
      is_im: true,
      channel: 'feishu',
      title: '目录检查',
    });

    db.prepare(
      `INSERT INTO projects (id, name, agent_id, created_at, updated_at)
       VALUES ('p1', '项目', 'default', ?, ?)`,
    ).run(step(0), step(0));
    db.prepare(
      `INSERT INTO sessions (id, chat_id, user_id, project_id, channel, created_at, updated_at)
       VALUES ('s-webui', 's-webui', 'unknown', 'p1', 'webui', ?, ?)`,
    ).run(step(0), step(0));
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at)
       VALUES ('w1', 's-webui', 'user', 'Excel 表格', ?)`,
    ).run(step(1));

    const project = await app.inject({
      method: 'GET',
      url: '/api/search/context?session_id=s-webui&message_id=w1',
    });
    expect(project.json().session).toMatchObject({ is_im: false, project_id: 'p1' });
  });

  it('404s an unknown session and 400s a missing session_id', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/api/search/context?session_id=nope',
    });
    expect(missing.statusCode).toBe(404);

    const noParam = await app.inject({ method: 'GET', url: '/api/search/context' });
    expect(noParam.statusCode).toBe(400);
  });

  it('labels message search hits with their session title and channel', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=Excel&limit=10',
    });

    expect(response.statusCode).toBe(200);
    const hit = response
      .json()
      .results.find((r: { kind: string; id: string }) => r.kind === 'message' && r.id === 'm11');
    expect(hit).toMatchObject({
      session_id: SESSION,
      session_title: '目录检查',
      channel: 'feishu',
    });
  });
});

describe('loadMessageContext', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it("clamps the radius and keeps the anchor's own row formatted like a transcript", () => {
    db.prepare(
      `INSERT INTO sessions (id, chat_id, user_id, channel, created_at, updated_at)
       VALUES ('s1', 's1', 'unknown', 'webui', ?, ?)`,
    ).run(step(0), step(0));
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at)
       VALUES ('only', 's1', 'user', ?, ?)`,
    ).run('[当前时间: 2026-10-07 10:00]\n\n你好', step(1));

    const { messages, focusId } = loadMessageContext(db, 's1', 'only', { radius: 0 });
    expect(focusId).toBe('only');
    // radius 0 clamps up to 1; the injected time prefix is stripped as usual.
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('你好');
  });
});
