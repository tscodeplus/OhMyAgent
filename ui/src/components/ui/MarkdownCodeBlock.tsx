import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import { copyTextToClipboard } from '../../utils/clipboard';

/** Pull the raw text out of a React subtree, so `pre` can copy its own source. */
function toText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(toText).join('');
  if (typeof node === 'object' && 'props' in (node as never)) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return toText(props?.children);
  }
  return '';
}

function CopyButton({ value }: { value: string }) {
  const { t } = useTranslation('common');
  const [copied, setCopied] = useState(false);
  // `copyTextToClipboard`, not `navigator.clipboard`: over the LAN the app is served on
  // plain HTTP, where the Clipboard API is missing and the raw call threw into an empty
  // catch — the button was clickable and did nothing (see `utils/clipboard.ts`).
  const copy = useCallback(async () => {
    if (!(await copyTextToClipboard(value))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }, [value]);
  return (
    <button
      type="button"
      onClick={copy}
      title={t('common.copy')}
      aria-label={t('common.copy')}
      // Visible without hover below `sm`: a phone has no pointer to hover with, and a
      // copy control that only exists on hover does not exist on touch at all. The
      // colours are the inverted pair for the two themes rather than white-on-dark,
      // because the block itself is dark only half the time.
      className="absolute right-2 top-2 rounded-md border border-neutral-300 bg-white/80 p-1 text-neutral-500 opacity-100 transition-opacity hover:bg-white hover:text-neutral-800 focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 dark:border-white/20 dark:bg-white/10 dark:text-white/80 dark:hover:bg-white/20 dark:hover:text-white"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

/**
 * A fenced markdown code block with a copy button in its corner, registered as the
 * `pre` renderer by the notes body and the chat bubble.
 *
 * The wrapper is what makes the button positionable (`group relative`), and the block's
 * own colours stay with the caller: the notes body wants its lighter `oma-code-block`
 * pair, the chat bubble keeps the shared `.markdown-content pre` fill, and a copy
 * button on a block of code is the same affordance in both.
 *
 * Copying drops the newline before the closing fence — it is markdown syntax, not part
 * of the command, and `pnpm dev\n` pasted into a shell runs one extra empty line.
 */
export default function MarkdownCodeBlock({
  children,
  preClassName,
}: {
  children?: ReactNode;
  preClassName?: string;
}) {
  return (
    <div className="group relative">
      <pre className={preClassName}>{children}</pre>
      <CopyButton value={toText(children).replace(/(?:\r?\n)+$/, '')} />
    </div>
  );
}
