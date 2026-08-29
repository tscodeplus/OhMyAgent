import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bot, Send } from 'lucide-react';
import { apiRequest } from '../../utils/api';
import { isElectron } from '../../utils/env';
import { devLog } from '../../utils/logger';
import { useProject } from '../../contexts/ProjectContext';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { useToast } from '../ui/Toast';
import MessageList from './MessageList';
import ChatInput from './ChatInput';

import type { Session } from '../../types/session';
import type { Message } from '../../types/session';

/**
 * Conservative duplicate detection between a live streaming message and the
 * persisted API snapshot (used when ids differ, e.g. assistant bubbles).
 * Only matches when the persisted copy was created at/after the live bubble
 * started (persist happens at turn end) and contents overlap. Short contents
 * are only matched exactly to avoid false positives like "好" vs "好的…".
 */
function fuzzyDuplicate(m: Message, fetched: Message[]): boolean {
  // Assistant-only: user messages dedupe by exact id (clientMsgId echo).
  // Fuzzy-matching users is risky — two identical short messages sent in
  // quick succession (e.g. "继续") would falsely prune the live copy.
  if (m.role !== 'assistant') return false;
  const t = new Date(m.created_at).getTime();
  return fetched.some(f => {
    if (f.role !== 'assistant' || !f.content) return false;
    const ft = new Date(f.created_at).getTime();
    if (Math.abs(ft - t) > 30_000) return false;
    if (ft < t - 2_000) return false;
    if (f.content === m.content) return true;
    const shorter = Math.min(f.content.length, m.content.length);
    if (shorter < 16) return false;
    return f.content.startsWith(m.content) || m.content.startsWith(f.content);
  });
}

export default function ChatView() {
  const { projectId, sessionId } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation('common');
  const { showToast } = useToast();
  const { bumpSessionsRefreshKey } = useProject();
  const [quickInput, setQuickInput] = useState('');
  const [creating, setCreating] = useState(false);
  const [streamMessages, setStreamMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [refetchKey, setRefetchKey] = useState(0);

  // Timestamp of the last streaming activity (SSE message arrival / stream
  // start). Used to distinguish a live local stream from a dead one when a
  // WebSocket agent_turn_complete arrives.
  const lastStreamActivityRef = useRef(0);
  // Bubbles whose SSE turn has fully completed (done/error received). Their
  // content was persisted server-side BEFORE done was dispatched (pre-complete
  // callback), so once the post-done refetch returns they exist under a
  // server-generated id and the local copy can be pruned safely.
  const completedBubblesRef = useRef(new Set<string>());
  // Sessions with an in-flight agent turn whose LOCAL SSE was dropped
  // (user navigated to another session mid-turn). Used to restore the
  // thinking indicator when the user returns; entries are removed when
  // the WS agent_turn_complete push arrives for that session.
  const pendingTurnSessionsRef = useRef(new Set<string>());

  // Stable ref for the current session ID — checked in handleMessages to
  // drop late-arriving SSE events from a previous session after a switch.
  const currentSessionIdRef = useRef(sessionId);
  currentSessionIdRef.current = sessionId;

  // Clear streaming state when switching sessions. Restore the thinking
  // indicator when returning to a session whose agent is still running
  // server-side (its local SSE was dropped on leave; the WS completion
  // push will clear the indicator and refresh the history).
  useEffect(() => {
    setStreamMessages([]);
    setIsThinking(pendingTurnSessionsRef.current.has(sessionId ?? ''));
    completedBubblesRef.current.clear();
    lastStreamActivityRef.current = 0;
  }, [sessionId]);

  // Register/unregister with Desktop Bridge for remote tool execution.
  // The bridge runs in the Electron main process and needs to know which
  // session the user is currently viewing so it can forward tool calls
  // (file_read, file_write, shell) to the local machine.
  useEffect(() => {
    if (!isElectron() || !sessionId) return;

    const api = window.electronAPI;
    api?.bridgeRegisterSession(sessionId);

    return () => {
      api?.bridgeUnregisterSession(sessionId);
    };
  }, [sessionId]);

  /** Trigger an API refetch. */
  const triggerRefetch = useCallback(() => {
    setRefetchKey(k => k + 1);
  }, []);

  // Listen for agent turn completion notifications via WebSocket.
  // When the SSE connection is lost mid-stream (page refresh, browser close,
  // navigation away), the agent keeps running on the server and persists
  // messages on completion. This WebSocket push triggers a refetch so the
  // UI auto-updates without the user needing to manually refresh.
  const { subscribe } = useWebSocket();
  useEffect(() => {
    return subscribe('agent_turn_complete', (data: any) => {
      if (data.sessionId === sessionId) {
        devLog('[ChatView] agent_turn_complete via WS — triggering refetch');
        // Only drop the local "streaming" flag when no live SSE has been
        // active recently — if our own connection is still receiving events,
        // its own done handler owns that state transition.
        if (Date.now() - lastStreamActivityRef.current > 5_000) {
          setIsStreaming(false);
          setIsThinking(false);
        }
        triggerRefetch();
      }
      // The turn for this session is finished wherever it was started —
      // drop its pending marker so a later visit shows no stale indicator.
      pendingTurnSessionsRef.current.delete(data.sessionId);
    });
  }, [subscribe, sessionId, triggerRefetch]);

  const handleThinkingChange = useCallback((thinking: boolean) => {
    setIsThinking(thinking);
  }, []);

  const handleTurnDone = useCallback(() => {
    devLog('[ChatView] handleTurnDone — switching to API mode');
    setIsStreaming(false);
    setIsThinking(false);
    // The only attached stream belongs to the current session — its turn
    // is over, so clear the pending marker (the WS push would also do it,
    // but this keeps things tight when the WS message is delayed).
    pendingTurnSessionsRef.current.delete(currentSessionIdRef.current ?? '');
    triggerRefetch();
    // Don't clear streamMessages here — MessageList.onRefetched will do it
    // after the API fetch succeeds, preventing message flash/disappearance.
  }, [triggerRefetch]);

  /** Prune streaming messages against a fresh API snapshot after a successful
   *  refetch. A streaming message is dropped only when we know it exists in
   *  the snapshot under another id:
   *  - exact id match (user messages share the clientMsgId),
   *  - its turn already emitted done/error (persist happens before those),
   *  - conservative content-overlap fallback for lost connections.
   *  This replaces the old all-or-nothing counter guard that could wipe
   *  mid-turn content when the user sent a message during an in-flight fetch. */
  const handleRefetched = useCallback((fetched?: Message[]) => {
    devLog('[ChatView] handleRefetched — pruning streamMessages (API fetch succeeded)');
    setStreamMessages(prev => {
      const fetchedList = fetched ?? [];
      const fetchedIds = new Set(fetchedList.map(m => m.id));
      const kept = prev.filter(m => {
        // Approval / pending question cards are streaming-only UI state — keep them.
        if (m.approval || (m.userQuestion && m.userQuestion.status !== 'answered')) return true;
        // Persisted under the same id (clientMsgId echo) — API copy wins.
        if (fetchedIds.has(m.id)) return false;
        // Turn completed before this refetch was triggered → already persisted
        // under a server-generated id.
        if (completedBubblesRef.current.has(m.id)) return false;
        // Fallback for dead connections where done never arrived.
        if (fetchedList.length > 0 && fuzzyDuplicate(m, fetchedList)) return false;
        return true;
      });
      if (kept.length !== prev.length) {
        devLog('[ChatView] handleRefetched pruned', { before: prev.length, after: kept.length });
      }
      return kept;
    });
    // GC completed-bubble markers occasionally — they're small but unbounded.
    if (completedBubblesRef.current.size > 100) {
      completedBubblesRef.current.clear();
    }
  }, []);
  // Track the initial message to auto-send after session creation
  const [initialMessage, setInitialMessage] = useState<string | undefined>(undefined);

  const handleQuickStart = useCallback(async () => {
    if (!projectId || !quickInput.trim()) return;
    const msg = quickInput.trim();
    setCreating(true);
    try {
      const session = await apiRequest<Session>(`/api/projects/${projectId}/sessions`, { method: 'POST' });
      // Pass the initial message so ChatInput can auto-send it
      setInitialMessage(msg);
      setQuickInput('');
      bumpSessionsRefreshKey();
      navigate(`/p/${projectId}/s/${session.id}`, { state: { initialMessage: msg } });
    } catch {
      showToast(t('chat.createSessionError'), 'error');
      setCreating(false);
    }
  }, [projectId, quickInput, navigate, showToast, t]);

  const handleMessages = useCallback((msgs: Message[], clearPrevious?: boolean) => {
    // Drop messages that don't belong to the currently-viewed session.
    // Guards against stale SSE connections that may fire late after a
    // session switch (in case the unmount abort hasn't taken effect yet).
    const curSid = currentSessionIdRef.current;
    msgs = msgs.filter(m => !m.session_id || m.session_id === curSid);
    if (msgs.length === 0) return;
    lastStreamActivityRef.current = Date.now();

    setStreamMessages(prev => {
      // When a new user message arrives in a fresh turn (not steer/follow-up),
      // clear non-approval messages from the previous turn. Frontend-generated
      // IDs differ from server-generated IDs, so uncleared messages would
      // duplicate after the API refetch.
      // clearPrevious=false is used by steerMessage to preserve messages from
      // the current turn when the user sends a follow-up message mid-stream.
      const shouldClear = clearPrevious !== false;
      const hasNewUser = msgs.some(m => m.role === 'user');
      const base = (hasNewUser && shouldClear)
        ? prev.filter(m => m.approval || (m.userQuestion && m.userQuestion.status !== 'answered'))
        : prev;
      const existing = new Map(base.map(m => [m.id, m]));
      for (const msg of msgs) {
        const old = existing.get(msg.id);
        // Preserve tool_calls from old message if the new update
        // (e.g. text_delta) doesn't carry them — prevents tool cards
        // from being pushed to the bottom or disappearing.
        if (old?.tool_calls && !msg.tool_calls) {
          msg.tool_calls = old.tool_calls;
        }
        existing.set(msg.id, msg);
      }
      const merged = Array.from(existing.values()).sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      // Pin pending approval / user-question cards to the END of the list.
      // They represent a pause point waiting for user input, so any text the
      // agent streams afterwards must render ABOVE the card, not below it.
      const isPinned = (m: Message) =>
        (m.approval && m.approval.status === 'pending') ||
        (m.userQuestion && m.userQuestion.status === 'pending');
      const pinnedCards = merged.filter(isPinned);
      return pinnedCards.length > 0 ? [...merged.filter(m => !isPinned(m)), ...pinnedCards] : merged;
    });
  }, []);

  // No project selected
  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center px-8">
          <div className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-neutral-100 dark:bg-neutral-800 mb-4">
            <Bot className="h-8 w-8 text-neutral-400 dark:text-neutral-500" strokeWidth={1.5} />
          </div>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('chat.noProject')}</p>
        </div>
      </div>
    );
  }

  // Existing session — show full chat
  if (sessionId) {
    return (
      <div className="flex h-full flex-col">
        {/* MessageList keyed by sessionId: fresh fetch/pagination state per
            session (also prevents the previous session's messages from
            flashing while the new session's history loads).
            ChatInput is deliberately NOT keyed — it holds the cross-session
            input draft/upload caches. Its streaming state machine resets
            itself via an internal sessionId-change effect instead. */}
        <MessageList key={sessionId} projectId={projectId} sessionId={sessionId} streamingMessages={streamMessages} isStreaming={isStreaming} isThinking={isThinking} refetchKey={refetchKey} onRefetched={handleRefetched} />
        <ChatInput projectId={projectId} sessionId={sessionId} onMessages={handleMessages} onStreamStart={() => { setIsStreaming(true); lastStreamActivityRef.current = Date.now(); if (sessionId) pendingTurnSessionsRef.current.add(sessionId); }} onThinkingChange={handleThinkingChange} onDone={handleTurnDone} onTurnPersisted={(msgId) => completedBubblesRef.current.add(msgId)} />
      </div>
    );
  }

  // No session yet — show welcome + input at the bottom (same position as ChatInput)
  return (
    <div className="flex h-full flex-col">
      {/* Welcome area fills the space above the input */}
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center px-8">
          <div className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-neutral-100 dark:bg-neutral-800 mb-4">
            <Bot className="h-8 w-8 text-neutral-400 dark:text-neutral-500" strokeWidth={1.5} />
          </div>
          <h2 className="text-[15px] font-semibold text-neutral-800 dark:text-neutral-200 mb-1">{t('chat.startNew')}</h2>
          <p className="text-[13px] text-neutral-500 dark:text-neutral-400">{t('chat.welcomeDesc')}</p>
        </div>
      </div>

      {/* Input at bottom — same position/size as ChatInput */}
      <div className="shrink-0 border-t border-neutral-200 bg-white px-3 sm:px-4 py-2 sm:py-3 pb-safe dark:border-neutral-700 dark:bg-neutral-950">
        <div className="mx-auto flex max-w-3xl items-end gap-2 sm:gap-3">
          <textarea
            value={quickInput}
            onChange={e => setQuickInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleQuickStart(); }
            }}
            placeholder={t('chat.input.placeholder')}
            rows={3}
            className="flex-1 resize-none rounded-xl border border-neutral-300 bg-white px-3 sm:px-4 py-2.5 sm:py-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          />
          <button
            onClick={creating ? undefined : handleQuickStart}
            disabled={creating || !quickInput.trim()}
            className={`shrink-0 inline-flex h-10 w-10 items-center justify-center rounded-xl transition-colors disabled:opacity-30 ${
              quickInput.trim()
                ? 'border border-blue-500 bg-blue-500 text-white hover:bg-blue-600 dark:border-blue-400 dark:bg-blue-400 dark:hover:bg-blue-500'
                : 'border border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700'
            }`}
            aria-label={t('chat.send')}
          >
            {creating ? (
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" className="opacity-75" />
              </svg>
            ) : (
              <Send size={16} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
