import { useState, useCallback, useRef, useEffect, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { Send } from 'lucide-react';
import { createSSEClient, type SSEEvent } from '../../utils/sse-client';
import { getToken } from '../../utils/api';
import type { Message, MessageApproval, ToolCall, MessageFooter, MessageSegment } from '../../types/session';

interface ChatInputProps {
  projectId?: string;
  sessionId?: string;
  /** Called when new messages arrive (streaming or user).
   *  Optional second param controls whether previous streaming messages
   *  are cleared. Default true — pass false for steer/follow-up to
   *  preserve messages from the current turn. */
  onMessages?: (messages: Message[], clearPrevious?: boolean) => void;
  /** Called when a new SSE stream starts (to switch to streaming mode). */
  onStreamStart?: () => void;
  /** Called when the SSE stream completes (done or error). */
  onDone?: () => void;
}

const sseClient = createSSEClient();

/**
 * Generate a random UUID v4 string. Uses crypto.randomUUID() when available
 * (secure contexts: localhost or HTTPS), falls back to Math.random() for
 * non-secure contexts (e.g. accessing the dev server via http://IP:port).
 */
function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}

export default function ChatInput({ projectId, sessionId, onMessages, onStreamStart, onDone }: ChatInputProps) {
  const { t } = useTranslation('common');
  const location = useLocation();
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autoSentRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Refs for SSE streaming state — captured by the event handler closure.
  // Reset on turn_start so steer/follow-up responses create separate bubbles.
  const assistantIdRef = useRef('');
  const assistantContentRef = useRef('');
  const assistantCreatedAtRef = useRef('');
  const toolCallsRef = useRef<ToolCall[]>([]);
  const runningToolsRef = useRef(new Map<string, ToolCall>());
  /** Chronological timeline of text and tool calls within the current turn. */
  const segmentsRef = useRef<MessageSegment[]>([]);
  /** Length of cleaned assistant text that has already been "flushed" into
   *  segments. Used to compute only the new portion for the current text
   *  segment after a tool-call boundary. */
  const flushedCleanLenRef = useRef(0);
  /** Set to true when steerMessage eagerly creates a bubble so the later
   *  turn_start from the agent reuses it instead of creating a duplicate. */
  const steerBubbleRef = useRef(false);
  const approvalMessagesRef = useRef(new Map<string, Message>());
  // Count active turns: incremented on turn_start, decremented on done.
  // sending resets to false only when all turns have completed.
  const activeTurnsRef = useRef(0);

  /** Start a fresh turn — new assistant message bubble for this response. */
  const beginTurn = () => {
    const newId = uid();
    console.log('[ChatInput] beginTurn', { newId: newId.slice(0, 8), prevId: assistantIdRef.current.slice(0, 8), activeTurns: activeTurnsRef.current + 1 });
    assistantIdRef.current = newId;
    assistantContentRef.current = '';
    assistantCreatedAtRef.current = new Date().toISOString();
    toolCallsRef.current = [];
    segmentsRef.current = [];
    flushedCleanLenRef.current = 0;
    // NOTE: runningToolsRef and approvalMessagesRef are intentionally NOT
    // cleared here. beginTurn is called on both the initial SSE and
    // steer/follow-up, and clearing them would cause tool_call_end and
    // approval_resolved events arriving after steer to be silently dropped.
    activeTurnsRef.current++;
  };

  /** End the current turn. Returns true if this was the last active turn. */
  const endTurn = () => {
    activeTurnsRef.current--;
    if (activeTurnsRef.current <= 0) {
      activeTurnsRef.current = 0;
      return true;
    }
    return false;
  };

  const sendMessage = useCallback((messageText: string, opts?: { preserveContent?: boolean }) => {
    if (!messageText.trim() || !projectId || !sessionId) return;
    // Abort any running SSE stream before starting a new one
    abortRef.current?.abort();
    setSending(true);
    // Don't clear existing streaming content when sending slash commands
    // during an active stream (e.g. /steer, /btw). Regular sends always reset.
    if (!opts?.preserveContent) {
      onStreamStart?.();
    }

    // Clear input FIRST, before any potentially-throwing code.
    setInput('');

    const userMessage: Message = {
      id: uid(),
      session_id: sessionId,
      role: 'user',
      content: messageText.trim(),
      created_at: new Date().toISOString(),
    };
    if (onMessages) onMessages([userMessage], true); // clearPrevious: new SSE connection

    // First turn is started by the turn_start SSE event (dispatcher.onStart),
    // so we don't call beginTurn() here — doing so would double-count turns
    // and prevent the done handler from resetting the sending state.

    const streamStartTime = Date.now();
    console.log('[ChatInput] SSE stream starting', { sessionId, messagePreview: messageText.slice(0, 40) });

    abortRef.current = sseClient.start(
      `/api/projects/${projectId}/chat`,
      { sessionId, message: userMessage.content },
      (event: SSEEvent) => {
        lastSseEventRef.current = Date.now();
        console.log('[ChatInput] SSE event', { type: event.type, ts: Date.now() - streamStartTime });
        switch (event.type) {
          case 'turn_start':
            // Reuse the bubble eagerly created by steerMessage.
            if (steerBubbleRef.current) {
              steerBubbleRef.current = false;
              // Reset active turn counter: the steer turn supersedes any
              // previous turn (whose 'done' event may never fire). Only
              // the steer turn (counted in steerMessage's beginTurn) remains.
              activeTurnsRef.current = 1;
              console.log('[ChatInput] SSE turn_start — reusing steer bubble', { curId: assistantIdRef.current.slice(0, 8), activeTurns: activeTurnsRef.current });
            } else {
              console.log('[ChatInput] SSE turn_start — creating new bubble');
              beginTurn();
            }
            break;

          case 'text_delta':
            assistantContentRef.current += event.data || '';
            {
              const cleaned = assistantContentRef.current
                .replace(/<思考>[^]*?<\/思考>/g, '')
                .replace(/<thinking>[^]*?<\/thinking>/gi, '');
              // Only the portion after the last flush point belongs to the
              // current text segment (text after the most recent tool call).
              const currentText = cleaned.slice(flushedCleanLenRef.current);
              const lastSeg = segmentsRef.current[segmentsRef.current.length - 1];
              if (lastSeg?.type === 'text') {
                lastSeg.content = currentText;
              } else if (currentText) {
                segmentsRef.current.push({ type: 'text', content: currentText });
              }
              if (onMessages) {
                onMessages([{
                  id: assistantIdRef.current, session_id: sessionId, role: 'assistant',
                  content: cleaned,
                  tool_calls: toolCallsRef.current.length > 0 ? [...toolCallsRef.current] : undefined,
                  segments: [...segmentsRef.current],
                  created_at: assistantCreatedAtRef.current,
                }]);
              }
            }
            break;

          case 'tool_call_start': {
            const tc: ToolCall = {
              id: event.toolCallId || uid(),
              name: event.toolName || 'unknown',
              arguments: (typeof event.data === 'string' ? JSON.parse(event.data) : event.data) || {},
              status: 'running',
            };
            runningToolsRef.current.set(tc.id, tc);
            toolCallsRef.current.push(tc);
            // Flush current cleaned text so the next text_delta starts a
            // fresh text segment after this tool call.
            const cleaned = assistantContentRef.current
              .replace(/<思考>[^]*?<\/思考>/g, '')
              .replace(/<thinking>[^]*?<\/thinking>/gi, '');
            flushedCleanLenRef.current = cleaned.length;
            segmentsRef.current.push({ type: 'tool_call', toolCall: tc });
            if (onMessages) {
              onMessages([{
                id: assistantIdRef.current, session_id: sessionId, role: 'assistant',
                content: assistantContentRef.current,
                tool_calls: [...toolCallsRef.current],
                segments: [...segmentsRef.current],
                created_at: assistantCreatedAtRef.current,
              }]);
            }
            break;
          }

          case 'tool_call_end': {
            const toolCallId = event.toolCallId;
            const existing = toolCallId ? runningToolsRef.current.get(toolCallId) : undefined;
            if (existing && toolCallId) {
              existing.status = event.isError ? 'error' : 'success';
              existing.output = event.data ?? '';
              runningToolsRef.current.delete(toolCallId);
            }
            // Update the matching segment so the tool card re-renders
            // with the final status / output.
            if (existing) {
              for (let i = segmentsRef.current.length - 1; i >= 0; i--) {
                const seg = segmentsRef.current[i]!;
                if (seg.type === 'tool_call' && seg.toolCall?.id === toolCallId) {
                  seg.toolCall = { ...existing };
                  break;
                }
              }
            }
            if (onMessages) {
              onMessages([{
                id: assistantIdRef.current, session_id: sessionId, role: 'assistant',
                content: assistantContentRef.current,
                tool_calls: [...toolCallsRef.current],
                segments: [...segmentsRef.current],
                created_at: assistantCreatedAtRef.current,
              }]);
            }
            break;
          }

          case 'approval_required': {
            const approvalData: MessageApproval = {
              approvalId: event.approvalId || '',
              command: event.command || event.toolName || '',
              risk: event.risk || 'medium',
              reason: event.reason,
              status: 'pending',
            };
            const approvalMsg: Message = {
              id: `approval-${approvalData.approvalId}`,
              session_id: sessionId,
              role: 'assistant',
              content: '',
              approval: approvalData,
              created_at: new Date().toISOString(),
            };
            approvalMessagesRef.current.set(approvalData.approvalId, approvalMsg);
            if (onMessages) onMessages([approvalMsg]);
            break;
          }

          case 'approval_resolved': {
            const aid = event.approvalId || '';
            const existing = approvalMessagesRef.current.get(aid);
            if (existing && existing.approval) {
              const resolved: Message = {
                ...existing,
                approval: {
                  ...existing.approval,
                  status: (event.decision || '').startsWith('approve') ? 'approved' : 'rejected',
                  decision: event.decision,
                  timeoutReason: event.reason || existing.approval.timeoutReason,
                },
              };
              approvalMessagesRef.current.set(aid, resolved);
              if (onMessages) onMessages([resolved]);
            }
            break;
          }

          case 'thinking':
            // Reasoning content is deliberately suppressed in WebUI.
            break;

          case 'done': {
            const footer = (event as any).footer as MessageFooter | undefined;
            // Extract images from markdown in content and tool outputs
            const images: { url: string; alt?: string }[] = [];
            const imgRegex = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
            let imgMatch: RegExpExecArray | null;
            const extractImages = (text: string) => {
              imgRegex.lastIndex = 0;
              while ((imgMatch = imgRegex.exec(text)) !== null) {
                images.push({ alt: imgMatch[1] || undefined, url: imgMatch[2] });
              }
            };
            extractImages(assistantContentRef.current);
            for (const tc of toolCallsRef.current) {
              if (tc.status === 'success' && tc.output) extractImages(tc.output);
            }
            if (images.length > 0) console.log('[ChatInput] done — extracted images', images.length, images.map(i => i.url.slice(0, 50)));
            // Extract file download links
            const files: { name: string; path: string; size?: number }[] = [];
            const seenFiles = new Set<string>();
            const linkRegex = /\[([^\]]+)\]\((\/[^)]+)\)/g;
            let linkMatch: RegExpExecArray | null;
            while ((linkMatch = linkRegex.exec(assistantContentRef.current)) !== null) {
              const label = linkMatch[1].trim();
              const url = linkMatch[2];
              if ((url.includes('/api/files/serve') || url.includes('/api/files/download')) && !seenFiles.has(url)) {
                seenFiles.add(url);
                files.push({ name: label, path: url });
              }
            }
            if (onMessages) {
              onMessages([{
                id: assistantIdRef.current, session_id: sessionId, role: 'assistant',
                content: assistantContentRef.current,
                tool_calls: toolCallsRef.current.length > 0 ? [...toolCallsRef.current] : undefined,
                segments: [...segmentsRef.current],
                footer: footer || undefined,
                images: images.length > 0 ? images : undefined,
                files: files.length > 0 ? files : undefined,
                // Keep the original creation time so this bubble stays in
                // its correct chronological position relative to user messages.
                created_at: assistantCreatedAtRef.current || new Date().toISOString(),
              }]);
            }
            // Only set sending=false when ALL turns have completed.
            console.log('[ChatInput] done — endTurn', { activeTurns: activeTurnsRef.current });
            if (endTurn()) {
              console.log('[ChatInput] done — last turn, sending=false');
              setSending(false);
              onDone?.();
            }
            break;
          }

          case 'error':
            // Reset everything on stream error
            activeTurnsRef.current = 0;
            setSending(false);
            onDone?.();
            break;
        }
      },
      () => {
        activeTurnsRef.current = 0;
        setSending(false);
        onDone?.();
      },
    );
  }, [projectId, sessionId, onMessages, onStreamStart, onDone]);

  /** Send a steer message while the agent is already running. Does NOT abort
   *  the existing SSE — the steer response streams through the same connection. */
  const steerMessage = useCallback(async (messageText: string) => {
    if (!messageText.trim() || !projectId || !sessionId) return;

    console.log('[ChatInput] steerMessage — queueing steer', { msg: messageText.slice(0, 30), activeTurns: activeTurnsRef.current });

    // Signal that a new stream of output is starting (for the steer response).
    onStreamStart?.();

    // The original turn was interrupted by this steer — its 'done' event
    // may never arrive. Reset the turn counter so the steer turn's 'done'
    // can properly set sending=false. beginTurn() increments to 1, and
    // the steer turn's 'done' will decrement it back to 0.
    activeTurnsRef.current = 0;
    beginTurn();
    steerBubbleRef.current = true;

    // Clear input and show user message
    setInput('');
    const userMessage: Message = {
      id: uid(),
      session_id: sessionId,
      role: 'user',
      content: messageText.trim(),
      created_at: new Date().toISOString(),
    };
    if (onMessages) onMessages([userMessage], false); // clearPrevious: false — keep current-turn messages

    // Send steer request (non-blocking — the existing SSE handles the response)
    const token = getToken();
    try {
      await fetch(`/api/projects/${projectId}/chat/steer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ sessionId, message: messageText.trim() }),
      });
    } catch {
      // Steer is best-effort; the existing SSE continues regardless
    }
  }, [projectId, sessionId, onMessages]);

  const handleSend = useCallback(() => {
    const text = textareaRef.current?.value ?? input;
    if (!text.trim()) return;
    if (sending) {
      // Agent is running — route based on message type.
      // /steer, /queue, /btw → steer API (strip prefix on backend, keep SSE alive).
      // /stop → abort agent (new SSE, doesn't preserve content).
      // Other / commands → SSE with content preserved (need command handler).
      // Regular text → steer API (keep existing SSE + content).
      if (text.startsWith('/steer ') || text.startsWith('/queue ') || text.startsWith('/btw ')) {
        steerMessage(text);
      } else if (text.startsWith('/')) {
        sendMessage(text, { preserveContent: true });
      } else {
        steerMessage(text);
      }
    } else {
      sendMessage(text);
    }
  }, [input, sendMessage, sending, steerMessage]);

  // Auto-send initial message from navigation state (session was just created)
  useEffect(() => {
    if (autoSentRef.current) return;
    const state = location.state as { initialMessage?: string } | null;
    if (state?.initialMessage && projectId && sessionId) {
      autoSentRef.current = true;
      window.history.replaceState({}, '');
      sendMessage(state.initialMessage);
    }
  }, [projectId, sessionId, sendMessage, location.state]);

  // Abort SSE stream on unmount — prevents stale connections from
  // leaking messages into a different conversation after a session switch.
  useEffect(() => {
    return () => {
      console.log('[ChatInput] unmounting — aborting SSE stream');
      abortRef.current?.abort();
      activeTurnsRef.current = 0;
      setSending(false);
    };
  }, []);

  // Safety timeout: reset sending state if SSE stream hangs (no events
  // for 60s). Uses a heartbeat ref updated on every SSE event so long-
  // running tools (e.g. image generation) don't trigger a false timeout.
  const lastSseEventRef = useRef(Date.now());
  useEffect(() => {
    if (!sending) return;
    const interval = setInterval(() => {
      if (Date.now() - lastSseEventRef.current > 60_000) {
        console.warn('[ChatInput] SSE heartbeat timeout — no events for 60s');
        abortRef.current?.abort();
        activeTurnsRef.current = 0;
        setSending(false);
      }
    }, 10_000);
    return () => clearInterval(interval);
  }, [sending]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="shrink-0 border-t border-neutral-200 bg-white px-3 sm:px-4 py-3 sm:py-4 pb-6 sm:pb-8 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="mx-auto flex max-w-3xl items-end gap-2 sm:gap-3">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('chat.input.placeholder')}
          rows={3}
          disabled={!projectId || !sessionId}
          enterKeyHint="send"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className="flex-1 resize-none rounded-xl border border-neutral-300 bg-white px-3 sm:px-4 py-2.5 sm:py-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        />
        <button
          onClick={() => {
            const text = textareaRef.current?.value.trim() || input.trim();
            if (text) {
              handleSend();
            } else {
              sendMessage('/stop');
            }
          }}
          disabled={(!input.trim() && !sending) || !projectId || !sessionId}
          className={`shrink-0 inline-flex h-10 w-10 items-center justify-center rounded-xl transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
            input.trim()
              ? 'border border-blue-500 bg-blue-500 text-white hover:bg-blue-600 dark:border-blue-400 dark:bg-blue-400 dark:hover:bg-blue-500'
              : 'border border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700'
          }`}
          aria-label={t('chat.send')}
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}
