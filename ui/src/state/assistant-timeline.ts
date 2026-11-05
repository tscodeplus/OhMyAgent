/**
 * Assistant bubble timeline: the ordered text / tool / skill / media run of one
 * streamed turn.
 *
 * The WebUI renders a bubble from `segments` whenever they exist, and falls
 * back to `content` only for plain text. That makes the *order* load-bearing:
 * text streamed before a tool call must already sit in its own segment when the
 * tool segment is appended, or it silently disappears from the rendered bubble
 * (it is still in `content`, but `content` is not what gets rendered).
 *
 * Live streaming hid this for a long time because a throttled flush usually ran
 * between the deltas and the tool call. Replay — a re-attach baseline, where
 * every event is folded synchronously — has no such gap, which is why the text
 * above a running tool card could vanish on resume. Hence this module:
 * fragment boundaries flush explicitly instead of relying on timing, and the
 * whole thing is pure so the fold can be tested (tests/ui) without a DOM.
 */
import type { MessageSegment, ToolCall } from '../types/session';

/** Strip reasoning blocks from accumulated assistant text (WebUI suppresses them). */
export function cleanAssistantText(raw: string): string {
  return raw.replace(/<思考>[^]*?<\/思考>/g, '').replace(/<thinking>[^]*?<\/thinking>/gi, '');
}

/** Ordered segment run of one assistant bubble. */
export class AssistantTimeline {
  private rawText = '';
  /**
   * Length of cleaned text already owned by a closed segment (or the text
   * segment in front of the current fragment). Everything after it belongs to
   * the trailing text segment, which is rewritten on each flush.
   */
  private flushedLen = 0;
  private readonly segmentList: MessageSegment[] = [];

  /** Append one text delta to the accumulated (uncleaned) text. */
  appendText(delta: string): void {
    this.rawText += delta;
  }

  /** Assistant text with reasoning blocks removed — the bubble's `content`. */
  get cleaned(): string {
    return cleanAssistantText(this.rawText);
  }

  /**
   * The live segment array. Callers update properties in place (tool call
   * status/output), so treat it as owned mutable state, not a snapshot.
   */
  get segments(): MessageSegment[] {
    return this.segmentList;
  }

  /** True when this timeline has produced anything worth rendering. */
  get isEmpty(): boolean {
    return this.segmentList.length === 0 && this.rawText.length === 0;
  }

  /**
   * Fold the text accumulated since the last flush into the trailing text
   * segment. Text after a tool/skill fragment opens a new text segment.
   */
  flushText(): void {
    const pending = this.cleaned.slice(this.flushedLen);
    if (!pending) return;
    const last = this.segmentList[this.segmentList.length - 1];
    if (last?.type === 'text') {
      last.content = pending;
    } else {
      this.segmentList.push({ type: 'text', content: pending });
    }
  }

  /**
   * Close the current text run and append a non-text segment after it. Flushing
   * *before* advancing the boundary is what keeps pre-tool text visible.
   */
  beginFragment(segment: MessageSegment): void {
    this.flushText();
    this.flushedLen = this.cleaned.length;
    this.segmentList.push(segment);
  }

  /**
   * Find the segment carrying a tool call, newest first.
   * @returns its index, or -1 when the call never started on this timeline.
   */
  indexOfToolCall(toolCallId: string): number {
    for (let i = this.segmentList.length - 1; i >= 0; i -= 1) {
      const seg = this.segmentList[i]!;
      if (seg.type === 'tool_call' && seg.toolCall?.id === toolCallId) return i;
    }
    return -1;
  }

  /** Replace the tool call stored in a segment (a clone forces a re-render). */
  updateToolCall(index: number, toolCall: ToolCall): void {
    const seg = this.segmentList[index];
    if (seg?.type === 'tool_call') seg.toolCall = toolCall;
  }

  /** Insert a segment immediately after a tool call's segment (inline media). */
  insertAfter(index: number, segment: MessageSegment): void {
    this.segmentList.splice(index + 1, 0, segment);
  }

  /** Drop everything for a new turn. */
  reset(): void {
    this.rawText = '';
    this.flushedLen = 0;
    this.segmentList.length = 0;
  }
}
