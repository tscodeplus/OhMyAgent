/**
 * Page numbers for the notes list.
 *
 * The list used to end with a "加载更多" button, which made the reader the owner of a
 * scroll position the server could not reproduce: the appended tail lived in the page
 * component, so any write (`approve`, `pin`, `archive`) refetched one page and dropped
 * the reader back to row 1. A page number is the opposite trade — every page is one
 * `limit`/`offset` request the provider can repeat after a write, and the pager can
 * say truthfully which of how many pages is on screen because the server already
 * returns `total` (`COUNT(*)` over the same predicate).
 *
 * What this component does *not* do is own the position: `page` comes from
 * `NotesContext` and `onPage` writes it back there, because the refetch-after-write
 * path runs inside the provider.
 */

import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * Numbers a short list shows before any gap is needed.
 *
 * `1 2 3 4 5 6 7` fits the 364px rail; inserting `…` there would hide a page that fits.
 */
const MAX_PLAIN_PAGES = 7;

/** Numbers beside the current one in a long list, edges excluded. */
const WINDOW = 5;

/** One slot of the pager: a page number, or the ellipsis standing for a run of them. */
export type PageSlot = number | 'gap';

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let value = from; value <= to; value += 1) out.push(value);
  return out;
}

/**
 * A skipped run of pages: the number itself when only one page is hidden, `'gap'`
 * when two or more are.
 *
 * Collapsing a single page into `…` is what makes a pager look like it lost a page:
 * `… 6 7 8 …` deletes row 20 of the library from the reader's point of view.
 */
function skipped(from: number, to: number): PageSlot[] {
  if (to < from) return [];
  return to === from ? [from] : ['gap'];
}

/**
 * The numbers to render for `page` of `pageCount`, in order.
 *
 * First and last are always reachable, so the window slides at the edges instead of
 * shrinking: paging forward from page 1 keeps the pager's width constant, which is
 * what stops the buttons from moving under the pointer.
 */
export function pageWindow(page: number, pageCount: number): PageSlot[] {
  if (pageCount <= MAX_PLAIN_PAGES) return range(1, pageCount);
  const start = Math.min(Math.max(page - Math.floor(WINDOW / 2), 2), pageCount - WINDOW);
  const end = start + WINDOW - 1;
  return [
    1,
    ...skipped(2, start - 1),
    ...range(start, end),
    ...skipped(end + 1, pageCount - 1),
    pageCount,
  ];
}

const SLOT_CLASS =
  'inline-flex h-7 min-w-7 items-center justify-center rounded-lg px-1 text-[11px] tabular-nums transition-colors disabled:opacity-40';

interface NotesPagerProps {
  page: number;
  pageCount: number;
  /** Rows matching the filters, all pages. Printed, not derived from `pageCount`. */
  total: number;
  onPage: (next: number) => void;
}

export default function NotesPager({ page, pageCount, total, onPage }: NotesPagerProps) {
  const { t, i18n } = useTranslation('common');

  // An empty library says nothing about paging; a library that fits on one page still
  // says how big it is, which is the number the old short-page heuristic threw away.
  if (pageCount <= 1) {
    if (total === 0) return null;
    return (
      <p className="shrink-0 px-2 pb-2 pt-1 text-center text-[11px] text-neutral-400 dark:text-neutral-500">
        {t('notes.pagination.totalNotes', { total: total.toLocaleString(i18n.language) })}
      </p>
    );
  }

  return (
    <nav aria-label={t('notes.pagination.label')} className="shrink-0 px-2 pb-2 pt-1">
      <div className="flex items-center justify-center gap-0.5">
        <button
          type="button"
          aria-label={t('notes.pagination.prev')}
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          className={cn(
            SLOT_CLASS,
            'text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800',
          )}
        >
          <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
        </button>

        {pageWindow(page, pageCount).map((slot, index) =>
          slot === 'gap' ? (
            <span
              key={`gap-${index}`}
              aria-hidden="true"
              className="inline-flex h-7 min-w-7 items-center justify-center text-[11px] text-neutral-400 dark:text-neutral-600"
            >
              …
            </span>
          ) : (
            <button
              key={slot}
              type="button"
              aria-label={t('notes.pagination.goTo', { page: slot })}
              aria-current={slot === page ? 'page' : undefined}
              onClick={() => onPage(slot)}
              className={cn(
                SLOT_CLASS,
                slot === page
                  ? 'bg-neutral-900 font-medium text-white dark:bg-neutral-100 dark:text-neutral-900'
                  : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800',
              )}
            >
              {slot}
            </button>
          ),
        )}

        <button
          type="button"
          aria-label={t('notes.pagination.next')}
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
          className={cn(
            SLOT_CLASS,
            'text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800',
          )}
        >
          <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>

      <p className="mt-1 text-center text-[11px] text-neutral-400 dark:text-neutral-500">
        {t('notes.pagination.status', { page, pages: pageCount })} ·{' '}
        {t('notes.pagination.totalNotes', { total: total.toLocaleString(i18n.language) })}
      </p>
    </nav>
  );
}
