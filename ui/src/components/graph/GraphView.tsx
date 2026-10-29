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
import type {
  EntityDetailPayload,
  EntityPageRef,
  GraphPayload,
  GraphSummary,
} from '../../types/graph';

const DEPTH_OPTIONS = [1, 2, 3];

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
 * The entity graph tab: overview or one entity's neighbourhood, the detail panel
 * beside it, and the two links back into the page layer.
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

  const loadGraph = useCallback(async () => {
    setGraphLoading(true);
    setGraphError(null);
    const params = new URLSearchParams({ limit: '200' });
    if (entityId) {
      params.set('entity', entityId);
      params.set('depth', String(depth));
    }
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
  }, [depth, entityId, onSummary, t]);

  useEffect(() => {
    void loadGraph();
  }, [loadGraph]);

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

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="w-full p-3 sm:px-6 sm:py-4">
        <div className={cn('grid gap-4', selectedNode && 'lg:grid-cols-[minmax(0,1fr)_18rem]')}>
          <section className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h2 className="flex items-center gap-1.5 truncate text-sm font-medium text-neutral-800 dark:text-neutral-200">
                  <Network size={14} strokeWidth={1.75} />
                  {selectedNode ? selectedNode.name : t('graph.overview')}
                </h2>
                {graph && (
                  <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                    {t('graph.counts', { nodes: graph.nodes.length, edges: graph.edges.length })}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {entityId && (
                  <Button variant="secondary" size="sm" onClick={() => onSelectEntity(undefined)}>
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
                  disabled={!entityId}
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
            ) : graphDisabled ? (
              // `memory.graph.enabled: false` projects nothing. Saying "no data
              // yet" here would blame the corpus for a switch.
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
                <NeighbourhoodGraph
                  nodes={graph.nodes}
                  edges={graph.edges}
                  focusId={entityId}
                  onSelect={(id) => onSelectEntity(id)}
                />
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
                onSelect={(id) => onSelectEntity(id)}
                onOpenPage={onOpenPage}
              />
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
