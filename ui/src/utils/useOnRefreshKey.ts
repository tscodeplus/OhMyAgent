import { useEffect, useRef } from 'react';

/**
 * Run `fn` when the shell's refresh key changes — and only then.
 *
 * Every list in the sidebar paired its initial fetch with
 * `useEffect(fn, [refreshKey])`, which also ran on mount: the tray is mounted
 * twice (sidebar + collapsed rail's flyout) with two effects each, so first
 * paint asked for the same page four times over a link where a round trip costs
 * about a second. The mount fetch belongs to the other effect; this one is only
 * about a change.
 */
export function useOnRefreshKey(refreshKey: number | undefined, fn: () => void): void {
  const seen = useRef(refreshKey);
  useEffect(() => {
    if (seen.current === refreshKey) return;
    seen.current = refreshKey;
    fn();
  }, [refreshKey, fn]);
}
