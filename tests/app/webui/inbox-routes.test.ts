/**
 * Tests for the read-only IM inbox API (inbox-routes.ts).
 *
 * Covers the WebUI↔server contract:
 *   GET /api/inbox                          — IM sessions only, channel filter, paging
 *   GET /api/inbox/:sid/messages            — IM transcript, 404 for project/unknown
 *   the message payload is the SAME projection the project-scoped session route
 *   returns (session-message-view.loadSessionMessages), and the inbox exposes no
 *   write endpoints.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../../src/memory/db';
import { registerInboxRoutes } from '../../../src/app/webui/inbox-routes';
import { registerSessionRoutes } from '../../../src/app/webui/session-routes';

interface SessionSeed {
  id: string;
  chat_id?: string;
  channel?: string | null;
  title?: string | null;
  project_id?: string | null;
  updated_at?: number;
  created_at?: number;
  metadata?: string | null;
}

describe('IM inbox routes', () => {
  let db: Database.Database;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    app = Fastify({ logger: false });
    registerInboxRoutes(app, db);
    // Registered alongside so the payload comparison below has the reference route.
    registerSessionRoutes(app, db);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  function seedSession(seed: SessionSeed): void {
    db.prepare(
      `INSERT INTO sessions
         (id, chat_id, user_id, project_id, channel, external_chat_id, title, metadata,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      seed.id,
      seed.chat_id ?? seed.id,
      seed.project_id ? 'webui-user' : 'unknown',
      seed.project_id ?? null,
      seed.channel ?? null,
      seed.chat_id ?? seed.id,
      seed.title ?? null,
      seed.metadata ?? null,
      String(seed.created_at ?? 1000),
      String(seed.updated_at ?? 1000),
    );
  }

  function seedMessage(
    id: string,
    sessionId: string,
    role: string,
    content: string,
    createdAt: number,
    metadata?: string,
  ): void {
    db.prepare(
      `INSERT INTO messages (id, session_id, role, content, created_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, sessionId, role, content, createdAt, metadata ?? null);
  }

  it('lists only IM sessions (project_id IS NULL) with counts per channel', async () => {
    seedSession({ id: 'oc_1', channel: 'feishu', title: 'Feishu chat', updated_at: 3000 });
    seedSession({ id: 'telegram:1', channel: 'telegram', updated_at: 2000 });
    seedSession({
      id: 'proj-session',
      chat_id: 'webui:proj-1',
      channel: 'webui',
      project_id: 'proj-1',
      updated_at: 9000,
    });

    const res = await app.inject({ method: 'GET', url: '/api/inbox' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(['oc_1', 'telegram:1']);
    expect(body.hasMore).toBe(false);
    expect(body.channels).toEqual(
      expect.arrayContaining([
        { channel: 'feishu', count: 1 },
        { channel: 'telegram', count: 1 },
      ]),
    );
    // The project session is counted by the project routes, not the inbox.
    expect(body.channels).not.toEqual(expect.arrayContaining([{ channel: 'webui', count: 1 }]));
    expect(body.items[0]).toEqual({
      id: 'oc_1',
      channel: 'feishu',
      external_chat_id: 'oc_1',
      title: 'Feishu chat',
      updated_at: 3000,
      message_count: 0,
      preview: '',
    });
  });

  it('lists every conversation opened by /new as its own row', async () => {
    // Two transcripts of the same Feishu chat: the slot keeps chat_id, the ids
    // differ (see ConversationSessions). The inbox lists rows, so both show up.
    seedSession({ id: 'oc_1', chat_id: 'oc_1', channel: 'feishu', updated_at: 1000 });
    seedSession({
      id: 'oc_1~2',
      chat_id: 'oc_1',
      channel: 'feishu',
      title: '公众号文案',
      updated_at: 2000,
    });
    seedMessage('m1', 'oc_1', 'user', 'first conversation', 1000);
    seedMessage('m2', 'oc_1~2', 'user', 'second conversation', 2000);

    const res = await app.inject({ method: 'GET', url: '/api/inbox' });

    const body = res.json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(['oc_1~2', 'oc_1']);
    expect(body.items[0]).toMatchObject({ title: '公众号文案', message_count: 1 });
    // The chat handle is still visible, so the header can show it.
    expect(body.items[0].external_chat_id).toBe('oc_1');
    // One chat, two rows, still one group.
    expect(body.channels).toEqual([{ channel: 'feishu', count: 2 }]);
  });

  it('exposes an untouched /new conversation as an empty, untitled row', async () => {
    // The sidebar labels such a row with its own placeholder ("新会话"): the row
    // has neither a title nor a preview, so the transport handle must not leak
    // into the label, and the server has to be honest about the emptiness.
    seedSession({ id: 'oc_2~2', chat_id: 'oc_2', channel: 'feishu', updated_at: 2000 });

    const body = (await app.inject({ method: 'GET', url: '/api/inbox' })).json();

    expect(body.items[0]).toMatchObject({
      id: 'oc_2~2',
      title: null,
      preview: '',
      message_count: 0,
      external_chat_id: 'oc_2',
    });
  });

  it('serves a suffixed transcript id over the plain route', async () => {
    seedSession({ id: 'oc_1~2', chat_id: 'oc_1', channel: 'feishu', title: '第二期' });
    seedMessage('m1', 'oc_1~2', 'user', 'hello', 1000);

    const res = await app.inject({ method: 'GET', url: '/api/inbox/oc_1~2/messages' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The transcript payload carries the header fields inline (no wrapper).
    expect(body).toMatchObject({ id: 'oc_1~2', title: '第二期', channel: 'feishu' });
    expect(body.messages.map((m: { content: string }) => m.content)).toEqual(['hello']);
  });

  it('filters by channel', async () => {
    seedSession({ id: 'oc_1', channel: 'feishu' });
    seedSession({ id: 'telegram:1', channel: 'telegram' });
    seedSession({ id: 'wechat:1', channel: 'wechat' });

    const res = await app.inject({ method: 'GET', url: '/api/inbox?channel=telegram' });

    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { id: string }) => i.id)).toEqual(['telegram:1']);
  });

  it('rejects an unknown channel with 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/inbox?channel=discord' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'Bad Request',
      message: 'Unknown channel: discord',
    });
  });

  it('clamps limit to 1..200 and defaults to 50', async () => {
    for (let i = 0; i < 3; i++) {
      seedSession({ id: `qq:${i}`, channel: 'qq', updated_at: 1000 + i });
    }

    const zero = await app.inject({ method: 'GET', url: '/api/inbox?limit=0' });
    expect(zero.statusCode).toBe(200);
    expect(zero.json().items).toHaveLength(1);
    expect(zero.json().hasMore).toBe(true);

    const huge = await app.inject({ method: 'GET', url: '/api/inbox?limit=9999' });
    expect(huge.statusCode).toBe(200);
    expect(huge.json().items).toHaveLength(3);
    expect(huge.json().hasMore).toBe(false);

    const bad = await app.inject({ method: 'GET', url: '/api/inbox?limit=abc' });
    expect(bad.statusCode).toBe(200);
    expect(bad.json().items).toHaveLength(3); // default 50
  });

  it('pages with the updated_at cursor', async () => {
    seedSession({ id: 'qq:1', channel: 'qq', updated_at: 3000 });
    seedSession({ id: 'qq:2', channel: 'qq', updated_at: 2000 });
    seedSession({ id: 'qq:3', channel: 'qq', updated_at: 1000 });

    const first = await app.inject({ method: 'GET', url: '/api/inbox?limit=2' });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.items.map((i: { id: string }) => i.id)).toEqual(['qq:1', 'qq:2']);
    expect(firstBody.hasMore).toBe(true);

    const cursor = firstBody.items[1].updated_at;
    const second = await app.inject({
      method: 'GET',
      url: `/api/inbox?limit=2&before=${cursor}`,
    });
    const secondBody = second.json();
    expect(secondBody.items.map((i: { id: string }) => i.id)).toEqual(['qq:3']);
    expect(secondBody.hasMore).toBe(false);
  });

  it('returns the transcript with the inbox header fields', async () => {
    seedSession({
      id: 'oc_1',
      channel: 'feishu',
      title: 'Feishu chat',
      created_at: 1000,
      updated_at: 2000,
    });
    seedMessage('m1', 'oc_1', 'user', 'hello', 1500);
    seedMessage('m2', 'oc_1', 'assistant', 'hi there', 1800);

    const res = await app.inject({ method: 'GET', url: '/api/inbox/oc_1/messages' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      id: 'oc_1',
      channel: 'feishu',
      external_chat_id: 'oc_1',
      title: 'Feishu chat',
      created_at: 1000,
      updated_at: 2000,
      hasMore: false,
    });
    expect(body.messages.map((m: { content: string }) => m.content)).toEqual(['hello', 'hi there']);
  });

  it('falls back to metadata.title for rows written before v9', async () => {
    seedSession({
      id: 'telegram:1',
      channel: 'telegram',
      metadata: JSON.stringify({ title: 'Pre-v9 title' }),
    });

    const res = await app.inject({ method: 'GET', url: '/api/inbox/telegram:1/messages' });

    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe('Pre-v9 title');
  });

  it('infers the channel for rows that have none recorded', async () => {
    seedSession({ id: 'telegram:42', channel: null, metadata: '{}' });

    const res = await app.inject({ method: 'GET', url: '/api/inbox/telegram:42/messages' });

    expect(res.statusCode).toBe(200);
    expect(res.json().channel).toBe('telegram');
  });

  it('returns 404 for a project session — inbox is IM-only', async () => {
    seedSession({
      id: 'proj-session',
      chat_id: 'webui:proj-1',
      channel: 'webui',
      project_id: 'proj-1',
    });
    seedMessage('m1', 'proj-session', 'user', 'hello', 1500);

    const res = await app.inject({ method: 'GET', url: '/api/inbox/proj-session/messages' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not Found', message: 'Session not found' });
  });

  it('returns 404 for a missing session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/inbox/nope/messages' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not Found', message: 'Session not found' });
  });

  it('pages the transcript and reports hasMore', async () => {
    seedSession({ id: 'oc_1', channel: 'feishu' });
    for (let i = 1; i <= 3; i++) {
      seedMessage(`m${i}`, 'oc_1', 'user', `msg ${i}`, 1000 + i);
    }

    const first = await app.inject({ method: 'GET', url: '/api/inbox/oc_1/messages?limit=2' });
    const firstBody = first.json();
    expect(firstBody.messages).toHaveLength(2);
    expect(firstBody.hasMore).toBe(true);

    const oldest = firstBody.messages[0].created_at;
    const second = await app.inject({
      method: 'GET',
      url: `/api/inbox/oc_1/messages?limit=2&before=${oldest}`,
    });
    const secondBody = second.json();
    expect(secondBody.messages).toHaveLength(1);
    expect(secondBody.hasMore).toBe(false);
  });

  it('returns the same message projection as the project-scoped route', async () => {
    const toolCalls = JSON.stringify({
      tool_calls: [{ id: 't1', name: 'read_file', arguments: { path: 'a.txt' } }],
      segments: [
        { type: 'text', content: 'checking' },
        { type: 'tool_call', id: 't1' },
      ],
      usage: { input: 12, output: 4 },
      model: 'test-model',
      elapsed: 900,
    });
    seedSession({ id: 'telegram:1', channel: 'telegram', created_at: 1000, updated_at: 2000 });
    seedSession({
      id: 'proj-session',
      chat_id: 'webui:proj-1',
      channel: 'webui',
      project_id: 'proj-1',
      created_at: 1000,
      updated_at: 2000,
    });
    for (const sessionId of ['telegram:1', 'proj-session']) {
      seedMessage(`${sessionId}-m1`, sessionId, 'user', 'please read a.txt', 1500);
      seedMessage(`${sessionId}-m2`, sessionId, 'assistant', 'checking', 1800, toolCalls);
    }

    const inbox = await app.inject({ method: 'GET', url: '/api/inbox/telegram:1/messages' });
    const project = await app.inject({
      method: 'GET',
      url: '/api/projects/proj-1/sessions/proj-session',
    });

    expect(inbox.statusCode).toBe(200);
    expect(project.statusCode).toBe(200);

    const strip = (messages: Array<Record<string, unknown>>) =>
      messages.map(({ id: _id, session_id: _sid, ...rest }) => rest);

    expect(strip(inbox.json().messages)).toEqual(strip(project.json().messages));
    expect(inbox.json().hasMore).toBe(project.json().hasMore);
  });

  it('exposes no write endpoints — the inbox is read-only', async () => {
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/api/inbox' });
      expect(res.statusCode).toBe(404);
      const nested = await app.inject({ method, url: '/api/inbox/oc_1/messages' });
      expect(nested.statusCode).toBe(404);
    }
  });
});

/**
 * Channel groups are labelled with the bot that owns them ("小书 · 飞书").
 *
 * The name is per-channel config, so the API has to surface it — the WebUI has no
 * other way to know it, and hard-coding a name in the UI would be wrong for every
 * other user's bot.
 */
describe('IM inbox bot names', () => {
  let db: Database.Database;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    db = openDatabase(':memory:');
    app = Fastify({ logger: false });
    registerInboxRoutes(app, db, undefined, (channel) =>
      channel === 'feishu' ? '小书' : undefined,
    );
    await app.ready();

    const insert = db.prepare(
      `INSERT INTO sessions (id, chat_id, user_id, channel, title, created_at, updated_at)
       VALUES (?, ?, 'unknown', ?, ?, ?, ?)`,
    );
    insert.run('oc_1', 'oc_1', 'feishu', '飞书会话', 1, 2);
    insert.run('tg_1', 'tg_1', 'telegram', 'TG 会话', 1, 1);
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('annotates each channel count with its bot name, and only where one exists', async () => {
    const body = (await app.inject({ method: 'GET', url: '/api/inbox' })).json();
    const byChannel = new Map(
      body.channels.map((entry: { channel: string; bot_name?: string }) => [entry.channel, entry]),
    );

    expect(byChannel.get('feishu')).toMatchObject({ bot_name: '小书' });
    // No bot name configured: the field is absent rather than empty, so the UI
    // can fall back with a simple falsy check.
    expect(byChannel.get('telegram')).not.toHaveProperty('bot_name');
  });

  it('carries the bot name on the transcript header too', async () => {
    const feishu = (await app.inject({ method: 'GET', url: '/api/inbox/oc_1/messages' })).json();
    expect(feishu.bot_name).toBe('小书');

    const telegram = (await app.inject({ method: 'GET', url: '/api/inbox/tg_1/messages' })).json();
    expect(telegram).not.toHaveProperty('bot_name');
  });

  it('omits every bot name when no resolver is configured', async () => {
    const bare = Fastify({ logger: false });
    registerInboxRoutes(bare, db);
    await bare.ready();

    const body = (await bare.inject({ method: 'GET', url: '/api/inbox' })).json();
    for (const entry of body.channels) expect(entry).not.toHaveProperty('bot_name');

    await bare.close();
  });
});
