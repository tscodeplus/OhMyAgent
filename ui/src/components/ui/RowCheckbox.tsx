import { useEffect, useRef } from 'react';

/**
 * Checkbox sized for a dense sidebar row (24–28px tall).
 *
 * Native `indeterminate` is a property, not an attribute, so it can only be set
 * through a ref — that is the whole reason this is a component rather than an
 * inline `<input>`. It also stops the click from reaching the row button
 * underneath, which would navigate away while the user is picking rows.
 */
export default function RowCheckbox({
  checked,
  indeterminate = false,
  onChange,
  className = '',
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      className={`h-3 w-3 shrink-0 cursor-pointer accent-[var(--color-primary)] ${className}`}
    />
  );
}
