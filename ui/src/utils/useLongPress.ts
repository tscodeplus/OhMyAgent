import React, { useCallback, useRef } from 'react';

/**
 * Long-press (touch) and right-click (mouse) trigger for row context menus.
 *
 * Long-press is the only context-menu gesture a phone has, so it has to survive
 * the things that come with a finger: iOS/Android fire their own context menu
 * (copy / translate / look up) at roughly the same delay, a long-press ends with
 * a synthetic click, and a small jitter while holding should not cancel the
 * gesture — but a real scroll should.
 *
 * Callers spread the returned props onto a row and attach their own `onClick` to
 * a *child*: `onClickCapture` runs first and swallows the click that closes a
 * long press, so the row does not also navigate underneath the open menu.
 */
export function useLongPress(
  onLongPress: (e: React.TouchEvent | React.MouseEvent) => void,
  delay = 500,
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventRef = useRef<React.TouchEvent | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  /** Set when the press turned into a menu — the trailing click must be dropped. */
  const swallowClickRef = useRef(false);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      // Only trigger for single-finger touch
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      if (!touch) return;
      startRef.current = { x: touch.clientX, y: touch.clientY };
      eventRef.current = e;
      clear();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (eventRef.current) {
          swallowClickRef.current = true;
          onLongPress(eventRef.current);
        }
      }, delay);
    },
    [clear, delay, onLongPress],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const start = startRef.current;
      const touch = e.touches[0];
      if (!start || !touch) {
        clear();
        return;
      }
      // A finger drifting a few pixels while holding is still a press; anything
      // further is the start of a scroll and must not open a menu.
      if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) {
        eventRef.current = null;
        clear();
      }
    },
    [clear],
  );

  const onTouchEnd = useCallback(() => {
    clear();
    eventRef.current = null;
    startRef.current = null;
  }, [clear]);

  // Desktop: native contextmenu event (also fired by Android while long-pressing,
  // so it is prevented — the browser menu is exactly what we are replacing).
  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onLongPress(e);
    },
    [onLongPress],
  );

  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (!swallowClickRef.current) return;
    swallowClickRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onContextMenu,
    onClickCapture,
  };
}
