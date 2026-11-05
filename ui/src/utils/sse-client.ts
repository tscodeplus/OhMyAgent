import { getToken } from './api';
import type { HarnessImprovementProposal } from '../components/chat/HarnessImprovementCard';

export type SSEEventType =
  | 'text_delta'
  | 'tool_call_start'
  | 'tool_call_end'
  | 'thinking'
  | 'done'
  | 'error'
  | 'turn_start'
  | 'approval_required'
  | 'approval_resolved'
  | 'approval_status'
  | 'skill_activated'
  | 'stream_retry'
  | 'user_question'
  | 'user_question_resolved'
  | 'harness_improvement'
  /**
   * Re-attach frames (GET .../chat/stream). `resume` opens with a compact
   * baseline of the in-flight turn — its events are replayed through the same
   * reducer that consumed them live, so the client rebuilds the stream state
   * it lost. `idle` means there is no turn to recover; `resume_unavailable`
   * means the server's baseline outgrew its cap.
   */
  | 'resume'
  | 'idle'
  | 'resume_unavailable';

export interface SSEEvent {
  type: SSEEventType;
  data?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  error?: string;
  message?: string;
  // Approval-related fields
  approvalId?: string;
  command?: string;
  risk?: 'low' | 'medium' | 'high';
  reason?: string;
  decision?: string;
  footer?: Record<string, unknown>;
  // User question fields
  requestId?: string;
  question?: string;
  options?: Array<{ label: string; value: string }>;
  answer?: string;
  // Self-Harness improvement proposal fields
  proposal?: HarnessImprovementProposal;
  // Re-attach (`resume`) fields
  streamId?: string;
  /** Monotone index of the newest event folded into the baseline. */
  index?: number;
  /** False when the replayed turn already finished (its log ends with done/error). */
  live?: boolean;
  startedAt?: number;
  /** Compacted event log replaying the turn from its start. */
  events?: SSEEvent[];
}

type EventHandler = (event: SSEEvent) => void;

export interface SSEClient {
  start: (
    url: string,
    body: unknown,
    onEvent: EventHandler,
    onError?: (error: Error) => void,
    /** Called on every received chunk — including keepalive comment lines.
     *  Use this to feed a heartbeat so long silent phases (running tools,
     *  approval waits) don't trip client-side no-event timeouts. */
    onChunk?: () => void,
    /** Called when the response body ends (server closed, network died, or the
     *  caller aborted). Lets the caller tell a finished turn from a dropped
     *  transport. */
    onEnd?: () => void,
  ) => AbortController;
  /**
   * Open a server-push stream with GET (no request body). Used for re-attaching
   * to an in-flight turn: the server answers with the `resume` baseline or
   * `idle` and then keeps the connection open for the live tail.
   */
  open: (
    url: string,
    onEvent: EventHandler,
    onError?: (error: Error) => void,
    onChunk?: () => void,
    onEnd?: () => void,
  ) => AbortController;
}

/** Read an SSE response body, invoking the handlers for each parsed frame. */
async function consume(
  response: Response,
  onEvent: EventHandler,
  onError: (error: Error) => void,
  onChunk?: () => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    onError(new Error('No response body'));
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      // Feed the heartbeat for ANY received data (including the server's
      // ": ping" keepalive comments) before parsing.
      onChunk?.();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          onEvent({ type: 'done' });
          continue;
        }
        try {
          onEvent(JSON.parse(data) as SSEEvent);
        } catch {
          // Skip unparseable lines
        }
      }
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      onError(err as Error);
    }
  }
}

export function createSSEClient(): SSEClient {
  return {
    start(url, body, onEvent, onError, onChunk, onEnd) {
      const controller = new AbortController();
      const token = getToken();

      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            const err = await response.json().catch(() => ({ message: 'SSE connection failed' }));
            onError?.(new Error(err.message || 'SSE connection failed'));
            return;
          }
          await consume(response, onEvent, onError ?? (() => {}), onChunk);
        })
        .catch((err) => {
          if (err.name !== 'AbortError') {
            onError?.(err);
          }
        })
        .finally(() => onEnd?.());

      return controller;
    },

    open(url, onEvent, onError, onChunk, onEnd) {
      const controller = new AbortController();
      const token = getToken();

      fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            onError?.(new Error(`SSE re-attach failed (${response.status})`));
            return;
          }
          await consume(response, onEvent, onError ?? (() => {}), onChunk);
        })
        .catch((err) => {
          if (err.name !== 'AbortError') {
            onError?.(err);
          }
        })
        .finally(() => onEnd?.());

      return controller;
    },
  };
}
