/**
 * Where the floating ball sits, and what it does when the composer is in the
 * way.
 *
 * Two rules, in this order:
 *
 * 1. **The composer wins.** The ball is an accessory; the send button is the
 *    thing the user is reaching for. So an untouched ball sits `AVOID_GAP` above
 *    the composer's top edge, in its usual corner, and is re-measured on resize /
 *    focus / layout changes rather than computed once at mount.
 *    Which way it is measured is the marker's own business, because the marker is
 *    what knows where the box is: `[data-notes-avoid]` is a bottom bar (its height
 *    *is* its distance from the bottom), `[data-notes-avoid="centered"]` is a box
 *    floating mid-column (its top edge has to be read off the viewport). Get this
 *    wrong and the ball lifts itself by the height of the screen — it lands in the
 *    top corner, above the edge its menu opens toward, and a tap looks like a dead
 *    button. See `ChatInput` for which layout marks which.
 * 2. **The user's own position is remembered.** Dragging stores `{right, bottom}`
 *    from the viewport's bottom-right corner, so the ball comes back where it was
 *    left on this device — and from then on that position wins, including over
 *    rule 1. Rule 1 only nudges a ball that is *on* the composer (`resolveBottom`),
 *    because a rule enforced as a floor rather than as an overlap test makes the
 *    ball undraggable in any layout where there is free space on the other side of
 *    the box.
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
/** Gap between the ball and the box it stands beside. */
const AVOID_GAP = 12;
/** Movement (px) before a press counts as a drag instead of a tap. */
const DRAG_THRESHOLD = 4;

export interface BallPosition {
  right: number;
  bottom: number;
}

/**
 * The composer, in the units the ball is placed in: distances off the column's
 * bottom edge.
 */
interface Composer {
  /** Where the ball lives if the user has never moved it: just above the box. */
  lift: number;
  /** Where the box is, as a band of `bottom`/`right` values — for snapping out. */
  band: { fromBottom: number; toBottom: number; fromRight: number; toRight: number };
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

function sameComposer(a: Composer | null, b: Composer | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.lift === b.lift &&
    a.band.fromBottom === b.band.fromBottom &&
    a.band.toBottom === b.band.toBottom &&
    a.band.fromRight === b.band.fromRight &&
    a.band.toRight === b.band.toRight
  );
}

/**
 * A remembered position, and whether it is one the *user* chose.
 *
 * The two are not the same thing and the difference is visible: with no remembered
 * position the ball belongs above the composer, while a position someone picked
 * belongs wherever they dropped it. Deriving the first from the second is how the
 * ball ends up pinned over the composer on every page, unable to be moved.
 */
function loadPlacement(): { position: BallPosition; placed: boolean } {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<BallPosition>;
      if (typeof parsed.right === 'number' && typeof parsed.bottom === 'number') {
        return {
          position: clampToViewport({ right: parsed.right, bottom: parsed.bottom }),
          placed: true,
        };
      }
    }
  } catch {
    // A corrupt or unavailable store is not a reason to lose the ball: fall
    // through to the default corner.
  }
  return { position: defaultPosition(), placed: false };
}

/**
 * The nearest `bottom` that does not put the ball on the composer.
 *
 * Only a *chosen* position is ever moved this way (see `placed`): the ball is a
 * thing you can drag, and a drag that lands somewhere is the answer unless it lands
 * on the send button. The old rule — `bottom = max(dragged, lift)` — could not tell
 * the two apart, so in the centred new-session layout, where the composer sits
 * mid-column with free space underneath it, dragging the ball down did nothing at
 * all and the ball could never be brought near the input.
 */
function resolveBottom(position: BallPosition, composer: Composer | null): number {
  if (!composer) return position.bottom;
  const { fromBottom, toBottom, fromRight, toRight } = composer.band;
  // Both boxes are measured off the same corner, so this is a plain overlap test.
  const hitsX =
    position.right < toRight + AVOID_GAP && position.right + BALL_SIZE > fromRight - AVOID_GAP;
  const hitsY =
    position.bottom < toBottom + AVOID_GAP && position.bottom + BALL_SIZE > fromBottom - AVOID_GAP;
  if (!hitsX || !hitsY) return position.bottom;
  // Out the short way: whichever side of the box the drop is closer to, and only
  // the side that leaves the ball on screen at all — a docked bar has no room
  // underneath it, which is why it always resolves upward.
  const above = toBottom + AVOID_GAP;
  const below = fromBottom - BALL_SIZE - AVOID_GAP;
  const maxBottom = Math.max(EDGE, window.innerHeight - BALL_SIZE - EDGE);
  const canAbove = above <= maxBottom;
  const canBelow = below >= EDGE;
  if (
    canAbove &&
    (!canBelow || Math.abs(above - position.bottom) <= Math.abs(below - position.bottom))
  ) {
    return above;
  }
  return canBelow ? below : position.bottom;
}

export function useBallPlacement(active: boolean) {
  const [{ position, placed }, setPlacement] = useState(loadPlacement);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [dragging, setDragging] = useState(false);

  // Read inside pointer handlers that must not close over a stale value.
  const positionRef = useRef(position);
  positionRef.current = position;

  const wasDragRef = useRef(false);
  /** The `bottom` actually on screen — see the assignment next to `style`. */
  const renderedRef = useRef(position.bottom);
  const dragRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    right: number;
    bottom: number;
  } | null>(null);

  // ── rule 1: keep clear of the composer ───────────────────────────────────
  useEffect(() => {
    if (!active) {
      setComposer(null);
      return;
    }

    /**
     * Where the composer is, and therefore where the ball belongs.
     *
     * For a *docked* composer, just above it = its own height, deliberately —
     * **not** `innerHeight - rect.top`. The two are equal at rest (the composer is
     * anchored to the bottom of a full-height shell), but only the height is honest
     * while a phone's viewport is mid-change: iOS Safari reports `window.innerHeight`
     * in *visual* viewport space (the keyboard and the collapsing toolbar both move
     * it) while the `fixed inset-0` shell — and therefore the composer — is laid out
     * in *layout* viewport space. Scrolling with the keyboard open, or a swipe that
     * collapses the toolbar, moves one without the other, so the old arithmetic slid
     * the ball up and down relative to the composer under the user's thumb; the
     * viewport then settled, the value came back equal to the height, and the ball
     * snapped home.
     *
     * A *centred* composer (`data-notes-avoid="centered"`, the new-session layout)
     * has no such number — it floats mid-column, so "just above it" is necessarily
     * a viewport measurement. That is fine here for the reason the height trick
     * exists: a centred composer is itself positioned off the viewport, so the ball
     * has to be too if it is to stay glued to the box while the keyboard opens.
     */
    const measure = () => {
      const target = document.querySelector('[data-notes-avoid]');
      if (!target) {
        setComposer(null);
        return;
      }
      // 0 means the composer is not rendered (an `hidden` column): "not in the
      // way". There is no scrolled-off-screen case to handle — the composer is a
      // flex child of a fixed full-height column, so it cannot leave the viewport,
      // and a `rect.top >= innerHeight` test would itself be viewport-space churn.
      const rect = target.getBoundingClientRect();
      if (rect.height === 0) {
        setComposer(null);
        return;
      }
      const centered = target.getAttribute('data-notes-avoid') === 'centered';
      /**
       * The box's own top edge, off the bottom of the column.
       *
       * A bottom bar is flush with the column's bottom, so its height *is* that
       * distance and nothing has to ask where anything is. A centred box is not
       * flush: the ball's home is `AVOID_GAP` above the box's top edge, the same
       * relationship as when the box is docked — which is what the marker is for.
       */
      const boxTop = centered ? window.innerHeight - rect.top : rect.height;
      const boxBottom = centered ? window.innerHeight - rect.bottom : 0;
      // A lift taller than the screen would put the ball outside it; this only
      // catches a measurement taken mid-relayout — a shrinking viewport whose
      // composer has not been re-laid-out yet. It is a one-off clamp, not an input
      // that drags the ball around.
      const cap = Math.max(0, window.innerHeight - BALL_SIZE - EDGE);
      const next: Composer = {
        lift: Math.max(0, Math.round(Math.min(boxTop + AVOID_GAP, cap))),
        band: {
          fromBottom: boxBottom,
          toBottom: boxTop,
          fromRight: Math.round(window.innerWidth - rect.right),
          toRight: Math.round(window.innerWidth - rect.left),
        },
      };
      // Same object back = same answer: a streaming turn mutates the transcript
      // continuously, and a fresh object per measurement would re-render the ball on
      // every frame for nothing.
      setComposer((prev) => (sameComposer(prev, next) ? prev : next));
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
    const onResize = () =>
      setPlacement((prev) => ({ placed: prev.placed, position: clampToViewport(prev.position) }));
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
      bottom: renderedRef.current,
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
    // A drag is the user placing the ball, so from here on its position is theirs
    // to keep — it is only ever nudged off the composer itself (see `resolveBottom`).
    setPlacement({
      placed: true,
      position: clampToViewport({ right: drag.right - dx, bottom: drag.bottom - dy }),
    });
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
    // Two rules, and the order matters: an untouched ball lives above the composer,
    // a ball the user dropped stays where they dropped it unless that is *on* the
    // composer. See `loadPlacement` and `resolveBottom`.
    bottom: placed
      ? resolveBottom(position, composer)
      : Math.max(position.bottom, composer?.lift ?? 0),
  };

  // What the user sees, as opposed to what is remembered: a drag has to start from
  // here. Starting from the remembered `bottom` made the ball jump on the first
  // pixel of a downward drag whenever the two disagree — which they do by design,
  // since the remembered value is the corner and the rendered one is above the
  // composer.
  renderedRef.current = Number(style.bottom);

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
