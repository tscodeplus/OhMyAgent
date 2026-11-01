/**
 * Where the floating ball sits, and what it does when the composer is in the
 * way.
 *
 * Two rules, in this order:
 *
 * 1. **The composer wins.** The ball is an accessory; the send button is the
 *    thing the user is reaching for. So the ball never covers the bottom bar: it
 *    lifts itself above `[data-notes-avoid]` whenever that element is on screen.
 *    The composer grows as you type, so the lift is re-measured on resize / focus /
 *    layout changes rather than computed once at mount — and it is measured as the
 *    composer's *height*, never as `innerHeight - top` (see `measure`), because
 *    only the height holds still while a phone is scrolling.
 * 2. **The user's own position is remembered.** Dragging stores `{right, bottom}`
 *    from the viewport's bottom-right corner, so the ball comes back where it was
 *    left on this device. Rule 1 still overrides the stored value when the two
 *    disagree — a remembered position must not put the ball back over the send
 *    button.
 *
 * Why `bottom`/`right` rather than `top`/`left`: the anchor is the corner the ball
 * lives in, so a resize (or the on-screen keyboard) moves it with the edge instead
 * of leaving it stranded mid-screen.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

const STORAGE_KEY = 'oma-notes-ball-pos';
/** `h-14` in NotesFloatingBall — kept in sync by eye, it is one number. */
const BALL_SIZE = 56;
/** Minimum gap to the viewport edge. */
const EDGE = 8;
/** Gap between the ball and the top of the composer. */
const AVOID_GAP = 12;
/** Movement (px) before a press counts as a drag instead of a tap. */
const DRAG_THRESHOLD = 4;

export interface BallPosition {
  right: number;
  bottom: number;
}

function clampToViewport(position: BallPosition): BallPosition {
  const maxRight = Math.max(EDGE, window.innerWidth - BALL_SIZE - EDGE);
  const maxBottom = Math.max(EDGE, window.innerHeight - BALL_SIZE - EDGE);
  return {
    right: Math.min(Math.max(EDGE, Math.round(position.right)), maxRight),
    bottom: Math.min(Math.max(EDGE, Math.round(position.bottom)), maxBottom),
  };
}

function defaultPosition(): BallPosition {
  return { right: window.innerWidth >= 768 ? 24 : 16, bottom: 20 };
}

function loadPosition(): BallPosition {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<BallPosition>;
      if (typeof parsed.right === 'number' && typeof parsed.bottom === 'number') {
        return clampToViewport({ right: parsed.right, bottom: parsed.bottom });
      }
    }
  } catch {
    // A corrupt or unavailable store is not a reason to lose the ball: fall
    // through to the default corner.
  }
  return defaultPosition();
}

export function useBallPlacement(active: boolean) {
  const [position, setPosition] = useState<BallPosition>(loadPosition);
  const [composerLift, setComposerLift] = useState(0);
  const [dragging, setDragging] = useState(false);

  // Read inside pointer handlers that must not close over a stale value.
  const positionRef = useRef(position);
  positionRef.current = position;

  const wasDragRef = useRef(false);
  const dragRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    right: number;
    bottom: number;
  } | null>(null);

  // ── rule 1: keep clear of the composer ───────────────────────────────────
  useEffect(() => {
    if (!active) return;

    /**
     * How far off the bottom the ball has to sit to clear the composer.
     *
     * The composer's own height, deliberately — **not** `innerHeight - rect.top`.
     * The two are equal at rest (the composer is anchored to the bottom of a
     * full-height shell), but only the height is honest while a phone's viewport is
     * mid-change: iOS Safari reports `window.innerHeight` in *visual* viewport
     * space (the keyboard and the collapsing toolbar both move it) while the
     * `fixed inset-0` shell — and therefore the composer — is laid out in *layout*
     * viewport space. Scrolling with the keyboard open, or a swipe that collapses
     * the toolbar, moves one without the other, so the old arithmetic slid the ball
     * up and down relative to the composer under the user's thumb; the viewport then
     * settled, the value came back equal to the height, and the ball snapped home.
     *
     * Measured this way the only input is a number that does not move when the
     * viewport does — which is why nothing here needs `visualViewport` listeners.
     */
    const measure = () => {
      const target = document.querySelector('[data-notes-avoid]');
      if (!target) {
        setComposerLift(0);
        return;
      }
      // 0 means the composer is not rendered (an `hidden` column): "not in the
      // way". There is no scrolled-off-screen case to handle — the composer is a
      // flex child of a fixed full-height column, so it cannot leave the viewport,
      // and a `rect.top >= innerHeight` test would itself be viewport-space churn.
      const height = target.getBoundingClientRect().height;
      if (height === 0) {
        setComposerLift(0);
        return;
      }
      // A lift taller than the screen would put the ball outside it — the composer
      // fills the whole column on the "new session" layout. The cap is the only
      // place a viewport height may appear, and it is a one-off clamp, not an input
      // that drags the ball around.
      const cap = Math.max(0, window.innerHeight - BALL_SIZE - EDGE);
      setComposerLift(Math.max(0, Math.round(Math.min(height + AVOID_GAP, cap))));
    };

    // A scroll can fire a burst of viewport events per frame and a streaming turn
    // mutates the transcript continuously; one measurement per frame is plenty.
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };

    // The composer is re-created on session change (and resizes as the textarea
    // grows and chips appear), so re-resolve the node on every signal and only
    // rebuild the observer when it actually changed — rebuilding it on every DOM
    // mutation of the transcript was pure churn.
    let observer: ResizeObserver | null = null;
    let observed: Element | null = null;
    const attach = () => {
      const target = document.querySelector('[data-notes-avoid]');
      if (target === observed) {
        schedule();
        return;
      }
      observer?.disconnect();
      observer = null;
      observed = target;
      if (target && typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(schedule);
        observer.observe(target);
      }
      // A node swap changes the answer outright, so apply it without the frame of
      // latency the coalescing adds.
      measure();
    };

    attach();
    window.addEventListener('resize', attach);
    // Focus changes are what tell us the on-screen keyboard appeared or went away
    // before layout settles; the height itself still comes from the observer, these
    // only re-resolve the node.
    document.addEventListener('focusin', attach);
    document.addEventListener('focusout', attach);
    const mutations =
      typeof MutationObserver !== 'undefined' ? new MutationObserver(() => attach()) : null;
    // A session switch replaces the composer node; watching the shell catches it
    // without polling. `childList` only — attributes would fire on every class
    // change in the transcript.
    mutations?.observe(document.body, { childList: true, subtree: true });

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      mutations?.disconnect();
      window.removeEventListener('resize', attach);
      document.removeEventListener('focusin', attach);
      document.removeEventListener('focusout', attach);
    };
  }, [active]);

  // A smaller window must not leave the ball outside the screen.
  useEffect(() => {
    if (!active) return;
    const onResize = () => setPosition((prev) => clampToViewport(prev));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [active]);

  // ── rule 2: drag, and remember ───────────────────────────────────────────
  const onPointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      right: positionRef.current.right,
      bottom: positionRef.current.bottom,
    };
    wasDragRef.current = false;
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!wasDragRef.current) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      wasDragRef.current = true;
      setDragging(true);
    }
    setPosition(clampToViewport({ right: drag.right - dx, bottom: drag.bottom - dy }));
  }, []);

  const endDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const moved = wasDragRef.current;
    setDragging(false);
    if (moved) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(positionRef.current));
      } catch {
        // Private mode / quota: the position lives for this session only.
      }
    }
  }, []);

  const style: CSSProperties = {
    right: position.right,
    bottom: Math.max(position.bottom, composerLift),
  };

  return {
    style,
    dragging,
    /** True when the gesture that just ended was a drag, so the tap is not a click. */
    wasDrag: () => wasDragRef.current,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
  };
}
