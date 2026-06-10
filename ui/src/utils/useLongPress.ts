import { useCallback, useRef } from 'react';

/**
 * Returns a callback that fires on long-press (touch or mouse hold).
 * Falls back to onContextMenu on desktop, and adds touch long-press for iOS/Android.
 *
 * Usage: spread the returned props onto the target element, and pass
 * a callback that receives the React touch/mouse event.
 */
export function useLongPress(onLongPress: (e: React.TouchEvent | React.MouseEvent) => void, delay = 500) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const movedRef = useRef(false);
  const eventRef = useRef<React.TouchEvent | React.MouseEvent | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    // Only trigger for single-finger touch
    if (e.touches.length !== 1) return;
    movedRef.current = false;
    eventRef.current = e;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (!movedRef.current && eventRef.current) {
        onLongPress(eventRef.current);
      }
    }, delay);
  }, [delay, onLongPress]);

  const onTouchMove = useCallback(() => {
    movedRef.current = true;
    clear();
  }, [clear]);

  const onTouchEnd = useCallback(() => {
    clear();
  }, [clear]);

  // Desktop: native contextmenu event
  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    onLongPress(e);
  }, [onLongPress]);

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onContextMenu,
  };
}
