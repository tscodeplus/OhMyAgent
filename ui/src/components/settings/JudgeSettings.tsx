/**
 * Jev judgment kernel settings (M0.5, MyDocs/JEV_JUDGE_KERNEL_PLAN.md §8.2).
 *
 * Mounted inside ModelSettings as the 5th sub-tab. Owns its own lifecycle
 * (server fetch + deferred draft) and plugs into the settings modal dirty /
 * save / cancel flow through the actions handle registered with the parent —
 * the judge section of config.yaml hot-reloads, so it never needs a restart.
 *
 * API contract (implemented server-side in parallel; absence tolerated):
 * - GET  /api/judge/config → effective judge config + key status + classifier
 *   model enumeration. Missing endpoint / `available: false` → unavailable card.
 * - POST /api/judge/config → persists the judge: section (yaml hot-reloaded),
 *   body = { enabled, provider, modelRef, fallbackTiers, modes, judges }.
 * - POST /api/judge/key    → { provider, apiKey?, accountId? } per-field writes;
 *   '' clears the field, omission leaves it untouched, values never returned.
 * - POST /api/judge/test   → golden sample (choice / noul / score), latency +
 *   the three answer shapes are shown tolerantly (missing fields → '—').
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, GripVertical, Plus, X } from 'lucide-react';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { apiRequest } from '../../utils/api';
import { useToast } from '../ui/Toast';
import Toggle from '../ui/Toggle';
import Select from '../ui/Select';
import Input from '../ui/Input';
import PasswordInput from '../ui/PasswordInput';
import Spinner from '../ui/Spinner';
import { SettingsSection, SettingsCard } from './SettingsSection';

/* ───────── Domain types ───────── */

type JudgeMode = 'off' | 'shadow' | 'active';
const JUDGE_MODES = ['off', 'shadow', 'active'] as const;
const isJudgeMode = (v: unknown): v is JudgeMode =>
  typeof v === 'string' && (JUDGE_MODES as readonly string[]).includes(v);

/** All 15 decision points (impl doc §4); each row gets a tri-state control. */
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

/** The 5 builtin judge provider rows of the drag-sortable chain. */
const JUDGE_PROVIDER_IDS = [
  'opencode',
  'typesafe',
  'vercel-ai-gateway',
  'openrouter',
  'cloudflare-workers-ai',
] as const;
const isBuiltinProvider = (id: string): id is (typeof JUDGE_PROVIDER_IDS)[number] =>
  (JUDGE_PROVIDER_IDS as readonly string[]).includes(id);

/* Editable subset of the judge: config section (plus custom relay judges). */
interface CustomJudgeEntry {
  name: string;
  type: 'typesafe' | 'http';
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
}
interface JudgeDraft {
  enabled: boolean;
  provider: string;
  modelRef: string;
  fallbackTiers: string[];
  modes: Record<string, JudgeMode>;
  judges: CustomJudgeEntry[];
}

/* Shapes tolerated from GET /api/judge/config. */
interface JudgeModelOption {
  id: string;
  name?: string;
  free?: boolean;
  provider?: string;
}
interface JudgeConfigPayload {
  available?: boolean;
  enabled?: boolean;
  provider?: string;
  modelRef?: string;
  fallbackTiers?: string[];
  modes?: Record<string, unknown>;
  /** judge.judges: custom relay judges keyed by entry name. */
  judges?: Record<string, unknown>;
  /** Server envelope: GET /api/judge/config returns { config, models, keyStatus }. */
  config?: Partial<JudgeConfigPayload>;
  /** Either an array of { id, keyConfigured } or a map providerId → configured. */
  providers?: Array<{ id: string; keyConfigured?: boolean }> | Record<string, unknown>;
  keyConfigured?: Record<string, unknown>;
  /** Server shape: Record<provider, { envVars, present, accountId? }> or boolean map. */
  keyStatus?: Record<string, unknown>;
  modelsByProvider?: Record<string, JudgeModelOption[]>;
  /** Server shape: Record<provider, string[]> of classifier ids; UI also tolerates option objects. */
  models?: Record<string, string[]> | JudgeModelOption[];
}

/**
 * Normalize the server envelope ({ config, models, keyStatus }) into the
 * flat payload this component parses; tolerates already-flat shapes.
 */
function normalizeJudgeConfigPayload(data: JudgeConfigPayload): JudgeConfigPayload {
  const root = data && typeof data === 'object' ? data : {};
  const inner = root.config && typeof root.config === 'object' ? root.config : root;
  const normalized: JudgeConfigPayload = { ...root, ...inner };
  // models: Record<provider, string[]> → modelsByProvider options
  if (
    root.models &&
    typeof root.models === 'object' &&
    !Array.isArray(root.models) &&
    !root.modelsByProvider
  ) {
    const map: Record<string, JudgeModelOption[]> = {};
    for (const [provider, ids] of Object.entries(root.models)) {
      map[provider] = (Array.isArray(ids) ? ids : [])
        .filter((id): id is string => typeof id === 'string')
        .map((id) => ({ id, free: id.endsWith('-free') }));
    }
    normalized.modelsByProvider = map;
  }
  return normalized;
}

/** Actions handle handed back to ModelSettings for the shared save/cancel bar. */
export interface JudgeSettingsActions {
  save: (opts?: { silent?: boolean }) => Promise<void>;
  cancel: () => void;
}

interface JudgeSettingsProps {
  registerActions?: (actions: JudgeSettingsActions | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Jump to the providers sub-tab to fill in a missing API key. */
  onJumpToProviders?: () => void;
}

/* ───────── Config payload parsing ───────── */

interface JudgeKeyStatusEntry {
  envVars: string[];
  present: boolean;
  /** Only meaningful for cloudflare-workers-ai (POST /api/judge/key contract). */
  accountId?: { present?: boolean };
}

function extractKeyStatus(payload: JudgeConfigPayload): Record<string, JudgeKeyStatusEntry> {
  const map: Record<string, JudgeKeyStatusEntry> = {};
  const entry = (envVars: unknown, present: unknown, accountId: unknown): JudgeKeyStatusEntry => ({
    envVars: Array.isArray(envVars)
      ? envVars.filter((s): s is string => typeof s === 'string')
      : [],
    present: !!present,
    accountId:
      accountId && typeof accountId === 'object'
        ? { present: !!(accountId as { present?: unknown }).present }
        : undefined,
  });
  if (Array.isArray(payload.providers)) {
    for (const e of payload.providers) {
      if (e && typeof e.id === 'string') map[e.id] = entry(undefined, e.keyConfigured, undefined);
    }
  } else if (payload.providers && typeof payload.providers === 'object') {
    for (const [k, v] of Object.entries(payload.providers)) map[k] = entry(undefined, v, undefined);
  } else if (payload.keyConfigured && typeof payload.keyConfigured === 'object') {
    for (const [k, v] of Object.entries(payload.keyConfigured))
      map[k] = entry(undefined, v, undefined);
  }
  if (payload.keyStatus && typeof payload.keyStatus === 'object') {
    for (const [k, v] of Object.entries(payload.keyStatus)) {
      if (typeof v === 'boolean') map[k] = entry(undefined, v, undefined);
      else if (v && typeof v === 'object') {
        const o = v as { envVars?: unknown; present?: unknown; accountId?: unknown };
        map[k] = entry(o.envVars, o.present, o.accountId);
      }
    }
  }
  return map;
}

/** Classifier models offered for a provider; falls back to the OpenCode pair. */
function extractModelOptions(
  payload: JudgeConfigPayload | null,
  provider: string,
): JudgeModelOption[] {
  if (!payload) return [];
  if (
    payload.modelsByProvider &&
    typeof payload.modelsByProvider === 'object' &&
    Array.isArray(payload.modelsByProvider[provider])
  ) {
    return payload.modelsByProvider[provider].filter((m) => m && typeof m.id === 'string');
  }
  const models = Array.isArray(payload.models) ? payload.models : [];
  if (models.some((m) => typeof m?.provider === 'string')) {
    return models.filter((m) => m.provider === provider && typeof m.id === 'string');
  }
  if (models.length > 0) return models.filter((m) => m && typeof m.id === 'string');
  if (provider === 'opencode') {
    return [
      { id: 'jev-1.13', name: 'Jev 1.13' },
      { id: 'jev-1.13-free', name: 'Jev 1.13 Free', free: true },
    ];
  }
  return [];
}

/** judge.judges entries (custom relay judges) — defaults per the API contract. */
function parseCustomJudges(raw: unknown): CustomJudgeEntry[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.entries(raw).map(([name, v]) => {
    const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    return {
      name,
      type: o.type === 'http' ? ('http' as const) : ('typesafe' as const),
      baseUrl: typeof o.baseUrl === 'string' ? o.baseUrl : '',
      apiKeyEnv: typeof o.apiKeyEnv === 'string' ? o.apiKeyEnv : '',
      model: typeof o.model === 'string' ? o.model : 'jev-latest',
    };
  });
}

function draftFromPayload(payload: JudgeConfigPayload): JudgeDraft {
  const modes = payload.modes && typeof payload.modes === 'object' ? payload.modes : {};
  const defaultMode = isJudgeMode(modes.default) ? modes.default : 'shadow';
  const judgeModes: Record<string, JudgeMode> = { default: defaultMode };
  for (const id of JUDGE_POINT_IDS)
    judgeModes[id] = isJudgeMode(modes[id]) ? modes[id]! : defaultMode;
  return {
    enabled: !!payload.enabled,
    provider: typeof payload.provider === 'string' ? payload.provider : '',
    modelRef: typeof payload.modelRef === 'string' ? payload.modelRef : '',
    fallbackTiers: Array.isArray(payload.fallbackTiers)
      ? payload.fallbackTiers.filter((s): s is string => typeof s === 'string')
      : [],
    modes: judgeModes,
    judges: parseCustomJudges(payload.judges),
  };
}

/* ───────── Test response parsing ───────── */

interface TestAnswer {
  kind: 'choice' | 'noul' | 'score';
  winner?: string;
  probability?: number;
  score?: number;
  confidence?: number;
}
interface TestDisplay {
  latencyMs: number;
  answers: TestAnswer[];
}

function number(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function inferAnswer(raw: unknown): TestAnswer | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const type = typeof obj.type === 'string' ? (obj.type as string) : undefined;
  if (type === 'choice' || (!type && typeof obj.choice === 'string' && obj.choice)) {
    return {
      kind: 'choice',
      winner: typeof obj.choice === 'string' ? obj.choice : undefined,
      confidence: number(obj.confidence),
    };
  }
  if (type === 'noul' || type === 'bool' || (!type && typeof obj.probability === 'number')) {
    return { kind: 'noul', probability: number(obj.probability) };
  }
  if (type === 'score' || (!type && typeof obj.score === 'number')) {
    return { kind: 'score', score: number(obj.score), confidence: number(obj.confidence) };
  }
  return null;
}

/**
 * Accepts answered-shaped containers of every plausible shape
 * (`answers` object/array, `results` array, or a bare answer object) and
 * keeps at most one answer per kind (choice / noul / score).
 */
function normalizeTest(data: unknown, startedAt: number): TestDisplay {
  const latencyMs =
    data &&
    typeof data === 'object' &&
    number((data as Record<string, unknown>).latencyMs) !== undefined
      ? number((data as Record<string, unknown>).latencyMs)!
      : Date.now() - startedAt;
  const candidates: unknown[] = [data];
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.results)) candidates.push(...d.results);
    if (Array.isArray(d.answers)) candidates.push(...d.answers);
    else if (d.answers && typeof d.answers === 'object')
      candidates.push(...Object.values(d.answers));
    if (d.verdict && typeof d.verdict === 'object') candidates.push(d.verdict);
  }
  const answers: TestAnswer[] = [];
  for (const kind of ['choice', 'noul', 'score'] as const) {
    for (const candidate of candidates) {
      const answer = inferAnswer(candidate);
      if (answer && answer.kind === kind) {
        answers.push(answer);
        break;
      }
    }
  }
  return { latencyMs, answers };
}

function errorToMessage(e: unknown): string {
  if (
    e &&
    typeof e === 'object' &&
    'message' in e &&
    typeof (e as { message: unknown }).message === 'string'
  ) {
    return (e as { message: string }).message;
  }
  return String(e);
}

/* ───────── Judge chain derivation (pure functions of the draft) ───────── */

/**
 * The chain = [primary provider/modelRef, ...fallbackTiers refs]. Builtin
 * providers are provider rows; refs of the form 'judges.<name>' place that
 * judge.judges entry's row at that chain position. Entries never referenced
 * by any ref load as rows at the TOP of the list — that mirrors the server's
 * auto-prepend priority for unreferenced entries, and after the next save
 * they become explicitly placed (same effective order). Rows are re-derived
 * from the draft on every render (no parallel state), so the shared save/
 * cancel flow can't desync.
 */
interface ChainProviderRow {
  kind: 'provider';
  id: string;
  provider: (typeof JUDGE_PROVIDER_IDS)[number];
  model: string;
}
/**
 * A judge.judges entry as a chain row; draft.judges stays the source of
 * truth for entry DATA — the chain order is encoded purely through refs.
 */
interface ChainJudgesRow {
  kind: 'judges';
  /** Sortable id 'judges:<name>' — renaming an entry just re-keys the row.
   * Blank names get a positional id so two untitled entries never collide. */
  id: string;
  entry: CustomJudgeEntry;
  /** Position inside draft.judges, for edit/remove handlers. */
  entryIndex: number;
}
type ChainSortableRow = ChainProviderRow | ChainJudgesRow;

/** A judges entry can judge only when it has both a name and a Base URL. */
function judgesEntryUsable(entry: CustomJudgeEntry): boolean {
  return entry.name.trim() !== '' && entry.baseUrl.trim() !== '';
}

function deriveChainRows(draft: JudgeDraft): { rows: ChainSortableRow[]; opaque: string[] } {
  const rows: ChainSortableRow[] = [];
  const opaque: string[] = [];
  const placedProviders = new Set<string>();
  const placedJudges = new Set<number>();

  const judgesRow = (entryIndex: number, entry: CustomJudgeEntry): ChainJudgesRow => ({
    kind: 'judges',
    // Index-keyed id: name-based ids would remount the row (and drop input
    // focus) on every keystroke while typing the entry name.
    id: `judges:#${entryIndex}`,
    entry,
    entryIndex,
  });

  // Ordered refs: primary judge first, then the fallback tiers.
  const refs: { ref: string; isPrimaryRef: boolean }[] = [];
  if (draft.provider && draft.modelRef) {
    refs.push({
      ref:
        draft.provider === 'judges'
          ? `judges.${draft.modelRef}`
          : `${draft.provider}/${draft.modelRef}`,
      isPrimaryRef: true,
    });
  }
  for (const ref of draft.fallbackTiers) refs.push({ ref, isPrimaryRef: false });

  for (const { ref, isPrimaryRef } of refs) {
    // 'judges.<name>' → that entry's row at this chain position.
    if (ref.startsWith('judges.')) {
      const wanted = ref.slice('judges.'.length).trim();
      const idx = draft.judges.findIndex(
        (j, i) => !placedJudges.has(i) && j.name.trim() !== '' && j.name.trim() === wanted,
      );
      if (idx >= 0 && draft.judges[idx]) {
        placedJudges.add(idx);
        rows.push(judgesRow(idx, draft.judges[idx]));
        continue;
      }
      // Ref to a removed/renamed entry: drop it (keeping the orphan ref would
      // leave an unresolvable tier in the saved chain).
      continue;
    }
    // 'provider/model' → a builtin provider row at this chain position.
    const slashIdx = ref.indexOf('/');
    const provider = slashIdx > 0 ? ref.slice(0, slashIdx) : '';
    if (slashIdx > 0 && isBuiltinProvider(provider)) {
      if (!placedProviders.has(provider)) {
        placedProviders.add(provider);
        rows.push({
          kind: 'provider',
          id: provider,
          provider,
          model: ref.slice(slashIdx + 1),
        });
        continue;
      }
    }
    // Unresolved or malformed ref (incl. duplicate refs and legacy
    // non-builtin primaries): pinned opaque row, preserved verbatim.
    if (!isPrimaryRef || !opaque.includes(ref)) opaque.push(ref);
  }

  // Judges entries never placed by any ref (hand-edited or newly added) sit
  // at the END of the list, after the builtin providers: the chain write-back
  // then references them at exactly the position the user sees, so display
  // order = execution order. Drag any of them anywhere (position 1 = primary).
  for (let i = 0; i < draft.judges.length; i++) {
    const entry = draft.judges[i];
    if (entry && !placedJudges.has(i)) rows.push(judgesRow(i, entry));
  }
  // Builtin providers without a ref keep their row (empty model → not in chain).
  for (const provider of JUDGE_PROVIDER_IDS)
    if (!placedProviders.has(provider))
      rows.push({ kind: 'provider', id: provider, provider, model: '' });
  return { rows, opaque };
}

/**
 * Pure write-back from the ordered row list: the first USABLE row becomes the
 * primary — a provider row holding a model → draft.provider + draft.modelRef,
 * a judges row with name + baseUrl → provider='judges', modelRef=<entry name>;
 * every LATER usable row appends a fallback ref ('provider/model' resp.
 * 'judges.<name>'). Provider rows without a model and judges rows without
 * name||baseUrl are skipped — their editor data still lives in draft.judges /
 * stays for future edits. Opaque refs are appended verbatim at the end.
 */
function chainWriteBack(
  rows: ChainSortableRow[],
  opaque: string[],
  prev: JudgeDraft,
): Pick<JudgeDraft, 'provider' | 'modelRef' | 'fallbackTiers'> {
  let provider = '';
  let modelRef = '';
  let primarySet = false;
  const fallbackTiers: string[] = [];
  for (const row of rows) {
    if (row.kind === 'provider') {
      if (!row.model) continue;
      if (!primarySet) {
        provider = row.provider;
        modelRef = row.model;
        primarySet = true;
      } else {
        fallbackTiers.push(`${row.provider}/${row.model}`);
      }
    } else {
      if (!judgesEntryUsable(row.entry)) continue;
      const name = row.entry.name.trim();
      if (!primarySet) {
        provider = 'judges';
        modelRef = name;
        primarySet = true;
      } else {
        fallbackTiers.push(`judges.${name}`);
      }
    }
  }
  fallbackTiers.push(...opaque);
  // No row is usable: keep a legacy non-builtin (non-judges) primary untouched
  // instead of clearing it (opaque rows above already preserve the ref).
  if (
    !primarySet &&
    prev.provider &&
    prev.modelRef &&
    !isBuiltinProvider(prev.provider) &&
    prev.provider !== 'judges'
  ) {
    provider = prev.provider;
    modelRef = prev.modelRef;
  }
  return { provider, modelRef, fallbackTiers };
}

/* ───────── Presentational helpers ───────── */

function ModeSegment({
  value,
  disabled,
  onChange,
}: {
  value: JudgeMode;
  disabled?: boolean;
  onChange?: (mode: JudgeMode) => void;
}) {
  const { t } = useTranslation('common');
  const label: Record<JudgeMode, string> = {
    off: t('settings.judge.modeOff'),
    shadow: t('settings.judge.modeShadow'),
    active: t('settings.judge.modeActive'),
  };
  const activeCls: Record<JudgeMode, string> = {
    off: 'bg-neutral-500 border-neutral-500 text-white',
    shadow: 'bg-amber-500 border-amber-500 text-white',
    active: 'bg-green-600 border-green-600 text-white',
  };
  return (
    <div
      role="group"
      className="inline-flex shrink-0 overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-700"
    >
      {JUDGE_MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          disabled={disabled}
          onClick={() => onChange?.(mode)}
          className={`px-2.5 py-1 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            value === mode
              ? activeCls[mode]
              : 'text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800'
          }`}
        >
          {label[mode]}
        </button>
      ))}
    </div>
  );
}

/**
 * One draggable builtin judge provider row of the chain: grip handle +
 * position number + key status dot + provider name + model chip (or a dimmed
 * "not in chain" tag). Clicking the row body (not the grip) toggles the
 * expandable group holding the key editor (and Account ID for Cloudflare)
 * plus the provider's model Select. Selecting a model puts the provider into
 * the chain; the empty placeholder removes it again.
 */
function JudgeChainRow({
  providerId,
  index,
  model,
  primary,
  keyStatus,
  modelLabel,
  freeBadge,
  models,
  expanded,
  onToggle,
  onSelectModel,
  onKeySaved,
}: {
  providerId: (typeof JUDGE_PROVIDER_IDS)[number];
  index: number;
  model: string;
  primary: boolean;
  keyStatus: JudgeKeyStatusEntry | undefined;
  modelLabel: string;
  freeBadge: string;
  models: JudgeModelOption[];
  expanded: boolean;
  onToggle: () => void;
  onSelectModel: (model: string) => void;
  onKeySaved: () => void;
}) {
  const { t } = useTranslation('common');
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: providerId,
  });
  const [keyDraft, setKeyDraft] = useState('');
  const [keySaving, setKeySaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyJustSaved, setKeyJustSaved] = useState(false);
  const [acctDraft, setAcctDraft] = useState('');
  const [acctSaving, setAcctSaving] = useState(false);
  const [acctError, setAcctError] = useState<string | null>(null);
  const [acctJustSaved, setAcctJustSaved] = useState(false);

  const keyOk = keyStatus?.present ?? false;
  const envVars = keyStatus?.envVars ?? [];
  const accountId = providerId === 'cloudflare-workers-ai' ? keyStatus?.accountId : undefined;

  /** Provider catalog plus the row's current model id (hand-edited values stay selectable). */
  const modelOptions = useMemo(() => {
    const list = [...models];
    if (model && !list.some((m) => m.id === model)) list.push({ id: model });
    return list;
  }, [models, model]);

  const saveKey = useCallback(async () => {
    setKeySaving(true);
    setKeyError(null);
    setKeyJustSaved(false);
    try {
      await apiRequest('/api/judge/key', {
        method: 'POST',
        body: JSON.stringify({ provider: providerId, apiKey: keyDraft.trim() }),
      });
      setKeyDraft('');
      setKeyJustSaved(true);
      window.setTimeout(() => setKeyJustSaved(false), 2000);
      onKeySaved();
    } catch (e) {
      setKeyError(e instanceof Error ? e.message : String(e));
    } finally {
      setKeySaving(false);
    }
  }, [keyDraft, providerId, onKeySaved]);

  const saveAccountId = useCallback(async () => {
    setAcctSaving(true);
    setAcctError(null);
    setAcctJustSaved(false);
    try {
      // Never send apiKey and accountId in one call: omission leaves untouched.
      await apiRequest('/api/judge/key', {
        method: 'POST',
        body: JSON.stringify({ provider: providerId, accountId: acctDraft.trim() }),
      });
      setAcctDraft('');
      setAcctJustSaved(true);
      window.setTimeout(() => setAcctJustSaved(false), 2000);
      onKeySaved();
    } catch (e) {
      setAcctError(e instanceof Error ? e.message : String(e));
    } finally {
      setAcctSaving(false);
    }
  }, [acctDraft, providerId, onKeySaved]);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Ghost while dragging: the DragOverlay clone is what the user sees.
    opacity: isDragging ? 0.3 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-lg border transition-colors ${
        primary
          ? 'border-blue-500 bg-blue-50/40 dark:border-blue-500 dark:bg-blue-950/25'
          : 'border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900'
      }`}
    >
      {/* Header — grip drags, row body click toggles the group */}
      <div className="flex items-center gap-1.5 px-2.5 py-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="shrink-0 cursor-grab touch-none text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
          title={t('settings.websearch.dragToReorder')}
        >
          <GripVertical size={16} />
        </button>
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
            primary
              ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
              : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'
          }`}
        >
          {index + 1}
        </span>
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2.5 py-1 text-left transition-colors"
        >
          <ChevronRight
            size={14}
            className={`shrink-0 text-neutral-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              keyOk ? 'bg-green-500' : 'bg-neutral-300 dark:bg-neutral-600'
            }`}
          />
          <span
            className={`truncate text-[13px] font-medium ${
              primary
                ? 'text-blue-700 dark:text-blue-300'
                : 'text-neutral-700 dark:text-neutral-200'
            }`}
          >
            {t(`settings.judge.providers.${providerId}`)}
          </span>
          {primary && (
            <span className="shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
              {t('settings.judge.primaryJudge')}
            </span>
          )}
          {model ? (
            <span className="ml-auto min-w-0 truncate font-mono text-[10px] text-neutral-500 dark:text-neutral-400">
              {model}
            </span>
          ) : (
            <span className="ml-auto shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-400 dark:bg-neutral-800 dark:text-neutral-500">
              {t('settings.judge.notInChain')}
            </span>
          )}
          {keyOk && (
            <span className="shrink-0 text-[10px] text-green-600 dark:text-green-400">
              {t('settings.judge.keyConfigured')}
            </span>
          )}
        </button>
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-neutral-100 px-3 py-3 dark:border-neutral-800">
          {/* API key (saved independently from the form draft) */}
          <div>
            <label className="mb-1 block text-[11px] font-medium text-neutral-600 dark:text-neutral-300">
              {t('settings.judge.apiKeyLabel')}
            </label>
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <PasswordInput
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  placeholder={
                    keyOk
                      ? t('settings.judge.keyReplacePlaceholder')
                      : t('settings.judge.keyPlaceholder')
                  }
                  className="h-8 text-xs"
                />
              </div>
              <button
                type="button"
                onClick={() => void saveKey()}
                disabled={keySaving}
                className="shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {keySaving
                  ? t('settings.judge.keySaving')
                  : keyDraft.trim() === ''
                    ? t('settings.judge.keyClear')
                    : t('settings.judge.keySave')}
              </button>
            </div>
            {keyJustSaved && (
              <p className="mt-1 text-[11px] text-green-600 dark:text-green-400">
                {t('settings.judge.keySaved')}
              </p>
            )}
            {keyError && (
              <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                {t('settings.judge.keySaveFailed', { error: keyError })}
              </p>
            )}
            {envVars.length > 0 && (
              <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                {t('settings.judge.keyEnvHint', { vars: envVars.join(', ') })}
              </p>
            )}
          </div>

          {/* Cloudflare Workers AI also needs an Account ID (own save button). */}
          {providerId === 'cloudflare-workers-ai' && (
            <div>
              <label className="mb-1 block text-[11px] font-medium text-neutral-600 dark:text-neutral-300">
                {t('settings.judge.accountIdLabel')}
              </label>
              <div className="flex gap-2">
                <div className="min-w-0 flex-1">
                  <Input
                    value={acctDraft}
                    onChange={(e) => setAcctDraft(e.target.value)}
                    placeholder={
                      accountId?.present ? t('settings.judge.accountIdConfigured') : undefined
                    }
                    className="h-8 text-xs"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void saveAccountId()}
                  disabled={acctSaving}
                  className="shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {acctSaving
                    ? t('settings.judge.keySaving')
                    : acctDraft.trim() === ''
                      ? t('settings.judge.keyClear')
                      : t('settings.judge.keySave')}
                </button>
              </div>
              {acctJustSaved && (
                <p className="mt-1 text-[11px] text-green-600 dark:text-green-400">
                  {t('settings.judge.keySaved')}
                </p>
              )}
              {acctError && (
                <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                  {t('settings.judge.keySaveFailed', { error: acctError })}
                </p>
              )}
              {envVars.length > 0 && (
                <p className="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                  {t('settings.judge.keyEnvHint', { vars: envVars.join(', ') })}
                </p>
              )}
            </div>
          )}

          {/* Model catalog of this provider (empty choice removes it from the chain).
              Input-vs-Select is decided by the RAW catalog only — merging the
              current value into a NON-empty catalog is fine, but pushing it into
              an empty one must not flip the free-text Input to a Select
              mid-keystroke (that steals focus after the first character). */}
          {models.length > 0 ? (
            <Select
              label={modelLabel}
              value={model}
              onChange={(e) => onSelectModel(e.target.value)}
              options={[
                { value: '', label: `— ${modelLabel} —` },
                ...modelOptions.map((m) => ({
                  value: m.id,
                  label: `${m.id}${m.free ? ` · ${freeBadge}` : ''}`,
                })),
              ]}
            />
          ) : (
            <Input
              label={modelLabel}
              value={model}
              onChange={(e) => onSelectModel(e.target.value)}
              placeholder="e.g. jev-1.13"
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Preserved hand-edited tier ref that maps to none of the 5 builtin providers. */
function OpaqueJudgeRow({ refText, index }: { refText: string; index: number }) {
  const { t } = useTranslation('common');
  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-2.5 py-2 dark:border-neutral-800 dark:bg-neutral-900">
      <span className="w-4 shrink-0" />
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-[10px] font-bold text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
        {index + 1}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-600 dark:text-neutral-300">
        {refText}
      </span>
      <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-400 dark:bg-neutral-800 dark:text-neutral-500">
        {t('settings.judge.preserved')}
      </span>
    </div>
  );
}

/**
 * One custom relay judge (judge.judges entry) as a draggable chain row: grip
 * handle + position number + readiness dot (green when the entry has name +
 * baseUrl) + entry name (dimmed "unnamed" while blank) + model chip
 * (entry.model || 'jev-latest'). A row missing name or baseUrl shows the
 * notInChain tag — it cannot judge. The expandable body holds the entry
 * editor fields (same set as the former separate section) plus the remove
 * button.
 */
function JudgeChainJudgesRow({
  id,
  entry,
  index,
  primary,
  expanded,
  onToggle,
  onChange,
  onRemove,
}: {
  id: string;
  entry: CustomJudgeEntry;
  index: number;
  primary: boolean;
  expanded: boolean;
  onToggle: () => void;
  onChange: (next: CustomJudgeEntry) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('common');
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const usable = judgesEntryUsable(entry);
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Ghost while dragging: the DragOverlay clone is what the user sees.
    opacity: isDragging ? 0.3 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-lg border transition-colors ${
        primary
          ? 'border-blue-500 bg-blue-50/40 dark:border-blue-500 dark:bg-blue-950/25'
          : 'border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900'
      }`}
    >
      {/* Header — grip drags, row body click toggles the group */}
      <div className="flex items-center gap-1.5 px-2.5 py-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="shrink-0 cursor-grab touch-none text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
          title={t('settings.websearch.dragToReorder')}
        >
          <GripVertical size={16} />
        </button>
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
            primary
              ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
              : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'
          }`}
        >
          {index + 1}
        </span>
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2.5 py-1 text-left transition-colors"
        >
          <ChevronRight
            size={14}
            className={`shrink-0 text-neutral-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              usable ? 'bg-green-500' : 'bg-neutral-300 dark:bg-neutral-600'
            }`}
          />
          <span
            className={`truncate text-[13px] font-medium ${
              primary
                ? 'text-blue-700 dark:text-blue-300'
                : 'text-neutral-700 dark:text-neutral-200'
            }`}
          >
            {entry.name.trim() !== '' ? (
              entry.name
            ) : (
              <span className="text-neutral-400 dark:text-neutral-500">
                {t('settings.judge.customJudgeUnnamed')}
              </span>
            )}
          </span>
          {primary && (
            <span className="shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
              {t('settings.judge.primaryJudge')}
            </span>
          )}
          {!usable && (
            <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-400 dark:bg-neutral-800 dark:text-neutral-500">
              {t('settings.judge.notInChain')}
            </span>
          )}
          <span className="ml-auto shrink-0 font-mono text-[10px] text-neutral-500 dark:text-neutral-400">
            {entry.model.trim() || 'jev-latest'}
          </span>
        </button>
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-neutral-100 px-3 py-3 dark:border-neutral-800">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Input
              label={t('settings.judge.customJudgeNameLabel')}
              value={entry.name}
              onChange={(e) => onChange({ ...entry, name: e.target.value })}
              className="text-xs"
            />
            <Select
              label={t('settings.judge.customJudgeTypeLabel')}
              value={entry.type}
              onChange={(e) =>
                onChange({ ...entry, type: e.target.value === 'http' ? 'http' : 'typesafe' })
              }
              options={[
                { value: 'typesafe', label: 'Typesafe' },
                { value: 'http', label: 'HTTP(S) relay' },
              ]}
            />
            <Input
              label={t('settings.judge.customJudgeBaseUrlLabel')}
              value={entry.baseUrl}
              onChange={(e) => onChange({ ...entry, baseUrl: e.target.value })}
              placeholder="https://relay.example.com"
              className="text-xs"
            />
            <Input
              label={t('settings.judge.customJudgeApiKeyEnvLabel')}
              value={entry.apiKeyEnv}
              onChange={(e) => onChange({ ...entry, apiKeyEnv: e.target.value })}
              placeholder="e.g. MY_RELAY_API_KEY"
              className="text-xs"
            />
            <Input
              label={t('settings.judge.customJudgeModelLabel')}
              value={entry.model}
              onChange={(e) => onChange({ ...entry, model: e.target.value })}
              placeholder="jev-latest"
              className="text-xs"
            />
            <div className="flex items-end justify-end">
              <button
                type="button"
                onClick={onRemove}
                className="flex shrink-0 items-center justify-center rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/40"
                title={t('settings.judge.customJudgeRemove')}
              >
                <X size={16} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ModeRow({ label, desc }: { label: string; desc: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[13px] font-medium text-neutral-700 dark:text-neutral-200">{label}</p>
      <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-neutral-400">{desc}</p>
    </div>
  );
}

/* ───────── Main component ───────── */

export default function JudgeSettings({ registerActions, onDirtyChange }: JudgeSettingsProps) {
  const { t } = useTranslation('common');
  const { showToast } = useToast();

  /* ── Server state ── */
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [payload, setPayload] = useState<JudgeConfigPayload | null>(null);

  /* ── Draft (deferred save) ── */
  const [draft, setDraft] = useState<JudgeDraft | null>(null);
  const [synced, setSynced] = useState<JudgeDraft | null>(null);

  /* ── UI state ── */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestDisplay | null>(null);

  const unavailable = loadFailed || (payload !== null && payload.available === false);

  const fetchJudgeConfig = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const data = await apiRequest<JudgeConfigPayload>('/api/judge/config');
      const cfg = normalizeJudgeConfigPayload(data && typeof data === 'object' ? data : {});
      const next = draftFromPayload(cfg);
      setPayload(cfg);
      setLoadFailed(false);
      setDraft(next);
      setSynced(next);
    } catch {
      setPayload(null);
      setLoadFailed(true);
      setDraft(null);
      setSynced(null);
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchJudgeConfig();
  }, [fetchJudgeConfig]);

  const dirty = useMemo(
    () => !!draft && !!synced && JSON.stringify(draft) !== JSON.stringify(synced),
    [draft, synced],
  );
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  /* Report dirty state upward so the shared Save button enables. */
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  /* ── Save / cancel (registered with ModelSettings via refs) ── */

  const performSave = useCallback(
    async (opts?: { silent?: boolean }) => {
      const cur = draftRef.current;
      if (!cur || !dirtyRef.current) return;
      /* Custom relay judges: blank-name entries are dropped silently; a named
         entry without a Base URL blocks the save with an error toast. */
      const named = cur.judges.filter((j) => j.name.trim() !== '');
      const missingBaseUrl = named.find((j) => j.baseUrl.trim() === '');
      if (missingBaseUrl) {
        showToast(
          t('settings.judge.customJudgeNeedsBaseUrl', { name: missingBaseUrl.name.trim() }),
          'error',
        );
        return;
      }
      const judges: Record<string, Record<string, string>> = {};
      for (const j of named) {
        const out: Record<string, string> = { type: j.type, baseUrl: j.baseUrl.trim() };
        if (j.apiKeyEnv.trim() !== '') out.apiKeyEnv = j.apiKeyEnv.trim();
        if (j.model.trim() !== '') out.model = j.model.trim();
        judges[j.name.trim()] = out;
      }
      try {
        await apiRequest('/api/judge/config', {
          method: 'POST',
          body: JSON.stringify({
            enabled: cur.enabled,
            provider: cur.provider,
            modelRef: cur.modelRef,
            fallbackTiers: cur.fallbackTiers,
            modes: cur.modes,
            judges,
          }),
        });
        // Re-read the persisted config so key status / model enums stay fresh;
        // also resets the draft to synced (same pattern as useConfigDirty).
        await fetchJudgeConfig({ silent: true });
        if (!opts?.silent) showToast(t('settings.saved'), 'success');
      } catch (e) {
        if (!opts?.silent) showToast(t('settings.saveError'), 'error');
        throw e instanceof Error ? e : new Error(errorToMessage(e));
      }
    },
    [fetchJudgeConfig, showToast, t],
  );

  const performCancel = useCallback(() => {
    setTestError(null);
    setTestResult(null);
    if (synced) setDraft(synced);
  }, [synced]);

  const saveRef = useRef(performSave);
  saveRef.current = performSave;
  const cancelRef = useRef(performCancel);
  cancelRef.current = performCancel;

  useEffect(() => {
    registerActions?.({
      save: (opts) => saveRef.current(opts),
      cancel: () => cancelRef.current(),
    });
    return () => registerActions?.(null);
  }, [registerActions]);

  /* ── Draft mutations ── */

  const updateDraft = useCallback((patch: Partial<JudgeDraft>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const setMode = useCallback((key: string, mode: JudgeMode) => {
    setDraft((prev) => (prev ? { ...prev, modes: { ...prev.modes, [key]: mode } } : prev));
  }, []);

  /* ── Expanded chain row (provider or judges entry; default collapsed) ── */
  const [openRow, setOpenRow] = useState<string | null>(null);
  /* ── Drag preview: a static DragOverlay clone (prevents mid-drag layout/
     transform artifacts on the original row) ── */
  const [dragActiveId, setDragActiveId] = useState<string | null>(null);

  /* ── Judge chain (derived from the draft on every render) ── */

  const chain = useMemo(() => (draft ? deriveChainRows(draft) : null), [draft]);
  const chainRows = chain?.rows ?? [];
  const chainOpaque = chain?.opaque ?? [];
  /** First usable row (provider with a model, or judges entry with name + baseUrl). */
  const primaryId =
    chainRows.find((r) => (r.kind === 'provider' ? r.model !== '' : judgesEntryUsable(r.entry)))
      ?.id ?? null;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /** Drag reorder across provider and judges rows; opaque refs stay pinned last. */
  const handleChainDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setDragActiveId(null);
    if (!over || active.id === over.id) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const { rows, opaque } = deriveChainRows(prev);
      const oldIndex = rows.findIndex((r) => r.id === active.id);
      const newIndex = rows.findIndex((r) => r.id === over.id);
      if (oldIndex < 0 || newIndex < 0) return prev;
      return {
        ...prev,
        ...chainWriteBack(arrayMove(rows, oldIndex, newIndex), opaque, prev),
      };
    });
  }, []);

  /** Select / clear a provider's model ('' → provider leaves the chain). */
  const setChainModel = useCallback((providerId: string, model: string) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const { rows, opaque } = deriveChainRows(prev);
      const nextRows = rows.map((r) =>
        r.kind === 'provider' && r.provider === providerId ? { ...r, model } : r,
      );
      return { ...prev, ...chainWriteBack(nextRows, opaque, prev) };
    });
  }, []);

  /* ── Test ── */

  const runTest = useCallback(async () => {
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    const startedAt = Date.now();
    try {
      const data = await apiRequest<unknown>('/api/judge/test', {
        method: 'POST',
        body: JSON.stringify({}),
        timeoutMs: 20_000,
      });
      setTestResult(normalizeTest(data, startedAt));
    } catch (e) {
      setTestResult(null);
      setTestError(errorToMessage(e));
    } finally {
      setTesting(false);
    }
  }, []);

  /* ── Derived render data ── */

  const keyStatus = useMemo(() => extractKeyStatus(payload ?? {}), [payload]);

  const setJudgeEntry = useCallback((index: number, next: CustomJudgeEntry) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const judges = prev.judges.map((j, i) => (i === index ? next : j));
      // Re-write the chain refs too: an entry that just became usable (name +
      // Base URL filled) joins the chain at its list position — display order
      // always equals execution order.
      const { rows, opaque } = deriveChainRows({ ...prev, judges });
      return { ...prev, judges, ...chainWriteBack(rows, opaque, prev) };
    });
  }, []);

  const removeJudgeEntry = useCallback((index: number) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const judges = prev.judges.filter((_, i) => i !== index);
      // Re-derive so the removed entry's chain ref is dropped with it.
      const { rows, opaque } = deriveChainRows({ ...prev, judges });
      return { ...prev, judges, ...chainWriteBack(rows, opaque, prev) };
    });
  }, []);

  const addJudgeEntry = useCallback(() => {
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            judges: [
              ...prev.judges,
              {
                name: '',
                type: 'typesafe' as const,
                baseUrl: '',
                apiKeyEnv: '',
                model: 'jev-latest',
              },
            ],
          }
        : prev,
    );
  }, []);

  /* ── Render ── */

  if (loading && !draft)
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );

  if (unavailable) {
    return (
      <SettingsCard>
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-900/20">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
            {t('settings.judge.unavailableTitle')}
          </p>
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
            {t('settings.judge.unavailableDesc')}
          </p>
        </div>
      </SettingsCard>
    );
  }
  if (!draft) {
    return <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('common.error')}</p>;
  }

  const disabledRest = !draft.enabled;

  return (
    <div className="space-y-6">
      {/* ── Enable switch ── */}
      <SettingsCard>
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
            {t('settings.judge.enabledLabel')}
          </p>
          <Toggle
            checked={draft.enabled}
            onChange={(v) => updateDraft({ enabled: v })}
            ariaLabel={t('settings.judge.enabledLabel')}
          />
        </div>
        {!draft.enabled && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-900/20">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
              {t('settings.judge.inactiveTitle')}
            </p>
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
              {t('settings.judge.inactiveDesc')}
            </p>
          </div>
        )}
      </SettingsCard>

      {/* Everything below is inert while the kernel is disabled (config still editable for save). */}
      <div className={`space-y-6 ${disabledRest ? 'pointer-events-none opacity-50' : ''}`}>
        {/* ── Drag-sortable judge chain (providers + custom relay judges as peers) ── */}
        <SettingsSection title={t('settings.judge.providerAndModel')}>
          <SettingsCard>
            <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
              {t('settings.judge.chainHint')}
            </p>
            <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
              {t('settings.judge.customJudgesHint')}
            </p>
            <div className="space-y-2">
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragStart={(e) => setDragActiveId(String(e.active.id))}
                onDragCancel={() => setDragActiveId(null)}
                onDragEnd={handleChainDragEnd}
              >
                <SortableContext
                  items={chainRows.map((r) => r.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {chainRows.map((row, idx) =>
                    row.kind === 'provider' ? (
                      <JudgeChainRow
                        key={row.id}
                        providerId={row.provider}
                        index={idx}
                        model={row.model}
                        primary={primaryId === row.id}
                        keyStatus={keyStatus[row.provider]}
                        modelLabel={t('settings.judge.modelLabel')}
                        freeBadge={t('settings.judge.freeBadge')}
                        models={extractModelOptions(payload, row.provider)}
                        expanded={openRow === row.id}
                        onToggle={() => setOpenRow((prev) => (prev === row.id ? null : row.id))}
                        onSelectModel={(model) => setChainModel(row.provider, model)}
                        onKeySaved={() => {
                          void fetchJudgeConfig({ silent: true });
                        }}
                      />
                    ) : (
                      <JudgeChainJudgesRow
                        key={row.id}
                        id={row.id}
                        entry={row.entry}
                        index={idx}
                        primary={primaryId === row.id}
                        expanded={openRow === row.id}
                        onToggle={() => setOpenRow((prev) => (prev === row.id ? null : row.id))}
                        onChange={(next) => setJudgeEntry(row.entryIndex, next)}
                        onRemove={() => removeJudgeEntry(row.entryIndex)}
                      />
                    ),
                  )}
                </SortableContext>
                {/* Static drag preview: a fixed-size header snapshot of the dragged
                    row — the original row ghosts (opacity 0.3) underneath. */}
                <DragOverlay>
                  {dragActiveId &&
                    (() => {
                      const row = chainRows.find((r) => r.id === dragActiveId);
                      if (!row) return null;
                      const name =
                        row.kind === 'provider'
                          ? t(`settings.judge.providers.${row.provider}`)
                          : row.entry.name.trim() !== ''
                            ? row.entry.name
                            : t('settings.judge.customJudgeUnnamed');
                      const chip =
                        row.kind === 'provider'
                          ? row.model || t('settings.judge.notInChain')
                          : judgesEntryUsable(row.entry)
                            ? row.entry.model.trim() || 'jev-latest'
                            : t('settings.judge.notInChain');
                      return (
                        <div className="flex w-[440px] max-w-[85vw] items-center gap-2 rounded-lg border border-blue-500 bg-white px-2.5 py-2 shadow-lg dark:border-blue-500 dark:bg-neutral-900">
                          <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" />
                          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-800 dark:text-neutral-100">
                            {name}
                          </span>
                          <span className="shrink-0 truncate font-mono text-[10px] text-neutral-500 dark:text-neutral-400">
                            {chip}
                          </span>
                        </div>
                      );
                    })()}
                </DragOverlay>
              </DndContext>
              {chainOpaque.map((ref, i) => (
                <OpaqueJudgeRow key={ref} refText={ref} index={chainRows.length + i} />
              ))}
              <button
                type="button"
                onClick={addJudgeEntry}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-neutral-300 bg-transparent px-4 py-2.5 text-sm text-neutral-600 hover:border-neutral-400 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600 dark:hover:text-neutral-200"
              >
                <Plus size={16} />
                {t('settings.judge.customJudgeAdd')}
              </button>
            </div>
          </SettingsCard>
        </SettingsSection>

        {/* ── Golden-sample test ── */}
        <SettingsSection title={t('settings.judge.testSection')}>
          <SettingsCard>
            <div className="flex items-center justify-between gap-4">
              <p className="text-[13px] text-neutral-600 dark:text-neutral-400">
                {t('settings.judge.testDesc')}
              </p>
              <button
                type="button"
                onClick={runTest}
                disabled={testing}
                className="shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {testing ? t('settings.judge.testing') : t('settings.judge.testButton')}
              </button>
            </div>
            {dirty && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                {t('settings.judge.testDirtyHint')}
              </p>
            )}
            {testError && (
              <p className="text-xs text-red-600 dark:text-red-400">
                {t('settings.judge.testFailed', { error: testError })}
              </p>
            )}
            {testResult && (
              <div className="space-y-1.5 rounded-lg border border-neutral-100 dark:border-neutral-800 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] text-neutral-600 dark:text-neutral-400">
                    {t('settings.judge.testLatency')}
                  </span>
                  <span className="font-mono text-xs text-neutral-800 dark:text-neutral-200">
                    {testResult.latencyMs}ms
                  </span>
                </div>
                {testResult.answers.map((answer) => (
                  <div
                    key={answer.kind}
                    className="flex items-center justify-between border-t border-neutral-100 dark:border-neutral-800 pt-1.5"
                  >
                    <span className="text-[13px] text-neutral-600 dark:text-neutral-400">
                      {answer.kind === 'choice' && t('settings.judge.answerChoice')}
                      {answer.kind === 'noul' && t('settings.judge.answerNoul')}
                      {answer.kind === 'score' && t('settings.judge.answerScore')}
                    </span>
                    <span className="font-mono text-xs text-neutral-800 dark:text-neutral-200">
                      {answer.kind === 'choice' &&
                        `${answer.winner ?? '—'}${
                          answer.confidence !== undefined
                            ? ` · ${t('settings.judge.answerConfidence')} ${(answer.confidence * 100).toFixed(0)}%`
                            : ''
                        }`}
                      {answer.kind === 'noul' &&
                        answer.probability !== undefined &&
                        `${t('settings.judge.answerProbability')} ${(answer.probability * 100).toFixed(0)}%`}
                      {answer.kind === 'score' &&
                        answer.score !== undefined &&
                        `${t('settings.judge.answerScoreValue')} ${answer.score}${
                          answer.confidence !== undefined
                            ? ` · ${t('settings.judge.answerConfidence')} ${(answer.confidence * 100).toFixed(0)}%`
                            : ''
                        }`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </SettingsCard>
        </SettingsSection>

        {/* ── Decision-point mode matrix (advanced, collapsible) ── */}
        <SettingsSection title={t('settings.judge.advancedSection')}>
          <SettingsCard>
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="flex items-center gap-1.5 text-sm font-medium text-neutral-700 transition-colors hover:text-neutral-900 dark:text-neutral-200 dark:hover:text-neutral-100"
            >
              {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {t('settings.judge.modesSection')}
            </button>
            {advancedOpen && (
              <div className="space-y-2 border-t border-neutral-100 pt-3 dark:border-neutral-800">
                <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  {t('settings.judge.modesHint')}
                </p>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <ModeRow
                    label={t('settings.judge.defaultMode')}
                    desc={t('settings.judge.defaultModeDesc')}
                  />
                  <ModeSegment
                    value={draft.modes['default'] ?? 'shadow'}
                    onChange={(m) => setMode('default', m)}
                  />
                </div>
                {JUDGE_POINT_IDS.map((id) => (
                  <div
                    key={id}
                    className="flex flex-col gap-2 border-t border-neutral-100 pt-2 dark:border-neutral-800 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <ModeRow
                      label={t(`settings.judge.points.${id.replace('.', '-')}.label`)}
                      desc={t(`settings.judge.points.${id.replace('.', '-')}.desc`)}
                    />
                    <ModeSegment
                      value={draft.modes[id] ?? 'shadow'}
                      onChange={(m) => setMode(id, m)}
                    />
                  </div>
                ))}
              </div>
            )}
          </SettingsCard>
        </SettingsSection>
      </div>
    </div>
  );
}
