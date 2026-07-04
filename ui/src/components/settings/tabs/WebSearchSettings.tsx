import React, { useCallback, useMemo, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { GripVertical, X } from 'lucide-react';
import { useConfigDirty, type SettingsTabHandle } from '../useConfigDirty';
import Input from '../../ui/Input';
import Spinner from '../../ui/Spinner';

interface WebSearchSettingsProps {
  tabId?: string;
  registerHandle?: (tabId: string, handle: SettingsTabHandle | null) => void;
  onDirtyChange?: (tabId: string, dirty: boolean) => void;
}

const KNOWN_SEARCH_PROVIDERS = ['anysearch', 'tavily', 'exa', 'baidu'];

/** Parse comma-separated (or array) provider order into a clean list */
function parseProviderOrder(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') return raw.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

export default function WebSearchSettings({ tabId = 'websearch', registerHandle, onDirtyChange }: WebSearchSettingsProps) {
  const { t } = useTranslation('common');
  const { config, loading, getField, setField } = useConfigDirty(tabId, registerHandle, onDirtyChange);

  const ws = (config?.webSearch as Record<string, unknown>) || {};
  const providerOrderFallback = Array.isArray(ws.providerOrder)
    ? (ws.providerOrder as string[]).join(', ')
    : String(ws.providerOrder || '');

  const dirtyVal = getField('webSearch.providerOrder', providerOrderFallback) as string;
  const selectedProviders = useMemo(() => parseProviderOrder(dirtyVal), [dirtyVal]);

  const updateOrder = useCallback((next: string[]) => {
    setField('webSearch.providerOrder', next.join(', '));
  }, [setField]);

  // ── Drag-and-drop state ──
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const dragNodeRef = useRef<HTMLDivElement | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent, idx: number) => {
    setDragIdx(idx);
    dragNodeRef.current = e.currentTarget as HTMLDivElement;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(idx));
    // Make the drag image slightly transparent
    requestAnimationFrame(() => {
      (e.currentTarget as HTMLDivElement).style.opacity = '0.4';
    });
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIdx(idx);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverIdx(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, dropIdx: number) => {
    e.preventDefault();
    if (dragIdx === null || dragIdx === dropIdx) {
      setDragIdx(null);
      setDragOverIdx(null);
      return;
    }
    const next = [...selectedProviders];
    const [moved] = next.splice(dragIdx, 1);
    next.splice(dropIdx, 0, moved);
    updateOrder(next);
    setDragIdx(null);
    setDragOverIdx(null);
  }, [dragIdx, selectedProviders, updateOrder]);

  const handleDragEnd = useCallback(() => {
    if (dragNodeRef.current) {
      dragNodeRef.current.style.opacity = '1';
    }
    setDragIdx(null);
    setDragOverIdx(null);
  }, []);

  const handleToggleProvider = useCallback((provider: string) => {
    const current = parseProviderOrder(getField('webSearch.providerOrder', providerOrderFallback) as string);
    if (current.includes(provider)) {
      updateOrder(current.filter(p => p !== provider));
    } else {
      updateOrder([...current, provider]);
    }
  }, [getField, providerOrderFallback, updateOrder]);

  const availableProviders = KNOWN_SEARCH_PROVIDERS.filter(p => !selectedProviders.includes(p));

  if (loading) return <div className="flex justify-center py-8"><Spinner /></div>;
  if (!config) return <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('common.error')}</p>;

  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">{t("settings.websearch.provider")}</h3>
        <div className="space-y-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-[13px] font-medium text-neutral-700 dark:text-neutral-300">
              {t("settings.websearch.providerOrder")}
            </label>
            <p className="text-[11px] text-neutral-400 dark:text-neutral-500">
              {t("settings.websearch.providerOrderHint")}
            </p>

            {/* Selected providers — draggable ordered list */}
            {selectedProviders.length > 0 ? (
              <div className="flex flex-col gap-1 mt-1">
                {selectedProviders.map((provider, idx) => (
                  <div
                    key={provider}
                    draggable
                    onDragStart={(e) => handleDragStart(e, idx)}
                    onDragOver={(e) => handleDragOver(e, idx)}
                    onDragLeave={handleDragLeave}
                    onDrop={(e) => handleDrop(e, idx)}
                    onDragEnd={handleDragEnd}
                    className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-xs font-medium transition-all select-none ${
                      dragOverIdx === idx && dragIdx !== idx
                        ? 'border-blue-400 bg-blue-50 dark:border-blue-500 dark:bg-blue-900/20 translate-y-0.5'
                        : 'border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-600'
                    } ${dragIdx === idx ? 'opacity-40' : ''}`}
                  >
                    <span className="cursor-grab text-neutral-300 dark:text-neutral-600 hover:text-neutral-500 dark:hover:text-neutral-400 flex-shrink-0" title={t("settings.websearch.dragToReorder")}>
                      <GripVertical size={14} />
                    </span>
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 flex items-center justify-center text-[10px] font-bold">
                      {idx + 1}
                    </span>
                    <span className="flex-1 text-neutral-800 dark:text-neutral-200">{provider}</span>
                    <button
                      type="button"
                      onClick={() => handleToggleProvider(provider)}
                      className="flex-shrink-0 text-neutral-400 hover:text-red-500 dark:hover:text-red-400 transition-colors p-0.5"
                      title={t("settings.websearch.removeProvider")}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-1">
                {t("settings.websearch.noProviderSelected")}
              </p>
            )}

            {/* Available (unselected) providers */}
            {availableProviders.length > 0 && (
              <div className="mt-2">
                <p className="text-[11px] text-neutral-400 dark:text-neutral-500 mb-1.5">
                  {t("settings.websearch.availableProviders")}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {availableProviders.map(provider => (
                    <button
                      key={provider}
                      type="button"
                      onClick={() => handleToggleProvider(provider)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium border border-dashed border-neutral-300 dark:border-neutral-600 text-neutral-400 dark:text-neutral-500 hover:border-blue-400 hover:text-blue-600 dark:hover:border-blue-500 dark:hover:text-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-900/20 transition-all"
                    >
                      <span className="text-[13px] leading-none">+</span>
                      {provider}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Input label={t("settings.websearch.searchTimeout")} type="number" value={getField('webSearch.searchTimeoutMs', String(ws.searchTimeoutMs ?? '')) as string}
              onChange={(e) => setField('webSearch.searchTimeoutMs', e.target.value)} />
            <Input label={t("settings.websearch.maxResults")} type="number" value={getField('webSearch.maxResults', String(ws.maxResults ?? '')) as string}
              onChange={(e) => setField('webSearch.maxResults', e.target.value)} />
          </div>
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold mb-3">API Keys</h3>
        <div className="space-y-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
          {['anysearch', 'baidu', 'exa', 'tavily'].map(provider => {
            const path = `webSearch.${provider}ApiKey`;
            const fallback = String((ws[`${provider}ApiKey`] as string) || '');
            return (
              <Input key={provider} label={`${provider.toUpperCase()} API Key`} type="password"
                value={getField(path, fallback) as string}
                onChange={(e) => setField(path, e.target.value)}
                placeholder={fallback ? undefined : ''}
              />
            );
          })}
        </div>
      </section>
    </div>
  );
}
