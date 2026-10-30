import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { cn } from '../../lib/utils';
import { apiRequest } from '../../utils/api';
import Button from '../ui/Button';
import Select from '../ui/Select';
import Spinner from '../ui/Spinner';
import { formatDay } from './RelationTable';
import type {
  EdgeRosterPage,
  EdgeRosterRow,
  EntityRosterPage,
  EntityRosterRow,
  GraphRosterStats,
} from '../../types/graph';

type RosterTab = 'entities' | 'relations';
type EntitySort = 'degree' | 'mentions' | 'name' | 'updated';
/** `any` = everything, `yes` = carries a typed edge, `no` = isolated (mention-only included). */
type EdgePresence = 'any' | 'yes' | 'no';
type EdgeStatus = 'all' | 'open' | 'retracted';

/**
 * The entity list is the one a phone scrolls, so it takes the shorter page of the two.
 * Both are the server's own defaults, repeated here because the roster states its page
 * size implicitly — the total and the arrow are what tell a reader it paged.
 */
const ENTITY_PAGE_SIZE = 50;
const EDGE_PAGE_SIZE = 100;
/** Keystrokes arrive in bursts; a list must not be queried for every intermediate prefix. */
const SEARCH_DEBOUNCE_MS = 300;
/** How much of `sourceMemoryId` a relation row prints — enough to match a `[mem:]` citation. */
const MEMORY_REF_CHARS = 8;

/**
 * One filter control's option list: "all" plus whatever the server listed.
 *
 * "All" is always present, even when the vocabulary never arrived — a filter with an
 * empty option list would be a control that cannot be used rather than one that is off.
 */
function vocabularyOptions(allLabel: string, values: string[] | undefined) {
  return [
    { value: 'all', label: allLabel },
    ...(values ?? []).map((value) => ({ value, label: value })),
  ];
}

/**
 * The graph roster: every entity and every relation, as a list.
 *
 * A drawing is a slice and an enumeration is not. The canvas is capped at 40 rendered
 * nodes, and on the real device 357 of 378 entities carry no relation at all — there is
 * nothing to draw for them, so the budget is spent on the 21 that do. "What is in my
 * graph" therefore cannot be answered by looking at a picture, however well filtered:
 * it needs a total order, a total count and a cursor, which is exactly what the two
 * roster endpoints serve.
 *
 * The two tabs are the same component rather than two screens because their shared
 * behaviour is the hard part: one cursor stack, one loading rule, one error line. A
 * relation row that forgot to keep the list mounted while paging would jump the scroll
 * position on a phone, and that bug is not worth having twice.
 *
 * Nothing here writes. The roster opens an entity in the graph tab (the drawing is where
 * a neighbourhood is read); a relation's memory reference stays plain text, because
 * following it would replace the list the reader was enumerating.
 */
export default function GraphRosterView() {
  const { t } = useTranslation('common');
  const navigate = useNavigate();

  const [tab, setTab] = useState<RosterTab>('entities');
  /**
   * Filter vocabularies. `null` means the stats call failed or is still running, and the
   * selects then offer only "all" — a filter whose option list is guesswork must never be
   * the reason the list itself does not render.
   */
  const [stats, setStats] = useState<GraphRosterStats | null>(null);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [entityType, setEntityType] = useState('all');
  const [edgePresence, setEdgePresence] = useState<EdgePresence>('any');
  const [entitySort, setEntitySort] = useState<EntitySort>('degree');

  /** `all` on purpose: the half a drawing cannot show is the retracted one. */
  const [edgeStatus, setEdgeStatus] = useState<EdgeStatus>('all');
  const [relation, setRelation] = useState('all');

  /**
   * The cursors taken so far, one per page, so "previous" is a pop rather than a second
   * traversal backwards: an opaque keyset cursor cannot be inverted, and a list that
   * could only go forwards is not a list a reader can search in.
   */
  const [cursorStack, setCursorStack] = useState<string[]>([]);

  const [entityRows, setEntityRows] = useState<EntityRosterRow[]>([]);
  const [entityTotal, setEntityTotal] = useState(0);
  const [entityNextCursor, setEntityNextCursor] = useState<string | null>(null);
  const [entityLoading, setEntityLoading] = useState(false);
  const [entityError, setEntityError] = useState<string | null>(null);

  const [edgeRows, setEdgeRows] = useState<EdgeRosterRow[]>([]);
  const [edgeTotal, setEdgeTotal] = useState(0);
  const [edgeCounts, setEdgeCounts] = useState<{ open: number; retracted: number } | null>(null);
  const [edgeNextCursor, setEdgeNextCursor] = useState<string | null>(null);
  const [edgeLoading, setEdgeLoading] = useState(false);
  const [edgeError, setEdgeError] = useState<string | null>(null);

  const cursor = cursorStack[cursorStack.length - 1];
  const page = cursorStack.length;

  /**
   * Every filter change is a new first page. A cursor taken under the previous filters
   * points into a list that no longer exists, so keeping the stack would page rows the
   * reader never saw the start of.
   */
  const resetPaging = useCallback(() => setCursorStack([]), []);

  const changeTab = useCallback(
    (next: RosterTab) => {
      setTab(next);
      resetPaging();
    },
    [resetPaging],
  );

  // The stats payload exists for its vocabularies only; the counts it carries describe
  // the drawing and are shown on the graph tab. `nodes` is the one number here, because
  // the hint has to name the size of the complete list it is showing.
  useEffect(() => {
    let cancelled = false;
    apiRequest<GraphRosterStats>('/api/memory/graph/stats')
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

  // Search is debounced through its own state rather than a ref timer, so the fetch
  // effect depends on a value that only changes when the burst of typing ends.
  useEffect(() => {
    if (search === debouncedSearch) return;
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      resetPaging();
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [debouncedSearch, resetPaging, search]);

  useEffect(() => {
    if (tab !== 'entities') return;
    let cancelled = false;
    setEntityLoading(true);
    setEntityError(null);
    const params = new URLSearchParams({
      sort: entitySort,
      // Names read A→Z; a count reads biggest-first. One `dir` per sort key, not a
      // second control a reader has to reason about.
      dir: entitySort === 'name' ? 'asc' : 'desc',
      limit: String(ENTITY_PAGE_SIZE),
    });
    const query = debouncedSearch.trim();
    if (query) params.set('q', query);
    if (entityType !== 'all') params.set('type', entityType);
    if (edgePresence !== 'any') params.set('edges', edgePresence);
    if (cursor) params.set('cursor', cursor);
    apiRequest<EntityRosterPage>(`/api/memory/entities?${params.toString()}`)
      .then((payload) => {
        if (cancelled) return;
        setEntityRows(payload.items);
        setEntityTotal(payload.total);
        setEntityNextCursor(payload.nextCursor);
      })
      .catch(() => {
        if (cancelled) return;
        // The previous rows stay mounted: they are the last answer the server gave, and
        // the red line above them says this one failed. Blanking the table would also
        // collapse the scroll height, which is what makes a phone jump to the top.
        setEntityError(t('graph.loadError'));
        setEntityNextCursor(null);
      })
      .finally(() => {
        if (!cancelled) setEntityLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cursor, debouncedSearch, edgePresence, entitySort, entityType, t, tab]);

  useEffect(() => {
    if (tab !== 'relations') return;
    let cancelled = false;
    setEdgeLoading(true);
    setEdgeError(null);
    const params = new URLSearchParams({
      status: edgeStatus,
      limit: String(EDGE_PAGE_SIZE),
    });
    if (relation !== 'all') params.set('relation', relation);
    if (cursor) params.set('cursor', cursor);
    apiRequest<EdgeRosterPage>(`/api/memory/edges?${params.toString()}`)
      .then((payload) => {
        if (cancelled) return;
        setEdgeRows(payload.items);
        setEdgeTotal(payload.total);
        setEdgeCounts(payload.counts);
        setEdgeNextCursor(payload.nextCursor);
      })
      .catch(() => {
        if (cancelled) return;
        setEdgeError(t('graph.loadError'));
        setEdgeNextCursor(null);
      })
      .finally(() => {
        if (!cancelled) setEdgeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cursor, edgeStatus, relation, t, tab]);

  const goNext = useCallback(() => {
    setCursorStack((stack) => {
      const next = tab === 'entities' ? entityNextCursor : edgeNextCursor;
      return next ? [...stack, next] : stack;
    });
  }, [edgeNextCursor, entityNextCursor, tab]);

  const goPrev = useCallback(() => {
    setCursorStack((stack) => stack.slice(0, -1));
  }, []);

  const typeOptions = useMemo(
    () => vocabularyOptions(t('graph.rosterAllTypes'), stats?.entityTypes),
    [stats, t],
  );
  const relationOptions = useMemo(
    () => vocabularyOptions(t('graph.rosterAllRelations'), stats?.relationTypes),
    [stats, t],
  );
  const presenceOptions = useMemo(
    () => [
      { value: 'any', label: t('graph.rosterEdgeAny') },
      { value: 'yes', label: t('graph.rosterEdgeYes') },
      { value: 'no', label: t('graph.rosterEdgeNo') },
    ],
    [t],
  );
  const sortOptions = useMemo(
    () => [
      { value: 'degree', label: t('graph.rosterSortDegree') },
      { value: 'mentions', label: t('graph.rosterSortMentions') },
      { value: 'name', label: t('graph.rosterSortName') },
      { value: 'updated', label: t('graph.rosterSortUpdated') },
    ],
    [t],
  );
  const statusOptions = useMemo(
    () => [
      { value: 'all', label: t('graph.rosterStatusAll') },
      { value: 'open', label: t('graph.rosterStatusOpen') },
      { value: 'retracted', label: t('graph.rosterStatusRetracted') },
    ],
    [t],
  );

  const rows = tab === 'entities' ? entityRows : edgeRows;
  const loading = tab === 'entities' ? entityLoading : edgeLoading;
  const error = tab === 'entities' ? entityError : edgeError;
  const total = tab === 'entities' ? entityTotal : edgeTotal;
  const nextCursor = tab === 'entities' ? entityNextCursor : edgeNextCursor;

  /**
   * The list body.
   *
   * Only a first load is blanked. A new page keeps the previous rows mounted (the inline
   * spinner beside the total is what says a fetch is running) because unmounting them
   * collapses `scrollHeight` and the browser then clamps `scrollTop` — the page jumps to
   * the top exactly when the reader paged.
   *
   * A failure with nothing loaded shows only the red line above: "no matching records"
   * would blame the filters for the request that failed.
   */
  let body: ReactNode;
  if (rows.length === 0) {
    body = loading ? (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    ) : error ? null : (
      <p className="py-8 text-center text-xs text-neutral-500 dark:text-neutral-400">
        {t('graph.rosterEmpty')}
      </p>
    );
  } else if (tab === 'entities') {
    body = (
      <EntityRosterTable
        rows={entityRows}
        onOpen={(id) => navigate(`/knowledge/graph/${encodeURIComponent(id)}`)}
      />
    );
  } else {
    body = <EdgeRosterTable rows={edgeRows} />;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="w-full p-3 sm:px-6 sm:py-4">
        <section className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <SegmentedTab
              active={tab === 'entities'}
              label={t('graph.rosterEntities')}
              onClick={() => changeTab('entities')}
            />
            <SegmentedTab
              active={tab === 'relations'}
              label={t('graph.rosterRelations')}
              onClick={() => changeTab('relations')}
            />
          </div>

          {/*
            The sentence the whole screen exists for: a reader looking at a sparse drawing
            has already been told "200 of 378 entities"; this states that the list below is
            the missing part rather than another slice. Absent stats means no denominator,
            and a blank would be worse than saying nothing.
          */}
          {stats && (
            <p className="mb-2 text-[11px] text-neutral-500 dark:text-neutral-400">
              {t('graph.rosterHint', { total: stats.nodes })}
            </p>
          )}

          {tab === 'entities' ? (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('graph.rosterSearch')}
                aria-label={t('graph.rosterSearch')}
                className="h-8 min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2 text-xs text-neutral-700 placeholder:text-neutral-400 dark:border-neutral-800 dark:bg-neutral-800 dark:text-neutral-200 dark:placeholder:text-neutral-500 sm:max-w-xs"
              />
              <Select
                compact
                value={entityType}
                onChange={(event) => {
                  setEntityType(event.target.value);
                  resetPaging();
                }}
                options={typeOptions}
                className="w-32"
              />
              <Select
                compact
                value={edgePresence}
                onChange={(event) => {
                  setEdgePresence(event.target.value as EdgePresence);
                  resetPaging();
                }}
                options={presenceOptions}
                className="w-28"
              />
              <Select
                compact
                value={entitySort}
                onChange={(event) => {
                  setEntitySort(event.target.value as EntitySort);
                  resetPaging();
                }}
                options={sortOptions}
                className="w-32"
              />
            </div>
          ) : (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Select
                compact
                value={edgeStatus}
                onChange={(event) => {
                  setEdgeStatus(event.target.value as EdgeStatus);
                  resetPaging();
                }}
                options={statusOptions}
                className="w-28"
              />
              <Select
                compact
                value={relation}
                onChange={(event) => {
                  setRelation(event.target.value);
                  resetPaging();
                }}
                options={relationOptions}
                className="w-32"
              />
            </div>
          )}

          {error && <p className="mb-1 text-[11px] text-red-600 dark:text-red-400">{error}</p>}

          {body}

          {rows.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                {t('graph.rosterTotal', { total })}
                {/*
                  A count with no drill-down is a dead end, and this is the list it was
                  missing: when history is sitting among the rows, say so where the rows
                  are counted.
                */}
                {tab === 'relations' && edgeCounts !== null && edgeCounts.retracted > 0 && (
                  <span className="ml-1.5">
                    {t('graph.rosterIncludesRetracted', { count: edgeCounts.retracted })}
                  </span>
                )}
                {loading && (
                  <span className="ml-1.5 inline-flex items-center align-middle">
                    <Spinner size="sm" />
                  </span>
                )}
              </p>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" disabled={page === 0} onClick={goPrev}>
                  {t('graph.rosterPrev')}
                </Button>
                <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  {t('graph.rosterPage', { page: page + 1 })}
                </span>
                <Button variant="secondary" size="sm" disabled={!nextCursor} onClick={goNext}>
                  {t('graph.rosterNext')}
                </Button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** One half of the tab pair; primary marks the list currently on screen. */
function SegmentedTab({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant={active ? 'primary' : 'secondary'}
      size="sm"
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

function EntityRosterTable({
  rows,
  onOpen,
}: {
  rows: EntityRosterRow[];
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation('common');
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-[11px] text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
            <th className="py-1 pl-1 pr-2 font-medium">{t('graph.rosterColEntity')}</th>
            <th className="whitespace-nowrap px-2 py-1 font-medium">{t('graph.rosterColType')}</th>
            <th className="whitespace-nowrap px-2 py-1 font-medium">
              {t('graph.rosterColDegree')}
            </th>
            <th className="whitespace-nowrap px-2 py-1 font-medium">
              {t('graph.rosterColMentions')}
            </th>
            <th className="px-2 py-1 font-medium">{t('graph.rosterColAliases')}</th>
            <th className="whitespace-nowrap px-2 py-1 font-medium">
              {t('graph.rosterColUpdated')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className="border-b border-neutral-100 last:border-0 dark:border-neutral-800/60"
            >
              <td className="py-1 pl-1 pr-2">
                {/*
                  A name is a door, and it opens the drawing: the roster answers "what is
                  there", the canvas answers "what is it next to".
                */}
                <button
                  type="button"
                  onClick={() => onOpen(row.id)}
                  title={row.name}
                  className="block max-w-[9rem] truncate text-left font-medium text-blue-600 hover:underline dark:text-blue-400 sm:max-w-[16rem]"
                >
                  {row.name}
                </button>
              </td>
              <td className="whitespace-nowrap px-2 py-1 text-neutral-600 dark:text-neutral-400">
                {row.entityType}
              </td>
              <td className="whitespace-nowrap px-2 py-1 tabular-nums text-neutral-700 dark:text-neutral-300">
                {/* `out/in`, then the total in the same cell: they are one number's three
                    readings, and a fourth column would say "canonical degree" twice. */}
                {row.degree.out}/{row.degree.in}
                <span className="ml-1 text-[11px] text-neutral-400 dark:text-neutral-500">
                  {row.degree.total}
                </span>
              </td>
              <td className="whitespace-nowrap px-2 py-1 tabular-nums text-neutral-700 dark:text-neutral-300">
                {row.mentionCount}
              </td>
              <td className="px-2 py-1 text-neutral-600 dark:text-neutral-400">
                {row.aliases.length === 0 ? (
                  <span className="text-neutral-400 dark:text-neutral-500">—</span>
                ) : (
                  <span className="block max-w-[11rem] truncate" title={row.aliases.join(' · ')}>
                    {row.aliases.join(' · ')}
                    {/*
                      The server sends a preview and counts the rest, so the row says
                      "these are 6 of 9" instead of implying this is every alias.
                    */}
                    {row.aliasCount > row.aliases.length && (
                      <span className="ml-1 text-[11px] text-neutral-400 dark:text-neutral-500">
                        +{row.aliasCount - row.aliases.length}
                      </span>
                    )}
                  </span>
                )}
              </td>
              <td className="whitespace-nowrap px-2 py-1 text-neutral-500 dark:text-neutral-400">
                {row.updatedAt === null ? '—' : formatDay(row.updatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EdgeRosterTable({ rows }: { rows: EdgeRosterRow[] }) {
  const { t } = useTranslation('common');
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-neutral-200 text-left text-[11px] text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
            <th className="py-1 pl-1 pr-2 font-medium">{t('graph.rosterColEdge')}</th>
            <th className="whitespace-nowrap px-2 py-1 font-medium">
              {t('graph.rosterColConfidence')}
            </th>
            <th className="whitespace-nowrap px-2 py-1 font-medium">
              {t('graph.rosterColValidity')}
            </th>
            <th className="whitespace-nowrap px-2 py-1 font-medium">{t('graph.edgeEvidence')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const validTo = row.validTo;
            const retracted = validTo !== null;
            return (
              <tr
                key={row.id}
                className={cn(
                  'border-b border-neutral-100 last:border-0 dark:border-neutral-800/60',
                  // A retracted relation is history, not connectivity — dimmed rather
                  // than hidden, because the status filter is what decides whether it
                  // is in the list at all.
                  retracted && 'opacity-60',
                )}
              >
                <td className="py-1 pl-1 pr-2 align-top">
                  <span className="flex flex-wrap items-baseline gap-x-1">
                    <span className="max-w-[8rem] truncate font-medium text-neutral-800 dark:text-neutral-200 sm:max-w-[14rem]">
                      {row.source.name}
                    </span>
                    <span className="text-neutral-400 dark:text-neutral-500">→</span>
                    <span className="whitespace-nowrap text-neutral-600 dark:text-neutral-400">
                      {row.relationType}
                    </span>
                    <span className="text-neutral-400 dark:text-neutral-500">→</span>
                    <span className="max-w-[8rem] truncate font-medium text-neutral-800 dark:text-neutral-200 sm:max-w-[14rem]">
                      {row.target.name}
                    </span>
                  </span>
                </td>
                <td className="whitespace-nowrap px-2 py-1 align-top tabular-nums text-neutral-700 dark:text-neutral-300">
                  {row.confidence.toFixed(2)}
                </td>
                <td className="whitespace-nowrap px-2 py-1 align-top text-neutral-500 dark:text-neutral-400">
                  {validTo !== null ? (
                    // `validTo` set means the fact stopped being true; the day it stopped
                    // is the answer a reader came for, not the day it began.
                    <span>{t('graph.rosterRetractedAt', { date: formatDay(validTo) })}</span>
                  ) : row.validFrom === null ? (
                    <span>—</span>
                  ) : (
                    <span>{formatDay(row.validFrom)}</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-2 py-1 align-top font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                  {/* Plain text, not a link: following it would replace the enumeration
                      the reader is working through with one memory's transcript. */}
                  {row.sourceMemoryId === null
                    ? '—'
                    : `[mem:${row.sourceMemoryId.slice(0, MEMORY_REF_CHARS)}]`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
