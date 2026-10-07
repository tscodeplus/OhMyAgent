/**
 * Judge ledger panel (M4, MyDocs/JEV_JUDGE_KERNEL_IMPLEMENTATION.md §6/§8):
 * read-only view of recent judge verdicts on the dashboard. Read-only on
 * purpose — the judge is configured in settings (JudgeSettings.tsx), this
 * panel only observes the ledger.
 *
 * Mounted by DashboardView next to the channel status panel (NOT inside the
 * settings judge sub-tab).
 *
 * API contract (implemented server-side in parallel; absence tolerated):
 * GET /api/judge/ledger?page=1&pageSize=20&pointId=&mode=&outcome=&from=&to=&session=
 *   → { entries: LedgerRecord-like[], total, page, pageSize }.
 * Every entry field except the envelope is optional and rendered tolerantly
 * ('—'). Missing endpoint / unavailable lifecycle → muted hint, not an error.
 */
import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { apiRequest } from '../../utils/api';
import Select from '../ui/Select';
import Input from '../ui/Input';
import Button from '../ui/Button';
import { cn } from '../../lib/utils';

/* ───────── Domain types (tolerant: entry fields may be absent) ───────── */

type JudgeMode = 'off' | 'shadow' | 'active';
const JUDGE_MODES = ['off', 'shadow', 'active'] as const;

/** Bounded DecisionOutcome actions (src/judge/types.ts) usable as an outcome filter. */
const OUTCOME_ACTIONS = [
  'keep-all',
  'keep',
  'discard',
  'replace',
  'none',
  'proceed',
  'ask',
  'steer',
  'route',
] as const;

/** All 15 decision points (impl doc §4) — filter options before data arrives. */
const JUDGE_POINT_IDS = [
  'tool.admission',
  'testlog.fold',
  'intent.classify',
  'skills.disclosure',
  'memory.capture',
  'memory.worth',
  'memory.merge',
  'context.forget',
  'context.compact',
  'turn.drift',
  'turn.completion',
  'tool.risk',
  'injection.screen',
  'channel.triage',
  'notify.routing',
] as const;

interface JudgeLedgerEntry {
  ts?: string;
  sessionId?: string;
  pointId?: string;
  decisionId?: string;
  mode?: string;
  judgeId?: string;
  source?: string;
  fallbackReason?: string;
  latencyMs?: number;
  /** Serializes either as the action string or as a DecisionOutcome object. */
  outcome?: string | { action?: unknown };
  usage?: { input?: number; output?: number };
}

interface JudgeLedgerPayload {
  entries?: JudgeLedgerEntry[];
  total?: number;
  page?: number;
  pageSize?: number;
  /** Tolerated server flag: judge ledger lifecycle not enabled. */
  available?: boolean;
  enabled?: boolean;
}

const PAGE_SIZE = 20;

/** datetime-local string → ISO timestamp; '' when absent/unparseable. */
function toIso(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/** Outcome cell text: action string, action field of an object, or '—'. */
function outcomeText(outcome: JudgeLedgerEntry['outcome']): string {
  if (typeof outcome === 'string') return outcome;
  if (outcome && typeof outcome === 'object' && typeof outcome.action === 'string')
    return outcome.action;
  return '—';
}

/* ───────── Presentational helpers ───────── */

function ModeBadge({ mode }: { mode?: string }) {
  const { t } = useTranslation('common');
  const known = (JUDGE_MODES as readonly string[]).includes(mode ?? '');
  const tone = known
    ? mode === 'active'
      ? 'bg-green-600 text-white'
      : mode === 'shadow'
        ? 'bg-amber-500 text-white'
        : 'bg-neutral-500 text-white'
    : 'bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300';
  const label = known
    ? t(`settings.judge.mode${(mode as JudgeMode)[0].toUpperCase()}${(mode as JudgeMode).slice(1)}`)
    : (mode ?? '—');
  return (
    <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium', tone)}>
      {label}
    </span>
  );
}

function EntryRow({ entry }: { entry: JudgeLedgerEntry }) {
  const { t } = useTranslation('common');
  const time =
    entry.ts && !Number.isNaN(new Date(entry.ts).getTime())
      ? new Date(entry.ts).toLocaleString(undefined, {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      : '—';
  const fellBack = entry.source === 'fallback';
  return (
    <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900">
      {/* First row: time · decision point · mode · outcome */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="shrink-0 font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
          {time}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-900 dark:text-neutral-100">
          {entry.pointId || '—'}
        </span>
        <ModeBadge mode={entry.mode} />
        <span className="shrink-0 font-mono text-[11px] text-neutral-700 dark:text-neutral-200">
          {outcomeText(entry.outcome)}
        </span>
      </div>
      {/* Second row: judge id + latency (+ fallback reason) */}
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">
        <span>
          {t('dashboard.judgeLedger.judgeLabel')}:{' '}
          <span className="font-mono">{entry.judgeId || '—'}</span>
        </span>
        <span className="font-mono">
          {typeof entry.latencyMs === 'number' && Number.isFinite(entry.latencyMs)
            ? `${entry.latencyMs}ms`
            : '—'}
        </span>
        {fellBack && entry.fallbackReason && (
          <span className="text-amber-600 dark:text-amber-400">
            {t('dashboard.judgeLedger.fallbackLabel')}: {entry.fallbackReason}
          </span>
        )}
      </div>
    </div>
  );
}

/* ───────── Main component ───────── */

export default function JudgeLedger() {
  const { t } = useTranslation('common');

  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<JudgeLedgerPayload | null>(null);
  /** Ledger API / judge lifecycle absent → muted hint, not an error. */
  const [unavailable, setUnavailable] = useState(false);

  /* Filters */
  const [pointFilter, setPointFilter] = useState('all');
  const [modeFilter, setModeFilter] = useState('all');
  const [outcomeFilter, setOutcomeFilter] = useState('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);

  const fetchLedger = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set('page', String(page));
        params.set('pageSize', String(PAGE_SIZE));
        if (pointFilter !== 'all') params.set('pointId', pointFilter);
        if (modeFilter !== 'all') params.set('mode', modeFilter);
        if (outcomeFilter !== 'all') params.set('outcome', outcomeFilter);
        const fromIso = toIso(from);
        if (fromIso) params.set('from', fromIso);
        const toIsoValue = toIso(to);
        if (toIsoValue) params.set('to', toIsoValue);
        const data = await apiRequest<JudgeLedgerPayload>(`/api/judge/ledger?${params}`, {
          signal,
        });
        setPayload(data && typeof data === 'object' ? data : {});
        setUnavailable(false);
      } catch (e) {
        if (e && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError') return;
        setPayload(null);
        setUnavailable(true);
      } finally {
        setLoading(false);
      }
    },
    [page, pointFilter, modeFilter, outcomeFilter, from, to],
  );

  /* Debounced fetch; filter changes reset the page first. */
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void fetchLedger(controller.signal), 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [fetchLedger]);

  const setFilter =
    <T extends string>(setter: (v: T) => void) =>
    (value: string) => {
      setPage(1);
      setter(value as T);
    };

  const entries = Array.isArray(payload?.entries) ? payload.entries : [];
  const total = typeof payload?.total === 'number' ? payload.total : entries.length;
  const pageSize =
    typeof payload?.pageSize === 'number' && payload.pageSize > 0 ? payload.pageSize : PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  /* Muted hint when the ledger API or the judge lifecycle is absent. */
  const disabled =
    unavailable || payload?.available === false || (payload !== null && payload.enabled === false);

  return (
    <div>
      {/* Filters */}
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap">
          <Select
            value={pointFilter}
            onChange={(e) => setFilter(setPointFilter)(e.target.value)}
            options={[
              {
                value: 'all',
                label: `${t('dashboard.judgeLedger.pointLabel')}: ${t('dashboard.judgeLedger.all')}`,
              },
              ...JUDGE_POINT_IDS.map((id) => ({ value: id, label: id })),
            ]}
            compact
            className="w-full sm:w-[160px]"
          />
          <Select
            value={modeFilter}
            onChange={(e) => setFilter(setModeFilter)(e.target.value)}
            options={[
              {
                value: 'all',
                label: `${t('dashboard.judgeLedger.modeLabel')}: ${t('dashboard.judgeLedger.all')}`,
              },
              ...JUDGE_MODES.map((m) => ({
                value: m,
                label: t(`settings.judge.mode${m[0].toUpperCase()}${m.slice(1)}`),
              })),
            ]}
            compact
            className="w-full sm:w-[140px]"
          />
          <Select
            value={outcomeFilter}
            onChange={(e) => setFilter(setOutcomeFilter)(e.target.value)}
            options={[
              {
                value: 'all',
                label: `${t('dashboard.judgeLedger.outcomeLabel')}: ${t('dashboard.judgeLedger.all')}`,
              },
              ...OUTCOME_ACTIONS.map((a) => ({ value: a, label: a })),
            ]}
            compact
            className="w-full sm:w-[150px]"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="datetime-local"
            value={from}
            onChange={(e) => setFilter(setFrom)(e.target.value)}
            className="h-8 w-[180px] text-xs"
            aria-label={t('dashboard.judgeLedger.fromLabel')}
          />
          <Input
            type="datetime-local"
            value={to}
            onChange={(e) => setFilter(setTo)(e.target.value)}
            className="h-8 w-[180px] text-xs"
            aria-label={t('dashboard.judgeLedger.toLabel')}
          />
          <Button
            variant="secondary"
            size="sm"
            loading={loading}
            onClick={() => void fetchLedger()}
          >
            {t('dashboard.judgeLedger.refresh')}
          </Button>
        </div>
      </div>

      {/* Body */}
      {disabled ? (
        <p className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-[13px] text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
          {t('dashboard.judgeLedger.unavailable')}
        </p>
      ) : entries.length === 0 ? (
        <p className="rounded-lg border border-neutral-200 bg-white px-4 py-3 text-[13px] text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
          {t('dashboard.judgeLedger.empty')}
        </p>
      ) : (
        <div className="space-y-2">
          {entries.map((entry, i) => (
            <EntryRow key={`${entry.ts ?? i}-${entry.pointId ?? i}-${i}`} entry={entry} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {!disabled && entries.length > 0 && (
        <div className="mt-3 flex items-center justify-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            {t('common.prev_page')}
          </Button>
          <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
            {t('dashboard.judgeLedger.pageInfo', { page, pages: totalPages })}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage(page + 1)}
          >
            {t('common.next_page')}
          </Button>
        </div>
      )}
    </div>
  );
}
