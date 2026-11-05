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
import { chatStreamStore } from '../../state/chat-stream-store';
import { useChatStream, useChatTurnComplete } from '../../state/useChatStream';

import type { Session } from '../../types/session';
import type { Message } from '../../types/session';

export default function ChatView() {
  const { projectId, sessionId } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation('common');
  const { showToast } = useToast();
  const { bumpSessionsRefreshKey } = useProject();
  // Streaming state lives in the session-scoped store, so it survives this
  // component unmounting (session switch, navigation, reload + re-attach).
  const stream = useChatStream(sessionId);
  const [refetchKey, setRefetchKey] = useState(0);

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
    setRefetchKey((k) => k + 1);
  }, []);

  // Opening a session is the moment a turn that outlived this tab becomes
  // relevant again: after a reload, a backgrounded window, or a turn started
  // in another tab. Ask the server for its in-flight baseline and continue the
  // live stream instead of showing an empty placeholder. No-op when the store
  // already holds a live stream (or already checked this session).
  useEffect(() => {
    if (!projectId || !sessionId) return;
    chatStreamStore.ensureAttached(sessionId, projectId);

    // Phones and PWAs rarely reload: the tab is suspended and resumed in
    // place. Re-probe this session on wake-up so a turn that started while the
    // app was in the background (another device, another tab, or this one
    // before the OS froze it) shows up live instead of waiting for its
    // completion push.
    const onWake = () => chatStreamStore.handleWake(sessionId, projectId);
    const onVisible = () => {
      if (document.visibilityState === 'visible') onWake();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onWake);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onWake);
    };
  }, [projectId, sessionId]);

  // A turn's `done`/`error` means the server persisted it — refetch history and
  // let MessageList prune the streaming bubbles (see handleRefetched).
  useChatTurnComplete(sessionId, triggerRefetch);

  // Listen for agent turn completion notifications via WebSocket.
  // When the SSE connection is lost mid-stream (page refresh, browser close,
  // navigation away), the agent keeps running on the server and persists
  // messages on completion. This WebSocket push triggers a refetch so the
  // UI auto-updates without the user needing to manually refresh.
  const { subscribe } = useWebSocket();
  useEffect(() => {
    if (!sessionId) return;
    return subscribe('agent_turn_complete', (data: any) => {
      if (data.sessionId !== sessionId) return;
      devLog('[ChatView] agent_turn_complete via WS — triggering refetch');
      // A live stream of our own handles its own done; refetching mid-stream
      // is still safe (pruning only drops bubbles the snapshot supersedes).
      triggerRefetch();
    });
  }, [subscribe, sessionId, triggerRefetch]);

  /**
   * Prune streaming messages against a fresh API snapshot after a successful
   * refetch. Decisions live in the store (it owns the bubbles).
   */
  const handleRefetched = useCallback(
    (fetched?: Message[]) => {
      devLog('[ChatView] handleRefetched — pruning streaming messages');
      chatStreamStore.pruneAfterRefetch(sessionId, fetched ?? []);
    },
    [sessionId],
  );

  // Sessions known to hold history messages. A session NOT in this set (and
  // with no live streaming messages) is treated as a brand-new conversation:
  // its input renders centered (slightly below middle) instead of at the
  // bottom, and switches back to the bottom dock once the first message is
  // sent. Entries are only added (never removed) so returning to a session
  // with history doesn't flash the centered layout while the history fetches.
  const [nonEmptySessions, setNonEmptySessions] = useState<Set<string>>(() => new Set());
  const handleHistoryCount = useCallback((sid: string, count: number) => {
    if (count <= 0) return;
    setNonEmptySessions((prev) => {
      if (prev.has(sid)) return prev;
      const next = new Set(prev);
      next.add(sid);
      return next;
    });
  }, []);

  /** Create a session and navigate to it; the typed text rides along via
   *  navigation state and ChatInput auto-sends it as the first message.
   *  Called by ChatInput when the user sends with no session selected. */
  const handleQuickStart = useCallback(
    async (text: string) => {
      if (!projectId || !text.trim()) return;
      try {
        const session = await apiRequest<Session>(`/api/projects/${projectId}/sessions`, {
          method: 'POST',
          body: JSON.stringify({ baseTitle: t('chat.newSession') }),
        });
        bumpSessionsRefreshKey();
        navigate(`/p/${projectId}/s/${session.id}`, { state: { initialMessage: text.trim() } });
      } catch {
        showToast(t('chat.createSessionError'), 'error');
      }
    },
    [projectId, navigate, bumpSessionsRefreshKey, showToast, t],
  );

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
  const centeredNewSession =
    !sessionId ||
    (!nonEmptySessions.has(sessionId) &&
      stream.messages.length === 0 &&
      !stream.thinking &&
      !stream.sending);

  return (
    <div className="flex h-full flex-col">
      <div className={centeredNewSession ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
        {sessionId && (
          <MessageList
            key={sessionId}
            projectId={projectId}
            sessionId={sessionId}
            streamingMessages={stream.messages}
            isStreaming={stream.live}
            isThinking={stream.thinking}
            retryStatus={stream.retryStatus}
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
      />
    </div>
  );
}
