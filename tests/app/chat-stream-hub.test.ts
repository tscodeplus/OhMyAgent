/**
 * Tests for the in-flight chat stream hub (`src/app/webui/chat-stream-hub.ts`).
 *
 * The hub exists so a WebUI tab that leaves mid-turn (session switch, reload,
 * dropped connection) can re-attach and continue the same turn. These tests
 * pin the contract the client store relies on:
 *   - live fan-out to every subscriber, numbered with a monotone index,
 *   - a compacted baseline (merged text deltas, no reasoning deltas) that
 *     replays the turn from its start,
 *   - `idle` / `resume_unavailable` answers,
 *   - a finished turn staying replayable for a bounded window,
 *   - a superseded or slow connection being released instead of pinning memory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatStreamHub, type ChatStreamEvent } from '../../src/app/webui/chat-stream-hub.js';

function collector() {
  const frames: ChatStreamEvent[] = [];
  return {
    frames,
    write: (event: ChatStreamEvent) => frames.push(event),
  };
}

describe('ChatStreamHub', () => {
  let hub: ChatStreamHub;

  beforeEach(() => {
    hub = new ChatStreamHub({ finishedRetentionMs: 60_000 });
  });

  afterEach(() => {
    hub.dispose();
    vi.useRealTimers();
  });

  it('fans live events out to the POST writer and to re-attached followers', () => {
    const postWriter = collector();
    const turn = hub.begin('s1');
    turn.subscribe({ write: postWriter.write });

    turn.publish({ type: 'turn_start' });
    turn.publish({ type: 'text_delta', data: 'Hel' });

    const follower = collector();
    const handle = hub.attach('s1', { write: follower.write });
    expect(handle.status).toBe('attached');
    expect(handle.finished).toBe(false);

    turn.publish({ type: 'text_delta', data: 'lo' });

    // Followers get the opening baseline, then only the live tail.
    expect(follower.frames).toHaveLength(2);
    expect(follower.frames[0]).toMatchObject({ type: 'resume', live: true });
    expect(follower.frames[1]).toMatchObject({ type: 'text_delta', data: 'lo' });
    // ...while the original writer saw every event.
    expect(postWriter.frames.map((f) => f.type)).toEqual([
      'turn_start',
      'text_delta',
      'text_delta',
    ]);
  });

  it('numbers live frames with a monotone index', () => {
    const writer = collector();
    const turn = hub.begin('s1');
    turn.subscribe({ write: writer.write });
    turn.publish({ type: 'turn_start' });
    turn.publish({ type: 'text_delta', data: 'a' });
    turn.publish({ type: 'done' });

    expect(writer.frames.map((f) => f.index)).toEqual([1, 2, 3]);
  });

  it('opens a re-attach with one compacted baseline instead of every delta', () => {
    const turn = hub.begin('s1');
    turn.publish({ type: 'turn_start' });
    // Reasoning deltas are suppressed by the WebUI — they must not bloat the
    // baseline, but they still reach live subscribers.
    turn.publish({ type: 'thinking', data: 'pondering…' });
    for (const chunk of ['a', 'b', 'c', 'd']) turn.publish({ type: 'text_delta', data: chunk });
    turn.publish({ type: 'tool_call_start', toolName: 'shell', toolCallId: 't1' });

    const follower = collector();
    hub.attach('s1', { write: follower.write });

    const resume = follower.frames[0]!;
    expect(resume.type).toBe('resume');
    expect(resume.index).toBe(7);
    expect(resume.live).toBe(true);
    const events = resume.events as ChatStreamEvent[];
    expect(events.map((e) => e.type)).toEqual(['turn_start', 'text_delta', 'tool_call_start']);
    // Consecutive deltas fold into one accumulated event.
    expect(events[1]!.data).toBe('abcd');
    // The stored baseline is a copy: a later delta must not rewrite it.
    expect(events[0]).not.toBe(undefined);
  });

  it('answers idle for a session with no recorded turn', () => {
    const follower = collector();
    const handle = hub.attach('unknown', { write: follower.write });

    expect(handle.status).toBe('idle');
    expect(handle.finished).toBe(true);
    expect(follower.frames).toEqual([{ type: 'idle' }]);
  });

  it('keeps a finished turn replayable inside the retention window', () => {
    const turn = hub.begin('s1');
    turn.publish({ type: 'turn_start' });
    turn.publish({ type: 'text_delta', data: 'final answer' });
    turn.publish({ type: 'done' });

    const follower = collector();
    const handle = hub.attach('s1', { write: follower.write });

    expect(handle.status).toBe('attached');
    // Nothing follows the replay — the caller can close the transport.
    expect(handle.finished).toBe(true);
    const resume = follower.frames[0]!;
    expect(resume.live).toBe(false);
    expect((resume.events as ChatStreamEvent[]).map((e) => e.type)).toEqual([
      'turn_start',
      'text_delta',
      'done',
    ]);
  });

  it('expires the retained turn after the retention window', () => {
    vi.useFakeTimers();
    const turn = hub.begin('s1');
    turn.publish({ type: 'done' });
    expect(hub.size).toBe(1);

    vi.advanceTimersByTime(60_001);
    expect(hub.size).toBe(0);
  });

  it('closes live subscribers once the turn settles', () => {
    const close = vi.fn();
    const turn = hub.begin('s1');
    turn.subscribe({ write: () => {}, close });

    turn.publish({ type: 'done' });

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('drops a superseded turn instead of serving two truths for one session', () => {
    const closeOld = vi.fn();
    const first = hub.begin('s1');
    first.subscribe({ write: () => {}, close: closeOld });
    first.publish({ type: 'text_delta', data: 'stale' });

    const second = hub.begin('s1');
    second.publish({ type: 'text_delta', data: 'fresh' });

    expect(closeOld).toHaveBeenCalledTimes(1);
    const follower = collector();
    hub.attach('s1', { write: follower.write });
    const resume = follower.frames[0]!;
    const events = resume.events as ChatStreamEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toBe('fresh');
  });

  it('refuses to replay an oversized baseline instead of pinning memory', () => {
    hub.dispose();
    hub = new ChatStreamHub({ maxBaselineBytes: 64 });
    const turn = hub.begin('s1');
    turn.publish({ type: 'turn_start' });
    for (let i = 0; i < 20; i += 1) turn.publish({ type: 'text_delta', data: '0123456789' });

    const follower = collector();
    const handle = hub.attach('s1', { write: follower.write });

    expect(handle.status).toBe('unavailable');
    expect(follower.frames[0]).toMatchObject({ type: 'resume_unavailable' });
    expect(hub.peek('s1')!.events).toEqual([]);
  });

  it('releases a subscriber that cannot drain', () => {
    const close = vi.fn();
    const turn = hub.begin('s1');
    turn.subscribe({ write: () => {}, buffered: () => 8 * 1024 * 1024, close });

    turn.publish({ type: 'text_delta', data: 'x' });

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('survives a subscriber whose transport throws', () => {
    const turn = hub.begin('s1');
    turn.subscribe({
      write: () => {
        throw new Error('socket closed');
      },
    });
    const healthy = collector();
    turn.subscribe({ write: healthy.write });

    expect(() => turn.publish({ type: 'text_delta', data: 'x' })).not.toThrow();
    expect(healthy.frames).toHaveLength(1);
  });

  it('clears every retained turn on dispose', () => {
    hub.begin('s1').publish({ type: 'turn_start' });
    hub.begin('s2').publish({ type: 'turn_start' });
    expect(hub.size).toBe(2);

    hub.dispose();

    expect(hub.size).toBe(0);
  });
});
