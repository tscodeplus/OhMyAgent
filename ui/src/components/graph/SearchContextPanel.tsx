import { useCallback, useEffect, useState } from 'react';
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
  /** The hit being inspected; null closes the drawer. */
  hit: SearchResult | null;
  onClose: () => void;
  /**
   * Measured box of the result list, so the drawer spans exactly that column on
   * wide screens. Null on phones (or before the first measurement falls back to
   * the CSS defaults), where the sheet stays full-bleed.
   */
  box?: { left: number; width: number } | null;
}

/**
 * Drawer that shows a search hit in its conversation.
 *
 * A snippet answers "does this mention the term" but not "what was going on",
 * and jumping straight to the session loses the search the user just ran. The
 * drawer keeps the result list on screen while the surrounding turns load, and
 * offers the full session as a deliberate second step.
 *
 * A bottom sheet on every viewport, not a side column: as a column it competed
 * with the graph for the same horizontal band, sat below the query box, and was
 * easy to miss entirely on a wide screen — a conversation transcript is the
 * wrong shape for a 26rem stripe. Full width along the bottom makes its
 * appearance unmissable and gives the transcript the line length it wants;
 * on large screens it is centred and capped so it still reads as a sheet
 * rather than as a new page.
 */
export default function SearchContextPanel({ hit, onClose, box }: SearchContextPanelProps) {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const [context, setContext] = useState<SearchContextResponse | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');

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
      {/* Backdrop on every viewport: the dimming is what makes the drawer
          unmistakable, and tapping outside is the fastest way out. */}
      <button
        type="button"
        aria-label={t('graph.contextClose')}
        onClick={onClose}
        className="fixed inset-0 z-30 bg-black/40"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={t('graph.contextTitle')}
        // Inline box wins on wide screens: it is the measured rect of the result
        // list, which is narrower than the viewport and starts after the sidebar.
        style={box ? { left: box.left, right: 'auto', width: box.width } : undefined}
        className={cn(
          'fixed inset-x-0 bottom-0 z-40 flex flex-col border-t bg-white shadow-2xl dark:bg-neutral-900',
          'max-h-[78vh] rounded-t-2xl border-neutral-200 sm:max-h-[72vh] dark:border-neutral-800',
          // Fallback when no measurement is available yet: centred and capped, so
          // the first frame cannot flash a full-width sheet.
          !box && 'sm:mx-auto sm:max-w-3xl sm:rounded-2xl sm:border sm:border-b-0',
          box && 'sm:rounded-2xl sm:border sm:border-b-0',
        )}
      >
        {/* Grab handle: the standard cue that this surface was pulled up from
            the bottom edge and can be dismissed. */}
        <div className="flex shrink-0 justify-center pt-2">
          <span className="h-1 w-10 rounded-full bg-neutral-300 dark:bg-neutral-700" />
        </div>
        <header className="flex shrink-0 items-start gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-200">
              {hit.kind === 'message' ? (hit.session_title ?? t('graph.contextTitle')) : hit.title}
            </h2>
            <p className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">
              {hit.kind === 'message'
                ? [hit.channel, t('graph.contextHitIn')].filter(Boolean).join(' · ')
                : t(`graph.kinds.${hit.kind}`)}
            </p>
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

        <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
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
          <footer className="shrink-0 border-t border-neutral-200 p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] dark:border-neutral-800">
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
