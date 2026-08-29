import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, ChevronDown, Check, Zap, AlertCircle, Loader2 } from 'lucide-react';
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
  className = '',
}: ModelPickerProps) {
  const { t } = useTranslation('common');

  const [providers, setProviders] = useState<ProviderOption[]>(fallbackProviders);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  /* Fetch provider list */
  useEffect(() => {
    apiRequest<{ providers: Array<{ id: string; name: string; baseUrl?: string }> }>('/api/providers')
      .then(data => {
        setProviders([
          ...data.providers.map(p => ({ value: p.id, label: p.name, baseUrl: p.baseUrl })),
          ...extraProviders,
        ]);
      })
      .catch(() => setProviders([...fallbackProviders, ...extraProviders]));
  }, [fallbackProviders, extraProviders]);

  /* Fetch models when provider changes */
  useEffect(() => {
    if (!provider) return;
    setLoadingModels(true);
    setModels([]);
    onModelMeta?.(null);
    apiRequest<{ provider: string; models: ModelInfo[] }>(`/api/providers/${encodeURIComponent(provider)}/models`)
      .then(data => {
        setModels(data.models);
        const found = data.models.find(m => m.id === model);
        if (found) onModelMeta?.(found);
      })
      .catch(() => setModels([]))
      .finally(() => setLoadingModels(false));
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
    if (open) searchRef.current?.focus();
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
    <div className={`space-y-3 ${className}`}>
      {/* Provider select */}
      <Select
        label={providerLabel}
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

      {/* Model combobox */}
      <div ref={containerRef} className="relative">
        {modelLabel && (
          <label className="block text-[13px] font-medium text-neutral-700 dark:text-neutral-300 mb-1.5">
            {modelLabel}
          </label>
        )}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-sm text-left text-neutral-900 hover:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 dark:border-neutral-800 dark:bg-neutral-800 dark:text-neutral-100"
        >
          <span className="flex-1 truncate">
            {selectedModel?.name || model || <span className="text-neutral-400">{modelPlaceholder || '—'}</span>}
          </span>
          {loadingModels ? (
            <Loader2 size={14} className="animate-spin text-neutral-400" />
          ) : (
            <ChevronDown size={14} className="text-neutral-400" />
          )}
        </button>

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
            <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-200 dark:border-neutral-800">
              <Search size={14} className="text-neutral-400 shrink-0" />
              <input
                ref={searchRef}
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t('settings.models.searchModels')}
                className="flex-1 bg-transparent text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none dark:text-neutral-100"
              />
            </div>
            <div className="overflow-y-auto flex-1">
              {filteredModels.length === 0 ? (
                <p className="px-3 py-4 text-xs text-neutral-500 dark:text-neutral-400 text-center">
                  {t('settings.models.noModelsFound')}
                </p>
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
                    {m.reasoning && <Zap size={12} className="text-purple-500 shrink-0" />}
                    {m.id === model && <Check size={14} className="text-blue-600 shrink-0" />}
                  </button>
                ))
              )}
            </div>
            {/* Custom model id fallback */}
            <div className="border-t border-neutral-200 dark:border-neutral-800 px-3 py-2">
              <input
                value={model}
                onChange={e => handleCustomModel(e.target.value)}
                placeholder={t('settings.models.customModelPlaceholder')}
                className="w-full bg-transparent text-xs text-neutral-700 placeholder:text-neutral-400 focus:outline-none dark:text-neutral-300"
              />
            </div>
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

