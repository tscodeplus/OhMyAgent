interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel?: string;
  disabled?: boolean;
  /** Override for the checked-state track colors (border + bg). Defaults to
   *  the send button's active blue (blue-500 light / blue-400 dark). Pass
   *  classes that cover BOTH light and dark mode (e.g. "border-x bg-x
   *  dark:border-y dark:bg-y") so nothing is left to the default. */
  checkedClassName?: string;
}

export default function Toggle({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
  checkedClassName,
}: ToggleProps) {
  const trackCls = checked
    ? (checkedClassName ?? 'border-blue-500 bg-blue-500 dark:border-blue-400 dark:bg-blue-400')
    : 'border-neutral-300 bg-neutral-200 dark:border-neutral-600 dark:bg-neutral-700';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`
        relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-200
        focus:outline-none
        ${trackCls}
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
      `}
    >
      <span
        className={`
          pointer-events-none inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm ring-0
          transition-transform duration-200 ease-in-out
          ${checked ? 'translate-x-[18px]' : 'translate-x-[3px]'}
        `}
      />
    </button>
  );
}
