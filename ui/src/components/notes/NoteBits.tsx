/**
 * Small shared pieces of the notes UI: the facet row, tag chips, the source
 * (trace) chips and the markdown body.
 *
 * Every one of them is presentational — the rules they encode (facets are
 * derived, never editable; tags are free; a source that no longer resolves is
 * greyed rather than dropped) live in `MyDocs/NOTES_LAYER_PLAN.md` §4.6–4.7.
 *
 * There is no kind chip any more: the aspect dimension lives in tags (one
 * optional aspect tag such as `pitfall`), and the identity a row needs — draft
 * vs published, subject tags — is already carried by `DraftBadge` and the tag
 * chips.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { Note, NoteChannel, NoteSource } from './types';

/**
 * The draft token, in one place: the badge in the list row, the badge in the
 * detail header and the draft hint all read from here, so "not yet published"
 * cannot drift into three different yellows.
 *
 * Deliberately hue-free. Amber is the pin icon's colour, and a second amber in
 * the same 364px column made "this note is unpublished" and "this note is
 * pinned" the same colour. A dashed edge over neutral ink says "provisional"
 * on its own, and on #161b22 it is a whisper rather than a highlighter — the
 * light mode reading was fine either way.
 */
export const DRAFT_BADGE =
  'inline-flex shrink-0 items-center rounded border border-dashed border-neutral-300 bg-transparent px-1 py-0 font-medium text-neutral-500 dark:border-neutral-600 dark:text-neutral-400';

export function DraftBadge({ className }: { className?: string }) {
  const { t } = useTranslation('common');
  return (
    <span className={cn(DRAFT_BADGE, 'text-[9.5px]', className)}>{t('notes.status.draft')}</span>
  );
}

/** Channel → i18n key for the display label; the platform, not the chat (plan §4.5). */
export const CHANNEL_LABEL: Record<NoteChannel, string> = {
  feishu: 'notes.channel.feishu',
  telegram: 'notes.channel.telegram',
  wechat: 'notes.channel.wechat',
  qq: 'notes.channel.qq',
  webui: 'notes.channel.webui',
  cron: 'notes.channel.cron',
};

/**
 * The facet row: author, channel, project, scope.
 *
 * These are read off columns, not off `tags` — that is the whole point of the
 * split in §4.6. They render in the same row as free tags so the row reads as
 * "what this note is", while the tint marks the ones that cannot be deleted.
 */
export function FacetRow({ note, className }: { note: Note; className?: string }) {
  const { t } = useTranslation('common');
  return (
    <div className={cn('flex flex-wrap items-center gap-1 text-[11px]', className)}>
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5',
          note.origin === 'agent'
            ? 'border-violet-200/70 bg-violet-50 text-violet-700 dark:border-violet-400/20 dark:bg-violet-500/10 dark:text-violet-300'
            : 'border-neutral-200 bg-neutral-50 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300',
        )}
        title={t('notes.facet.authorHint')}
      >
        {t(`notes.facet.origin.${note.origin}`)}
      </span>
      {/* No channel is a fact, not a missing translation: a note distilled from a
          session whose channel was never recorded gets no chip, instead of one
          reading "notes.channel.null". */}
      {note.channel && (
        <span
          className="inline-flex items-center gap-1 rounded-md border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300"
          title={t('notes.facet.channelHint')}
        >
          {t(CHANNEL_LABEL[note.channel])}
        </span>
      )}
      {note.projectName && (
        <span
          className="inline-flex items-center gap-1 rounded-md border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300"
          title={t('notes.facet.projectHint')}
        >
          {note.projectName}
        </span>
      )}
      <ScopeChip scope={note.scope} />
    </div>
  );
}

/**
 * Where a note is visible, as a chip.
 *
 * One component for the detail's facet row and the list row: the same scope spelled two
 * ways in one screen is how a filter stops matching what the row says. Dashed, because
 * scope is derived from the row rather than a value anyone edits in place.
 */
export function ScopeChip({ scope, className }: { scope: Note['scope']; className?: string }) {
  const { t } = useTranslation('common');
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md border border-dashed border-neutral-300 px-1.5 py-0.5 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400',
        className,
      )}
      title={t('notes.facet.scopeHint')}
    >
      {t(`notes.scope.${scope}`)}
    </span>
  );
}

export function TagChip({ tag, onClick }: { tag: string; onClick?: () => void }) {
  const content = (
    <>
      <span className="text-neutral-400 dark:text-neutral-500">#</span>
      {tag}
    </>
  );
  const className =
    'inline-flex items-center rounded-full border border-transparent bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600 transition-colors dark:bg-neutral-800 dark:text-neutral-300';
  if (!onClick) return <span className={className}>{content}</span>;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        className,
        'hover:border-neutral-300 hover:bg-neutral-200/70 dark:hover:border-neutral-600 dark:hover:bg-neutral-700',
      )}
    >
      {content}
    </button>
  );
}

/**
 * `飞书 · 群 oc_work` — the channel in the user's language plus the session title.
 *
 * Composed here rather than server-side: a translated channel name in the payload
 * would make the same row read differently depending on which language rendered it,
 * and the payload is also what the export script writes.
 */
export function sessionLabel(
  note: { channel: NoteChannel | null; sessionTitle?: string | null; sessionId?: string | null },
  t: (key: string) => string,
): string {
  const channel = note.channel ? t(`notes.channel.${note.channel}`) : '';
  const title = note.sessionTitle ?? null;
  if (channel && title) return `${channel} · ${title}`;
  if (channel) return channel;
  return title ?? '';
}

/** Relative time, coarse on purpose: a note library is read in days, not seconds. */
export function relativeTime(ts: number, language: string): string {
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * 24 * 3600_000],
    ['month', 30 * 24 * 3600_000],
    ['day', 24 * 3600_000],
    ['hour', 3600_000],
    ['minute', 60_000],
  ];
  const rtf = new Intl.RelativeTimeFormat(language.startsWith('zh') ? 'zh-CN' : 'en', {
    numeric: 'auto',
  });
  for (const [unit, ms] of units) {
    if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return rtf.format(Math.round(diff / 1000), 'second');
}

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
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* Clipboard needs a secure context; failing silently is better than a toast storm. */
    }
  }, [value]);
  return (
    <button
      type="button"
      onClick={copy}
      title={t('notes.copy')}
      aria-label={t('notes.copy')}
      className="absolute right-2 top-2 rounded-md border border-white/20 bg-white/10 p-1 text-white/80 opacity-0 transition-opacity hover:bg-white/20 hover:text-white group-hover:opacity-100 focus:opacity-100"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

/**
 * Note body. Markdown is the authoritative field (`body`), so it renders through
 * the same `.markdown-content` styles the chat bubble uses, plus a copy button
 * on every code block — a note about a command exists to be executed.
 */
export function NoteBody({ body }: { body: string }) {
  const components = useMemo(
    () => ({
      pre: ({ children }: { children?: ReactNode }) => (
        <div className="group relative my-2">
          {/* Inline colours: `.markdown-content pre` in index.css sets its own
              background at the same specificity, so a utility class loses. */}
          <pre
            className="overflow-x-auto rounded-lg p-3 text-[12px] leading-relaxed"
            style={{ backgroundColor: '#1c1c1c', color: '#f5f5f5' }}
          >
            {children}
          </pre>
          <CopyButton value={toText(children)} />
        </div>
      ),
      a: ({ children, href }: { children?: ReactNode; href?: string }) => (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-indigo-600 underline underline-offset-2 dark:text-indigo-400"
        >
          {children}
        </a>
      ),
    }),
    [],
  );
  return (
    <div className="markdown-content text-sm text-neutral-700 dark:text-neutral-300">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {body}
      </ReactMarkdown>
    </div>
  );
}

/** A value that exists to be copied (a command, a path, a config key). */
export function CopyableValue({ value }: { value: string }) {
  const { t } = useTranslation('common');
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* No secure context — the value is still selectable by hand. */
    }
  }, [value]);
  return (
    <span className="group inline-flex max-w-full items-center gap-1.5 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900">
      <code
        className="truncate text-[12px] text-neutral-800 dark:text-neutral-200"
        style={{
          background: 'none',
          padding: 0,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
      >
        {value}
      </code>
      <button
        type="button"
        onClick={copy}
        title={t('notes.copy')}
        aria-label={t('notes.copy')}
        className="shrink-0 rounded p-0.5 text-neutral-400 transition-colors hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </span>
  );
}

/**
 * One citation chip.
 *
 * The visible text is *what the citation said*, not its id: `msg:om_9c1f2ab73d` is a row
 * identifier from another layer, and a reader scanning a note's trace cannot do anything
 * with it. The id stays in `title`/`aria-label`, so it is still available to whoever needs
 * to check the receipt. An unavailable source keeps its place and loses its link —
 * dropping the row would quietly rewrite history (plan §4.7).
 */
export function SourceChip({
  source,
  onOpen,
}: {
  source: NoteSource;
  /** Opens the conversation around this citation (plan §4.7). */
  onOpen?: (source: NoteSource) => void;
}) {
  const { t } = useTranslation('common');
  const excerpt = source.excerpt.replace(/\s+/g, ' ').trim();
  // Long enough to recognise the quote, short enough that three chips still fit a
  // 364px column: the chip ellipsises anyway, and a truncated chip with no visible
  // words reads as an id again.
  const label = excerpt
    ? excerpt.length > 16
      ? `${excerpt.slice(0, 16)}…`
      : excerpt
    : source.kind;
  const idLabel = `${source.kind}:${source.id}`;
  if (!source.available) {
    return (
      <span
        title={`${t('notes.sourcesGone')} · ${idLabel}`}
        aria-label={`${t('notes.sourcesGone')} · ${idLabel}`}
        className="inline-flex max-w-[220px] items-center gap-1 truncate rounded-full border border-dashed border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-400 line-through decoration-neutral-300 dark:border-neutral-700 dark:text-neutral-500"
      >
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      // A citation is a claim with a receipt: clicking it shows the receipt in
      // place, in the same drawer search results use, rather than throwing the
      // reader into the middle of a long transcript.
      onClick={onOpen ? () => onOpen(source) : undefined}
      title={source.excerpt || t('notes.traceOpen')}
      aria-label={`${t('notes.traceCited')} · ${idLabel}`}
      className="inline-flex max-w-[260px] items-center gap-1 truncate rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-left text-[11px] text-neutral-600 transition-colors hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:border-neutral-600 dark:hover:bg-neutral-800"
    >
      {/* The kind stays as a muted prefix — it is a category, not an id — and the
          content follows it, so the chip reads `msg: pnpm dev 报端口占用`. */}
      <span className="shrink-0 font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
        {source.kind === 'message' ? 'msg:' : `${source.kind}:`}
      </span>
      {label}
    </button>
  );
}
