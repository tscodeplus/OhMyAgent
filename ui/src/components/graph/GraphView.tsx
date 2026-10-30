import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Network } from 'lucide-react';
import { apiRequest } from '../../utils/api';
import { cn } from '../../lib/utils';
import Button from '../ui/Button';
import Select from '../ui/Select';
import Spinner from '../ui/Spinner';
import NeighbourhoodGraph from './NeighbourhoodGraph';
import EntityDetail from './EntityDetail';
import RelationTable from './RelationTable';
import GraphDiagnostics from './GraphDiagnostics';
import GraphFilters from './GraphFilters';
import { SPARSE_EDGE_LIMIT } from './layout';
import type {
  EntityDetailPayload,
  EntityPageRef,
  GraphComponent,
  GraphPayload,
  GraphStats,
  GraphSummary,
} from '../../types/graph';

const DEPTH_OPTIONS = [1, 2, 3];
/** The server's node budget for the overview; also the composition's node cap. */
const DEFAULT_LIMIT = 200;
/** Mention names the neighbourhood block prints before summarising the rest. */
const MENTION_DISPLAY_LIMIT = 24;

/**
 * `<input type="date">` value → the instant the drawing is asked about.
 *
 * End of the chosen day, because a relation that started that morning was true
 * that day: asking about the day should not hide it. An empty value means all
 * time, expressed by OMITTING `asOf` — the route's parser reads 0 as "no filter"
 * too, but a timestamp at the epoch would be a different request than no request.
 */
function asOfEpochMs(date: string): number | undefined {
  if (!date) return undefined;
  const parsed = new Date(`${date}T23:59:59.999`).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface GraphViewProps {
  /**
   * Route-owned selection (`/knowledge/graph/:entityId`); undefined = overview.
   * The hub owns it because the URL is what a page link and a search hit both
   * navigate by.
   */
  entityId?: string;
  onSelectEntity: (entityId: string | undefined) => void;
  /** Counts for the shared header; null while nothing has loaded. */
  onSummary?: (summary: GraphSummary | null) => void;
  /** Opens a curated page that points at the selected entity. */
  onOpenPage: (pageId: string) => void;
}

/**
 * The entity graph tab: overview, one entity's neighbourhood, or one connected
 * component, the detail panel beside it, and the two links back into the page
 * layer.
 *
 * The view is chosen by what the reader asked for, not by what the payload
 * happens to contain: the overview reports structure (counts, where the graph
 * breaks) and drills into one component on request; a neighbourhood draws the
 * entity it was opened for. A graph with a handful of relations is shown as a
 * table of relation rows, because a picture of twelve lines among hundreds of
 * names is not a picture of anything.
 *
 * It no longer owns a search box or a page header. Both moved to
 * `KnowledgeHubView` when pages and the graph became one surface — the box that
 * used to live here was already calling the four-lane `/api/search` and dropping
 * its page rows (see `UnifiedSearchPanel`).
 */
export default function GraphView({
  entityId,
  onSelectEntity,
  onSummary,
  onOpenPage,
}: GraphViewProps) {
  const { t } = useTranslation('common');

  const [depth, setDepth] = useState(1);
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [graphLoading, setGraphLoading] = useState(true);
  const [graphError, setGraphError] = useState<string | null>(null);
  const [aliases, setAliases] = useState<string[]>([]);
  const [pages, setPages] = useState<EntityPageRef[]>([]);
  const [aliasesLoading, setAliasesLoading] = useState(false);
  /**
   * The component being drilled into. Local rather than a route param: the route
   * already owns "which entity", and a component is a temporary narrowing of the
   * overview that a reader leaves with one click.
   */
  const [component, setComponent] = useState<{ id: string; name: string } | null>(null);
  const [stats, setStats] = useState<GraphStats | null>(null);
  /** Empty = every relation type (the server's default), never "types=''". */
  const [types, setTypes] = useState<string[]>([]);
  /** `YYYY-MM-DD`; empty = all time. */
  const [asOf, setAsOf] = useState('');
  const [wholeGraph, setWholeGraph] = useState(false);
  /** The canvas, unfolded while the payload is sparse enough to default to a table. */
  const [expanded, setExpanded] = useState(false);

  const asOfMs = useMemo(() => asOfEpochMs(asOf), [asOf]);
  const isNeighbourhood = Boolean(entityId) && !component;
  const isOverview = !entityId && !component;

  const loadGraph = useCallback(async () => {
    setGraphLoading(true);
    setGraphError(null);
    const params = new URLSearchParams({ limit: String(DEFAULT_LIMIT) });
    if (component) {
      // `component` wins over `entity` on the server, and the drill-down is the
      // more specific request of the two.
      params.set('component', component.id);
    } else if (entityId) {
      params.set('entity', entityId);
      params.set('depth', String(depth));
    } else if (wholeGraph) {
      // The escape hatch spends the server's hard cap instead of the budget.
      params.set('whole', '1');
    }
    if (types.length > 0) params.set('types', types.join(','));
    if (asOfMs !== undefined) params.set('asOf', String(asOfMs));
    try {
      const payload = await apiRequest<GraphPayload>(`/api/memory/graph?${params.toString()}`);
      setGraph(payload);
      onSummary?.({
        nodes: payload.nodes.length,
        edges: payload.edges.length,
        enabled: payload.enabled !== false,
      });
    } catch {
      setGraphError(t('graph.loadError'));
      setGraph(null);
      onSummary?.(null);
    } finally {
      setGraphLoading(false);
    }
  }, [asOfMs, component, depth, entityId, onSummary, t, types, wholeGraph]);

  useEffect(() => {
    void loadGraph();
  }, [loadGraph]);

  /**
   * A new payload is a new drawing, so a canvas unfolded for one filter must not stay
   * unfolded for the next — otherwise "expand" silently becomes a setting.
   *
   * The whole-graph switch is deliberately NOT in this list. It is the one control
   * whose whole purpose is to see everything, and it now auto-expands; resetting here
   * would fold away the drawing the reader just asked for.
   */
  useEffect(() => {
    setExpanded(false);
  }, [asOfMs, component, entityId, types]);

  /**
   * Asking for the whole graph and then having to click "expand" is the same
   * intention expressed twice, so checking it unfolds the canvas. Unchecking leaves
   * the canvas as it is: folding a picture the reader is looking at is not a
   * consequence of narrowing the node set.
   */
  const changeWholeGraph = useCallback((next: boolean) => {
    setWholeGraph(next);
    if (next) setExpanded(true);
  }, []);

  // The route owns the entity selection, so arriving at one (a page link, a search
  // hit) has to leave the component drill-down behind instead of drawing it on top.
  useEffect(() => {
    setComponent(null);
  }, [entityId]);

  // Diagnostics describe the whole graph and are unfiltered by design: they are the
  // reference point the filtered drawing is read against. A failure here must not
  // take the drawing down with it, so it simply stays absent.
  useEffect(() => {
    let cancelled = false;
    apiRequest<GraphStats>('/api/memory/graph/stats')
      .then((payload) => {
        if (!cancelled) setStats(payload);
      })
      .catch(() => {
        if (!cancelled) setStats(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Aliases and the pages that point at this entity are not part of the graph
  // payload (nodes describe the drawing, not the record), so the detail header
  // fetches the entity itself.
  useEffect(() => {
    if (!entityId) {
      setAliases([]);
      setPages([]);
      return;
    }
    let cancelled = false;
    setAliasesLoading(true);
    apiRequest<EntityDetailPayload>(`/api/memory/entity/${encodeURIComponent(entityId)}`)
      .then((payload) => {
        if (cancelled) return;
        setAliases(payload.aliases);
        setPages(payload.pages ?? []);
      })
      .catch(() => {
        if (cancelled) return;
        setAliases([]);
        setPages([]);
      })
      .finally(() => {
        if (!cancelled) setAliasesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entityId]);

  const nodesById = useMemo(
    () => new Map((graph?.nodes ?? []).map((node) => [node.id, node])),
    [graph],
  );
  const selectedNode = entityId ? nodesById.get(entityId) : undefined;
  const graphDisabled = graph?.enabled === false;
  const edgeCount = graph?.edges.length ?? 0;
  const sparse = edgeCount <= SPARSE_EDGE_LIMIT;
  const canvasVisible = edgeCount > 0 && (!sparse || expanded);
  const mentions = graph?.mentions ?? [];
  const shownMentions = mentions.slice(0, MENTION_DISPLAY_LIMIT);
  /**
   * Entities in the whole graph, from the unfiltered stats payload. The overview's
   * default is a budget (a phone-shaped 200), so on any corpus bigger than that the
   * picture is a slice — and "200 个实体" alone cannot be told apart from "there are
   * 200". Absent stats means the count stays unqualified rather than invented.
   */
  const wholeTotal = stats && stats.enabled !== false ? stats.nodes : undefined;
  /**
   * How many of the payload's nodes carry no relation at all.
   *
   * This is the sentence the whole-graph switch was missing: those nodes are real,
   * they are now in the node set, and they still draw nothing — so the canvas can be
   * identical before and after checking it. Saying so costs one line; leaving it out
   * reads as a broken control.
   */
  const nodesWithoutEdges = (graph?.nodes ?? []).filter((node) => node.degree === 0).length;

  const selectEntity = useCallback(
    (id: string | undefined) => {
      setComponent(null);
      onSelectEntity(id);
    },
    [onSelectEntity],
  );

  const backToOverview = useCallback(() => {
    setComponent(null);
    onSelectEntity(undefined);
  }, [onSelectEntity]);

  const openComponent = useCallback((next: GraphComponent) => {
    const representative = next.nodes.find((node) => node.id === next.id) ?? next.nodes[0];
    setComponent({ id: next.id, name: representative?.name ?? next.id });
  }, []);

  // Collected defensively: the stats payload does not carry the vocabulary yet, and
  // the selected types are unioned in so that a payload already narrowed by them
  // cannot remove the only way to uncheck them.
  const typeOptions = useMemo(() => {
    const known = new Set(stats?.relationTypes ?? []);
    for (const type of types) known.add(type);
    for (const edge of graph?.edges ?? []) known.add(edge.relation_type);
    return [...known].sort((left, right) => left.localeCompare(right));
  }, [graph, stats, types]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="w-full p-3 sm:px-6 sm:py-4">
        <div className={cn('grid gap-4', selectedNode && 'lg:grid-cols-[minmax(0,1fr)_18rem]')}>
          <section className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className="flex items-center gap-1.5 truncate text-sm font-medium text-neutral-800 dark:text-neutral-200">
                  <Network size={14} strokeWidth={1.75} />
                  {component
                    ? component.name
                    : selectedNode
                      ? selectedNode.name
                      : t('graph.overview')}
                </h2>
                {graph && (
                  <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                    {/*
                      "How much of the graph is in this picture" is the one thing the
                      whole-graph switch visibly changes, so the count has to say it.
                      `stats` reports the whole graph and is fetched independently of
                      the payload, so the pair is `drawn / exists` — the denominator is
                      present only when there really is something left outside, since
                      "378 / 378" is noise pretending to be information.
                    */}
                    {wholeTotal && wholeTotal > graph.nodes.length
                      ? t('graph.countsOfTotal', {
                          nodes: graph.nodes.length,
                          total: wholeTotal,
                          edges: graph.edges.length,
                        })
                      : t('graph.counts', { nodes: graph.nodes.length, edges: graph.edges.length })}
                    {graphLoading && (
                      <span className="ml-1.5 inline-block align-middle text-[10px] text-neutral-400 animate-pulse dark:text-neutral-500">
                        {t('graph.reloading')}
                      </span>
                    )}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {(entityId || component) && (
                  <Button variant="secondary" size="sm" onClick={backToOverview}>
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
                  disabled={!isNeighbourhood}
                  onChange={(event) => setDepth(Number(event.target.value))}
                  options={DEPTH_OPTIONS.map((option) => ({
                    value: String(option),
                    label: t('graph.depthOption', { count: option }),
                  }))}
                  className="w-24"
                />
              </div>
            </div>

            {graphLoading && !graph ? (
              // Only the first load blanks the panel. A reload keeps the previous
              // drawing on screen (dimmed) because replacing it with this centred
              // spinner collapses the scroll height, and the browser then clamps
              // `scrollTop` — the page jumps to the top when a filter is toggled,
              // which is exactly the moment the reader is looking at something.
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
            ) : graphDisabled ? (
              // `memory.graph.enabled: false` projects nothing. Saying "no data
              // yet" here would blame the corpus for a switch — and this branch is
              // also why the diagnostics panel never renders a grid of zeros.
              <div className="flex flex-col items-center gap-1 py-12 text-center">
                <p className="text-sm text-neutral-600 dark:text-neutral-300">
                  {t('graph.disabledTitle')}
                </p>
                <p className="max-w-sm text-xs text-neutral-500 dark:text-neutral-400">
                  {t('graph.disabledHint')}
                </p>
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
                    {t('graph.truncated', { count: graph.nodes.length })}
                  </p>
                )}

                {isOverview && stats && stats.enabled !== false && (
                  <GraphDiagnostics stats={stats} onOpenComponent={openComponent} />
                )}

                {/* The filters stay above the empty line: a reader who narrowed the
                    picture down to nothing needs the control that undid it. */}
                <GraphFilters
                  typeOptions={typeOptions}
                  selectedTypes={types}
                  onTypesChange={setTypes}
                  asOf={asOf}
                  onAsOfChange={setAsOf}
                  wholeGraph={
                    isOverview
                      ? {
                          value: wholeGraph,
                          onChange: changeWholeGraph,
                          total: wholeTotal ?? graph.nodes.length,
                          noEdgeNodes: wholeGraph ? nodesWithoutEdges : 0,
                        }
                      : undefined
                  }
                />

                {edgeCount === 0 ? (
                  // Nothing to draw and nothing to tabulate. The line is the whole
                  // answer, including the part a reader would otherwise assume:
                  // co-occurrence is deliberately not an edge.
                  <p className="py-8 text-center text-xs text-neutral-500 dark:text-neutral-400">
                    {t('graph.noEdgesAtAll')}
                  </p>
                ) : (
                  <>
                    {sparse && (
                      <div className="mb-1 flex justify-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-expanded={expanded}
                          onClick={() => setExpanded((current) => !current)}
                        >
                          {expanded ? t('graph.collapseGraph') : t('graph.expandGraph')}
                        </Button>
                      </div>
                    )}
                    {(!sparse || !expanded) && (
                      <RelationTable
                        edges={graph.edges}
                        nodesById={nodesById}
                        onSelect={selectEntity}
                      />
                    )}
                    {canvasVisible && (
                      <div className={sparse ? 'mt-2' : undefined}>
                        <NeighbourhoodGraph
                          nodes={graph.nodes}
                          edges={graph.edges}
                          focusId={isNeighbourhood ? entityId : undefined}
                          onSelect={selectEntity}
                          // S1b: the overview's chip list is a truncation
                          // artefact. Only its count is a fact worth stating.
                          showUnlinked={isNeighbourhood}
                        />
                      </div>
                    )}
                  </>
                )}

                {isNeighbourhood && (
                  <section className="mt-3 border-t border-neutral-200 pt-2 dark:border-neutral-800">
                    <h3 className="text-xs font-medium text-neutral-800 dark:text-neutral-200">
                      {t('graph.mentionsTitle')}
                    </h3>
                    {/* Stated, not implied: these names share memories with the
                        entity and nothing else, and co-occurrence is not a
                        statement (§3 of KNOWLEDGE_GRAPH.md). */}
                    <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                      {t('graph.mentionsHint')}
                    </p>
                    {mentions.length === 0 ? (
                      <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                        {t('graph.noMentions')}
                      </p>
                    ) : (
                      <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                        {shownMentions.map((mention) => (
                          <li key={mention.name}>
                            {/* A name with a node is a door; one the projector never
                                admitted has nothing to open and stays text. */}
                            {mention.entity_id ? (
                              <button
                                type="button"
                                onClick={() => selectEntity(mention.entity_id)}
                                title={t('graph.nodeAria', { name: mention.name })}
                                className="inline-flex items-baseline gap-1 text-xs text-neutral-700 hover:text-neutral-900 hover:underline dark:text-neutral-300 dark:hover:text-neutral-100"
                              >
                                <span className="truncate">{mention.name}</span>
                                <span className="text-[10px] tabular-nums text-neutral-400 dark:text-neutral-500">
                                  {mention.memories}
                                </span>
                              </button>
                            ) : (
                              <span className="inline-flex items-baseline gap-1 text-xs text-neutral-600 dark:text-neutral-400">
                                <span className="truncate">{mention.name}</span>
                                <span className="text-[10px] tabular-nums text-neutral-400 dark:text-neutral-500">
                                  {mention.memories}
                                </span>
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    {(graph.mentions_truncated || mentions.length > shownMentions.length) && (
                      <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                        {t('graph.mentionsMore', { count: shownMentions.length })}
                      </p>
                    )}
                  </section>
                )}
              </>
            )}
          </section>

          {selectedNode && (
            <aside className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
              <EntityDetail
                node={selectedNode}
                aliases={aliases}
                pages={pages}
                edges={graph?.edges ?? []}
                nodesById={nodesById}
                aliasesLoading={aliasesLoading}
                onSelect={selectEntity}
                onOpenPage={onOpenPage}
              />
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
