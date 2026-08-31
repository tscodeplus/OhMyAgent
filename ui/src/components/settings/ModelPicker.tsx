import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, ChevronDown, Check, Zap, AlertCircle, Loader2, RefreshCw } from 'lucide-react';
import { apiRequest } from '../../utils/api';
import Select from '../ui/Select';

/* ───────── Types ───────── */

export interface ModelInfo {
  id: string;
  name: string;
  api: string;
  baseUrl?: string;
  reasoning: boolean;
  input: string[];
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
}

export interface ProviderOption {
  value: string;
  label: string;
  baseUrl?: string;
}

export interface ModelPickerProps {
  provider: string;
  model: string;
  fallbackProviders?: ProviderOption[];
  /** Extra provider options appended after the builtin list (e.g. custom providers) */
  extraProviders?: ProviderOption[];
  onChangeProvider: (provider: string) => void;
  onChangeModel: (model: string) => void;
  onModelMeta?: (meta: ModelInfo | null) => void;
  providerLabel?: string;
  modelLabel?: string;
  modelPlaceholder?: string;
  showTestButton?: boolean;
  onTestConnection?: () => Promise<boolean>;
  /** Hide the metadata badges (reasoning / context window / api) under the selected model */
  showMetaBadges?: boolean;
  /** List of provider IDs that have API keys configured — shows status dots in the provider dropdown */
  configuredProviders?: string[];
  /** Optional node rendered at the far right of the provider row (e.g. a remove button) */
  providerRowTrailing?: React.ReactNode;
  /** Compact variant: tighter spacing and input padding */
  dense?: boolean;
  className?: string;
}

/* ───────── Helpers ───────── */

function formatContextWindow(win?: number): string {
  if (!win) return '';
  if (win >= 1_000_000) return `${(win / 1_000_000).toFixed(1)}M`;
  if (win >= 1_000) return `${(win / 1_000).toFixed(0)}K`;
  return String(win);
}

export default function ModelPicker({
  provider,
  model,
  fallbackProviders = [],
  extraProviders = [],
  onChangeProvider,
  onChangeModel,
  onModelMeta,
  providerLabel,
  modelLabel,
  modelPlaceholder,
  showTestButton = false,
  onTestConnection,
  showMetaBadges = true,
  configuredProviders,
  dense = false,
  providerRowTrailing,
  className = '',
}: ModelPickerProps) {
  const { t } = useTranslation('common');

  // Provider list fetched once on mount; derived `providers` below merges extras.
  const [apiProviders, setApiProviders] = useState<ProviderOption[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [manualRefresh, setManualRefresh] = useState(false);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Set while we programmatically focus the input (on open) so onFocus doesn't wipe typed text.
  const programmaticFocus = useRef(false);
  // Outcome of the last manual (live) refresh: 'ok' | 'failed' | null. Shown as a
  // hint so the user knows whether the live fetch succeeded or fell back to the
  // static catalog.
  const [liveResult, setLiveResult] = useState<'ok' | 'failed' | null>(null);
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  /* Fetch provider list once on mount. Using a mount-only effect (not depending on
     fallbackProviders/extraProviders identity) avoids a re-fetch-on-every-render loop
     when a parent passes a fresh array each render. */
  useEffect(() => {
    let cancelled = false;
    apiRequest<{ providers: Array<{ id: string; name: string; baseUrl?: string }> }>('/api/providers')
      .then(data => {
        if (!cancelled) {
          setApiProviders(data.providers.map(p => ({ value: p.id, label: p.name, baseUrl: p.baseUrl })));
        }
      })
      .catch(() => {
        if (!cancelled) setApiProviders(fallbackProviders);
      });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const providers = useMemo(
    () => [...apiProviders, ...extraProviders],
    [apiProviders, extraProviders],
  );

  /* Fetch models for a given provider */
  const fetchModels = useCallback((providerId: string, isManual = false) => {
    if (!providerId) return;
    setLoadingModels(true);
    // Only blank for the automatic (static) fetch; a manual live refresh should
    // keep the already-loaded catalog visible on failure/empty.
    if (!isManual) {
      setModels([]);
      onModelMeta?.(null);
    } else {
      if (liveTimer.current) clearTimeout(liveTimer.current);
      setLiveResult(null);
    }
    if (isManual) setManualRefresh(true);

    // Use live endpoint for manual refresh, static endpoint otherwise
    const endpoint = isManual ? `/api/providers/${encodeURIComponent(providerId)}/models/live` : `/api/providers/${encodeURIComponent(providerId)}/models`;

    apiRequest<{ provider: string; models: ModelInfo[]; live?: boolean }>(endpoint)
      .then(data => {
        // Manual (live) refresh returned nothing usable → keep the static catalog
        // and flag the failure so the UI can show a hint.
        if (isManual && (!data.models || data.models.length === 0)) {
          setLiveResult('failed');
          return;
        }
        setModels(data.models);
        const found = data.models.find(m => m.id === model);
        if (found) onModelMeta?.(found);
        if (isManual) setLiveResult('ok');
      })
      .catch(() => {
        // Live refresh failure: keep the static catalog visible.
        if (!isManual) setModels([]);
        else setLiveResult('failed');
      })
      .finally(() => {
        setLoadingModels(false);
        if (isManual) {
          setTimeout(() => setManualRefresh(false), 1500);
          if (liveTimer.current) clearTimeout(liveTimer.current);
          liveTimer.current = setTimeout(() => setLiveResult(null), 4000);
        }
      });
  }, [model, onModelMeta]);

  /* Fetch models when provider changes */
  useEffect(() => {
    fetchModels(provider);
  }, [provider]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Auto-select first provider when provider is empty */
  useEffect(() => {
    if (!provider && providers.length > 0) {
      const firstAvailable = configuredProviders
        ? providers.find(p => configuredProviders.includes(p.value))
        : providers[0];
      if (firstAvailable) {
        onChangeProvider(firstAvailable.value);
      }
    }
  }, [provider, providers, configuredProviders, onChangeProvider]);

  /* Close combobox on outside click */
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (open) {
      programmaticFocus.current = true;
      searchRef.current?.focus();
      programmaticFocus.current = false;
    }
  }, [open]);

  const filteredModels = useMemo(() => {
    if (!search.trim()) return models;
    const q = search.toLowerCase();
    return models.filter(m => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  }, [models, search]);

  const selectedModel = models.find(m => m.id === model);

  const handleSelectModel = useCallback((m: ModelInfo) => {
    onChangeModel(m.id);
    onModelMeta?.(m);
    setOpen(false);
    setSearch('');
    setTestResult(null);
  }, [onChangeModel, onModelMeta]);

  const handleCustomModel = useCallback((value: string) => {
    onChangeModel(value);
    const found = models.find(m => m.id === value);
    onModelMeta?.(found || null);
    setTestResult(null);
  }, [onChangeModel, models, onModelMeta]);

  const handleTest = useCallback(async () => {
    if (!onTestConnection) return;
    setTesting(true);
    setTestResult(null);
    try {
      const ok = await onTestConnection();
      setTestResult({ ok, message: ok ? t('settings.models.testSuccess') : t('settings.models.testFailed') });
    } catch (e) {
      setTestResult({ ok: false, message: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }, [onTestConnection, t]);

  return (
    <div className={`${dense ? 'space-y-3 sm:space-y-1.5' : 'space-y-3'} ${className}`}>
      {/* Provider select with refresh button */}
      <div className="flex items-end gap-2">
        <div className="flex-1 min-w-0">
          <Select
            label={providerLabel}
            dense={dense}
            value={provider}
            onChange={e => onChangeProvider(e.target.value)}
            options={providers
              .filter(p => !configuredProviders || configuredProviders.includes(p.value) || p.value === provider)
              .map(p => ({
                value: p.value,
                label: configuredProviders?.includes(p.value)
                  ? `${p.label} ✓`
                  : p.label,
              }))}
          />
        </div>
        <button
          type="button"
          onClick={() => fetchModels(provider, true)}
          onMouseDown={(e) => e.stopPropagation()}
          disabled={!provider || loadingModels}
          className="shrink-0 flex items-center gap-1.5 px-3 py-2.5 text-xs rounded-lg border border-neutral-300 bg-white text-neutral-600 hover:bg-neutral-50 hover:border-neutral-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors dark:border-neutral-800 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
          title={t('settings.models.fetchModels')}
        >
          {loadingModels ? (
            <Loader2 size={14} className="animate-spin" />
          ) : liveResult === 'ok' ? (
            <Check size={14} className="text-green-500" />
          ) : liveResult === 'failed' ? (
            <AlertCircle size={14} className="text-amber-500" />
          ) : (
            <RefreshCw size={14} className={manualRefresh ? 'text-green-500' : ''} />
          )}
          <span className="hidden sm:inline">
            {liveResult === 'ok'
              ? t('settings.models.liveFetched')
              : liveResult === 'failed'
                ? t('settings.models.liveFetchFailed')
                : t('settings.models.fetchModels')}
          </span>
        </button>
        {providerRowTrailing && (
          <div className="self-start sm:-mt-1">{providerRowTrailing}</div>
        )}
      </div>
      {liveResult === 'failed' && (
        <p className="flex items-center gap-1.5 mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertCircle size={12} className="shrink-0" />
          {t('settings.models.liveFetchFailedHint')}
        </p>
      )}

      {/* Model combobox with editable input */}
      <div ref={containerRef} className="relative">
        {modelLabel && (
          <label className={`block text-[13px] font-medium text-neutral-700 dark:text-neutral-300 ${dense ? 'mb-1.5 sm:mb-1' : 'mb-1.5'}`}>
            {modelLabel}
          </label>
        )}
        <div className="flex items-center w-full rounded-lg border border-neutral-300 bg-white dark:border-neutral-800 dark:bg-neutral-800">
          <input
            type="text"
            value={open ? search : (selectedModel?.name || model || '')}
            onChange={e => {
              if (!open) setOpen(true);
              setSearch(e.target.value);
            }}
            onFocus={() => {
              setOpen(true);
              // Only clear on a genuine user focus, not the programmatic focus
              // triggered by the open effect (which would erase typed text).
              if (!programmaticFocus.current) setSearch('');
            }}
            placeholder={modelPlaceholder || t('settings.models.customModelPlaceholder')}
            className={`flex-1 px-3 text-sm text-neutral-900 placeholder:text-neutral-400 bg-transparent focus:outline-none dark:text-neutral-100 ${dense ? 'py-2.5 sm:py-2' : 'py-2.5'}`}
          />
          {loadingModels ? (
            <Loader2 size={14} className="animate-spin text-neutral-400 mr-3" />
          ) : (
            <button
              type="button"
              onClick={() => {
                const next = !open;
                setOpen(next);
                if (next) setSearch('');
              }}
              className="px-2 py-2.5 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            >
              <ChevronDown size={14} />
            </button>
          )}
        </div>

        {/* Custom model indicator */}
        {model && !selectedModel && (
          <div className="flex items-center gap-1.5 mt-1.5">
            <AlertCircle size={12} className="text-amber-500" />
            <span className="text-[11px] text-amber-600 dark:text-amber-400">{t('settings.models.customModel')}: {model}</span>
          </div>
        )}

        {/* Metadata badges for the selected known model */}
        {showMetaBadges && selectedModel && (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {selectedModel.reasoning && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
                <Zap size={10} /> {t('settings.models.reasoning')}
              </span>
            )}
            {selectedModel.contextWindow && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                {formatContextWindow(selectedModel.contextWindow)} tokens
              </span>
            )}
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] bg-neutral-100 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
              {selectedModel.api}
            </span>
          </div>
        )}

        {/* Dropdown */}
        {open && (
          <div className="absolute z-50 mt-1 w-full rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-neutral-800 dark:bg-neutral-800 max-h-72 flex flex-col">
            <div className="overflow-y-auto flex-1">
              {filteredModels.length === 0 ? (
                <div className="px-3 py-4 text-center">
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-2">
                    {t('settings.models.noModelsFound')}
                  </p>
                  {search.trim() && (
                    <button
                      type="button"
                      onClick={() => {
                        handleCustomModel(search.trim());
                        setOpen(false);
                        setSearch('');
                      }}
                      className="text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                    >
                      {t('settings.models.customModel')}: <span className="font-mono">{search.trim()}</span>
                    </button>
                  )}
                </div>
              ) : (
                filteredModels.map(m => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => handleSelectModel(m)}
                    className={`flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-700/60 ${
                      m.id === model ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                    }`}
                  >
                    <span className="flex-1 truncate text-neutral-900 dark:text-neutral-100">{m.name}</span>
                    {m.id !== m.name && (
                      <span className="hidden sm:inline text-[10px] text-neutral-400 font-mono">{m.id}</span>
                    )}
                    {m.reasoning && <Zap size={12} className="text-purple-500 shrink-0" />}
                    {m.id === model && <Check size={14} className="text-blue-600 shrink-0" />}
                  </button>
                ))
              )}
            </div>
            {/* Use custom model if typed */}
            {search.trim() && !filteredModels.some(m => m.id === search.trim()) && (
              <div className="border-t border-neutral-200 dark:border-neutral-800 px-3 py-2">
                <button
                  type="button"
                  onClick={() => {
                    handleCustomModel(search.trim());
                    setOpen(false);
                    setSearch('');
                  }}
                  className="w-full text-left text-xs text-neutral-600 dark:text-neutral-400 hover:text-blue-600 dark:hover:text-blue-400"
                >
                  {t('settings.models.customModel')}: <span className="font-mono">{search.trim()}</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Test connection */}
      {showTestButton && onTestConnection && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleTest}
            disabled={testing || !model}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-neutral-200 dark:border-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40 transition-colors"
          >
            {testing ? <Loader2 size={12} className="animate-spin" /> : <AlertCircle size={12} />}
            {t('settings.models.testConnection')}
          </button>
          {testResult && (
            <span className={`text-xs ${testResult.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
              {testResult.message}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

