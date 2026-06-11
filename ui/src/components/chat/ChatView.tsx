import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bot, Send } from 'lucide-react';
import { apiRequest } from '../../utils/api';
import { isElectron } from '../../utils/env';
import { useProject } from '../../contexts/ProjectContext';
import { useToast } from '../ui/Toast';
import MessageList from './MessageList';
import ChatInput from './ChatInput';

import type { Session } from '../../types/session';
import type { Message } from '../../types/session';

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
  const [refetchKey, setRefetchKey] = useState(0);

  // Tracks whether a new SSE stream has started since the last refetch was
  // triggered. Prevents handleRefetched from wiping freshly-added streaming
  // messages when the user sends a new message during an in-flight API fetch.
  const streamGenerationRef = useRef(0);

  // Clear streaming messages when switching sessions to prevent
  // approval records / tool calls from one session leaking into another.
  useEffect(() => {
    setStreamMessages([]);
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

  const handleTurnDone = useCallback(() => {
    console.log('[ChatView] handleTurnDone — switching to API mode');
    setIsStreaming(false);
    setRefetchKey(k => k + 1);
    // Don't clear streamMessages here — MessageList.onRefetched will do it
    // after the API fetch succeeds, preventing message flash/disappearance.
  }, []);

  const handleRefetched = useCallback(() => {
    console.log('[ChatView] handleRefetched — clearing streamMessages (API fetch succeeded)');
    setStreamMessages(prev => {
      // Decrement counter if active; if a new stream has started since this
      // refetch was triggered, keep streaming messages to avoid a gap.
      if (streamGenerationRef.current > 0) {
        streamGenerationRef.current--;
        console.log('[ChatView] handleRefetched — skipped clear, new stream active (count=', streamGenerationRef.current, ')');
        return prev;
      }
      // Only keep approval messages (streaming-only, not persisted by API)
      const kept = prev.filter(m => m.approval);
      streamGenerationRef.current = 0;
      if (kept.length > 0) console.log('[ChatView] keeping approval messages after refetch', kept.map(m => m.id.slice(0, 12)));
      return kept;
    });
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
        ? prev.filter(m => m.approval)
        : prev;
      const existing = new Map(base.map(m => [m.id, m]));
      for (const msg of msgs) {
        const old = existing.get(msg.id);
        const isNew = !old;
        // Preserve tool_calls from old message if the new update
        // (e.g. text_delta) doesn't carry them — prevents tool cards
        // from being pushed to the bottom or disappearing.
        if (old?.tool_calls && !msg.tool_calls) {
          msg.tool_calls = old.tool_calls;
        }
        existing.set(msg.id, msg);
        if (isNew) {
          console.log('[ChatView] handleMessages — NEW message', { id: msg.id.slice(0, 8), role: msg.role, createdAt: msg.created_at, hasContent: !!msg.content, contentLen: msg.content?.length, hasSegments: !!(msg as any).segments });
        }
      }
      const merged = Array.from(existing.values()).sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      console.log('[ChatView] streamMessages updated', { count: merged.length, order: merged.map(m => `${m.role[0]}:${m.id.slice(0, 8)}(${String(m.created_at ?? '').slice(11,19)})`), approvals: merged.filter(m => m.approval).length });
      return merged;
    });
  }, []);

  // Wrapped version that also resets the stream generation counter.
  // When a new user message arrives in a fresh turn, old streaming messages
  // are cleared, so the counter guard in handleRefetched is no longer needed.
  const handleMessagesWithReset = useCallback((msgs: Message[], clearPrevious?: boolean) => {
    if (msgs.some(m => m.role === 'user') && clearPrevious !== false) {
      streamGenerationRef.current = 0;
    }
    handleMessages(msgs, clearPrevious);
  }, [handleMessages]);

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
        <MessageList projectId={projectId} sessionId={sessionId} streamingMessages={streamMessages} isStreaming={isStreaming} refetchKey={refetchKey} onRefetched={handleRefetched} />
        <ChatInput projectId={projectId} sessionId={sessionId} onMessages={handleMessagesWithReset} onStreamStart={() => { setIsStreaming(true); streamGenerationRef.current++; }} onDone={handleTurnDone} />
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
      <div className="shrink-0 border-t border-neutral-200 bg-white px-3 sm:px-4 py-3 sm:py-4 pb-6 sm:pb-8 dark:border-neutral-800 dark:bg-neutral-950">
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
