/**
 * Tests for the stream re-attach endpoint
 * (`GET /api/projects/:projectId/chat/stream` in chat-routes.ts).
 *
 * The endpoint is what makes a page reload (or a turn started in another tab)
 * recoverable: it answers with the hub's compacted baseline for the session,
 * or `idle` when nothing is running. The client store relies on the exact
 * frames asserted here.
 */

import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { registerChatRoutes } from '../../src/app/webui/chat-routes.js';
import { ChatStreamHub } from '../../src/app/webui/chat-stream-hub.js';

function makeApp(hub?: ChatStreamHub) {
  const app = Fastify({ logger: false });
  registerChatRoutes(app, {
    agentService: {} as any,
    projectStore: {
      getById: (id: string) => (id === 'proj-1' ? { id, agent_id: undefined } : undefined),
    } as any,
    streamHub: hub,
  } as any);
  return app;
}

/** Parse the SSE payload of an inject response into frames. */
function framesOf(payload: string): Array<Record<string, unknown>> {
  return payload
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

describe('GET /api/projects/:projectId/chat/stream', () => {
  it('rejects a request without a sessionId', async () => {
    const app = makeApp(new ChatStreamHub());
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/proj-1/chat/stream',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects an unknown project', async () => {
    const app = makeApp(new ChatStreamHub());
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/nope/chat/stream?sessionId=s1',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('answers idle when the session has no in-flight turn', async () => {
    const hub = new ChatStreamHub();
    const app = makeApp(hub);
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/proj-1/chat/stream?sessionId=s1',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(framesOf(res.payload)).toEqual([{ type: 'idle' }]);
    await app.close();
  });

  it('answers idle when no hub is wired (feature inert)', async () => {
    const app = makeApp(undefined);
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/proj-1/chat/stream?sessionId=s1',
    });

    expect(res.statusCode).toBe(200);
    expect(framesOf(res.payload)).toEqual([{ type: 'idle' }]);
    await app.close();
  });

  it('replays the compacted baseline of a live turn, then follows the live tail', async () => {
    const hub = new ChatStreamHub();
    const turn = hub.begin('s1');
    turn.publish({ type: 'turn_start' });
    turn.publish({ type: 'text_delta', data: 'partial ' });
    turn.publish({ type: 'text_delta', data: 'answer' });

    const app = makeApp(hub);
    // The response stays open while the turn is live, so `inject` only
    // resolves once the turn settles — which is exactly what a real client
    // sees too (it closes its reader on the terminal event).
    const pending = app.inject({
      method: 'GET',
      url: '/api/projects/proj-1/chat/stream?sessionId=s1',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    turn.publish({ type: 'tool_call_start', toolName: 'shell', toolCallId: 't1' });
    turn.publish({ type: 'done' });

    const res = await pending;
    expect(res.statusCode).toBe(200);
    const frames = framesOf(res.payload);
    expect(frames[0]).toMatchObject({ type: 'resume', live: true, index: 3 });
    expect(frames[0]!.events).toMatchObject([
      { type: 'turn_start' },
      { type: 'text_delta', data: 'partial answer' },
    ]);
    // The follower stayed subscribed: the tail arrived without a new attach.
    expect(frames.map((f) => f.type)).toEqual(['resume', 'tool_call_start', 'done']);

    hub.dispose();
    await app.close();
  });

  it('replays a finished turn and closes the response', async () => {
    const hub = new ChatStreamHub();
    const turn = hub.begin('s1');
    turn.publish({ type: 'turn_start' });
    turn.publish({ type: 'text_delta', data: 'done text' });
    turn.publish({ type: 'done' });

    const app = makeApp(hub);
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/proj-1/chat/stream?sessionId=s1',
    });

    const frames = framesOf(res.payload);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'resume', live: false });
    const events = frames[0]!.events as Array<Record<string, unknown>>;
    expect(events.map((e) => e.type)).toEqual(['turn_start', 'text_delta', 'done']);
    hub.dispose();
    await app.close();
  });

  it('probe=1 answers idle for a settled turn instead of replaying it', async () => {
    // Mobile/PWA re-probes must not resurrect a finished reply on top of the
    // history the client already fetched.
    const hub = new ChatStreamHub();
    const turn = hub.begin('s1');
    turn.publish({ type: 'turn_start' });
    turn.publish({ type: 'text_delta', data: 'finished text' });
    turn.publish({ type: 'done' });

    const app = makeApp(hub);
    const probe = await app.inject({
      method: 'GET',
      url: '/api/projects/proj-1/chat/stream?sessionId=s1&probe=1',
    });
    expect(framesOf(probe.payload)).toEqual([{ type: 'idle' }]);

    // Without the probe flag the tail stays replayable (reload just as the
    // turn ended still gets its content).
    const full = await app.inject({
      method: 'GET',
      url: '/api/projects/proj-1/chat/stream?sessionId=s1',
    });
    expect(framesOf(full.payload)[0]).toMatchObject({ type: 'resume', live: false });
    hub.dispose();
    await app.close();
  });

  it('probe=1 still attaches to a live turn', async () => {
    const hub = new ChatStreamHub();
    const turn = hub.begin('s1');
    turn.publish({ type: 'turn_start' });
    turn.publish({ type: 'text_delta', data: 'in flight' });

    const app = makeApp(hub);
    const pending = app.inject({
      method: 'GET',
      url: '/api/projects/proj-1/chat/stream?sessionId=s1&probe=1',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    turn.publish({ type: 'done' });
    const res = await pending;

    const frames = framesOf(res.payload);
    expect(frames[0]).toMatchObject({ type: 'resume', live: true });
    expect(frames.map((f) => f.type)).toEqual(['resume', 'done']);
    hub.dispose();
    await app.close();
  });

  it('keeps the POST writer and re-attached followers in sync', async () => {
    // Guard against a regression where the hub replaces (rather than adds to)
    // the subscriber set when a follower attaches.
    const hub = new ChatStreamHub();
    const writer = vi.fn();
    const turn = hub.begin('s1');
    turn.subscribe({ write: writer });

    const follower = vi.fn();
    hub.attach('s1', { write: follower });
    turn.publish({ type: 'text_delta', data: 'live' });

    expect(writer).toHaveBeenCalledWith(expect.objectContaining({ type: 'text_delta' }));
    expect(follower).toHaveBeenCalledWith(expect.objectContaining({ type: 'text_delta' }));
    hub.dispose();
  });
});
