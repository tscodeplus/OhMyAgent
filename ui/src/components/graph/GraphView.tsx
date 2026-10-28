import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Network, Search } from 'lucide-react';
import { apiRequest } from '../../utils/api';
import { cn } from '../../lib/utils';
import Button from '../ui/Button';
import Select from '../ui/Select';
import Spinner from '../ui/Spinner';
import NeighbourhoodGraph from './NeighbourhoodGraph';
import EntityDetail from './EntityDetail';
import SearchContextPanel from './SearchContextPanel';
import SearchKindFilter, { type SearchKindSelection } from './SearchKindFilter';
import type {
  EntityDetailPayload,
  GraphPayload,
  SearchPayload,
  SearchResult,
  SearchResultKind,
} from '../../types/graph';

/** Group order in the result list — entities are what this page is about. */
const RESULT_KINDS: SearchResultKind[] = ['entity', 'memory', 'message'];
const SEARCH_RESULT_LIMIT = 10;
const DEPTH_OPTIONS = [1, 2, 3];
/** Horizontal breathing room between the search-hit drawer and the result card. */
const DRAWER_INSET_PX = 2;

export default function GraphView() {
  const { t } = useTranslation('common');

  const [query, setQuery] = useState('');
  /**
   * Which legs/kinds the search may return. Memory kinds default to "all" (null)
   * rather than an explicit list, so a kind the database learns later is included
   * without the user re-selecting anything.
   */
  const [selection, setSelection] = useState<SearchKindSelection>({
    entity: true,
    message: true,
    memoryKinds: null,
  });
  /** Memory kinds that exist in the database, for the type dropdown. */
  const [availableMemoryKinds, setAvailableMemoryKinds] = useState<string[]>([]);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  /** Undefined = overview (the busiest entities). */
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [depth, setDepth] = useState(1);
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [graphLoading, setGraphLoading] = useState(true);
  const [graphError, setGraphError] = useState<string | null>(null);

  const [aliases, setAliases] = useState<string[]>([]);
  const [aliasesLoading, setAliasesLoading] = useState(false);
  /** Search hit opened in the context drawer; null = closed. */
  const [contextHit, setContextHit] = useState<SearchResult | null>(null);
  /** The result list, used to line the drawer up with it on wide screens. */
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const [drawerBox, setDrawerBox] = useState<{ left: number; width: number } | null>(null);

  const loadGraph = useCallback(async () => {
    setGraphLoading(true);
    setGraphError(null);
    const params = new URLSearchParams({ limit: '200' });
    if (selectedId) {
      params.set('entity', selectedId);
      params.set('depth', String(depth));
    }
    try {
      const payload = await apiRequest<GraphPayload>(`/api/memory/graph?${params.toString()}`);
      setGraph(payload);
    } catch {
      setGraphError(t('graph.loadError'));
      setGraph(null);
    } finally {
      setGraphLoading(false);
    }
  }, [selectedId, depth, t]);

  useEffect(() => {
    void loadGraph();
  }, [loadGraph]);

  // Aliases are not part of the graph payload (nodes describe the drawing, not
  // the record), so the detail header fetches the entity itself.
  useEffect(() => {
    if (!selectedId) {
      setAliases([]);
      return;
    }
    let cancelled = false;
    setAliasesLoading(true);
    apiRequest<EntityDetailPayload>(`/api/memory/entity/${encodeURIComponent(selectedId)}`)
      .then((payload) => {
        if (!cancelled) setAliases(payload.aliases);
      })
      .catch(() => {
        if (!cancelled) setAliases([]);
      })
      .finally(() => {
        if (!cancelled) setAliasesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // The dropdown offers the same memory kinds the memory page filters by, so it
  // reads the same endpoint instead of hard-coding a vocabulary that would drift.
  useEffect(() => {
    let cancelled = false;
    apiRequest<{ kinds: string[] }>('/api/memory/filters')
      .then((payload) => {
        if (!cancelled) setAvailableMemoryKinds(payload.kinds ?? []);
      })
      .catch(() => {
        if (!cancelled) setAvailableMemoryKinds([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounced so typing does not fire one request per keystroke. The filter goes
  // to the server rather than being applied to the response: each leg there is
  // capped at `limit`, so client-side hiding would silently return a shorter
  // page than the cap allows.
  useEffect(() => {
    const term = query.trim();
    const memoryKinds = selection.memoryKinds;
    const memoryOn = memoryKinds === null || memoryKinds.length > 0;
    const legs = [
      ...(selection.entity ? ['entity'] : []),
      ...(memoryOn ? ['memory'] : []),
      ...(selection.message ? ['message'] : []),
    ];
    if (!term) {
      setResults([]);
      setSearchError(null);
      setSearching(false);
      return;
    }
    if (legs.length === 0) {
      // Nothing is being asked for, so nothing is fetched — but keep whatever
      // is on screen out of the way of the hint.
      setResults([]);
      setSearchError(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setSearchError(null);
    const requestedKinds = RESULT_KINDS.filter((kind) => legs.includes(kind)).join(',');
    const memoryKindFilter =
      memoryOn && memoryKinds !== null ? `&memory_kinds=${memoryKinds.join(',')}` : '';
    const timer = setTimeout(() => {
      apiRequest<SearchPayload>(
        `/api/search?q=${encodeURIComponent(term)}&limit=${SEARCH_RESULT_LIMIT}&kinds=${requestedKinds}${memoryKindFilter}`,
      )
        .then((payload) => {
          if (!cancelled) setResults(payload.results);
        })
        .catch(() => {
          if (!cancelled) {
            setResults([]);
            setSearchError(t('graph.searchError'));
          }
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, selection, t]);

  // The drawer spans the result list rather than the viewport: `fixed` is
  // measured against the viewport, which the sidebar and the page padding shift,
  // so a centred sheet lands off the column it belongs to. Measured on open and
  // on resize — the sidebar collapses without a window resize, hence the observer.
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
      // Inset a couple of pixels on each side rather than matching the result
      // card edge for edge: an exact overlay reads as if the card itself turned
      // into a panel, and the hairline of the card behind is what tells the eye
      // this is a surface pulled over the page.
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

  const nodesById = useMemo(
    () => new Map((graph?.nodes ?? []).map((node) => [node.id, node])),
    [graph],
  );
  const selectedNode = selectedId ? nodesById.get(selectedId) : undefined;

  const groupedResults = useMemo(() => {
    return RESULT_KINDS.map((kind) => ({
      kind,
      items: results.filter((result) => result.kind === kind),
    })).filter((group) => group.items.length > 0);
  }, [results]);

  /** True when nothing at all is selected, so no request is worth making. */
  const noSelection =
    !selection.entity &&
    !selection.message &&
    selection.memoryKinds !== null &&
    selection.memoryKinds.length === 0;

  const hasQuery = query.trim().length > 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl p-3 sm:p-6">
        <header className="mb-3">
          <h1 className="flex items-center gap-2 text-base font-semibold text-neutral-900 dark:text-neutral-100">
            <Network size={18} strokeWidth={1.75} />
            {t('graph.title')}
          </h1>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {t('graph.subtitle')}
          </p>
        </header>

        {/* Unified search: entities, memories and messages in one box, with the
            type filter beside it. The filter is a dropdown of checkboxes rather
            than a chip row: it carries the memory kinds too, which would turn
            chips into two or three lines of noise. */}
        <div className="flex items-stretch gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 dark:text-neutral-400"
            />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('graph.searchPlaceholder')}
              aria-label={t('graph.searchPlaceholder')}
              className="w-full rounded-lg border border-neutral-300 bg-white py-2 pl-9 pr-3 text-sm text-neutral-900 focus:border-primary focus:outline-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100"
            />
          </div>
          <SearchKindFilter
            value={selection}
            availableMemoryKinds={availableMemoryKinds}
            onChange={setSelection}
          />
        </div>

        {hasQuery && (
          <div
            ref={resultsRef}
            className="mt-2 rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
          >
            {searching ? (
              <div className="flex justify-center py-6">
                <Spinner size="sm" />
              </div>
            ) : searchError ? (
              <p className="px-2 py-3 text-xs text-red-600 dark:text-red-400">{searchError}</p>
            ) : noSelection ? (
              <p className="px-2 py-3 text-xs text-neutral-500 dark:text-neutral-400">
                {t('graph.filterNone')}
              </p>
            ) : groupedResults.length === 0 ? (
              <p className="px-2 py-3 text-xs text-neutral-500 dark:text-neutral-400">
                {t('graph.searchNoResults')}
              </p>
            ) : (
              // Groups are stacked with one divider each and every row is a
              // single card of identical height rhythm: title clamped to one
              // line, snippet pinned to two. Mixed one/two-line snippets with
              // ad-hoc margins is what made the spacing look random on a phone.
              <div className="divide-y divide-neutral-200 dark:divide-neutral-800">
                {groupedResults.map((group) => (
                  <section key={group.kind} className="py-1 first:pt-0 last:pb-0">
                    <h2 className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                      {t(`graph.kinds.${group.kind}`)}
                    </h2>
                    <ul className="space-y-0.5">
                      {group.items.map((result) => {
                        const isEntity = result.kind === 'entity';
                        const isActive =
                          (isEntity && result.id === selectedId) ||
                          (contextHit?.kind === result.kind && contextHit?.id === result.id);
                        return (
                          <li key={`${result.kind}-${result.id}`}>
                            <button
                              type="button"
                              onClick={() => {
                                if (isEntity) {
                                  setSelectedId(result.id);
                                  setContextHit(null);
                                } else {
                                  setContextHit(result);
                                }
                              }}
                              className={cn(
                                'flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors',
                                isActive
                                  ? 'bg-neutral-100 dark:bg-neutral-800'
                                  : 'hover:bg-neutral-100 dark:hover:bg-neutral-800',
                              )}
                            >
                              {/* Exactly two text lines in every row — title, then a
                                  two-line snippet — so a page of mixed kinds keeps one
                                  rhythm. Provenance rides on the title line instead of
                                  adding a third line to message hits only, which is what
                                  made their spacing look different from memory hits. */}
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
                                {result.snippet || ' '}
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
          </div>
        )}

        <div
          className={cn(
            'mt-4 grid gap-4',
            // Only the entity detail shares the row now; the search-hit drawer
            // is fixed to the bottom edge and depends on no grid column.
            selectedId && 'lg:grid-cols-[minmax(0,1fr)_18rem]',
          )}
        >
          <section className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-200">
                  {selectedNode ? selectedNode.name : t('graph.overview')}
                </h2>
                {graph && (
                  <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                    {t('graph.counts', { nodes: graph.nodes.length, edges: graph.edges.length })}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {selectedId && (
                  <Button variant="secondary" size="sm" onClick={() => setSelectedId(undefined)}>
                    {t('graph.backToOverview')}
                  </Button>
                )}
                <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  {t('graph.depth')}
                </span>
                <Select
                  compact
                  value={String(depth)}
                  // Depth is a traversal knob for a single entity; the overview
                  // takes the whole graph, so the control is inert there.
                  disabled={!selectedId}
                  onChange={(event) => setDepth(Number(event.target.value))}
                  options={DEPTH_OPTIONS.map((option) => ({
                    value: String(option),
                    label: t('graph.depthOption', { count: option }),
                  }))}
                  className="w-24"
                />
              </div>
            </div>

            {graphLoading ? (
              <div className="flex justify-center py-12">
                <Spinner />
              </div>
            ) : graphError ? (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <p className="text-xs text-red-600 dark:text-red-400">{graphError}</p>
                <Button variant="secondary" size="sm" onClick={() => void loadGraph()}>
                  {t('graph.retry')}
                </Button>
              </div>
            ) : !graph || graph.nodes.length === 0 ? (
              <div className="flex flex-col items-center gap-1 py-12 text-center">
                <p className="text-sm text-neutral-600 dark:text-neutral-300">
                  {t('graph.emptyTitle')}
                </p>
                <p className="max-w-xs text-xs text-neutral-500 dark:text-neutral-400">
                  {t('graph.emptyHint')}
                </p>
              </div>
            ) : (
              <>
                {graph.truncated && (
                  <p className="mb-1 text-[11px] text-amber-600 dark:text-amber-400">
                    {t('graph.truncated')}
                  </p>
                )}
                <NeighbourhoodGraph
                  nodes={graph.nodes}
                  edges={graph.edges}
                  focusId={selectedId}
                  onSelect={setSelectedId}
                />
              </>
            )}
          </section>

          {selectedNode && (
            <aside className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
              <EntityDetail
                node={selectedNode}
                aliases={aliases}
                edges={graph?.edges ?? []}
                nodesById={nodesById}
                aliasesLoading={aliasesLoading}
                onSelect={setSelectedId}
              />
            </aside>
          )}
        </div>
      </div>

      {contextHit && (
        <SearchContextPanel hit={contextHit} onClose={() => setContextHit(null)} box={drawerBox} />
      )}
    </div>
  );
}
