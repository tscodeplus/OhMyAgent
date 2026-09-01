import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bot } from 'lucide-react';
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
  const [streamMessages, setStreamMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  /** Transient stream retry/fallback status line (null = hidden). */
  const [retryStatus, setRetryStatus] = useState<string | null>(null);
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
  // isStreaming must also be reset here — it is NOT session-scoped, and a
  // stale true value (sent in session A, immediately switched to empty
  // session B) would wrongly force the bottom-docked input instead of the
  // centered new-session layout.
  useEffect(() => {
    setStreamMessages([]);
    setIsStreaming(false);
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

  const handleRetryStatusChange = useCallback((status: string | null) => {
    setRetryStatus(status);
  }, []);

  const handleTurnDone = useCallback(() => {
    devLog('[ChatView] handleTurnDone — switching to API mode');
    setIsStreaming(false);
    setIsThinking(false);
    setRetryStatus(null);
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
  // Sessions known to hold history messages. A session NOT in this set (and
  // with no live streaming messages) is treated as a brand-new conversation:
  // its input renders centered (slightly below middle) instead of at the
  // bottom, and switches back to the bottom dock once the first message is
  // sent. Entries are only added (never removed) so returning to a session
  // with history doesn't flash the centered layout while the history fetches.
  const [nonEmptySessions, setNonEmptySessions] = useState<Set<string>>(() => new Set());
  const handleHistoryCount = useCallback((sid: string, count: number) => {
    if (count <= 0) return;
    setNonEmptySessions(prev => {
      if (prev.has(sid)) return prev;
      const next = new Set(prev);
      next.add(sid);
      return next;
    });
  }, []);

  /** Create a session and navigate to it; the typed text rides along via
   *  navigation state and ChatInput auto-sends it as the first message.
   *  Called by ChatInput when the user sends with no session selected. */
  const handleQuickStart = useCallback(async (text: string) => {
    if (!projectId || !text.trim()) return;
    try {
      const session = await apiRequest<Session>(`/api/projects/${projectId}/sessions`, { method: 'POST' });
      bumpSessionsRefreshKey();
      navigate(`/p/${projectId}/s/${session.id}`, { state: { initialMessage: text.trim() } });
    } catch {
      showToast(t('chat.createSessionError'), 'error');
    }
  }, [projectId, navigate, bumpSessionsRefreshKey, showToast, t]);

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

  // Chat view. The no-session (welcome) case and the empty new-session case
  // both render the SAME ChatInput centered — no-session just adds quick-start
  // mode (send creates a session first). Keeping a single return with the
  // same child structure keeps ChatInput mounted across the welcome → session
  // navigation, so drafts and pre-session file uploads survive.
  //
  // MessageList is keyed by sessionId: fresh fetch/pagination state per
  // session (also prevents the previous session's messages from flashing
  // while the new session's history loads).
  // ChatInput is deliberately NOT keyed — it holds the cross-session
  // input draft/upload caches. Its streaming state machine resets
  // itself via an internal sessionId-change effect instead.
  const centeredNewSession =
    !sessionId ||
    (!nonEmptySessions.has(sessionId) &&
      streamMessages.length === 0 &&
      !isThinking &&
      !isStreaming);
  return (
    <div className="flex h-full flex-col">
      <div className={centeredNewSession ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
        {sessionId && (
          <MessageList
            key={sessionId}
            projectId={projectId}
            sessionId={sessionId}
            streamingMessages={streamMessages}
            isStreaming={isStreaming}
            isThinking={isThinking}
            retryStatus={retryStatus}
            refetchKey={refetchKey}
            onRefetched={handleRefetched}
            hideEmptyState={centeredNewSession}
            onHistoryCount={handleHistoryCount}
          />
        )}
      </div>
      <ChatInput
        projectId={projectId}
        sessionId={sessionId}
        centered={centeredNewSession}
        onQuickStart={handleQuickStart}
        onMessages={handleMessages}
        onStreamStart={() => { setIsStreaming(true); lastStreamActivityRef.current = Date.now(); if (sessionId) pendingTurnSessionsRef.current.add(sessionId); }}
        onThinkingChange={handleThinkingChange}
        onRetryStatusChange={handleRetryStatusChange}
        onDone={handleTurnDone}
        onTurnPersisted={(msgId) => completedBubblesRef.current.add(msgId)}
      />
    </div>
  );
}
