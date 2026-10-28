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
/** Fraction of the sheet's height a downward drag must cover to dismiss it. */
const DRAG_DISMISS_RATIO = 0.25;
/** Floor for that threshold, so a short sheet is not closed by a stray nudge. */
const DRAG_DISMISS_MIN_PX = 72;
/** Flick speed (px/ms) that dismisses regardless of distance. */
const DRAG_DISMISS_VELOCITY = 0.5;
/** Movement below this is a tap, not a drag — keeps the handle's click working. */
const DRAG_TAP_TOLERANCE_PX = 4;

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

  // Drag-to-dismiss state for the sheet. `offset` is the live finger distance;
  // `dragging` disables the CSS transition while the finger is down.
  const sheetRef = useRef<HTMLElement | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startedAt: number;
    moved: number;
  } | null>(null);
  /** Set when a drag ended, so the click that follows a drag is not a dismissal. */
  const draggedRef = useRef(false);
  const closeTimerRef = useRef(0);

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

  useEffect(() => () => window.clearTimeout(closeTimerRef.current), []);

  const beginDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startedAt: Date.now(),
      moved: 0,
    };
    draggedRef.current = false;
    setDragging(true);
    // Capture so a fast flick that leaves the handle still reports its end.
    // Guarded: Safari throws when the pointer is already gone (a touch that
    // lifted between React's dispatch and this handler), and losing the gesture
    // must not turn into an unhandled error in the middle of the page.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // No capture means the pointerup arrives on whatever element is under the
      // finger; endDrag also runs from onPointerCancel for that case.
    }
  };

  const moveDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = event.clientY - drag.startY;
    drag.moved = Math.max(drag.moved, Math.abs(delta));
    // Upward drags are ignored rather than allowed: the sheet is already as tall
    // as it gets, and a rubber-band upward looks like a broken full-screen mode.
    setDragOffset(Math.max(0, delta));
  };

  const endDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Same as above: a released pointer is not an error worth surfacing.
    }

    if (drag.moved > DRAG_TAP_TOLERANCE_PX) draggedRef.current = true;

    const height = sheetRef.current?.offsetHeight ?? 0;
    const threshold = Math.max(DRAG_DISMISS_MIN_PX, height * DRAG_DISMISS_RATIO);
    const velocity = dragOffset / Math.max(1, Date.now() - drag.startedAt);
    if (dragOffset >= threshold || velocity >= DRAG_DISMISS_VELOCITY) {
      // Slide the rest of the way out before unmounting: the drawer vanishing
      // mid-drag reads as a glitch, the follow-through reads as cause and effect.
      const exit = Math.max(dragOffset, height || 240);
      setDragOffset(exit);
      closeTimerRef.current = window.setTimeout(onClose, 160);
      return;
    }
    setDragOffset(0);
  };

  const handleGrabClick = () => {
    // A drag ends with a click in some browsers; only a clean tap dismisses.
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    onClose();
  };

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
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('graph.contextTitle')}
        // Inline box wins on wide screens: it is the measured rect of the result
        // list, which is narrower than the viewport and starts after the sidebar.
        style={{
          ...(box ? { left: box.left, right: 'auto', width: box.width } : {}),
          transform: dragOffset > 0 ? `translateY(${dragOffset}px)` : undefined,
          transition: dragging ? 'none' : 'transform 180ms ease-out',
        }}
        className={cn(
          'fixed inset-x-0 bottom-0 z-40 flex flex-col border-t bg-white shadow-2xl dark:bg-neutral-900',
          'max-h-[78vh] rounded-t-2xl border-neutral-200 sm:max-h-[72vh] dark:border-neutral-800',
          // Fallback when no measurement is available yet: centred and capped, so
          // the first frame cannot flash a full-width sheet.
          !box && 'sm:mx-auto sm:max-w-3xl sm:rounded-2xl sm:border sm:border-b-0',
          box && 'sm:rounded-2xl sm:border sm:border-b-0',
        )}
      >
        {/* Grab handle: pulled up from the bottom edge, so pulling it back down
            is the gesture the shape promises. It is a button as well — tapping it
            dismisses — and the drag starts here rather than on the whole sheet,
            because the transcript below owns vertical drags as scrolling. */}
        <button
          type="button"
          onClick={handleGrabClick}
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          aria-label={t('graph.contextCollapse')}
          className="flex w-full shrink-0 cursor-grab touch-none justify-center pb-1 pt-2 active:cursor-grabbing"
        >
          <span className="h-1 w-10 rounded-full bg-neutral-300 dark:bg-neutral-700" />
        </button>
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
