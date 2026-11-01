import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';

export interface MultiSelectOption {
  value: string;
  /** Shown in the panel — carries the count (`#power-query · 3`). */
  label: string;
  /** Shown in the trigger, where the count is noise. Falls back to `label`. */
  shortLabel?: string;
}

interface MultiSelectProps {
  /** Accessible name for the trigger. The visible text is `formatSummary`. */
  label: string;
  /** Trigger text when nothing is selected — "作者：全部". */
  allLabel: string;
  options: MultiSelectOption[];
  values: string[];
  onChange: (values: string[]) => void;
  /**
   * Trigger text for a non-empty selection. Composed by the caller because the
   * "作者：agent +1" shape is a translation, and a component in `ui/` deliberately
   * carries no dictionary (see `Select`, which takes every label as a prop).
   */
  formatSummary: (labels: string[]) => string;
  /** Strings the panel needs; required, so no caller can ship an untranslated one. */
  searchPlaceholder: string;
  clearLabel: string;
  emptyLabel: string;
  /**
   * Filter box inside the panel. Defaults on for long lists: a dropdown of 30 tags
   * is a scroll, a dropdown of 30 *searchable* tags is a choice.
   */
  searchable?: boolean;
  /** h-8 trigger for a filter row (matches `Select compact`). */
  compact?: boolean;
  /** Applied to the root wrapper; layout classes (`grid` child) go here. */
  className?: string;
}

/**
 * A facet filter with checkboxes: several values, held open while you pick.
 *
 * Distinct from `Select` on purpose. `Select` is a *field* — pick one, the panel
 * closes, the form moves on. A filter row is a *lens*: you compose it (two authors,
 * one channel), watch the list change, and adjust without reopening. Teaching the
 * server to filter on a set and then offering one value in the UI would have been a
 * half-feature, which is how a filter row ends up with a "multi-select" nobody uses.
 */
export default function MultiSelect({
  label,
  allLabel,
  options,
  values,
  onChange,
  formatSummary,
  searchPlaceholder,
  clearLabel,
  emptyLabel,
  searchable,
  compact = false,
  className = '',
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const showSearch = searchable ?? options.length > 7;
  const selected = useMemo(() => new Set(values), [values]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) => option.label.toLowerCase().includes(needle));
  }, [options, query]);

  // The panel closes on an outside press and on Escape, the same two rules `Select`
  // follows — one dropdown behaviour in the app, not two.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Opening resets the search and focuses it: a stale query would hide the option
  // the user just came back to untick.
  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    setActive(0);
    if (showSearch) searchRef.current?.focus();
  }, [open, showSearch]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    // Order follows the option list, not the click order: the same two filters always
    // build the same request, which keeps the URL and any future cache key stable.
    onChange(options.filter((option) => next.has(option.value)).map((option) => option.value));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, Math.max(0, filtered.length - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter' || event.key === ' ') {
      // Space belongs to the search box while it has focus, or a tag like "power
      // query" could never be typed.
      if (event.key === ' ' && document.activeElement === searchRef.current) return;
      event.preventDefault();
      if (filtered[active]) toggle(filtered[active].value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  };

  const selectedLabels = options
    .filter((option) => selected.has(option.value))
    .map((option) => option.shortLabel ?? option.label);
  const summary = selectedLabels.length === 0 ? allLabel : formatSummary(selectedLabels);

  return (
    <div ref={rootRef} className={`relative ${className}`} onKeyDown={onKeyDown}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label} (${values.length})`}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border text-left transition-colors ${
          compact ? 'h-8 rounded-md px-2.5 text-xs' : 'px-3 py-2.5 text-sm'
        } ${
          values.length > 0
            ? 'border-neutral-400 bg-white text-neutral-900 hover:border-neutral-500 dark:border-neutral-500 dark:bg-neutral-800 dark:text-neutral-100'
            : 'border-neutral-300 bg-white text-neutral-900 hover:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:border-neutral-600'
        }`}
      >
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        <ChevronDown
          size={compact ? 13 : 14}
          className={`shrink-0 text-neutral-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-50 mt-1 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
          {showSearch && (
            <div className="border-b border-neutral-100 p-1.5 dark:border-neutral-800">
              <label className="relative block">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-neutral-400" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActive(0);
                  }}
                  placeholder={searchPlaceholder}
                  className="h-7 w-full rounded-md border border-neutral-200 bg-white pl-7 pr-2 text-[11.5px] text-neutral-800 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-200"
                />
              </label>
            </div>
          )}

          <div
            ref={listRef}
            role="listbox"
            aria-multiselectable
            className="max-h-64 overflow-y-auto py-1"
          >
            {values.length > 0 && (
              <button
                type="button"
                onClick={() => onChange([])}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-neutral-500 transition-colors hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
              >
                {clearLabel}
              </button>
            )}
            {filtered.length === 0 && (
              <p className="px-3 py-2 text-[11.5px] text-neutral-400 dark:text-neutral-500">
                {emptyLabel}
              </p>
            )}
            {filtered.map((option, index) => {
              const checked = selected.has(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={checked}
                  data-idx={index}
                  onClick={() => toggle(option.value)}
                  onPointerEnter={() => setActive(index)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors ${
                    index === active
                      ? 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
                      : 'text-neutral-700 dark:text-neutral-300'
                  }`}
                >
                  <span
                    aria-hidden
                    className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                      checked
                        ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
                        : 'border-neutral-300 dark:border-neutral-600'
                    }`}
                  >
                    {checked && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
