import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { cn, formatRelativeTime } from '../../lib/utils';
import Button from '../ui/Button';
import Select from '../ui/Select';
import Spinner from '../ui/Spinner';
import { KnowledgeApiError, listKnowledgePages, searchKnowledgePages } from './knowledge-api';
import KnowledgeScopeBadge from './KnowledgeScopeBadge';
import {
  PAGE_TYPES,
  type KnowledgePageStatus,
  type KnowledgePagePayload,
  type PageType,
} from './types';

/** Same page size the memory list uses (and the route's default). */
const PAGE_SIZE = 20;
/** The route clamps search to 20; asking for the cap keeps a common term from hiding hits. */
const SEARCH_LIMIT = 20;
const SEARCH_DEBOUNCE_MS = 300;

const STATUS_OPTIONS: Array<Exclude<KnowledgePageStatus, 'pending'>> = ['active', 'archived'];

/** `?tag=` exists on the route but is not a filter here: the tag list would need its own endpoint. */
type ListResult =
  | { kind: 'list'; pages: Awaited<ReturnType<typeof listKnowledgePages>> }
  | { kind: 'search'; hits: Awaited<ReturnType<typeof searchKnowledgePages>> };

/**
 * What a row hands the editor. A browse row carries its whole record, an
 * archived row *has* to: `GET /page/:id` is active-only, so the list response
 * is the only place an archived body is served.
 */
export interface KnowledgeSelection {
  id: string;
  page?: KnowledgePagePayload;
}

interface KnowledgePageListProps {
  selectedId: string | null;
  onSelect: (selection: KnowledgeSelection) => void;
  /** Bumped by the parent after a save / approve / archive, to refetch. */
  refreshKey: number;
}

/**
 * Browse + search column of the knowledge workbench.
 *
 * A non-empty query switches the column to full-text search (`/search`), which
 * is active-only by design on the server — so the status filter is hidden
 * rather than shown as if it applied, and the results say what they cover.
 */
export default function KnowledgePageList({
  selectedId,
  onSelect,
  refreshKey,
}: KnowledgePageListProps) {
  const { t } = useTranslation('common');

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<Exclude<KnowledgePageStatus, 'pending'>>('active');
  const [pageType, setPageType] = useState<PageType | 'all'>('all');
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<ListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 404 on a browse/search call means the layer is off, not that a page is missing. */
  const [notEnabled, setNotEnabled] = useState(false);
  /** Manual retry pulse — the effect's other inputs are unchanged on a failure. */
  const [reloadToken, setReloadToken] = useState(0);

  const term = query.trim();

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        if (term) {
          const hits = await searchKnowledgePages({
            q: term,
            pageType: pageType === 'all' ? undefined : pageType,
            limit: SEARCH_LIMIT,
          });
          if (!cancelled) setResult({ kind: 'search', hits });
        } else {
          const pages = await listKnowledgePages({
            status,
            pageType: pageType === 'all' ? undefined : pageType,
            limit: PAGE_SIZE,
            offset,
          });
          if (!cancelled) setResult({ kind: 'list', pages });
        }
        if (!cancelled) setError(null);
      } catch (err) {
        if (!cancelled) {
          setResult(null);
          setError(t(term ? 'knowledge.searchError' : 'knowledge.loadError'));
          // `knowledge-routes` is only registered while `knowledge.enabled` is
          // true, so an unmatched endpoint is the layer being switched off.
          setNotEnabled(err instanceof KnowledgeApiError && err.status === 404);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    setLoading(true);
    setError(null);
    // The browse list is a deliberate click; only typing is debounced.
    if (!term) {
      void load();
      return () => {
        cancelled = true;
      };
    }
    const timer = setTimeout(() => void load(), SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, status, pageType, offset, refreshKey, reloadToken, t]);

  // A filter change is a new result set, so the old offset would page into nothing.
  const changeStatus = (next: Exclude<KnowledgePageStatus, 'pending'>) => {
    setStatus(next);
    setOffset(0);
  };
  const changePageType = (next: PageType | 'all') => {
    setPageType(next);
    setOffset(0);
  };
  const changeQuery = (next: string) => {
    setQuery(next);
    setOffset(0);
  };

  const pageTypeOptions = [
    { value: 'all', label: t('knowledge.pageTypeAll') },
    ...PAGE_TYPES.map((value) => ({ value, label: t(`knowledge.pageTypes.${value}`) })),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 border-b border-neutral-200 p-3 dark:border-neutral-800">
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 dark:text-neutral-400"
          />
          <input
            type="text"
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
            placeholder={t('knowledge.searchPlaceholder')}
            aria-label={t('knowledge.searchPlaceholder')}
            className="w-full rounded-lg border border-neutral-300 bg-white py-2 pl-9 pr-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-primary focus:outline-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100"
          />
        </div>
        <div className="flex items-center gap-2">
          {/* Search is active-only server-side, so the status filter is not a
              filter in that mode — offering it would imply it did something. */}
          {!term && (
            <Select
              compact
              value={status}
              onChange={(event) =>
                changeStatus(event.target.value as Exclude<KnowledgePageStatus, 'pending'>)
              }
              options={STATUS_OPTIONS.map((value) => ({
                value,
                label: t(`knowledge.statuses.${value}`),
              }))}
              className="w-28"
            />
          )}
          <Select
            compact
            value={pageType}
            onChange={(event) => changePageType(event.target.value as PageType | 'all')}
            options={pageTypeOptions}
            className="min-w-0 flex-1"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex justify-center py-10">
            <Spinner size="sm" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
            {notEnabled && (
              <p className="max-w-xs text-[11px] text-neutral-500 dark:text-neutral-400">
                {t('knowledge.notEnabledHint')}
              </p>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setReloadToken((token) => token + 1)}
            >
              {t('knowledge.retry')}
            </Button>
          </div>
        ) : result === null ? null : result.kind === 'search' ? (
          result.hits.count === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-neutral-500 dark:text-neutral-400">
              {t('knowledge.searchNoResults')}
            </p>
          ) : (
            <>
              <p className="px-3 pt-2 text-[11px] text-neutral-500 dark:text-neutral-400">
                {t('knowledge.searchActiveOnlyHint')}
              </p>
              <ul className="p-2">
                {result.hits.hits.map((hit) => (
                  <li key={hit.id}>
                    <button
                      type="button"
                      onClick={() => onSelect({ id: hit.id })}
                      className={cn(
                        'flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left transition-colors',
                        hit.id === selectedId
                          ? 'bg-neutral-100 dark:bg-neutral-800'
                          : 'hover:bg-neutral-100 dark:hover:bg-neutral-800',
                      )}
                    >
                      <span className="flex w-full items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
                          {hit.title}
                        </span>
                        <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                          {t(`knowledge.pageTypes.${hit.pageType}`)}
                        </span>
                      </span>
                      <span className="line-clamp-2 text-[11px] leading-[1.4] text-neutral-500 dark:text-neutral-400">
                        {hit.snippet || ' '}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {result.hits.count >= result.hits.limit && (
                <p className="px-3 pb-3 text-[11px] text-amber-600 dark:text-amber-400">
                  {t('knowledge.searchCapped', { count: result.hits.limit })}
                </p>
              )}
            </>
          )
        ) : result.pages.pages.length === 0 ? (
          <div className="px-4 py-10 text-center">
            {status === 'archived' ? (
              <p className="text-sm text-neutral-600 dark:text-neutral-300">
                {t('knowledge.emptyArchived')}
              </p>
            ) : (
              <>
                <p className="text-sm text-neutral-600 dark:text-neutral-300">
                  {t('knowledge.emptyTitle')}
                </p>
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  {t('knowledge.emptyHint')}
                </p>
              </>
            )}
          </div>
        ) : (
          <ul className="p-2">
            {result.pages.pages.map((page) => (
              <li key={page.id}>
                <button
                  type="button"
                  onClick={() => onSelect({ id: page.id, page })}
                  className={cn(
                    'flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left transition-colors',
                    page.id === selectedId
                      ? 'bg-neutral-100 dark:bg-neutral-800'
                      : 'hover:bg-neutral-100 dark:hover:bg-neutral-800',
                  )}
                >
                  <span className="flex w-full items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-800 dark:text-neutral-200">
                      {page.title}
                    </span>
                    <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                      {t(`knowledge.pageTypes.${page.pageType}`)}
                    </span>
                  </span>
                  <span className="flex w-full items-baseline gap-2 text-[11px] text-neutral-500 dark:text-neutral-400">
                    {/* Which conversation this page came from: a list that spans
                        every scope is otherwise a pile of pages nobody can place. */}
                    <KnowledgeScopeBadge scope={page.scope} />
                    <span className="min-w-0 flex-1 truncate">{page.slug}</span>
                    <span className="shrink-0">
                      {page.updatedAt
                        ? t('knowledge.updatedAt', {
                            time: formatRelativeTime(page.updatedAt),
                          })
                        : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Paging is offset-based and the route returns no total, so "next" is
          offered only while the last page came back full. Search has no offset
          parameter at all — it is capped instead. */}
      {!term && result?.kind === 'list' && result.pages.count > 0 && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-neutral-200 px-3 py-2 dark:border-neutral-800">
          <Button
            variant="ghost"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            aria-label={t('knowledge.prevPage')}
          >
            <ChevronLeft size={14} />
          </Button>
          <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
            {t('knowledge.range', {
              from: result.pages.offset + 1,
              to: result.pages.offset + result.pages.count,
            })}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={result.pages.count < PAGE_SIZE}
            onClick={() => setOffset(offset + PAGE_SIZE)}
            aria-label={t('knowledge.nextPage')}
          >
            <ChevronRight size={14} />
          </Button>
        </div>
      )}
    </div>
  );
}
