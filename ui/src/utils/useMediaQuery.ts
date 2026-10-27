import { useEffect, useState } from 'react';

/**
 * Subscribe to a CSS media query from React.
 *
 * Only needed where the decision cannot be expressed in CSS — e.g. the chat
 * input's placeholder, which is an element *attribute* rather than rendered
 * markup, so Tailwind's `md:` / `hidden` utilities cannot switch it.
 *
 * The initial value is read synchronously from `matchMedia` (not deferred to
 * an effect) so the first paint already has the right string instead of
 * flashing the desktop variant on a phone.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (!window.matchMedia) return;
    const mql = window.matchMedia(query);
    // Re-sync in case the query changed between render and effect.
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
