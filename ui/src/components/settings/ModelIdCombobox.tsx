import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Check, Loader2, RefreshCw, AlertCircle, Zap } from 'lucide-react';
import { apiRequest } from '../../utils/api';
import type { ModelInfo } from './ModelPicker';

/* ───────── Types ───────── */

export interface ModelIdComboboxProps {
  /** Provider id used to fetch the model list (builtin or custom provider name) */
  provider: string;
  /** Current model id value */
  value: string;
  onChange: (id: string) => void;
  label?: string;
  /** Visual-only required marker (red asterisk next to the label). */
  required?: boolean;
  placeholder?: string;
  className?: string;
}

/**
 * Searchable model-ID combobox with a "fetch models" button.
 * Reuses the router tab's fetch button + model combobox UI and the same
 * `/api/providers/:id/models/live` endpoint (works for builtin and custom
 * providers alike). The dropdown supports filtering by keyword and entering
 * a custom model id that is not in the fetched list.
 */
export default function ModelIdCombobox({
  provider,
  value,
  onChange,
  label,
  required,
  placeholder,
  className = '',
}: ModelIdComboboxProps) {
  const { t } = useTranslation('common');

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  // Outcome of the last manual (live) fetch: 'ok' | 'failed' | null, shown on the button.
  const [liveResult, setLiveResult] = useState<'ok' | 'failed' | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Provider for which we already attempted an automatic live fetch on open,
  // so merely opening the dropdown doesn't hammer the API repeatedly.
  const triedLive = useRef<string>('');

  /* Fetch models live from the provider's API (same endpoint as the router tab) */
  const fetchModels = useCallback((providerId: string) => {
    if (!providerId) return;
    setLoading(true);
    if (liveTimer.current) clearTimeout(liveTimer.current);
    setLiveResult(null);
    apiRequest<{ provider: string; models: ModelInfo[] }>(
      `/api/providers/${encodeURIComponent(providerId)}/models/live`,
    )
      .then((data) => {
        if (!data.models || data.models.length === 0) {
          setLiveResult('failed');
          return;
        }
        setModels(data.models);
        setLiveResult('ok');
      })
      .catch(() => setLiveResult('failed'))
      .finally(() => {
        setLoading(false);
        if (liveTimer.current) clearTimeout(liveTimer.current);
        liveTimer.current = setTimeout(() => setLiveResult(null), 4000);
      });
  }, []);

  /* Reset the fetched list whenever the provider changes */
  useEffect(() => {
    setModels([]);
    setLiveResult(null);
    triedLive.current = '';
  }, [provider]);

  /* Close combobox on outside click */
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  /* Focus the input whenever the dropdown opens */
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const handleOpen = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) {
        setSearch('');
        // Auto live-fetch once per provider when the list is still empty.
        if (provider && models.length === 0 && !loading && triedLive.current !== provider) {
          triedLive.current = provider;
          fetchModels(provider);
        }
      }
    },
    [provider, models.length, loading, fetchModels],
  );

  const filteredModels = useMemo(() => {
    if (!search.trim()) return models;
    const q = search.toLowerCase();
    return models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  }, [models, search]);

  const handleSelectModel = useCallback(
    (m: ModelInfo) => {
      onChange(m.id);
      setOpen(false);
      setSearch('');
    },
    [onChange],
  );

  const handleCustomModel = useCallback(
    (v: string) => {
      onChange(v);
      setOpen(false);
      setSearch('');
    },
    [onChange],
  );

  return (
    <div className={className}>
      {/* Label row with the fetch button on the right */}
      <div className="flex items-center justify-between gap-2 mb-1.5">
        {label ? (
          <label className="text-[13px] font-medium text-neutral-700 dark:text-neutral-300">
            {label}
            {required && <span className="ml-0.5 text-red-500">*</span>}
          </label>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={() => fetchModels(provider)}
          disabled={!provider || loading}
          className="no-min-tap shrink-0 flex items-center gap-1 px-2 py-0.5 text-[11px] leading-[17px] rounded-lg border border-neutral-300 bg-white text-neutral-500 hover:bg-neutral-50 hover:text-neutral-700 hover:border-neutral-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors dark:border-neutral-800 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
          title={t('settings.models.fetchModels')}
        >
          {loading ? (
            <Loader2 size={12} className="animate-spin" />
          ) : liveResult === 'ok' ? (
            <Check size={12} className="text-green-500" />
          ) : liveResult === 'failed' ? (
            <AlertCircle size={12} className="text-amber-500" />
          ) : (
            <RefreshCw size={12} />
          )}
          <span className="hidden sm:inline">
            {liveResult === 'ok'
              ? t('settings.models.liveFetched')
              : liveResult === 'failed'
                ? t('settings.models.liveFetchFailed')
                : t('settings.models.fetchModels')}
          </span>
        </button>
      </div>
      {/* Combobox with editable input */}
      <div ref={containerRef} className="relative">
        <div className="flex items-center w-full rounded-lg border border-neutral-300 bg-white dark:border-neutral-800 dark:bg-neutral-800">
          <input
            ref={inputRef}
            type="text"
            value={open ? search : value || ''}
            onChange={(e) => {
              if (!open) setOpen(true);
              setSearch(e.target.value);
            }}
            onFocus={() => {
              if (!open) handleOpen(true);
            }}
            placeholder={placeholder || t('settings.models.customModelPlaceholder')}
            className="flex-1 min-w-0 px-3 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-400 bg-transparent focus:outline-none dark:text-neutral-100"
          />
          {loading ? (
            <Loader2 size={14} className="animate-spin text-neutral-400 mr-3" />
          ) : (
            <button
              type="button"
              onClick={() => handleOpen(!open)}
              className="px-2 py-2.5 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            >
              <ChevronDown size={14} />
            </button>
          )}
        </div>

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
                      onClick={() => handleCustomModel(search.trim())}
                      className="text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                    >
                      {t('settings.models.customModel')}:{' '}
                      <span className="font-mono">{search.trim()}</span>
                    </button>
                  )}
                </div>
              ) : (
                filteredModels.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => handleSelectModel(m)}
                    className={`flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-700/60 ${
                      m.id === value ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                    }`}
                  >
                    <span className="flex-1 truncate text-neutral-900 dark:text-neutral-100">
                      {m.name}
                    </span>
                    {m.id !== m.name && (
                      <span className="hidden sm:inline text-[10px] text-neutral-400 font-mono">
                        {m.id}
                      </span>
                    )}
                    {m.reasoning && <Zap size={12} className="text-purple-500 shrink-0" />}
                    {m.id === value && <Check size={14} className="text-blue-600 shrink-0" />}
                  </button>
                ))
              )}
            </div>
            {/* Use custom model if typed */}
            {search.trim() && !filteredModels.some((m) => m.id === search.trim()) && (
              <div className="border-t border-neutral-200 dark:border-neutral-800 px-3 py-2">
                <button
                  type="button"
                  onClick={() => handleCustomModel(search.trim())}
                  className="w-full text-left text-xs text-neutral-600 dark:text-neutral-400 hover:text-blue-600 dark:hover:text-blue-400"
                >
                  {t('settings.models.customModel')}:{' '}
                  <span className="font-mono">{search.trim()}</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      {liveResult === 'failed' && (
        <p className="flex items-center gap-1.5 mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertCircle size={12} className="shrink-0" />
          {t('settings.models.liveFetchFailedHint')}
        </p>
      )}
    </div>
  );
}
