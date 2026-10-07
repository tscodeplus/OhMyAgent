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
 * - POST /api/judge/config → persists the judge: section (yaml hot-reloaded).
 * - POST /api/judge/test   → golden sample (choice / noul / score), latency +
 *   the three answer shapes are shown tolerantly (missing fields → '—').
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { apiRequest } from '../../utils/api';
import { useToast } from '../ui/Toast';
import Toggle from '../ui/Toggle';
import Select from '../ui/Select';
import Input from '../ui/Input';
import PasswordInput from '../ui/PasswordInput';
import Spinner from '../ui/Spinner';
import FallbackModelsEditor from './FallbackModelsEditor';
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

/** 5 builtin judge providers + 'custom' (judges: section of config.yaml). */
const JUDGE_PROVIDER_IDS = [
  'opencode',
  'typesafe',
  'vercel-ai-gateway',
  'openrouter',
  'cloudflare-workers-ai',
  'custom',
] as const;
type JudgeProviderId = (typeof JUDGE_PROVIDER_IDS)[number];
const providerLabelKey = (id: string) =>
  `settings.judge.providers.${(JUDGE_PROVIDER_IDS as readonly string[]).includes(id) ? id : 'custom'}`;

/* Editable subset of the judge: config section. */
interface JudgeDraft {
  enabled: boolean;
  provider: string;
  modelRef: string;
  fallbackTiers: string[];
  modes: Record<string, JudgeMode>;
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
  /** Server envelope: GET /api/judge/config returns { config, models, keyStatus }. */
  config?: Partial<JudgeConfigPayload>;
  /** Either an array of { id, keyConfigured } or a map providerId → configured. */
  providers?: Array<{ id: string; keyConfigured?: boolean }> | Record<string, unknown>;
  keyConfigured?: Record<string, unknown>;
  /** Server shape: Record<provider, { envVars, fromConfig, envPresent, present }>. */
  keyStatus?: Record<string, { present?: boolean } | boolean>;
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

function extractKeyStatus(payload: JudgeConfigPayload): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  if (Array.isArray(payload.providers)) {
    for (const entry of payload.providers) {
      if (entry && typeof entry.id === 'string') map[entry.id] = !!entry.keyConfigured;
    }
  } else if (payload.providers && typeof payload.providers === 'object') {
    for (const [k, v] of Object.entries(payload.providers)) map[k] = !!v;
  } else if (payload.keyConfigured && typeof payload.keyConfigured === 'object') {
    for (const [k, v] of Object.entries(payload.keyConfigured)) map[k] = !!v;
  } else if (payload.keyStatus && typeof payload.keyStatus === 'object') {
    // Server envelope: Record<provider, { present }> or Record<provider, boolean>.
    for (const [k, v] of Object.entries(payload.keyStatus)) {
      map[k] = typeof v === 'boolean' ? v : !!v?.present;
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

function extractModelOptions_placeholder() {} // removed below
/**
 * One judge provider group: header (status dot + label + current model) that is
 * collapsed by default; the body holds the API key editor and the provider's
 * model catalog. Selecting a model in a group makes it the judge provider.
 */
function JudgeProviderGroup({
  providerId,
  selected,
  currentModel,
  keyOk,
  envVars,
  modelLabel,
  freeBadge,
  models,
  expanded,
  onToggle,
  onSelectModel,
  onKeySaved,
}: {
  providerId: string;
  selected: boolean;
  currentModel: string;
  keyOk: boolean;
  envVars: string[];
  modelLabel: string;
  freeBadge: string;
  models: JudgeModelOption[];
  expanded: boolean;
  onToggle: () => void;
  onSelectModel: (model: string) => void;
  onKeySaved: () => void;
}) {
  const { t } = useTranslation('common');
  const [keyDraft, setKeyDraft] = useState('');
  const [keySaving, setKeySaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyJustSaved, setKeyJustSaved] = useState(false);

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

  return (
    <div
      className={`rounded-lg border transition-colors ${
        selected
          ? 'border-blue-500 bg-blue-50/40 dark:border-blue-500 dark:bg-blue-950/25'
          : 'border-neutral-200 dark:border-neutral-800'
      }`}
    >
      {/* Header — always visible, row click toggles the group */}
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors"
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
          className={`flex-1 truncate text-[13px] font-medium ${
            selected ? 'text-blue-700 dark:text-blue-300' : 'text-neutral-700 dark:text-neutral-200'
          }`}
        >
          {t(providerLabelKey(providerId))}
        </span>
        {selected && currentModel && (
          <span className="shrink-0 font-mono text-[10px] text-neutral-500 dark:text-neutral-400">
            {currentModel}
          </span>
        )}
        {keyOk && (
          <span className="shrink-0 text-[10px] text-green-600 dark:text-green-400">
            {t('settings.judge.keyConfigured')}
          </span>
        )}
      </button>

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

          {/* Model catalog of this provider (selecting one makes it the judge) */}
          {models.length > 0 ? (
            <Select
              label={modelLabel}
              value={selected ? currentModel : ''}
              onChange={(e) => onSelectModel(e.target.value)}
              options={[
                { value: '', label: `— ${modelLabel} —` },
                ...models.map((m) => ({
                  value: m.id,
                  label: `${m.id}${m.free ? ` · ${freeBadge}` : ''}`,
                })),
              ]}
            />
          ) : (
            <Input
              label={modelLabel}
              value={selected ? currentModel : ''}
              onChange={(e) => onSelectModel(e.target.value)}
              placeholder="e.g. jev-1.13"
            />
          )}
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
      try {
        await apiRequest('/api/judge/config', {
          method: 'POST',
          body: JSON.stringify({
            enabled: cur.enabled,
            provider: cur.provider,
            modelRef: cur.modelRef,
            fallbackTiers: cur.fallbackTiers,
            modes: cur.modes,
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

  /* ── Provider groups (default collapsed) ── */

  const [openProvider, setOpenProvider] = useState<string | null>(null);

  /** Env var names per provider from the server keyStatus envelope ([] fallback). */
  const providerEnvVars = useCallback(
    (id: string): string[] => {
      const raw = (payload?.keyStatus ?? {}) as Record<string, { envVars?: unknown }>;
      const v = raw[id];
      return Array.isArray(v?.envVars) ? (v.envVars as string[]) : [];
    },
    [payload],
  );

  /* ── Derived render data ── */

  const keyStatus = useMemo(() => extractKeyStatus(payload ?? {}), [payload]);
  const modelOptions = useMemo(
    () => (draft ? extractModelOptions(payload, draft.provider) : []),
    [payload, draft],
  );
  const selectedModel = modelOptions.find((m) => m.id === draft?.modelRef);
  // Free tier: flagged by the config endpoint, or id suffix if the enum is absent.
  const isFreeModel =
    draft?.modelRef != null &&
    draft.modelRef !== '' &&
    (selectedModel?.free === true || draft.modelRef.endsWith('-free'));

  /* ── Render ── */

  if (loading && !draft)
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );

  if (unavailable) {
    return (
      <SettingsSection title={t('settings.judge.title')}>
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
      </SettingsSection>
    );
  }
  if (!draft) {
    return <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('common.error')}</p>;
  }

  const disabledRest = !draft.enabled;

  return (
    <div className="space-y-6">
      {/* ── Enable switch ── */}
      <SettingsSection title={t('settings.judge.title')}>
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
      </SettingsSection>

      {/* Everything below is inert while the kernel is disabled (config still editable for save). */}
      <div className={`space-y-6 ${disabledRest ? 'pointer-events-none opacity-50' : ''}`}>
        {/* ── Provider selector with per-provider key status ── */}
        <SettingsSection title={t('settings.judge.providerAndModel')}>
          <SettingsCard>
            <div className="space-y-1.5">
              {JUDGE_PROVIDER_IDS.map((id) => (
                <JudgeProviderGroup
                  key={id}
                  providerId={id}
                  selected={draft.provider === id}
                  currentModel={draft.provider === id ? draft.modelRef : ''}
                  keyOk={keyStatus[id] === true}
                  envVars={providerEnvVars(id)}
                  modelLabel={t('settings.judge.modelLabel')}
                  freeBadge={t('settings.judge.freeBadge')}
                  models={extractModelOptions(payload, id)}
                  expanded={openProvider === id}
                  onToggle={() => setOpenProvider((prev) => (prev === id ? null : id))}
                  onSelectModel={(model) => updateDraft({ provider: id, modelRef: model })}
                  onKeySaved={() => {
                    void fetchJudgeConfig({ silent: true });
                  }}
                />
              ))}
            </div>
            {isFreeModel && (
              <p className="mt-3 text-[11px] text-amber-600 dark:text-amber-400">
                {t('settings.judge.freeNote')}
              </p>
            )}
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

        {/* ── Fallback judge chain (judge.fallbackTiers) ── */}
        <SettingsSection title={t('settings.judge.fallbackSection')}>
          <SettingsCard>
            <FallbackModelsEditor
              value={draft.fallbackTiers}
              onChange={(v) => updateDraft({ fallbackTiers: v })}
            />
            <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
              {t('settings.judge.fallbackHint')}
            </p>
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
