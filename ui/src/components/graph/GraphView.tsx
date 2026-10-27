import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Network, Search } from 'lucide-react';
import { apiRequest } from '../../utils/api';
import Button from '../ui/Button';
import Select from '../ui/Select';
import Spinner from '../ui/Spinner';
import NeighbourhoodGraph from './NeighbourhoodGraph';
import EntityDetail from './EntityDetail';
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

export default function GraphView() {
  const { t } = useTranslation('common');

  const [query, setQuery] = useState('');
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

  // Debounced so typing does not fire one request per keystroke.
  useEffect(() => {
    const term = query.trim();
    if (!term) {
      setResults([]);
      setSearchError(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    setSearchError(null);
    const timer = setTimeout(() => {
      apiRequest<SearchPayload>(
        `/api/search?q=${encodeURIComponent(term)}&limit=${SEARCH_RESULT_LIMIT}`,
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
  }, [query, t]);

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

        {/* Unified search: entities, memories and messages in one box. */}
        <div className="relative">
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

        {hasQuery && (
          <div className="mt-2 rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
            {searching ? (
              <div className="flex justify-center py-4">
                <Spinner size="sm" />
              </div>
            ) : searchError ? (
              <p className="text-xs text-red-600 dark:text-red-400">{searchError}</p>
            ) : groupedResults.length === 0 ? (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {t('graph.searchNoResults')}
              </p>
            ) : (
              <div className="space-y-3">
                {groupedResults.map((group) => (
                  <div key={group.kind}>
                    <h2 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                      {t(`graph.kinds.${group.kind}`)}
                    </h2>
                    <ul className="space-y-1">
                      {group.items.map((result) => (
                        <li key={`${result.kind}-${result.id}`}>
                          <button
                            type="button"
                            onClick={() => {
                              if (result.kind === 'entity') setSelectedId(result.id);
                            }}
                            className={`w-full rounded-md px-2 py-1.5 text-left transition-colors ${
                              result.kind === 'entity'
                                ? 'hover:bg-neutral-100 dark:hover:bg-neutral-800'
                                : 'cursor-default'
                            }`}
                          >
                            <p className="truncate text-xs font-medium text-neutral-800 dark:text-neutral-200">
                              {result.title}
                            </p>
                            {result.snippet && (
                              <p className="mt-0.5 line-clamp-2 text-[11px] text-neutral-500 dark:text-neutral-400">
                                {result.snippet}
                              </p>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div
          className={`mt-4 grid gap-4 ${selectedId ? 'lg:grid-cols-[minmax(0,1fr)_18rem]' : ''}`}
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
    </div>
  );
}
