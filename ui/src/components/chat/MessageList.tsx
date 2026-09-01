import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown } from 'lucide-react';
import { apiRequest } from '../../utils/api';
import MessageBubble from './MessageBubble';
import type { Message } from '../../types/session';
import Spinner from '../ui/Spinner';
import { CHAT_MEDIA_TOOL_NAMES, isChatMediaUrl } from '../../utils/chatMedia';
import { devLog } from '../../utils/logger';

interface MessageListProps {
  projectId?: string;
  sessionId?: string;
  streamingMessages?: Message[];
  /** True while an SSE stream is active. */
  isStreaming?: boolean;
  /** True while the gateway is thinking (turn_start received, no response yet). */
  isThinking?: boolean;
  /** Transient stream retry/fallback status line (null/undefined = hidden). */
  retryStatus?: string | null;
  /** Increment after each turn completes to refetch from API. */
  refetchKey?: number;
  /** Called after a refetch completes successfully with the fetched snapshot,
   *  so ChatView can prune streaming messages that the snapshot supersedes. */
  onRefetched?: (fetched: Message[]) => void;
  /** Hide the "send a message to start" empty state (used when ChatInput is
   *  rendered centered in new-session mode). */
  hideEmptyState?: boolean;
  /** Reports the loaded history message count per session (after fetch).
   *  Used by ChatView to detect brand-new (empty) sessions. */
  onHistoryCount?: (sessionId: string, count: number) => void;
}

const PAGE_SIZE = 50;
/** Viewport is considered "at the bottom" (auto-follow resumes) within this distance. */
const NEAR_BOTTOM_PX = 40;
/** Scroll events landing within this window after a programmatic snap are
 *  echoes of our own scroll — never treated as user intent. */
const SNAP_GRACE_MS = 120;

export default function MessageList({ projectId: _projectId, sessionId, streamingMessages: externalMessages, isStreaming, isThinking, retryStatus, refetchKey, onRefetched, hideEmptyState, onHistoryCount }: MessageListProps) {
  const { t } = useTranslation('common');
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [oldestCreatedAt, setOldestCreatedAt] = useState<number | string | undefined>(undefined);
  // True while the viewport is unpinned from the bottom — shows the
  // jump-to-bottom button.
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

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
            if (!isChatMediaUrl(url)) continue;
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
            // Only media-emitting tools may surface images in chat (web_search
            // etc. return untrusted snippets full of image links).
            if (tc.output && CHAT_MEDIA_TOOL_NAMES.has(tc.name)) scan(tc.output);
          }
        }
        if (images.length > 0) { msg.images = images; devLog('[MessageList] extracted images for msg', msg.id.slice(0, 8), images); }
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
        if (userFiles.length > 0) { msg.files = userFiles; devLog('[MessageList] extracted files for user msg', msg.id.slice(0, 8), userFiles.length); }
      }
    }
    return data;
  }, []);

  // Fetch latest messages (initial load or after turn complete — replaces all messages)
  // Sequence guard: rapid refetchKey bumps can overlap two requests; a stale
  // response resolving late must never overwrite fresher data.
  const fetchSeqRef = useRef(0);
  const fetchLatest = useCallback(async () => {
    if (!_projectId || !sessionId) return;
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    try {
      const data = await apiRequest<{ messages: Message[]; hasMore: boolean }>(
        `/api/projects/${_projectId}/sessions/${sessionId}?limit=${PAGE_SIZE}`
      );
      if (seq !== fetchSeqRef.current) return; // superseded by a newer request
      formatResponse(data);
      devLog('[MessageList] API fetch OK (latest)', { count: data.messages?.length, hasMore: data.hasMore, refetchKey });
      setMessages(data.messages || []);
      setHasMore(data.hasMore ?? false);
      if (data.messages && data.messages.length > 0) {
        setOldestCreatedAt(data.messages[0].created_at);
      } else {
        setOldestCreatedAt(undefined);
      }
      onRefetched?.(data.messages || []);
    } catch (e) {
      devLog('[MessageList] API fetch FAILED', e);
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  }, [_projectId, sessionId, refetchKey, onRefetched, formatResponse]);

  // Load older messages (prepends to existing list, preserves scroll position)
  const loadMore = useCallback(async () => {
    if (!_projectId || !sessionId || !hasMore || loadingMore || !oldestCreatedAt) return;
    devLog('[MessageList] loadMore triggered', { oldestCreatedAt });
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
      devLog('[MessageList] loadMore OK', { count: data.messages?.length, hasMore: data.hasMore });
      const older = data.messages || [];
      setMessages(prev => [...older, ...prev]);
      setHasMore(data.hasMore ?? false);
      if (older.length > 0) {
        setOldestCreatedAt(older[0].created_at);
      }
    } catch (e) {
      devLog('[MessageList] loadMore FAILED', e);
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

  // Report the loaded history count (after fetch, not during loading) so the
  // parent can detect empty/new sessions.
  useEffect(() => {
    if (sessionId && !loading) onHistoryCount?.(sessionId, messages.length);
  }, [sessionId, loading, messages.length, onHistoryCount]);

  // Restore scroll position after prepending older messages
  useEffect(() => {
    if (prevScrollHeightRef.current > 0 && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop =
        scrollContainerRef.current.scrollHeight - prevScrollHeightRef.current;
      prevScrollHeightRef.current = 0;
    }
  }, [messages]);

  // ---- Auto-follow ("sticky bottom") -------------------------------------
  //
  // Streaming deltas continuously grow the message list; we pin the viewport
  // to the bottom only while the user is actually "following". Three signals
  // drive the flag:
  //
  // 1. wheel / touch gestures — unambiguous user intent captured at the event
  //    level: an upward gesture unfollows immediately. This is what prevents
  //    the old bug where programmatic smooth-scroll animation frames fed
  //    scroll events back into the proximity check and re-armed following
  //    mid-gesture, yanking the view back down on every streaming delta.
  // 2. pure scroll events (scrollbar drag, PageUp/Home keys) — unfollow once
  //    the viewport drifts more than NEAR_BOTTOM_PX from the bottom; rolling
  //    back into that window re-arms following.
  // 3. snaps are instant (no smooth animation), so no animation frames race
  //    the gesture handlers between streaming deltas, and repeated deltas
  //    are coalesced with rAF instead of stacking competing animations.

  const autoFollowRef = useRef(true);
  const rafIdRef = useRef(0);
  const lastTouchYRef = useRef<number | null>(null);
  // Timestamp of the most recent programmatic snap.
  const lastSnapAtRef = useRef(0);

  // Single writer for follow state. setShowJumpToBottom bails out when the
  // value is unchanged, so per-delta / per-scroll-tick calls don't re-render.
  const setFollowing = useCallback((following: boolean) => {
    autoFollowRef.current = following;
    setShowJumpToBottom(!following);
  }, []);

  // Instant snap to bottom, coalesced to at most one scroll per frame.
  // The guard inside the rAF callback is essential: a snap scheduled by a
  // delta that arrived while still following must become a no-op if the
  // user grabs the view before the frame fires — otherwise the next delta
  // skips scrollToBottom() entirely and never cancels the stale rAF,
  // letting it yank the viewport back down and (via the scroll handler)
  // silently re-arm following.
  const scrollToBottom = useCallback(() => {
    cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = requestAnimationFrame(() => {
      if (!autoFollowRef.current) return;
      const el = scrollContainerRef.current;
      if (!el) return;
      lastSnapAtRef.current = performance.now();
      el.scrollTop = el.scrollHeight;
    });
  }, []);

  useEffect(() => () => cancelAnimationFrame(rafIdRef.current), []);

  // Gesture-level intent capture. passive:true is enough — we only observe,
  // never preventDefault. On touch, finger moving DOWN the screen reveals
  // earlier messages → unfollow; moving up is handled by the proximity rule.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      // Only unfollow when there is actually scrollable room above — avoids
      // showing "back to bottom" on fully-visible (short) conversations.
      const el = scrollContainerRef.current;
      if (!el || el.scrollTop <= 0) return;
      if (e.deltaY < 0) setFollowing(false);
    };
    const onTouchStart = (e: TouchEvent) => {
      lastTouchYRef.current = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? null;
      const prev = lastTouchYRef.current;
      // Finger moving DOWN reveals earlier messages → unfollow — but only
      // when the view has actually left the bottom edge (scrollTop > 0);
      // rubber-band overscroll past the newest message must not count.
      const el = scrollContainerRef.current;
      if (!el || el.scrollTop <= 0) return;
      if (y !== null && prev !== null && y > prev) setFollowing(false);
      lastTouchYRef.current = y;
    };

    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
    };
  }, [setFollowing]);

  const handleScrollFollow = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    // Ignore echoes of our own snap — without this, the snap fired by the
    // last following delta would re-arm following right after the user's
    // grab-the-view gesture, restarting the pull-down loop.
    if (performance.now() - lastSnapAtRef.current < SNAP_GRACE_MS) return;
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX);
  }, [setFollowing]);

  // Reset to "following" when the session changes.
  useEffect(() => {
    setFollowing(true);
  }, [sessionId, setFollowing]);

  const handleJumpToBottom = useCallback(() => {
    setFollowing(true);
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [setFollowing]);

  // Auto-scroll to bottom when new messages arrive, thinking indicator shows,
  // retry status appears, or streaming content changes — only while the user
  // is following.
  // Exception: the user's OWN newly-sent message always forces a snap back,
  // even if they were reading history when they hit send.
  useEffect(() => {
    const lastExt = externalMessages?.[externalMessages.length - 1];
    const forceFollow = lastExt?.role === 'user' && !isLoadingMoreRef.current;
    if (forceFollow) setFollowing(true);
    if (!isLoadingMoreRef.current && (forceFollow || autoFollowRef.current)) {
      scrollToBottom();
    }
  }, [messages, externalMessages, isThinking, retryStatus, setFollowing, scrollToBottom]);

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
    devLog('[MessageList] displayMessages merge', {
      apiCount: messages.length,
      extCount: externalMessages.length,
      mergedCount: sorted.length,
    });
    return sorted;
  }, [messages, externalMessages]);

  return (
    <div className="relative flex-1 min-h-0">
      {/* Floating "back to bottom" pill — shown while reading history.
          Doubles as the discoverable way back into "following" mode. */}
      {showJumpToBottom && displayMessages.length > 0 && (
        <button
          type="button"
          onClick={handleJumpToBottom}
          aria-label={t('chat.backToBottom')}
          title={t('chat.backToBottom')}
          className="absolute left-1/2 bottom-4 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-neutral-200/60 bg-white/45 px-4 py-2 text-xs font-medium text-neutral-700 shadow-lg backdrop-blur-[2px] transition-colors hover:bg-white/75 dark:border-neutral-600/60 dark:bg-neutral-800/45 dark:text-neutral-200 dark:hover:bg-neutral-700/60"
        >
          {t('chat.backToBottom')}
          <ArrowDown className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      )}
      <div ref={scrollContainerRef} onScroll={handleScrollFollow} className="h-full overflow-y-auto px-3 sm:px-4 py-2 sm:py-3">
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
      {!loading && displayMessages.length === 0 && !isThinking && !hideEmptyState && (
        <div className="flex items-center justify-center h-full text-neutral-500 dark:text-neutral-400 text-sm">
          {t("chat.sendMessage")}
        </div>
      )}

      <div className="max-w-3xl mx-auto space-y-4">
        {displayMessages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        {/* Stream retry/fallback status — a model attempt failed and the
            gateway is retrying or switching to the next fallback model.
            Inline row: icon pinned to the first text line ((20px line-height
            − 14px icon) / 2 = 3px), hanging indent when the text wraps. */}
        {retryStatus && (
          <div className="flex items-start gap-2 px-1 text-sm text-neutral-500 dark:text-neutral-400">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="mt-[3px] shrink-0 text-amber-600 dark:text-amber-400"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
            <span className="min-w-0">{retryStatus}</span>
          </div>
        )}
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
      </div>
    </div>
  );
}
