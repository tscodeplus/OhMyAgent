import { useTranslation } from 'react-i18next';
import type { GraphComponent, GraphStats } from '../../types/graph';

/** Member names a component row prints before it summarises the rest as "+N". */
const COMPONENT_NAME_PREVIEW = 4;

interface GraphDiagnosticsProps {
  stats: GraphStats;
  /** Draw one component instead of the overview. */
  onOpenComponent: (component: GraphComponent) => void;
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
    { key: 'components', label: t('graph.diagComponents'), value: String(stats.componentCount) },
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

      {stats.components.length > 0 && (
        <div className="mt-2.5 border-t border-neutral-200 pt-2 dark:border-neutral-800">
          <h4 className="text-[11px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
            {t('graph.componentsTitle')}
          </h4>
          <ul className="mt-1 space-y-1">
            {stats.components.map((component) => {
              const names = component.nodes
                .slice(0, COMPONENT_NAME_PREVIEW)
                .map((member) => member.name);
              const rest = component.nodes.length - names.length;
              return (
                <li
                  key={component.id}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
                >
                  <span className="text-neutral-700 dark:text-neutral-300">
                    {t('graph.componentSize', {
                      count: component.size,
                      edges: component.edgeCount,
                    })}
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
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
