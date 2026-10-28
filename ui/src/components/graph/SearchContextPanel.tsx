import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, Loader2, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { fetchSearchContext } from '../../utils/api';
import MessageList from '../chat/MessageList';
import type { MessagePageFetcher } from '../chat/MessageList';
import type { SearchContextResponse, SearchResult } from '../../types/graph';
import type { Message } from '../../types/session';

/** Messages of context shown on each side of the hit. */
const CONTEXT_RADIUS = 8;

interface SearchContextPanelProps {
  /** The hit being inspected; null closes the panel. */
  hit: SearchResult | null;
  onClose: () => void;
}

/**
 * Side panel that shows a search hit in its conversation.
 *
 * A snippet answers "does this mention the term" but not "what was going on",
 * and jumping straight to the session loses the search the user just ran. The
 * panel keeps the result list on screen while the surrounding turns load, and
 * offers the full session as a deliberate second step.
 *
 * Rendered as a right-hand column on desktop and a bottom sheet on phones —
 * on a phone a right column would be a sliver, and a full-page navigation would
 * throw away the query.
 */
export default function SearchContextPanel({ hit, onClose }: SearchContextPanelProps) {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const [context, setContext] = useState<SearchContextResponse | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hit || hit.kind !== 'message' || !hit.session_id) {
      setContext(null);
      setStatus('idle');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    setContext(null);
    fetchSearchContext({
      session_id: hit.session_id,
      message_id: hit.id,
      radius: CONTEXT_RADIUS,
    })
      .then((payload) => {
        if (cancelled) return;
        setContext(payload);
        setStatus('idle');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [hit]);

  // The panel opens on the hit, not the top of the window: the question was
  // "what is this message about", and the hit sits in the middle by design.
  useEffect(() => {
    if (!context) return;
    // MessageList renders asynchronously after its own fetch; wait a frame so the
    // focused row exists before scrolling to it.
    const id = window.setTimeout(() => {
      const target = scrollRef.current?.querySelector('[data-focus-hit="true"]');
      target?.scrollIntoView({ block: 'center' });
    }, 60);
    return () => window.clearTimeout(id);
  }, [context]);

  // MessageList owns rendering and scrolling, so the window is handed to it as
  // a one-shot "page": the panel asks for no more history, the footer offers the
  // full session instead.
  const loadPage = useCallback<MessagePageFetcher>(
    async () => ({ messages: context?.messages ?? ([] as Message[]), hasMore: false }),
    [context],
  );

  // Escape closes, matching every other overlay in the WebUI.
  useEffect(() => {
    if (!hit) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hit, onClose]);

  if (!hit) return null;

  const openFullSession = () => {
    if (!context) return;
    const { session } = context;
    navigate(
      session.is_im
        ? `/inbox/${encodeURIComponent(session.id)}`
        : `/p/${encodeURIComponent(session.project_id ?? 'default')}/s/${encodeURIComponent(session.id)}`,
    );
  };

  return (
    <>
      {/* Phone: dimmed backdrop, tap to dismiss. Desktop keeps the list usable. */}
      <button
        type="button"
        aria-label={t('graph.contextClose')}
        onClick={onClose}
        className="fixed inset-0 z-30 bg-black/30 lg:hidden"
      />
      <aside
        role="dialog"
        aria-label={t('graph.contextTitle')}
        className={cn(
          // Phone: bottom sheet, capped so the result list stays reachable.
          'fixed inset-x-0 bottom-0 z-40 flex max-h-[75vh] flex-col rounded-t-2xl border-t border-neutral-200 bg-white shadow-xl',
          // Desktop: a sticky column that scrolls internally. Without the cap a
          // long conversation stretches the whole page and the graph is pushed
          // off-screen instead of staying next to it.
          'lg:sticky lg:top-4 lg:z-auto lg:max-h-[calc(100vh-8rem)] lg:w-[26rem] lg:shrink-0 lg:self-start lg:rounded-xl lg:border lg:shadow-none',
          'dark:border-neutral-800 dark:bg-neutral-900',
        )}
      >
        <header className="flex shrink-0 items-start gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-200">
              {hit.kind === 'message' ? (hit.session_title ?? t('graph.contextTitle')) : hit.title}
            </h2>
            {hit.kind === 'message' && hit.channel && (
              <p className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                {hit.channel}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('graph.contextClose')}
            className="rounded-md p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <X size={14} strokeWidth={1.75} />
          </button>
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
          {hit.kind === 'message' ? (
            status === 'loading' ? (
              <div className="flex justify-center py-8">
                <Loader2
                  size={16}
                  className="animate-spin text-neutral-400 dark:text-neutral-500"
                />
              </div>
            ) : status === 'error' || !context ? (
              <p className="px-2 py-4 text-xs text-red-600 dark:text-red-400">
                {t('graph.contextError')}
              </p>
            ) : (
              <>
                {context.truncated_start && (
                  <p className="px-2 py-1 text-center text-[11px] text-neutral-400 dark:text-neutral-500">
                    {t('graph.contextOlderHidden')}
                  </p>
                )}
                <MessageList
                  loadPage={loadPage}
                  readOnly
                  focusMessageId={context.focus_id ?? undefined}
                />
                {context.truncated_end && (
                  <p className="px-2 py-1 text-center text-[11px] text-neutral-400 dark:text-neutral-500">
                    {t('graph.contextNewerHidden')}
                  </p>
                )}
              </>
            )
          ) : (
            // Memory hits have no conversation of their own; the stored text is
            // the whole artifact, so show it unabridged rather than a snippet.
            <p className="whitespace-pre-wrap break-words px-2 py-2 text-xs leading-relaxed text-neutral-700 dark:text-neutral-300">
              {[hit.title, hit.snippet].filter(Boolean).join('')}
            </p>
          )}
        </div>

        {hit.kind === 'message' && context && (
          <footer className="shrink-0 border-t border-neutral-200 p-2 dark:border-neutral-800">
            <button
              type="button"
              onClick={openFullSession}
              className="flex w-full items-center justify-center gap-1.5 rounded-md bg-neutral-100 py-1.5 text-xs font-medium text-neutral-700 transition-colors hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
            >
              {t('graph.contextOpenSession')}
              <ArrowUpRight size={13} strokeWidth={1.75} />
            </button>
          </footer>
        )}
      </aside>
    </>
  );
}
