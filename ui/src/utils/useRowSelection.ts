import { useCallback, useMemo, useState } from 'react';

/**
 * Row selection for a sidebar list, used for batch archive / restore.
 *
 * Selection is a *mode*, entered from a row's context menu ("多选"), not a
 * always-visible checkbox column: these lists are dense and the batch action is
 * occasional, so a permanent checkbox would cost every normal use to serve a
 * rare one. Entering the mode may seed one row (the one the menu was opened on),
 * which matches the mental model of "I want this one and a few neighbours".
 *
 * `selected` is a Set so `isSelected` is O(1) in a list that re-renders on every
 * poll tick; it is exposed read-only and always replaced, never mutated, so
 * memoized rows see a new identity when the selection changes.
 */
export interface RowSelection {
  /** True while the list shows checkboxes and the action bar. */
  selecting: boolean;
  selected: ReadonlySet<string>;
  /** Selection size — convenience for the action bar. */
  count: number;
  /** Enter selection mode, optionally pre-selecting one row. */
  enter: (seedId?: string) => void;
  /** Leave selection mode and drop the selection. */
  exit: () => void;
  toggle: (id: string) => void;
  /** Select or clear every id of one group (a project / a channel header). */
  setMany: (ids: string[], on: boolean) => void;
  /** True when every id in `ids` is selected (and `ids` is non-empty). */
  allSelected: (ids: string[]) => boolean;
  /** True when at least one id in `ids` is selected — drives the group header's indeterminate mark. */
  someSelected: (ids: string[]) => boolean;
}

export function useRowSelection(): RowSelection {
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  const enter = useCallback((seedId?: string) => {
    setSelecting(true);
    // Without a seed the user is picking from scratch; a seed keeps whatever was
    // already selected so successive "多选" gestures accumulate.
    if (seedId !== undefined) {
      setSelected((prev) => {
        const next = new Set(prev);
        next.add(seedId);
        return next;
      });
    }
  }, []);

  const exit = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
  }, []);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setMany = useCallback((ids: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const allSelected = useCallback(
    (ids: string[]) => ids.length > 0 && ids.every((id) => selected.has(id)),
    [selected],
  );

  const someSelected = useCallback(
    (ids: string[]) => ids.some((id) => selected.has(id)),
    [selected],
  );

  return useMemo(
    () => ({
      selecting,
      selected,
      count: selected.size,
      enter,
      exit,
      toggle,
      setMany,
      allSelected,
      someSelected,
    }),
    [selecting, selected, enter, exit, toggle, setMany, allSelected, someSelected],
  );
}
