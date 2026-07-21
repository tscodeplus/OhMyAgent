import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { apiRequest } from '../../utils/api';
import MessageBubble from './MessageBubble';
import type { Message } from '../../types/session';
import Spinner from '../ui/Spinner';

interface MessageListProps {
  projectId?: string;
  sessionId?: string;
  streamingMessages?: Message[];
  /** True while an SSE stream is active. */
  isStreaming?: boolean;
  /** True while the gateway is thinking (turn_start received, no response yet). */
  isThinking?: boolean;
  /** Increment after each turn completes to refetch from API. */
  refetchKey?: number;
  /** Called after a refetch completes successfully — signals ChatView to clean up streaming messages. */
  onRefetched?: () => void;
}

const PAGE_SIZE = 50;

export default function MessageList({ projectId: _projectId, sessionId, streamingMessages: externalMessages, isStreaming, isThinking, refetchKey, onRefetched }: MessageListProps) {
  const { t } = useTranslation('common');
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [oldestCreatedAt, setOldestCreatedAt] = useState<number | string | undefined>(undefined);

  const bottomRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const prevScrollHeightRef = useRef(0);
  // True while a "load more" is in progress — suppress auto-scroll to bottom.
  const isLoadingMoreRef = useRef(false);

  // Stable refs for IntersectionObserver closure
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  const loadingMoreRef = useRef(loadingMore);
  loadingMoreRef.current = loadingMore;

  const formatResponse = useCallback((data: { messages: Message[]; hasMore: boolean }) => {
    // Re-extract images from markdown content AND tool call outputs
    // (frontend-only fields, not persisted by the API).
    const imgRegex = /!\[([^\[\]]*)\]\(([^)\s]+)\)/g;
    const fileLinkRegex = /\[([^\[\]]+)\]\((\/(?:api\/files\/(?:serve|download)\?[^)\s]+|dl\/[^)\s]+|desktop-bridge-download\?[^)\s]+))\)/g;
    for (const msg of (data.messages || [])) {
      if (msg.role === 'assistant') {
        const images: { url: string; alt?: string }[] = [];
        const seen = new Set<string>();
        const scan = (text: string) => {
          imgRegex.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = imgRegex.exec(text)) !== null) {
            const url = m[2];
            if (!seen.has(url)) {
              seen.add(url);
              images.push({ alt: m[1] || undefined, url });
            }
          }
        };
        scan(msg.content);
        // Also scan tool call outputs (webui_send_media puts images here)
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            if (tc.output) scan(tc.output);
          }
        }
        if (images.length > 0) { msg.images = images; console.log('[MessageList] extracted images for msg', msg.id.slice(0, 8), images); }
      }
      // Fallback: extract file links from user message content (uploaded attachments)
      // in case the API response doesn't include them in msg.files
      if (msg.role === 'user' && !msg.files) {
        const userFiles: { name: string; path: string }[] = [];
        const ufSeen = new Set<string>();
        fileLinkRegex.lastIndex = 0;
        let ufm: RegExpExecArray | null;
        while ((ufm = fileLinkRegex.exec(msg.content)) !== null) {
          const url = ufm[2];
          if (!ufSeen.has(url)) {
            ufSeen.add(url);
            userFiles.push({ name: ufm[1], path: url });
          }
        }
        if (userFiles.length > 0) { msg.files = userFiles; console.log('[MessageList] extracted files for user msg', msg.id.slice(0, 8), userFiles.length); }
      }
    }
    return data;
  }, []);

  // Fetch latest messages (initial load or after turn complete — replaces all messages)
  const fetchLatest = useCallback(async () => {
    if (!_projectId || !sessionId) return;
    setLoading(true);
    try {
      const data = await apiRequest<{ messages: Message[]; hasMore: boolean }>(
        `/api/projects/${_projectId}/sessions/${sessionId}?limit=${PAGE_SIZE}`
      );
      formatResponse(data);
      console.log('[MessageList] API fetch OK (latest)', { count: data.messages?.length, hasMore: data.hasMore, refetchKey });
      setMessages(data.messages || []);
      setHasMore(data.hasMore ?? false);
      if (data.messages && data.messages.length > 0) {
        setOldestCreatedAt(data.messages[0].created_at);
      } else {
        setOldestCreatedAt(undefined);
      }
      onRefetched?.();
    } catch (e) {
      console.log('[MessageList] API fetch FAILED', e);
    } finally {
      setLoading(false);
    }
  }, [_projectId, sessionId, refetchKey, onRefetched, formatResponse]);

  // Load older messages (prepends to existing list, preserves scroll position)
  const loadMore = useCallback(async () => {
    if (!_projectId || !sessionId || !hasMore || loadingMore || !oldestCreatedAt) return;
    console.log('[MessageList] loadMore triggered', { oldestCreatedAt });
    setLoadingMore(true);
    isLoadingMoreRef.current = true;
    // Record scrollHeight before DOM update so we can restore position
    if (scrollContainerRef.current) {
      prevScrollHeightRef.current = scrollContainerRef.current.scrollHeight;
    }
    try {
      const data = await apiRequest<{ messages: Message[]; hasMore: boolean }>(
        `/api/projects/${_projectId}/sessions/${sessionId}?before=${encodeURIComponent(oldestCreatedAt)}&limit=${PAGE_SIZE}`
      );
      formatResponse(data);
      console.log('[MessageList] loadMore OK', { count: data.messages?.length, hasMore: data.hasMore });
      const older = data.messages || [];
      setMessages(prev => [...older, ...prev]);
      setHasMore(data.hasMore ?? false);
      if (older.length > 0) {
        setOldestCreatedAt(older[0].created_at);
      }
    } catch (e) {
      console.log('[MessageList] loadMore FAILED', e);
    } finally {
      setLoadingMore(false);
      isLoadingMoreRef.current = false;
    }
  }, [_projectId, sessionId, hasMore, loadingMore, oldestCreatedAt, formatResponse]);

  // Store loadMore in a ref so IntersectionObserver can always call the latest version
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;

  // Initial fetch + refetch when refetchKey changes
  useEffect(() => {
    fetchLatest();
  }, [fetchLatest]);

  // IntersectionObserver on the top sentinel — triggers loadMore when
  // the user scrolls to the top and there are more messages to load.
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    if (!sentinel) return;
    // Only observe when there are more messages to load
    if (!hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMoreRef.current && !loadingMoreRef.current) {
          loadMoreRef.current();
        }
      },
      { root: scrollContainerRef.current, threshold: 0 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore]);

  // Restore scroll position after prepending older messages
  useEffect(() => {
    if (prevScrollHeightRef.current > 0 && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop =
        scrollContainerRef.current.scrollHeight - prevScrollHeightRef.current;
      prevScrollHeightRef.current = 0;
    }
  }, [messages]);

  // Auto-scroll to bottom when new messages arrive, thinking indicator shows,
  // or streaming content changes. Skip when loading older history.
  useEffect(() => {
    if (!isLoadingMoreRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, externalMessages, isThinking]);

  // Merge API history with live streaming messages, deduplicating by ID.
  const displayMessages = useMemo(() => {
    if (!externalMessages || externalMessages.length === 0) return messages;
    const seen = new Set(messages.map(m => m.id));
    const merged = [...messages];
    for (const em of externalMessages) {
      if (!seen.has(em.id)) {
        merged.push(em);
        seen.add(em.id);
      }
    }
    const sorted = merged.sort((a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
    console.log('[MessageList] displayMessages merge', {
      apiCount: messages.length,
      extCount: externalMessages.length,
      mergedCount: sorted.length,
    });
    return sorted;
  }, [messages, externalMessages]);

  return (
    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-3 sm:px-4 py-2 sm:py-3">
      {/* Top sentinel for infinite scroll — IntersectionObserver watches this */}
      <div ref={topSentinelRef} className="h-px" />

      {/* Loading spinner for initial load (no messages yet) */}
      {loading && displayMessages.length === 0 && (
        <div className="flex justify-center py-8">
          <Spinner size="sm" />
        </div>
      )}

      {/* Loading spinner for "load more" at top */}
      {loadingMore && (
        <div className="flex justify-center py-3">
          <Spinner size="sm" />
        </div>
      )}

      {/* Empty state */}
      {!loading && displayMessages.length === 0 && !isThinking && (
        <div className="flex items-center justify-center h-full text-neutral-500 dark:text-neutral-400 text-sm">
          {t("chat.sendMessage")}
        </div>
      )}

      <div className="max-w-3xl mx-auto space-y-4">
        {displayMessages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        {/* Thinking indicator — shown in message flow like Feishu/Lark */}
        {isThinking && (
          <div className="flex gap-3">
            <div className="shrink-0 flex h-7 w-7 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14l2 2 3-3"/></svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="rounded-xl px-3 sm:px-4 py-2 sm:py-2.5 text-sm text-neutral-500 dark:text-neutral-400">
                {t('chat.thinking')}
                <span className="thinking-dot">.</span>
                <span className="thinking-dot">.</span>
                <span className="thinking-dot">.</span>
              </div>
            </div>
          </div>
        )}
      </div>
      <div ref={bottomRef} />
    </div>
  );
}
