import { forwardRef, useEffect, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectGroup {
  label: string;
  options: SelectOption[];
}

interface SelectProps {
  label?: string;
  error?: string;
  /** Visual-only required marker (red asterisk next to the label). */
  required?: boolean;
  /** Smaller label gap and control padding */
  dense?: boolean;
  /** Extra-compact trigger (h-8, text-xs) for toolbar filter rows */
  compact?: boolean;
  /** Flat option list (mutually exclusive with groups) */
  options?: SelectOption[];
  /** Grouped options, rendered with non-interactive headers */
  groups?: SelectGroup[];
  value?: string;
  /** Emulates the native change event shape: e.target.value */
  onChange?: (event: { target: { value: string; name?: string } }) => void;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  name?: string;
  /** Applied to the root wrapper (layout classes like flex-1 go here) */
  className?: string;
}

/**
 * Custom dropdown replacing the native <select>. The native popup is drawn
 * by the OS (its frame/colors can't be styled and clash with the theme), so
 * this renders the panel in-app with the same look as the other custom
 * dropdowns (ModelIdCombobox, slash palette): rounded panel, subtle border,
 * no focus rings.
 */
const Select = forwardRef(function Select(
  {
    label,
    required,
    error,
    dense = false,
    compact = false,
    options,
    groups,
    value,
    onChange,
    disabled,
    placeholder,
    id,
    name,
    className = '',
  }: SelectProps,
  ref: Ref<HTMLButtonElement>,
) {
  const selectId = id || label?.toLowerCase().replace(/\s+/g, '-');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = (node: HTMLButtonElement) => {
    buttonRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) (ref as { current: HTMLButtonElement | null }).current = node;
  };

  const flat: SelectOption[] = groups ? groups.flatMap((g) => g.options) : (options ?? []);
  const selected = flat.find((o) => o.value === value);

  // Close on outside click / Escape handled via keydown below
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Keep the highlighted option visible while navigating
  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const openList = () => {
    if (disabled) return;
    const idx = flat.findIndex((o) => o.value === value);
    setActive(idx >= 0 ? idx : 0);
    setOpen(true);
  };

  const pick = (opt: SelectOption) => {
    if (opt.disabled) return;
    setOpen(false);
    buttonRef.current?.focus();
    if (opt.value !== value) onChange?.({ target: { value: opt.value, name } });
  };

  const move = (delta: number) => {
    if (flat.length === 0) return;
    let idx = active;
    for (let i = 0; i < flat.length; i++) {
      idx = (idx + delta + flat.length) % flat.length;
      if (!flat[idx].disabled) break;
    }
    setActive(idx);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(flat.findIndex((o) => !o.disabled));
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(flat.length - 1 - [...flat].reverse().findIndex((o) => !o.disabled));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (flat[active]) pick(flat[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    }
  };

  const triggerPad = compact ? 'px-2.5' : 'px-3';
  const triggerHeight = compact ? 'h-8 text-xs' : dense ? 'py-2 sm:py-1.5' : 'py-2.5';

  return (
    <div
      ref={rootRef}
      className={`relative flex flex-col ${dense ? 'gap-1.5 sm:gap-1' : 'gap-1.5'} ${className}`}
      onKeyDown={onKeyDown}
    >
      {label && (
        <label
          htmlFor={selectId}
          className="text-[13px] font-medium text-neutral-700 dark:text-neutral-300"
        >
          {label}
          {required && <span className="ml-0.5 text-red-500">*</span>}
        </label>
      )}
      <button
        ref={triggerRef}
        type="button"
        id={selectId}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          compact ? 'rounded-md' : ''
        } ${triggerPad} ${triggerHeight} ${
          error
            ? 'border-red-500'
            : 'border-neutral-300 bg-white text-neutral-900 hover:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:border-neutral-600'
        }`}
      >
        <span className="min-w-0 flex-1 truncate">
          {selected ? selected.label : placeholder || ''}
        </span>
        <ChevronDown
          size={compact ? 13 : 14}
          className={`shrink-0 text-neutral-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          className="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-800"
        >
          {groups
            ? groups.map((g) => (
                <div key={g.label}>
                  <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                    {g.label}
                  </div>
                  {g.options.map((opt) => (
                    <OptionRow
                      key={opt.value}
                      opt={opt}
                      active={flat[active] === opt}
                      selected={opt.value === value}
                      onPick={pick}
                      setActive={setActive}
                      idx={flat.indexOf(opt)}
                    />
                  ))}
                </div>
              ))
            : options?.map((opt) => (
                <OptionRow
                  key={opt.value}
                  opt={opt}
                  active={flat[active] === opt}
                  selected={opt.value === value}
                  onPick={pick}
                  setActive={setActive}
                  idx={flat.indexOf(opt)}
                />
              ))}
        </div>
      )}

      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
});

function OptionRow({
  opt,
  active,
  selected,
  onPick,
  setActive,
  idx,
}: {
  opt: SelectOption;
  active: boolean;
  selected: boolean;
  onPick: (opt: SelectOption) => void;
  setActive: (idx: number) => void;
  idx: number;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-idx={idx}
      disabled={opt.disabled}
      onClick={() => onPick(opt)}
      onPointerEnter={() => !opt.disabled && setActive(idx)}
      className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? 'bg-neutral-100 text-neutral-900 dark:bg-neutral-700/60 dark:text-neutral-100'
          : 'text-neutral-700 dark:text-neutral-300'
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{opt.label}</span>
      {selected && <Check size={14} className="shrink-0 text-blue-600 dark:text-blue-400" />}
    </button>
  );
}

Select.displayName = 'Select';
export default Select;
