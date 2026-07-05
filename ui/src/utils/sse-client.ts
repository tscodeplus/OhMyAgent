import { getToken } from './api';

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
  | 'user_question'
  | 'user_question_resolved';

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
}

export interface SSEClient {
  start: (
    url: string,
    body: unknown,
    onEvent: (event: SSEEvent) => void,
    onError?: (error: Error) => void
  ) => AbortController;
}

export function createSSEClient(): SSEClient {
  return {
    start(url, body, onEvent, onError) {
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

          const reader = response.body?.getReader();
          if (!reader) {
            onError?.(new Error('No response body'));
            return;
          }

          const decoder = new TextDecoder();
          let buffer = '';

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const data = line.slice(6).trim();
                  if (data === '[DONE]') {
                    onEvent({ type: 'done' });
                    continue;
                  }
                  try {
                    const parsed = JSON.parse(data) as SSEEvent;
                    onEvent(parsed);
                  } catch {
                    // Skip unparseable lines
                  }
                }
              }
            }
          } catch (err) {
            if ((err as Error).name !== 'AbortError') {
              onError?.(err as Error);
            }
          }
        })
        .catch((err) => {
          if (err.name !== 'AbortError') {
            onError?.(err);
          }
        });

      return controller;
    },
  };
}
