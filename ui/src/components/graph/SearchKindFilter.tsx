import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, SlidersHorizontal } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { SearchResultKind } from '../../types/graph';

/** The result legs that are not memories; memory kinds come from the database. */
const RESULT_LEG_OPTIONS: Array<{ kind: Exclude<SearchResultKind, 'memory'>; labelKey: string }> = [
  { kind: 'entity', labelKey: 'graph.kinds.entity' },
  { kind: 'message', labelKey: 'graph.kinds.message' },
];

/**
 * Memory kinds in the order the memory page presents them; anything the database
 * invented later (a new hygiene kind, say) is appended so it cannot be hidden.
 */
const MEMORY_KIND_ORDER = [
  'preference',
  'fact',
  'task',
  'scene',
  'summary',
  'persona',
  'hygiene_checkpoint',
  'device_state',
];

export interface SearchKindSelection {
  entity: boolean;
  message: boolean;
  /** null = every memory kind; [] = the memory leg is off. */
  memoryKinds: string[] | null;
}

interface SearchKindFilterProps {
  value: SearchKindSelection;
  /** Memory kinds present in the database, from `/api/memory/filters`. */
  availableMemoryKinds: string[];
  onChange: (next: SearchKindSelection) => void;
}

function orderMemoryKinds(kinds: string[]): string[] {
  const rank = (kind: string) => {
    const index = MEMORY_KIND_ORDER.indexOf(kind);
    return index === -1 ? MEMORY_KIND_ORDER.length : index;
  };
  return [...kinds].sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));
}

/**
 * Multi-select type filter for the graph search.
 *
 * Why a dropdown instead of the three chips this replaced: the memory page
 * already filters by memory kind (preference / fact / summary / …), and a user
 * narrowing a search wants the same vocabulary in the same place — one control
 * that opens a checklist, rather than a row of chips that grows a line taller
 * with every kind the database learns.
 */
export default function SearchKindFilter({
  value,
  availableMemoryKinds,
  onChange,
}: SearchKindFilterProps) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const kinds = orderMemoryKinds(availableMemoryKinds);
  const selectedMemory = value.memoryKinds ?? kinds;
  const total = 2 + kinds.length;
  const selected = (value.entity ? 1 : 0) + (value.message ? 1 : 0) + selectedMemory.length;
  const allSelected = selected === total;

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

  const toggleMemoryKind = (kind: string) => {
    const current = new Set(value.memoryKinds ?? kinds);
    if (current.has(kind)) current.delete(kind);
    else current.add(kind);
    // Selecting every kind individually is the same as "all", so collapse back to
    // null — otherwise the request grows a long `memory_kinds` list stating the
    // obvious.
    const next = kinds.filter((entry) => current.has(entry));
    onChange({ ...value, memoryKinds: next.length === kinds.length ? null : next });
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="true"
        className={cn(
          'flex h-full items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors',
          allSelected
            ? 'border-neutral-300 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-800'
            : 'border-primary/40 bg-primary/10 text-primary',
        )}
      >
        <SlidersHorizontal size={13} strokeWidth={1.75} />
        <span className="whitespace-nowrap">{t('graph.filterButton')}</span>
        {!allSelected && (
          <span className="rounded-full bg-primary/15 px-1.5 text-[10px] font-medium">
            {selected}/{total}
          </span>
        )}
        <ChevronDown size={12} strokeWidth={2} className={cn(open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-60 rounded-lg border border-neutral-200 bg-white p-1.5 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
          <div className="flex items-center justify-between px-1.5 pb-1">
            <span className="text-[11px] font-medium text-neutral-400 dark:text-neutral-500">
              {t('graph.filterTitle')}
            </span>
            <button
              type="button"
              onClick={() =>
                onChange({
                  entity: !allSelected,
                  message: !allSelected,
                  memoryKinds: allSelected ? [] : null,
                })
              }
              className="text-[11px] text-primary hover:underline"
            >
              {allSelected ? t('graph.filterClear') : t('graph.filterAll')}
            </button>
          </div>

          <p className="px-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
            {t('graph.filterGroupResult')}
          </p>
          <ul>
            {RESULT_LEG_OPTIONS.map((option) => (
              <li key={option.kind}>
                <FilterRow
                  checked={value[option.kind]}
                  label={t(option.labelKey)}
                  onToggle={() => onChange({ ...value, [option.kind]: !value[option.kind] })}
                />
              </li>
            ))}
          </ul>

          {kinds.length > 0 && (
            <>
              <p className="mt-1 px-1.5 pb-0.5 text-[10px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                {t('graph.filterGroupMemory')}
              </p>
              <ul>
                {kinds.map((kind) => (
                  <li key={kind}>
                    <FilterRow
                      checked={selectedMemory.includes(kind)}
                      label={t(`memory.kindLabels.${kind}`, kind)}
                      onToggle={() => toggleMemoryKind(kind)}
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function FilterRow({
  checked,
  label,
  onToggle,
}: {
  checked: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
    >
      <span
        className={cn(
          'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
          checked
            ? 'border-primary bg-primary text-white'
            : 'border-neutral-300 dark:border-neutral-600',
        )}
      >
        {checked && <Check size={10} strokeWidth={3} />}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}
