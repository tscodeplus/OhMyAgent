import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, SlidersHorizontal, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import Toggle from '../ui/Toggle';

interface GraphFiltersProps {
  /**
   * Relation types to offer. Comes from `GraphStats.relationTypes` when the server
   * serves it, else from the types present in the current payload — a filter with
   * nothing to pick would be dead UI.
   */
  typeOptions: string[];
  selectedTypes: string[];
  onTypesChange: (types: string[]) => void;
  /** `<input type="date">` value (`YYYY-MM-DD`); empty means all time. */
  asOf: string;
  onAsOfChange: (value: string) => void;
  /** Overview only — the `?whole=1` escape hatch. */
  wholeGraph?: { value: boolean; onChange: (next: boolean) => void };
}

function TypeOption({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onToggle}
      className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700/60"
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked && <Check size={13} className="shrink-0 text-blue-600 dark:text-blue-400" />}
    </button>
  );
}

/**
 * The two server-side filters the drawing has (relation type and point in time),
 * plus the whole-graph override.
 *
 * Both filters narrow what the server returns rather than hiding rows on the
 * client: an edge the filter excluded must not cost prompt-shaped payload or look
 * like a relation that vanished. "All time" is the ABSENCE of `asOf` — sending 0
 * would be a timestamp, and a timestamp at the epoch hides every edge.
 */
export default function GraphFilters({
  typeOptions,
  selectedTypes,
  onTypesChange,
  asOf,
  onAsOfChange,
  wholeGraph,
}: GraphFiltersProps) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Click-outside and Escape, like every other popover in the WebUI.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const toggleType = (type: string) => {
    onTypesChange(
      selectedTypes.includes(type)
        ? selectedTypes.filter((entry) => entry !== type)
        : [...selectedTypes, type],
    );
  };

  return (
    <div className="mb-2">
      <div className="flex flex-wrap items-center gap-2">
        <div ref={rootRef} className="relative">
          <button
            type="button"
            aria-expanded={open}
            aria-haspopup="true"
            onClick={() => setOpen((current) => !current)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors',
              selectedTypes.length > 0
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-neutral-300 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800',
            )}
          >
            <SlidersHorizontal size={12} strokeWidth={1.75} />
            <span className="whitespace-nowrap">{t('graph.relationsFilter')}</span>
            {selectedTypes.length > 0 && (
              <span className="rounded-full bg-primary/15 px-1.5 text-[10px] font-medium">
                {selectedTypes.length}
              </span>
            )}
          </button>
          {open && (
            <div className="absolute z-50 mt-1 max-h-64 w-56 overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-800">
              {/* "All types" is the empty selection, stated as a row: a reader who
                  has picked two types needs one obvious way back to everything. */}
              <TypeOption
                label={t('graph.relationsAll')}
                checked={selectedTypes.length === 0}
                onToggle={() => onTypesChange([])}
              />
              {typeOptions.map((type) => (
                <TypeOption
                  key={type}
                  label={type}
                  checked={selectedTypes.includes(type)}
                  onToggle={() => toggleType(type)}
                />
              ))}
            </div>
          )}
        </div>

        <label className="inline-flex items-center gap-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
          <span className="whitespace-nowrap">{t('graph.asOfLabel')}</span>
          <input
            type="date"
            value={asOf}
            onChange={(event) => onAsOfChange(event.target.value)}
            aria-label={t('graph.asOfOption')}
            className="h-7 rounded-md border border-neutral-300 bg-white px-1.5 text-[11px] text-neutral-700 dark:border-neutral-800 dark:bg-neutral-800 dark:text-neutral-200"
          />
        </label>
        {asOf ? (
          <button
            type="button"
            onClick={() => onAsOfChange('')}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-neutral-300 px-2 text-[11px] text-neutral-600 hover:bg-neutral-100 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <X size={11} strokeWidth={1.75} />
            {t('graph.asOfAll')}
          </button>
        ) : (
          <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
            {t('graph.asOfAll')}
          </span>
        )}

        {wholeGraph && (
          <span className="inline-flex items-center gap-1.5">
            <Toggle
              checked={wholeGraph.value}
              onChange={wholeGraph.onChange}
              ariaLabel={t('graph.wholeGraph')}
            />
            <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
              {t('graph.wholeGraph')}
            </span>
          </span>
        )}
      </div>

      {wholeGraph?.value && (
        <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
          {t('graph.wholeGraphHint')}
        </p>
      )}
    </div>
  );
}
