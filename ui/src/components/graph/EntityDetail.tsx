import { useTranslation } from 'react-i18next';
import type { EntityPageRef, GraphEdge, GraphNode } from '../../types/graph';
import { RelationRow } from './RelationTable';

interface EntityDetailProps {
  node: GraphNode;
  aliases: string[];
  /** Active curated pages pointing at this entity (`knowledge_pages.entity_id`). */
  pages: EntityPageRef[];
  /** Full edge list of the current graph payload; incident edges are the relations. */
  edges: GraphEdge[];
  nodesById: Map<string, GraphNode>;
  aliasesLoading: boolean;
  onSelect: (entityId: string) => void;
  /** Opens a page in the pages tab — the other half of the merge. */
  onOpenPage: (pageId: string) => void;
}

export default function EntityDetail({
  node,
  aliases,
  pages,
  edges,
  nodesById,
  aliasesLoading,
  onSelect,
  onOpenPage,
}: EntityDetailProps) {
  const { t } = useTranslation('common');

  // Direction comes from the edge itself: an edge whose source is this entity
  // is an outgoing statement, one whose target is this entity is incoming.
  const outgoing = edges.filter((edge) => edge.source === node.id);
  const incoming = edges.filter((edge) => edge.target === node.id);

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {node.name}
        </h3>
        <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">{node.entity_type}</p>
        {node.description && (
          <p className="mt-2 text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">
            {node.description}
          </p>
        )}
      </div>

      <div>
        <h4 className="text-[11px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
          {t('graph.aliases')}
        </h4>
        {aliasesLoading ? (
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {t('graph.loading')}
          </p>
        ) : aliases.length === 0 ? (
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {t('graph.noAliases')}
          </p>
        ) : (
          <div className="mt-1 flex flex-wrap gap-1">
            {aliases.map((alias) => (
              <span
                key={alias}
                className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              >
                {alias}
              </span>
            ))}
          </div>
        )}
      </div>

      <div>
        <h4 className="text-[11px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
          {t('graph.relatedPages')}
        </h4>
        {pages.length === 0 ? (
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {t('graph.noRelatedPages')}
          </p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {pages.map((page) => (
              <li key={page.id}>
                <button
                  type="button"
                  onClick={() => onOpenPage(page.id)}
                  className="flex w-full items-baseline gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-neutral-700 dark:text-neutral-300">
                    {page.title}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-neutral-500 dark:text-neutral-400">
                    {page.slug}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4 className="text-[11px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
          {t('graph.outgoing')}
        </h4>
        {outgoing.length === 0 ? (
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {t('graph.noRelations')}
          </p>
        ) : (
          <ul className="mt-1 space-y-1.5">
            {outgoing.map((edge) => (
              <RelationRow
                key={edge.id}
                edge={edge}
                source={node}
                target={nodesById.get(edge.target)}
                direction="outgoing"
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </div>

      <div>
        <h4 className="text-[11px] font-medium uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
          {t('graph.incoming')}
        </h4>
        {incoming.length === 0 ? (
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {t('graph.noRelations')}
          </p>
        ) : (
          <ul className="mt-1 space-y-1.5">
            {incoming.map((edge) => (
              <RelationRow
                key={edge.id}
                edge={edge}
                source={nodesById.get(edge.source)}
                target={node}
                direction="incoming"
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
