interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel?: string;
  disabled?: boolean;
}

export default function Toggle({ checked, onChange, ariaLabel, disabled = false }: ToggleProps) {
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
        focus:outline-none focus:ring-2 focus:ring-blue-500/30
        ${checked ? 'border-blue-500 bg-blue-500' : 'border-neutral-300 bg-neutral-200 dark:border-neutral-600 dark:bg-neutral-700'}
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
