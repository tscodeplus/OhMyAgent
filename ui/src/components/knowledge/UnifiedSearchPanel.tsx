import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';
import { apiRequest } from '../../utils/api';
import Spinner from '../ui/Spinner';
import SearchContextPanel from '../graph/SearchContextPanel';
import type { SearchKindSelection } from '../graph/SearchKindFilter';
import type {
  SearchPayload,
  SearchPageRow,
  SearchResult,
  SearchResultKind,
} from '../../types/graph';

/** Per-lane page size; the server treats `limit` as a per-lane allowance. */
const SEARCH_RESULT_LIMIT = 10;
const SEARCH_DEBOUNCE_MS = 300;
/** Group order: what was written down first, then what it was derived from. */
const RESULT_KINDS: SearchResultKind[] = ['entity', 'memory', 'message'];
/** Horizontal breathing room between the hit drawer and the result card. */
const DRAWER_INSET_PX = 2;

interface UnifiedSearchPanelProps {
  query: string;
  selection: SearchKindSelection;
  /**
   * The page lane's rows are always rendered (the server does not gate that lane
   * by `kinds`), but only while the page layer can answer at all — with the
   * layer off there is nothing to open, so an empty page group is not shown.
   */
  pageLayerEnabled: boolean;
  onOpenPage: (pageId: string) => void;
  onOpenEntity: (entityId: string) => void;
}

/**
 * The merged search box's result list: knowledge pages, entities, memories and
 * conversations, in one fused ranking.
 *
 * This replaced the graph page's own search. That box already called
 * `/api/search`, which fuses four lanes through `unifiedSearch()` — but its
 * payload type declared only `{q, results}`, so `pages`, `deduped` and `hints`
 * were dropped on the floor. That was not cosmetic: the fusion drops a memory
 * when a returned page cites it, so the page row is the *replacement* for a
 * memory hit. Without rendering it, a search silently lost results. Hence the
 * `deduped` line below — a drop the reader can see and explain.
 *
 * `onOpenPage` / `onOpenEntity` hand navigation to the hub, which owns the
 * routes: a page opens in the pages tab, an entity in the graph tab.
 */
export default function UnifiedSearchPanel({
  query,
  selection,
  pageLayerEnabled,
  onOpenPage,
  onOpenEntity,
}: UnifiedSearchPanelProps) {
  const { t } = useTranslation('common');

  const [results, setResults] = useState<SearchResult[]>([]);
  const [pages, setPages] = useState<SearchPageRow[]>([]);
  const [dedupedCount, setDedupedCount] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Message/memory hit opened in the context drawer; null = closed. */
  const [contextHit, setContextHit] = useState<SearchResult | null>(null);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const [drawerBox, setDrawerBox] = useState<{ left: number; width: number } | null>(null);

  /** True when nothing at all is selected, so no request is worth making. */
  const noSelection =
    !selection.entity &&
    !selection.message &&
    selection.memoryKinds !== null &&
    selection.memoryKinds.length === 0;

  useEffect(() => {
    const term = query.trim();
    const memoryKinds = selection.memoryKinds;
    const memoryOn = memoryKinds === null || memoryKinds.length > 0;
    const legs = [
      ...(selection.entity ? ['entity'] : []),
      ...(memoryOn ? ['memory'] : []),
      ...(selection.message ? ['message'] : []),
    ];
    if (!term || legs.length === 0) {
      setResults([]);
      setPages([]);
      setDedupedCount(0);
      setError(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setError(null);
    const requestedKinds = RESULT_KINDS.filter((kind) => legs.includes(kind)).join(',');
    const memoryKindFilter =
      memoryOn && memoryKinds !== null ? `&memory_kinds=${memoryKinds.join(',')}` : '';
    const timer = setTimeout(() => {
      apiRequest<SearchPayload>(
        `/api/search?q=${encodeURIComponent(term)}&limit=${SEARCH_RESULT_LIMIT}&kinds=${requestedKinds}${memoryKindFilter}`,
      )
        .then((payload) => {
          if (cancelled) return;
          setResults(payload.results);
          setPages(payload.pages ?? []);
          setDedupedCount(payload.deduped?.length ?? 0);
        })
        .catch(() => {
          if (cancelled) return;
          setResults([]);
          setPages([]);
          setDedupedCount(0);
          setError(t('graph.searchError'));
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, selection, t]);

  // The drawer covers the result column rather than the viewport: `fixed` is
  // measured against the viewport, which the sidebar and the page padding shift.
  useEffect(() => {
    if (!contextHit) {
      setDrawerBox(null);
      return;
    }
    const measure = () => {
      const element = resultsRef.current;
      // Phones keep the full-bleed sheet; a measured box would fight the layout.
      if (!element || window.innerWidth < 640) {
        setDrawerBox(null);
        return;
      }
      const rect = element.getBoundingClientRect();
      setDrawerBox({
        left: Math.round(rect.left) + DRAWER_INSET_PX,
        width: Math.round(rect.width) - DRAWER_INSET_PX * 2,
      });
    };
    measure();
    window.addEventListener('resize', measure);
    const observer = new ResizeObserver(measure);
    if (resultsRef.current) observer.observe(resultsRef.current);
    return () => {
      window.removeEventListener('resize', measure);
      observer.disconnect();
    };
  }, [contextHit]);

  const groupedResults = useMemo(
    () =>
      RESULT_KINDS.map((kind) => ({
        kind,
        items: results.filter((result) => result.kind === kind),
      })).filter((group) => group.items.length > 0),
    [results],
  );

  const showPages = pageLayerEnabled && pages.length > 0;
  const empty = !searching && !error && !noSelection && groupedResults.length === 0 && !showPages;

  return (
    <>
      <div
        ref={resultsRef}
        className="rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
      >
        {searching ? (
          <div className="flex justify-center py-6">
            <Spinner size="sm" />
          </div>
        ) : error ? (
          <p className="px-2 py-3 text-xs text-red-600 dark:text-red-400">{error}</p>
        ) : noSelection ? (
          <p className="px-2 py-3 text-xs text-neutral-500 dark:text-neutral-400">
            {t('graph.filterNone')}
          </p>
        ) : empty ? (
          <p className="px-2 py-3 text-xs text-neutral-500 dark:text-neutral-400">
            {t('graph.searchNoResults')}
          </p>
        ) : (
          // One divider per group and one fixed row rhythm: title clamped to one
          // line, snippet pinned to two. Mixed one/two-line snippets with ad-hoc
          // margins is what made the spacing look random on a phone.
          <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {showPages && (
              <section className="py-1 first:pt-0 last:pb-0">
                <h2 className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                  {t('knowledge.searchGroupPages')}
                </h2>
                <ul className="space-y-0.5">
                  {pages.map((page) => (
                    <li key={`page-${page.id}`}>
                      <button
                        type="button"
                        onClick={() => onOpenPage(page.id)}
                        className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800"
                      >
                        <span className="flex w-full items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-800 dark:text-neutral-200">
                            {page.title}
                          </span>
                          <span className="shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500">
                            {t('knowledge.searchOpenPage')}
                          </span>
                        </span>
                        <span className="line-clamp-2 min-h-[2.8em] w-full text-[11px] leading-[1.4] text-neutral-500 dark:text-neutral-400">
                          {page.snippet || ' '}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {groupedResults.map((group) => (
              <section key={group.kind} className="py-1 first:pt-0 last:pb-0">
                <h2 className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                  {t(`graph.kinds.${group.kind}`)}
                </h2>
                <ul className="space-y-0.5">
                  {group.items.map((result) => {
                    const isEntity = result.kind === 'entity';
                    const isActive =
                      contextHit?.kind === result.kind && contextHit?.id === result.id;
                    return (
                      <li key={`${result.kind}-${result.id}`}>
                        <button
                          type="button"
                          onClick={() => {
                            if (isEntity) {
                              setContextHit(null);
                              onOpenEntity(result.id);
                              return;
                            }
                            setContextHit(result);
                          }}
                          className={cn(
                            'flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors',
                            isActive
                              ? 'bg-neutral-100 dark:bg-neutral-800'
                              : 'hover:bg-neutral-100 dark:hover:bg-neutral-800',
                          )}
                        >
                          {/* Exactly two text lines in every row — title, then a
                              two-line snippet — so a page of mixed kinds keeps
                              one rhythm. Provenance rides on the title line
                              instead of adding a third line to message hits only. */}
                          <span className="flex w-full items-baseline gap-2">
                            <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-800 dark:text-neutral-200">
                              {result.title}
                            </span>
                            {result.kind === 'message' && result.session_title && (
                              <span
                                className="max-w-[45%] shrink-0 truncate text-[10px] font-normal text-neutral-400 dark:text-neutral-500"
                                title={result.session_title}
                              >
                                {result.session_title}
                              </span>
                            )}
                          </span>
                          <span className="line-clamp-2 min-h-[2.8em] w-full text-[11px] leading-[1.4] text-neutral-500 dark:text-neutral-400">
                            {result.snippet || ' '}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}

        {/* The fusion dropped these memories because a page above already cites
            them. Said out loud, because a silently shortened list reads as a
            broken search. */}
        {dedupedCount > 0 && (
          <p className="mt-1.5 border-t border-neutral-200 px-2 pt-1.5 text-[11px] text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
            {t('knowledge.searchDeduped', { count: dedupedCount })}
          </p>
        )}
      </div>

      {contextHit && (
        <SearchContextPanel hit={contextHit} onClose={() => setContextHit(null)} box={drawerBox} />
      )}
    </>
  );
}
