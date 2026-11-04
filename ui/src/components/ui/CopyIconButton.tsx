import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import { cn } from '../../lib/utils';
import { copyTextToClipboard } from '../../utils/clipboard';

/**
 * The "copy this" control, in one place.
 *
 * Three surfaces need it and each dresses it differently: a code block floats it over
 * the top-right corner, a tool card keeps it on the label row, the approval card pins it
 * inside the command box. What they must not differ in is the behaviour, so the copy
 * call, the tick, and the newline rule live here:
 *
 * - `copyTextToClipboard` rather than `navigator.clipboard`: over the LAN the app is
 *   served on plain HTTP, where the Clipboard API does not exist and the raw call threw
 *   into an empty `catch` — the button was clickable and did nothing.
 * - The tick only appears when the text actually reached the clipboard.
 * - A trailing newline is dropped: `pnpm dev\n` pasted into a shell runs one extra
 *   empty command, and every caller here copies something that gets pasted.
 */
export default function CopyIconButton({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  const { t } = useTranslation('common');
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    if (!(await copyTextToClipboard(value.replace(/(?:\r?\n)+$/, '')))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }, [value]);
  return (
    <button
      type="button"
      onClick={copy}
      title={t('common.copy')}
      aria-label={t('common.copy')}
      className={cn(
        'shrink-0 rounded p-0.5 text-neutral-400 transition-colors hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200',
        className,
      )}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}
