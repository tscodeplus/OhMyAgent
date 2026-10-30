import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiRequest } from '../../utils/api';
import Spinner from '../ui/Spinner';
import type { ComponentPage, GraphComponent, GraphStats } from '../../types/graph';

/** Member names a component row prints before it summarises the rest as "+N". */
const COMPONENT_NAME_PREVIEW = 4;
/** One page of the full component list; the panel's own eight are a summary. */
const COMPONENT_PAGE_SIZE = 20;

interface GraphDiagnosticsProps {
  stats: GraphStats;
  /** Draw one component instead of the overview. */
  onOpenComponent: (component: GraphComponent) => void;
}

/**
 * One component, as a line: its size, a few member names, and the way in.
 *
 * Shared by the panel's top eight and the full list, because they are the same row —
 * two renderings of "a component" would drift the day one of them gained a field.
 */
function ComponentRow({
  component,
  onOpenComponent,
}: {
  component: GraphComponent;
  onOpenComponent: (component: GraphComponent) => void;
}) {
  const { t } = useTranslation('common');
  const names = component.nodes.slice(0, COMPONENT_NAME_PREVIEW).map((member) => member.name);
  const rest = component.nodes.length - names.length;
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
      <span className="text-neutral-700 dark:text-neutral-300">
        {t('graph.componentSize', { count: component.size, edges: component.edgeCount })}
      </span>
      <span className="min-w-0 flex-1 truncate text-neutral-500 dark:text-neutral-400">
        {names.join(' · ')}
        {rest > 0 ? ` +${rest}` : ''}
      </span>
      <button
        type="button"
        onClick={() => onOpenComponent(component)}
        className="shrink-0 rounded px-1 text-[11px] text-blue-600 hover:underline dark:text-blue-400"
      >
        {t('graph.openComponent')}
      </button>
    </li>
  );
}

/**
 * Every multi-node component, not the panel's first eight.
 *
 * The headline says "368 components" while the panel can only print eight of them, and
 * nothing in the payload said how many were left out — a reader had no way to tell a
 * complete list from a truncated one. `multiNodeComponents` is that denominator, and
 * this list is the rows behind it.
 *
 * Pages on demand rather than up front: on a corpus with hundreds of small components
 * the first twenty are the ones a reader is looking for, and fetching the rest would
 * cost a full structure walk for rows nobody scrolls to.
 */
function AllComponents({ onOpenComponent }: { onOpenComponent: (c: GraphComponent) => void }) {
  const { t } = useTranslation('common');
  const [rows, setRows] = useState<GraphComponent[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    (after: string | null) => {
      setLoading(true);
      const params = new URLSearchParams({ limit: String(COMPONENT_PAGE_SIZE) });
      if (after) params.set('cursor', after);
      apiRequest<ComponentPage>(`/api/memory/components?${params.toString()}`)
        .then((payload) => {
          setRows((current) => (after ? [...current, ...payload.items] : payload.items));
          setTotal(payload.total);
          setCursor(payload.nextCursor);
          setError(null);
        })
        .catch(() => setError(t('graph.loadError')))
        .finally(() => setLoading(false));
    },
    [t],
  );

  useEffect(() => {
    load(null);
  }, [load]);

  return (
    <div>
      <ul className="mt-1 space-y-1">
        {rows.map((component) => (
          <ComponentRow
            key={component.id}
            component={component}
            onOpenComponent={onOpenComponent}
          />
        ))}
      </ul>
      {error && <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{error}</p>}
      <div className="mt-1 flex items-center gap-2 text-[11px] text-neutral-500 dark:text-neutral-400">
        {/* The count is the point of this list, so it is stated even while paging. */}
        <span>{t('graph.componentsListed', { shown: rows.length, total })}</span>
        {cursor && (
          <button
            type="button"
            onClick={() => load(cursor)}
            disabled={loading}
            className="rounded px-1 text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400"
          >
            {t('graph.componentsMore')}
          </button>
        )}
        {loading && <Spinner size="sm" />}
      </div>
    </div>
  );
}

/**
 * The overview's diagnostics: the numbers, then where the graph breaks.
 *
 * A whole-graph drawing of a sparse corpus is a cloud of unconnected names, and
 * that cloud's only readable content is its shape as counts — how many entities
 * never appear in a typed relation, and how large the largest connected part is.
 * The numbers are measured over the WHOLE graph rather than over the current
 * payload (the server answers from its own queries), so they stay the reference
 * point while the relation-type and as-of filters narrow the drawing below.
 */
export default function GraphDiagnostics({ stats, onOpenComponent }: GraphDiagnosticsProps) {
  const { t } = useTranslation('common');
  const [showAll, setShowAll] = useState(false);

  const multiNode = stats.multiNodeComponents ?? stats.components.length;
  // A cap nobody can see reads as "this is everything". Only when rows really are
  // missing does the panel offer the full list.
  const capped = multiNode > stats.components.length;

  // Optional fields render only when present, and a zero that carries no
  // information ("0 retracted", "0 mentions") is left out: a grid of zeros is how
  // a panel stops being read.
  const cells: Array<{ key: string; label: string; value: string }> = [
    { key: 'nodes', label: t('graph.diagNodes'), value: String(stats.nodes) },
    { key: 'edges', label: t('graph.diagEdges'), value: String(stats.edges) },
    ...(stats.retractedEdges > 0
      ? [
          {
            key: 'retracted',
            label: t('graph.diagRetracted'),
            value: String(stats.retractedEdges),
          },
        ]
      : []),
    { key: 'isolated', label: t('graph.diagIsolated'), value: String(stats.isolated) },
    { key: 'mentionOnly', label: t('graph.diagMentionOnly'), value: String(stats.mentionOnly) },
    ...(stats.mentionLinks > 0
      ? [
          {
            key: 'mentionLinks',
            label: t('graph.diagMentionLinks'),
            value: String(stats.mentionLinks),
          },
        ]
      : []),
    {
      key: 'components',
      label: t('graph.diagComponents'),
      // `368` is the whole graph including lone names; the parenthetical is the part
      // this list can actually show, so the two numbers cannot read as a truncation bug.
      value:
        multiNode > 0 && multiNode !== stats.componentCount
          ? `${stats.componentCount} (${multiNode})`
          : String(stats.componentCount),
    },
    {
      key: 'largest',
      label: t('graph.diagLargest'),
      value: `${Math.round(stats.largestComponentPct * 100)}%`,
    },
    ...(stats.danglingLinks !== undefined
      ? [
          {
            key: 'dangling',
            label: t('graph.diagDangling'),
            value: String(stats.danglingLinks),
          },
        ]
      : []),
    ...(stats.scopedPages !== undefined
      ? [
          {
            key: 'scopedPages',
            label: t('graph.diagScopedPages'),
            value: String(stats.scopedPages),
          },
        ]
      : []),
  ];

  return (
    <div className="mt-2 rounded-lg border border-neutral-200 bg-neutral-50/60 p-2.5 dark:border-neutral-800 dark:bg-neutral-900/60">
      <h3 className="text-xs font-medium text-neutral-800 dark:text-neutral-200">
        {t('graph.diagnosticsTitle')}
      </h3>
      <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
        {cells.map((cell) => (
          <div key={cell.key} className="min-w-0">
            <dt className="truncate text-[11px] text-neutral-500 dark:text-neutral-400">
              {cell.label}
            </dt>
            <dd className="text-sm font-medium tabular-nums text-neutral-800 dark:text-neutral-200">
              {cell.value}
            </dd>
          </div>
        ))}
      </dl>

      {multiNode > 0 && (
        <div className="mt-2.5 border-t border-neutral-200 pt-2 dark:border-neutral-800">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
            <h4 className="text-[11px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
              {t('graph.componentsTitle')}
            </h4>
            <div className="flex items-baseline gap-2 text-[11px] text-neutral-500 dark:text-neutral-400">
              <span>{t('graph.componentsMulti', { count: multiNode })}</span>
              {(capped || showAll) && (
                <button
                  type="button"
                  onClick={() => setShowAll((current) => !current)}
                  aria-expanded={showAll}
                  className="rounded px-1 text-blue-600 hover:underline dark:text-blue-400"
                >
                  {showAll ? t('graph.componentsCollapse') : t('graph.componentsAll')}
                </button>
              )}
            </div>
          </div>

          {showAll ? (
            <AllComponents onOpenComponent={onOpenComponent} />
          ) : (
            <ul className="mt-1 space-y-1">
              {stats.components.map((component) => (
                <ComponentRow
                  key={component.id}
                  component={component}
                  onOpenComponent={onOpenComponent}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
