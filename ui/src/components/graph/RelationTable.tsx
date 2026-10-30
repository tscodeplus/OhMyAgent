import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText } from 'lucide-react';
import { apiRequest } from '../../utils/api';
import type { GraphEdge, GraphNode } from '../../types/graph';

/** Validity is shown as a date, not a timestamp — the day is what people recall. */
export function formatDay(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString();
}

/**
 * How much of the asserting memory the evidence block shows.
 *
 * Enough to recognise the sentence the relation was read out of, short enough
 * that a twelve-row table stays a table instead of becoming a document.
 */
const EVIDENCE_PREVIEW_CHARS = 500;

/** The one field of `/api/memory/:id` this panel reads; the row carries dozens. */
interface MemoryEvidenceRow {
  content?: unknown;
}

type EvidenceState =
  | { status: 'loading' }
  | { status: 'ready'; text: string }
  | { status: 'missing' }
  | { status: 'empty' };

/**
 * The memory body behind one edge, fetched only when a row is expanded.
 *
 * The body is shown verbatim rather than summarised: an evidence panel exists to
 * let a reader check the edge against the sentence, and a paraphrase would be one
 * more thing to trust. A memory that no longer exists and one that stores nothing
 * readable are reported as different answers — neither is faked.
 */
function EdgeEvidence({ memoryId }: { memoryId: string }) {
  const { t } = useTranslation('common');
  const [state, setState] = useState<EvidenceState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    apiRequest<MemoryEvidenceRow>(`/api/memory/${encodeURIComponent(memoryId)}`)
      .then((row) => {
        if (cancelled) return;
        const content = typeof row.content === 'string' ? row.content.trim() : '';
        setState(
          content
            ? { status: 'ready', text: content.slice(0, EVIDENCE_PREVIEW_CHARS) }
            : { status: 'empty' },
        );
      })
      .catch(() => {
        if (cancelled) return;
        setState({ status: 'missing' });
      });
    return () => {
      cancelled = true;
    };
  }, [memoryId]);

  if (state.status === 'ready') {
    return (
      <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-neutral-50 p-2 text-[11px] leading-relaxed text-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-300">
        {state.text}
      </pre>
    );
  }

  const message =
    state.status === 'loading'
      ? t('graph.evidenceLoading')
      : state.status === 'missing'
        ? t('graph.evidenceMissing')
        : t('graph.memoryUnavailable');

  return <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">{message}</p>;
}

/** The other end of a relation, as a keyboard-reachable button. */
function EntityLink({ node, onSelect }: { node: GraphNode; onSelect: (entityId: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(node.id)}
      className="min-w-0 truncate text-left text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
    >
      {node.name}
    </button>
  );
}

export interface RelationRowProps {
  edge: GraphEdge;
  /** The edge's own ends; undefined when the payload does not carry that node. */
  source: GraphNode | undefined;
  target: GraphNode | undefined;
  /**
   * Which end the row is written from — the detail panel's two groups. Omitted in
   * the sparse table, where no single entity is the subject: the row then names
   * both ends instead of leaving the reader to guess which one it meant.
   */
  direction?: 'outgoing' | 'incoming';
  onSelect: (entityId: string) => void;
}

/**
 * One relation, and the single implementation of one.
 *
 * Both the entity detail panel and the sparse-mode table render this, so a
 * relation cannot read differently depending on where it was found — direction,
 * predicate, confidence, validity and the evidence link travel together.
 */
export function RelationRow({ edge, source, target, direction, onSelect }: RelationRowProps) {
  const { t } = useTranslation('common');
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const retracted = edge.valid_to !== undefined;
  // The end the row is not written from: the target of an outgoing statement, the
  // source of an incoming one. In the pair form the arrow points right, so that
  // end is the target again.
  const other = direction === 'incoming' ? source : target;
  const badge = `${direction === 'incoming' ? '←' : '→'} ${edge.relation_type}`;
  const unknown = (
    <span className="text-xs text-neutral-500 dark:text-neutral-400">
      {t('graph.unknownEntity')}
    </span>
  );

  return (
    <li className="flex flex-col gap-1 rounded-md border border-neutral-200 px-2.5 py-2 dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {!direction && (source ? <EntityLink node={source} onSelect={onSelect} /> : unknown)}
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
          {badge}
        </span>
        {other ? <EntityLink node={other} onSelect={onSelect} /> : unknown}
        {retracted && (
          <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
            {t('graph.retracted')}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
        <span>{t('graph.confidence', { value: Math.round(edge.confidence * 100) })}</span>
        {edge.valid_from !== undefined && (
          <span>{t('graph.validFrom', { date: formatDay(edge.valid_from) })}</span>
        )}
        {edge.valid_to !== undefined && (
          <span>{t('graph.validUntil', { date: formatDay(edge.valid_to) })}</span>
        )}
        {/* No `source_memory_id` means no link, not a link to nothing: the column is
            nullable, so an edge projected before provenance existed must not offer
            an evidence button that can only fail. */}
        {edge.source_memory_id && (
          <button
            type="button"
            aria-expanded={evidenceOpen}
            onClick={() => setEvidenceOpen((open) => !open)}
            className="inline-flex items-center gap-1 rounded px-1 text-[11px] text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <FileText size={11} strokeWidth={1.75} />
            {t('graph.edgeEvidence')}
          </button>
        )}
      </div>
      {evidenceOpen && edge.source_memory_id && <EdgeEvidence memoryId={edge.source_memory_id} />}
    </li>
  );
}

interface RelationTableProps {
  edges: GraphEdge[];
  nodesById: Map<string, GraphNode>;
  onSelect: (entityId: string) => void;
}

/**
 * The sparse-mode view: the relations as rows, because that is what twelve edges
 * are.
 *
 * Nothing is grouped — the node pair is the subject line of each row — and the
 * caption states the rule the emptiness comes from, so a reader does not read
 * "few relations" as "few connections in the corpus".
 */
export default function RelationTable({ edges, nodesById, onSelect }: RelationTableProps) {
  const { t } = useTranslation('common');

  return (
    <div>
      <h3 className="text-xs font-medium text-neutral-800 dark:text-neutral-200">
        {t('graph.relationsTitle')}
      </h3>
      <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
        {t('graph.relationsHint')}
      </p>
      <ul className="mt-2 space-y-1.5">
        {edges.map((edge) => (
          <RelationRow
            key={edge.id}
            edge={edge}
            source={nodesById.get(edge.source)}
            target={nodesById.get(edge.target)}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </div>
  );
}
