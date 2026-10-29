import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { Library, ClipboardCheck, FileText, Network, Search, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { apiRequest } from '../../utils/api';
import SearchKindFilter, { type SearchKindSelection } from '../graph/SearchKindFilter';
import GraphView from '../graph/GraphView';
import KnowledgeView from './KnowledgeView';
import KnowledgeReviewQueue from './KnowledgeReviewQueue';
import UnifiedSearchPanel from './UnifiedSearchPanel';
import { fetchKnowledgeStats } from './knowledge-api';
import type { KnowledgeSelection } from './KnowledgePageList';
import type { KnowledgePagePayload, KnowledgeStatsPayload } from './types';
import type { GraphSummary } from '../../types/graph';

export type KnowledgeHubTab = 'pages' | 'review' | 'graph';

/** The tab a route belongs to; unknown paths fall back to the page list. */
const TAB_PATHS: Record<KnowledgeHubTab, string> = {
  pages: '/knowledge/pages',
  review: '/knowledge/review',
  graph: '/knowledge/graph',
};

interface KnowledgeHubViewProps {
  tab: KnowledgeHubTab;
}

/**
 * The merged knowledge surface: page list + editor, the shadow review queue, and
 * the entity graph — one nav entry, one header, one search box.
 *
 * Why they are one page rather than two peers in the sidebar:
 *
 *   - `/api/search` ALREADY fuses the page lane into the entity/memory/message
 *     ranking. The graph page's search box was therefore a unified search that
 *     hid its page results, and the fusion drops a memory when a page cites it —
 *     so the hidden rows were the *replacement* for a hit. Rendering both is not
 *     a new capability, it is the fix.
 *   - Two search boxes over the same corpus (this one and the list's own
 *     full-text filter) rank differently and explain nothing. The list's box is
 *     now labelled as a filter over the list, and this one is the only search.
 *   - `knowledge_pages.entity_id` points at a graph node and had no way to be
 *     seen. The editor links into the graph tab, and an entity lists its pages.
 *
 * They stay separate *tabs* because their shapes differ: an editor wants width,
 * a canvas wants a square, a review queue wants one column. Cramming all three
 * into one split view makes each of them worse.
 */
export default function KnowledgeHubView({ tab }: KnowledgeHubViewProps) {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const { pageId, entityId } = useParams<{ pageId?: string; entityId?: string }>();

  const [stats, setStats] = useState<KnowledgeStatsPayload | null>(null);
  /** `/api/knowledge/stats` 404s when `knowledge.enabled` is false — routes unregistered. */
  const [pagesOff, setPagesOff] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [graphSummary, setGraphSummary] = useState<GraphSummary | null>(null);

  /** The query the merged search box holds; empty = the tab body is shown. */
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<SearchKindSelection>({
    entity: true,
    message: true,
    memoryKinds: null,
  });
  const [availableMemoryKinds, setAvailableMemoryKinds] = useState<string[]>([]);

  /** Unsaved editor text — navigating away from it needs a confirm. */
  const [editorDirty, setEditorDirty] = useState(false);
  /**
   * Body cache for the page list's own rows: an archived page's content is only
   * served by the list response (`GET /page/:id` is active-only), so the row has
   * to survive the navigation into the URL.
   */
  const pageCache = useRef(new Map<string, KnowledgePagePayload>());

  const bump = useCallback(() => setRefreshKey((key) => key + 1), []);
  const hasQuery = query.trim().length > 0;

  useEffect(() => {
    let cancelled = false;
    fetchKnowledgeStats()
      .then((payload) => {
        if (cancelled) return;
        setStats(payload);
        setPagesOff(false);
      })
      .catch(() => {
        if (cancelled) return;
        // Counts are decoration; the page layer being off is the fact worth
        // telling apart from "zero pages", and only a 404 says that.
        setStats(null);
        setPagesOff(true);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // The memory kinds offered by the filter are the ones the database actually
  // has, so the control cannot offer a kind nobody wrote.
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

  /**
   * Every navigation out of the pages tab goes through here, because leaving a
   * dirty editor is the one destructive gesture on this page: a tab click, a
   * search hit and a list row all unmount it.
   */
  const go = useCallback(
    (path: string) => {
      if (editorDirty && !window.confirm(t('knowledge.editor.confirmDiscard') as string)) return;
      setEditorDirty(false);
      // Leaving the search results for a destination: a query left in the box
      // would keep the results panel in front of the page the user just opened.
      setQuery('');
      navigate(path);
    },
    [editorDirty, navigate, t],
  );

  const openPage = useCallback(
    (next: KnowledgeSelection | null) => {
      if (!next) {
        go(TAB_PATHS.pages);
        return;
      }
      if (next.page) pageCache.current.set(next.id, next.page);
      go(`${TAB_PATHS.pages}/${next.id}`);
    },
    [go],
  );

  const openEntity = useCallback(
    (id: string) => {
      go(`${TAB_PATHS.graph}/${id}`);
    },
    [go],
  );

  const pendingCount = stats?.byStatus.pending ?? 0;
  const indexWarning = stats?.fts && !stats.fts.consistent ? stats.fts : null;

  const tabs = useMemo(
    () => [
      { id: 'pages' as const, label: t('knowledge.tabPages'), icon: FileText, badge: undefined },
      {
        id: 'review' as const,
        label: t('knowledge.tabReview'),
        icon: ClipboardCheck,
        badge: pendingCount,
      },
      { id: 'graph' as const, label: t('knowledge.tabGraph'), icon: Network, badge: undefined },
    ],
    [pendingCount, t],
  );

  const body = () => {
    if (tab === 'review') return <KnowledgeReviewQueue refreshKey={refreshKey} onChanged={bump} />;
    if (tab === 'graph') {
      return (
        <GraphView
          entityId={entityId}
          onSelectEntity={(id) => go(id ? `${TAB_PATHS.graph}/${id}` : TAB_PATHS.graph)}
          onSummary={setGraphSummary}
          onOpenPage={(id) => openPage({ id })}
        />
      );
    }
    return (
      <KnowledgeView
        pageId={pageId ?? null}
        cachedPage={pageId ? pageCache.current.get(pageId) : undefined}
        refreshKey={refreshKey}
        onSelectPage={openPage}
        onOpenEntity={openEntity}
        onChanged={bump}
        onDirtyChange={setEditorDirty}
      />
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-white dark:bg-neutral-950">
      <header className="shrink-0 border-b border-neutral-200 px-3 pt-3 sm:px-6 dark:border-neutral-800">
        <h1 className="flex items-center gap-2 text-base font-semibold text-neutral-900 dark:text-neutral-100">
          <Library size={18} strokeWidth={1.75} />
          {t('knowledge.title')}
        </h1>
        <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
          {t('knowledge.subtitle')}
        </p>

        {/* Two layers live here and they have two independent switches, so the
            header states each one separately instead of one vague "off". */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-500 dark:text-neutral-400">
          {stats ? (
            <>
              <span>{t('knowledge.statsTotal', { count: stats.total })}</span>
              <span>{t('knowledge.statsPending', { count: pendingCount })}</span>
              <span>{t('knowledge.statsArchived', { count: stats.byStatus.archived })}</span>
            </>
          ) : (
            pagesOff && (
              <span className="text-amber-600 dark:text-amber-400">
                {t('knowledge.pageLayerOff')}
              </span>
            )
          )}
          {graphSummary && (
            <span>
              {t('graph.counts', { nodes: graphSummary.nodes, edges: graphSummary.edges })}
            </span>
          )}
          {graphSummary?.enabled === false && (
            <span className="text-amber-600 dark:text-amber-400">{t('graph.disabledNotice')}</span>
          )}
        </div>
        {indexWarning && (
          // `fts` is null when the knowledge tables do not exist yet; only a real
          // parity report can be inconsistent, and then it is worth saying so.
          <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
            {t('knowledge.indexWarning', {
              pages: indexWarning.pageCount,
              indexed: indexWarning.indexedRowCount,
            })}
          </p>
        )}

        {/* One search over all four lanes. The list's own box (inside the pages
            tab) is a filter over the list and says so — two indistinguishable
            search boxes was the state this replaced. */}
        <div className="mt-2 flex items-stretch gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              size={14}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 dark:text-neutral-400"
            />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('knowledge.hubSearchPlaceholder')}
              aria-label={t('knowledge.hubSearchPlaceholder')}
              className="w-full rounded-lg border border-neutral-300 bg-white py-2 pl-9 pr-8 text-sm text-neutral-900 focus:border-primary focus:outline-none dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100"
            />
            {hasQuery && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={t('knowledge.clearSearch')}
                title={t('knowledge.clearSearch')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <SearchKindFilter
            value={selection}
            availableMemoryKinds={availableMemoryKinds}
            onChange={setSelection}
          />
        </div>

        <nav className="mt-2 flex items-center gap-1" role="tablist">
          {tabs.map((entry) => {
            const Icon = entry.icon;
            const active = tab === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => go(TAB_PATHS[entry.id])}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-1.5 text-[13px] font-medium transition-colors',
                  active
                    ? 'border-neutral-800 text-neutral-900 dark:border-neutral-200 dark:text-neutral-100'
                    : 'border-transparent text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200',
                )}
              >
                <Icon size={14} strokeWidth={1.75} />
                <span>{entry.label}</span>
                {entry.badge !== undefined && entry.badge > 0 && (
                  <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
                    {entry.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </header>

      {hasQuery ? (
        // Full width under the tabs, aligned with the tab strip's own left edge:
        // a centred narrow column here read as a detached dialog rather than as
        // this page's results.
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-6 sm:py-4">
          <UnifiedSearchPanel
            query={query}
            selection={selection}
            pageLayerEnabled={!pagesOff}
            onOpenPage={(id) => openPage({ id })}
            onOpenEntity={openEntity}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">{body()}</div>
      )}
    </div>
  );
}
