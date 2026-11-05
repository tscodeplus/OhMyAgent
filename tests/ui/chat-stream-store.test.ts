import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The stream store is the only writer of the WebUI's "thinking…" row: it owns
 * `thinking` in the snapshot React reads through `useSyncExternalStore`. The
 * snapshot is memoised by a revision counter, so a flag flipped without a
 * `notify()` is invisible — that is exactly how the indicator disappeared
 * when streaming moved out of the component: `turn_start` published no bubble,
 * the next notification came from the first `text_delta`, which had already
 * cleared the flag.
 */

interface StartCall {
  url: string;
  body: Record<string, unknown>;
  onEvent: (event: Record<string, unknown>) => void;
  onEnd?: () => void;
}

const mock = vi.hoisted(() => ({ calls: [] as StartCall[] }));

vi.mock('../../ui/src/utils/sse-client', () => ({
  createSSEClient: () => ({
    start: (
      url: string,
      body: Record<string, unknown>,
      onEvent: (event: Record<string, unknown>) => void,
      _onError?: (error: Error) => void,
      _onChunk?: () => void,
      onEnd?: () => void,
    ) => {
      mock.calls.push({ url, body, onEvent, onEnd });
      return new AbortController();
    },
    open: () => new AbortController(),
  }),
}));

// The store imports the browser i18n instance for its retry line; the node
// test environment has no localStorage/navigator.
vi.mock('../../ui/src/i18n/config', () => ({
  default: { t: (key: string) => key },
}));

const { chatStreamStore } = await import('../../ui/src/state/chat-stream-store');

function sendParams() {
  return {
    content: 'hi',
    clientMsgId: 'client-msg-0001',
    userMessage: {
      id: 'client-msg-0001',
      session_id: 'session-1',
      role: 'user' as const,
      content: 'hi',
      created_at: new Date().toISOString(),
    },
    model: null,
    reasoningLevel: null,
  };
}

describe('chat stream store — thinking indicator', () => {
  beforeEach(() => {
    mock.calls.length = 0;
  });

  afterEach(() => {
    chatStreamStore.reset();
  });

  it('raises the thinking flag on turn_start and notifies subscribers', () => {
    const seen: boolean[] = [];
    chatStreamStore.subscribe('session-1', () =>
      seen.push(chatStreamStore.snapshot('session-1').thinking),
    );

    chatStreamStore.send('session-1', 'project-1', sendParams());
    expect(chatStreamStore.snapshot('session-1').thinking).toBe(false);

    seen.length = 0;
    mock.calls[0]!.onEvent({ type: 'turn_start' });

    // Both the cached snapshot React renders and the notification that makes
    // React read it again must carry the flag.
    expect(chatStreamStore.snapshot('session-1').thinking).toBe(true);
    expect(seen.at(-1)).toBe(true);
  });

  it('clears the flag with the first content event, on the delta flush', () => {
    vi.useFakeTimers();
    try {
      chatStreamStore.subscribe('session-1', () => {});
      chatStreamStore.send('session-1', 'project-1', sendParams());

      mock.calls[0]!.onEvent({ type: 'turn_start' });
      expect(chatStreamStore.snapshot('session-1').thinking).toBe(true);

      mock.calls[0]!.onEvent({ type: 'text_delta', data: '你' });
      // The render rides the same throttled flush as the text (DELTA_FLUSH).
      vi.advanceTimersByTime(60);
      expect(chatStreamStore.snapshot('session-1').thinking).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the flag again when the turn settles', () => {
    chatStreamStore.subscribe('session-1', () => {});
    chatStreamStore.send('session-1', 'project-1', sendParams());

    mock.calls[0]!.onEvent({ type: 'turn_start' });
    mock.calls[0]!.onEvent({ type: 'done', footer: {} });

    const snapshot = chatStreamStore.snapshot('session-1');
    expect(snapshot.thinking).toBe(false);
    expect(snapshot.sending).toBe(false);
  });
});
