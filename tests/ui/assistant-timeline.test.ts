import { describe, it, expect } from 'vitest';
import { AssistantTimeline, cleanAssistantText } from '../../ui/src/state/assistant-timeline';

/**
 * The assistant bubble renders `segments` whenever they exist, so the segment
 * run — not `content` — is what the user sees. These cases pin the two ways
 * text could disappear from it:
 *
 *   1. text streamed before a tool call had no segment of its own when the tool
 *      segment was appended (a replayed re-attach baseline never runs the
 *      throttled text flush, so the text vanished above the card until the turn
 *      completed and history replaced the bubble);
 *   2. the throttled flush still pending when the turn settles lost the last
 *      chunk.
 */
describe('AssistantTimeline', () => {
  it('keeps text streamed before a tool call above the tool card', () => {
    const timeline = new AssistantTimeline();
    timeline.appendText('我先看一下当前目录。');
    // No flush between the deltas and the tool call — exactly what a replay of
    // the compacted baseline looks like (all events folded synchronously).
    timeline.beginFragment({ type: 'tool_call', toolCall: toolCall('t1') });

    expect(timeline.cleaned).toBe('我先看一下当前目录。');
    expect(timeline.segments).toEqual([
      { type: 'text', content: '我先看一下当前目录。' },
      { type: 'tool_call', toolCall: expect.objectContaining({ id: 't1' }) },
    ]);
  });

  it('splits text around a tool call into ordered segments', () => {
    const timeline = new AssistantTimeline();
    timeline.appendText('先检查。');
    timeline.beginFragment({ type: 'tool_call', toolCall: toolCall('t1') });
    timeline.appendText('结果是 42。');
    timeline.flushText();

    expect(timeline.segments.map((s) => s.type)).toEqual(['text', 'tool_call', 'text']);
    expect(timeline.segments[0]!.content).toBe('先检查。');
    expect(timeline.segments[2]!.content).toBe('结果是 42。');
  });

  it('rewrites the trailing text segment instead of stacking one per flush', () => {
    const timeline = new AssistantTimeline();
    timeline.appendText('你');
    timeline.flushText();
    timeline.appendText('好');
    timeline.flushText();

    expect(timeline.segments).toHaveLength(1);
    expect(timeline.segments[0]).toEqual({ type: 'text', content: '你好' });
  });

  it('produces the same segments live (flush between deltas) and replayed (no flush)', () => {
    const events = ['先说一句。', '再说一句。'];
    const live = new AssistantTimeline();
    for (const delta of events) {
      live.appendText(delta);
      live.flushText(); // the throttled flush that happens live
    }
    live.beginFragment({ type: 'tool_call', toolCall: toolCall('t1') });
    live.appendText('继续。');
    live.flushText();

    const replayed = new AssistantTimeline();
    for (const delta of events) replayed.appendText(delta); // no flush
    replayed.beginFragment({ type: 'tool_call', toolCall: toolCall('t1') });
    replayed.appendText('继续。');
    replayed.flushText();

    expect(replayed.segments).toEqual(live.segments);
  });

  it('flushes the un-flushed tail when the turn settles', () => {
    const timeline = new AssistantTimeline();
    timeline.appendText('第一段。');
    timeline.flushText();
    timeline.appendText('最后半句'); // throttled flush still pending

    timeline.flushText(); // what finishTurn does after cancelling the timer

    expect(timeline.segments).toEqual([{ type: 'text', content: '第一段。最后半句' }]);
  });

  it('strips reasoning blocks from both content and segments', () => {
    const timeline = new AssistantTimeline();
    timeline.appendText('<思考>internal musing</思考>对外的话');
    timeline.flushText();

    expect(timeline.cleaned).toBe('对外的话');
    expect(timeline.segments).toEqual([{ type: 'text', content: '对外的话' }]);
    expect(cleanAssistantText('<thinking>x</thinking>y')).toBe('y');
  });

  it('places a skill marker after the text that preceded it', () => {
    const timeline = new AssistantTimeline();
    timeline.appendText('正在处理。');
    timeline.beginFragment({ type: 'skill', name: 'pdf' });

    expect(timeline.segments.map((s) => s.type)).toEqual(['text', 'skill']);
  });

  it('inserts inline media directly after its tool card and updates the card', () => {
    const timeline = new AssistantTimeline();
    timeline.beginFragment({ type: 'tool_call', toolCall: toolCall('t1') });
    const index = timeline.indexOfToolCall('t1');
    expect(index).toBe(0);

    timeline.updateToolCall(index, { ...toolCall('t1'), status: 'success' });
    timeline.insertAfter(index, { type: 'media', media: { url: '/x.png', type: 'image' } });

    expect(timeline.segments.map((s) => s.type)).toEqual(['tool_call', 'media']);
    expect(timeline.segments[0]!.toolCall?.status).toBe('success');
  });

  it('reports a missing tool call instead of guessing a position', () => {
    const timeline = new AssistantTimeline();
    timeline.beginFragment({ type: 'tool_call', toolCall: toolCall('t1') });
    expect(timeline.indexOfToolCall('nope')).toBe(-1);
  });

  it('clears everything on reset', () => {
    const timeline = new AssistantTimeline();
    timeline.appendText('text');
    timeline.beginFragment({ type: 'tool_call', toolCall: toolCall('t1') });

    timeline.reset();

    expect(timeline.isEmpty).toBe(true);
    expect(timeline.cleaned).toBe('');
    expect(timeline.segments).toEqual([]);
  });
});

function toolCall(id: string) {
  return { id, name: 'shell', arguments: {}, status: 'running' as const };
}
