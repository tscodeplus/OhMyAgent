import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, ChevronDown, ChevronRight, X, CreditCard, Plug, Route, BrainCircuit, Copy, type LucideIcon } from 'lucide-react';
import { apiRequest } from '../../../utils/api';
import { useToast } from '../../ui/Toast';
import { useConfigDirty, type SettingsTabHandle } from '../useConfigDirty';
import Input from '../../ui/Input';
import Select from '../../ui/Select';
import Toggle from '../../ui/Toggle';
import Spinner from '../../ui/Spinner';
import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import SubscriptionsSettings from './SubscriptionsSettings';
import ModelPicker from '../ModelPicker';
import ModelRefInput from '../ModelRefInput';
import FallbackModelsEditor from '../FallbackModelsEditor';
import { SettingsSection, SettingsCard } from '../SettingsSection';

/* ───────── Sub-tabs for the Models tab ───────── */

type ModelSubTab = 'subscription' | 'providers' | 'router' | 'auxiliary';

const MODEL_SUB_TABS: Array<{ id: ModelSubTab; labelKey: string; icon: LucideIcon }> = [
  { id: 'subscription', labelKey: 'settings.models.subtabs.subscription', icon: CreditCard },
  { id: 'providers', labelKey: 'settings.models.subtabs.providers', icon: Plug },
  { id: 'router', labelKey: 'settings.models.subtabs.router', icon: Route },
  { id: 'auxiliary', labelKey: 'settings.models.subtabs.auxiliary', icon: BrainCircuit },
];

interface ProviderModel {
  id: string;
  name: string;
  api: string;
  reasoning?: boolean;
  reasoningLevel?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
}

interface CustomProvider {
  provider: string;
  apiKey: string;
  baseUrl: string;
  models: ProviderModel[];
}

interface ProviderKeyEntry {
  apiKey?: string;
  baseUrl?: string;
}

/* ───────── Main component ───────── */

interface ModelSettingsProps {
  tabId?: string;
  registerHandle?: (tabId: string, handle: SettingsTabHandle | null) => void;
  onDirtyChange?: (tabId: string, dirty: boolean) => void;
  initialSubTab?: string;
}

function HealthItem({ label, ok, warn }: { label: string; ok: boolean; warn?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${ok ? 'bg-green-500' : warn ? 'bg-amber-500' : 'bg-red-500'}`} />
      <span className="text-xs text-neutral-600 dark:text-neutral-400">{label}</span>
    </div>
  );
}

export default function ModelSettings({ tabId = 'models', registerHandle, onDirtyChange, initialSubTab }: ModelSettingsProps) {
  const { t } = useTranslation('common');
  const { showToast } = useToast();
  const { config, loading, getField, setField, save: saveSimple, cancel: cancelSimple, fetchConfig, dirtyCount, dirtyPaths } = useConfigDirty(tabId, undefined, undefined);

  /* ─── Sub-tab state ─── */
  const [activeSubTab, setActiveSubTab] = useState<ModelSubTab>((initialSubTab as ModelSubTab) || 'subscription');

  useEffect(() => {
    if (initialSubTab) setActiveSubTab(initialSubTab as ModelSubTab);
  }, [initialSubTab]);

  /* ─── Built-in providers fetched from pi-mono (avoids drift) ─── */
  const [builtinProviders, setBuiltinProviders] = useState<Record<string, string>>({});

  useEffect(() => {
    apiRequest<{ providers: Array<{ id: string; name: string; baseUrl?: string }> }>('/api/providers')
      .then(data => {
        const map: Record<string, string> = {};
        for (const p of data.providers) {
          if (p.baseUrl) map[p.id] = p.baseUrl;
        }
        setBuiltinProviders(map);
      })
      .catch(() => setBuiltinProviders({}));
  }, []);

  /* ─── Complex object state (deferred save via global Save button) ─── */
  const [customProviders, setCustomProviders] = useState<CustomProvider[]>([]);
  const [providerKeys, setProviderKeys] = useState<Record<string, ProviderKeyEntry>>({});
  const [providerKeysDirty, setProviderKeysDirty] = useState(false);
  const [customProvidersDirty, setCustomProvidersDirty] = useState(false);
  const [customProvidersNeedsRestart, setCustomProvidersNeedsRestart] = useState(false);

  /* ─── Add/Edit Model Modal ─── */
  const [modalOpen, setModalOpen] = useState(false);
  const [modalProviderIdx, setModalProviderIdx] = useState<number>(0);
  const [modalModel, setModalModel] = useState<ProviderModel | null>(null);

  const openAddModelModal = (pIdx: number) => {
    setModalProviderIdx(pIdx);
    setModalModel({ id: '', name: '', api: 'openai-completions', reasoning: false });
    setModalOpen(true);
  };

  const openCopyModelModal = (pIdx: number, mIdx: number) => {
    const modelToCopy = customProviders[pIdx].models[mIdx];
    setModalProviderIdx(pIdx);
    setModalModel({ ...modelToCopy, id: '', name: '' });
    setModalOpen(true);
  };

  const handleModalSave = () => {
    if (modalModel && modalModel.id.trim()) {
      setCustomProviders(prev => prev.map((p, i) =>
        i === modalProviderIdx ? { ...p, models: [...p.models, { ...modalModel }] } : p
      ));
      setCustomProvidersDirty(true);
      setCustomProvidersNeedsRestart(true);
      setModalOpen(false);
    }
  };

  /* Custom providers as extra options for ModelPicker (labelled custom/<name>).
     Must stay BEFORE the conditional early-returns below (Rules of Hooks). */
  const extraProviderOptions = useMemo(
    () => customProviders
      .filter(cp => cp.provider && !builtinProviders[cp.provider])
      .map(cp => ({ value: cp.provider, label: `custom/${cp.provider}` })),
    [customProviders, builtinProviders],
  );

  /* ─── UI state (kept as-is) ─── */
  const [expandedCustom, setExpandedCustom] = useState<Set<number>>(new Set());
  const [expandedBuiltin, setExpandedBuiltin] = useState<Set<string>>(new Set());
  const [showBuiltinModal, setShowBuiltinModal] = useState(false);
  const [showCustomModal, setShowCustomModal] = useState(false);
  const [newBuiltinForm, setNewBuiltinForm] = useState({ provider: '', apiKey: '', baseUrl: '' });
  const [newCustomForm, setNewCustomForm] = useState({ provider: '', apiKey: '', baseUrl: '' });

  /* ─── Sync complex objects from config whenever it loads/changes ─── */
  useEffect(() => {
    if (!config) return;
    setCustomProviders((config.customProviders as CustomProvider[]) || []);
    const pks = (config.providerKeys || config.provider_keys) as Record<string, ProviderKeyEntry> | undefined;
    setProviderKeys(pks || {});
  }, [config]);

  /* ─── Provider Keys (Builtin) ─── */

  const addProviderKey = () => {
    const { provider, apiKey, baseUrl } = newBuiltinForm;
    if (!provider || providerKeys[provider]) return;
    const updated = { ...providerKeys, [provider]: { apiKey: apiKey || undefined, baseUrl: baseUrl || undefined } };
    setProviderKeys(updated);
    setProviderKeysDirty(true);
    setExpandedBuiltin(prev => new Set(prev).add(provider));
    setShowBuiltinModal(false);
    setNewBuiltinForm({ provider: '', apiKey: '', baseUrl: '' });
  };

  const removeProviderKey = (name: string) => {
    const updated = { ...providerKeys };
    delete updated[name];
    setProviderKeys(updated);
    setProviderKeysDirty(true);
  };

  const updateProviderKeyName = (oldName: string, newName: string) => {
    if (oldName === newName) return;
    const updated: Record<string, ProviderKeyEntry> = {};
    for (const [k, v] of Object.entries(providerKeys)) {
      if (k === oldName) {
        if (newName) updated[newName] = v;
      } else {
        updated[k] = v;
      }
    }
    setProviderKeys(updated);
    setProviderKeysDirty(true);
  };

  const updateProviderKey = (name: string, field: keyof ProviderKeyEntry, value: string) => {
    const updated = { ...providerKeys, [name]: { ...providerKeys[name], [field]: value || undefined } };
    setProviderKeys(updated);
    setProviderKeysDirty(true);
  };

  /* ─── Custom Providers ─── */

  const addCustomProviderHandler = () => {
    const { provider, apiKey, baseUrl } = newCustomForm;
    if (!provider) return;
    const updated = [...customProviders, { provider, apiKey, baseUrl, models: [] }];
    setCustomProviders(updated);
    setCustomProvidersDirty(true);
    setCustomProvidersNeedsRestart(true);
    setExpandedCustom(prev => new Set(prev).add(updated.length - 1));
    setShowCustomModal(false);
    setNewCustomForm({ provider: '', apiKey: '', baseUrl: '' });
  };

  const removeCustomProvider = (idx: number) => {
    const updated = customProviders.filter((_, i) => i !== idx);
    setCustomProviders(updated);
    setCustomProvidersDirty(true);
    setCustomProvidersNeedsRestart(true);
  };

  const updateCustomProvider = (idx: number, field: keyof CustomProvider, value: unknown) => {
    const updated = customProviders.map((p, i) => i === idx ? { ...p, [field]: value } : p);
    setCustomProviders(updated);
    setCustomProvidersDirty(true);
    setCustomProvidersNeedsRestart(true);
  };

  const toggleCustomProvider = (idx: number) => {
    setExpandedCustom(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  /* ─── Custom Provider Models ─── */

  const removeModel = (pIdx: number, mIdx: number) => {
    const updated = customProviders.map((p, i) => {
      if (i !== pIdx) return p;
      return { ...p, models: p.models.filter((_, mi) => mi !== mIdx) };
    });
    setCustomProviders(updated);
    setCustomProvidersDirty(true);
    setCustomProvidersNeedsRestart(true);
  };

  const updateModel = (pIdx: number, mIdx: number, field: keyof ProviderModel, value: unknown) => {
    const updated = customProviders.map((p, i) => {
      if (i !== pIdx) return p;
      return { ...p, models: p.models.map((m, mi) => mi === mIdx ? { ...m, [field]: value } : m) };
    });
    setCustomProviders(updated);
    setCustomProvidersDirty(true);
    if (field !== 'reasoningLevel') {
      setCustomProvidersNeedsRestart(true);
    }
  };

  const toggleModelInput = (pIdx: number, mIdx: number, inputType: string) => {
    const updated = customProviders.map((p, i) => {
      if (i !== pIdx) return p;
      return {
        ...p,
        models: p.models.map((m, mi) => {
          if (mi !== mIdx) return m;
          const current = m.input || [];
          const next = current.includes(inputType)
            ? current.filter(v => v !== inputType)
            : [...current, inputType];
          return { ...m, input: next };
        }),
      };
    });
    setCustomProviders(updated);
    setCustomProvidersDirty(true);
    setCustomProvidersNeedsRestart(true);
  };

  /* ─── Combined save / cancel / dirty ─── */

  const handleSave = useCallback(async (opts?: { silent?: boolean }) => {
    try {
      if (providerKeysDirty) {
        await apiRequest('/api/config', { method: 'PUT', body: JSON.stringify({ provider_keys: providerKeys }) });
      }
      if (customProvidersDirty) {
        await apiRequest('/api/config', { method: 'PUT', body: JSON.stringify({ customProviders }) });
      }
      await saveSimple(opts);
      setProviderKeysDirty(false);
      setCustomProvidersDirty(false);
      setCustomProvidersNeedsRestart(false);
    } catch (e) {
      showToast(t('settings.saveError'), 'error');
      throw e;
    }
  }, [saveSimple, providerKeysDirty, customProvidersDirty, providerKeys, customProviders, showToast, t]);

  const handleCancel = useCallback(() => {
    cancelSimple();
    setProviderKeysDirty(false);
    setCustomProvidersDirty(false);
    setCustomProvidersNeedsRestart(false);
    fetchConfig(false);
  }, [cancelSimple, fetchConfig]);

  /* ─── Register handle with parent modal ─── */

  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;
  const handleCancelRef = useRef(handleCancel);
  handleCancelRef.current = handleCancel;
  const customProvidersDirtyRef = useRef(customProvidersDirty);
  customProvidersDirtyRef.current = customProvidersDirty;
  const customProvidersNeedsRestartRef = useRef(customProvidersNeedsRestart);
  customProvidersNeedsRestartRef.current = customProvidersNeedsRestart;

  useEffect(() => {
    const handle: SettingsTabHandle = {
      save: (opts) => handleSaveRef.current(opts),
      cancel: () => handleCancelRef.current(),
      isDirty: () => dirtyCount > 0 || providerKeysDirty || customProvidersDirty,
      needsRestart: () => customProvidersNeedsRestartRef.current,
    };
    registerHandle?.(tabId, handle);
    return () => registerHandle?.(tabId, null);
  }, [tabId, registerHandle, dirtyCount, providerKeysDirty, customProvidersDirty, customProvidersNeedsRestart]);

  /* ─── Report dirty state to parent ─── */

  useEffect(() => {
    onDirtyChange?.(tabId, dirtyCount > 0 || providerKeysDirty || customProvidersDirty);
  }, [tabId, dirtyCount, providerKeysDirty, customProvidersDirty, onDirtyChange]);

  /* ─── Render ─── */

  if (loading) return <div className="flex justify-center py-8"><Spinner /></div>;
  if (!config) return <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('common.error')}</p>;

  const piAi = (config.piAi as Record<string, string>) || {};
  const fallbackModels = (config.fallbackModels as string[]) || [];
  const defReasoningLevel = config.defaultReasoningLevel as string || '';
  const embedding = (config.embedding as Record<string, unknown>) || {};
  const memoryAux = (config.memoryAuxModels as Record<string, unknown>) || {};

  const selectedProvider = getField('piAi.provider', piAi.provider || 'deepseek') as string;
  const selectedPkEntry = providerKeys[selectedProvider];
  const selectedCustom = customProviders.find(cp => cp.provider === selectedProvider);
  const hasProviderKey = !!(selectedPkEntry?.apiKey || selectedCustom?.apiKey);

  const configuredProviders: string[] = (() => {
    const ids = new Set<string>();
    for (const [name, entry] of Object.entries(providerKeys)) {
      if (entry.apiKey) ids.add(name);
    }
    if (piAi.provider && piAi.apiKey) ids.add(piAi.provider);
    for (const cp of customProviders) {
      if (cp.apiKey) ids.add(cp.provider);
    }
    return Array.from(ids);
  })();

  // Build merged provider keys view: providerKeys entries + piAi provider if it has a key
  const builtinEntries: Array<{ name: string; entry: ProviderKeyEntry; source: 'providerKeys' | 'piAi' | 'custom' }> = [];

  // 1. Entries from providerKeys config
  for (const [name, entry] of Object.entries(providerKeys)) {
    builtinEntries.push({ name, entry, source: 'providerKeys' });
  }

  // 2. Primary model's provider (piAi) — if has apiKey, is a builtin, and not already in providerKeys
  const piAiProvider = piAi.provider;
  if (piAiProvider && piAi.apiKey && !providerKeys[piAiProvider] && piAiProvider in builtinProviders) {
    builtinEntries.push({
      name: piAiProvider,
      entry: { apiKey: piAi.apiKey, baseUrl: piAi.baseUrl || undefined },
      source: 'piAi',
    });
  }

  // Show builtin entries that have API key, OR are empty (being edited)
  const displayBuiltin = builtinEntries.filter(b => b.entry.apiKey || b.name);

  /* ─── Sub-tab dirty state (for badges) ───
     providers: providerKeys/customProviders are deferred-save (own flags);
     router: piAi.* / fallbackModels / defaultReasoningLevel;
     auxiliary: memoryAuxModels.* / embedding.*. */
  const subTabDirty: Record<ModelSubTab, boolean> = {
    subscription: false,
    providers: providerKeysDirty || customProvidersDirty,
    router: dirtyPaths.some(p =>
      p === 'fallbackModels' || p === 'defaultReasoningLevel' || p.startsWith('piAi.')),
    auxiliary: dirtyPaths.some(p =>
      p.startsWith('memoryAuxModels.') || p.startsWith('embedding.')),
  };

  return (
    <div className="space-y-3">

      {/* ── Health status bar ── */}
      <div className="flex items-center gap-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/50 px-3 py-2">
        <HealthItem
          label={t('settings.models.title')}
          ok={!!(piAi.provider && (piAi.apiKey || hasProviderKey))}
        />
        <span className="h-4 w-px bg-neutral-200 dark:bg-neutral-700" />
        <HealthItem
          label={t('settings.models.embeddingTitle')}
          ok={!!(embedding.model && embedding.apiKey)}
          warn={!embedding.model}
        />
      </div>

      {/* ── Sub-tab bar (segmented control) ── */}
      <div className="flex gap-1 p-1 rounded-lg bg-neutral-100 dark:bg-neutral-800 max-sm:overflow-x-auto" role="tablist">
        {MODEL_SUB_TABS.map(st => {
          const Icon = st.icon;
          const active = activeSubTab === st.id;
          return (
            <button
              key={st.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveSubTab(st.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-[13px] rounded-md transition-all whitespace-nowrap shrink-0 ${
                active
                  ? 'bg-white dark:bg-neutral-700 text-neutral-900 dark:text-neutral-100 shadow-sm font-medium'
                  : 'text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'
              }`}
            >
              <Icon size={14} strokeWidth={1.75} />
              <span>{t(st.labelKey)}</span>
              {subTabDirty[st.id] && !active && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
              )}
            </button>
          );
        })}
      </div>

      {/* ── Sub-tab: Subscription logins ── */}
      <div style={{ display: activeSubTab === 'subscription' ? undefined : 'none' }} className="space-y-3 pt-3">
        <SubscriptionsSettings />
      </div>

      {/* ── Sub-tab: Providers (Builtin + Custom) ── */}
      <div style={{ display: activeSubTab === 'providers' ? undefined : 'none' }} className="space-y-3">
        {/* ── Builtin Providers ── */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold text-neutral-600 dark:text-neutral-400">
              {t('settings.models.builtinProviders')}
            </h4>
            <button onClick={() => setShowBuiltinModal(true)}
              className="flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 transition-colors">
              <Plus size={12} />{t('settings.models.addProviderKey')}
            </button>
          </div>

          {displayBuiltin.length === 0 ? (
            <p className="text-xs text-neutral-400 dark:text-neutral-500 py-3 text-center border border-dashed border-neutral-200 dark:border-neutral-800 rounded-lg">
              {t('settings.models.noProviderKeys')}
            </p>
          ) : (
            <div className="space-y-1.5">
              {displayBuiltin.map(({ name, entry, source }) => {
                const isExpanded = expandedBuiltin.has(name);
                const toggle = () => setExpandedBuiltin(prev => {
                  const next = new Set(prev);
                  if (next.has(name)) next.delete(name); else next.add(name);
                  return next;
                });
                return (
                <div key={name || '__new__'} className="rounded-lg border border-neutral-100 dark:border-neutral-800 overflow-hidden">
                  {/* Header */}
                  <div className="flex items-center gap-2 px-3 py-2 bg-neutral-50 dark:bg-neutral-950/50">
                    <button onClick={toggle}
                      className="text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors">
                      {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                    <span className={`h-2 w-2 rounded-full shrink-0 ${entry.apiKey ? 'bg-green-500' : 'bg-neutral-300 dark:bg-neutral-600'}`} />
                    <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200 flex-1 truncate">
                      {name || t('settings.models.newProvider')}
                    </span>
                    {source === 'piAi' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 shrink-0">
                        Primary Model
                      </span>
                    )}
                    {source === 'custom' && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 shrink-0">
                        Custom
                      </span>
                    )}
                    <span className="text-[10px] text-neutral-400 dark:text-neutral-500 shrink-0 font-mono">
                      {entry.apiKey ? '••••••••' : 'no key'}
                    </span>
                    {source === 'providerKeys' ? (
                      <button onClick={() => removeProviderKey(name)}
                        className="text-neutral-400 hover:text-red-500 dark:hover:text-red-400 transition-colors shrink-0"
                        title={t('settings.models.removeProvider')}>
                        <Trash2 size={12} />
                      </button>
                    ) : (
                      <span className="text-[10px] text-neutral-400 dark:text-neutral-500 shrink-0">
                        {source === 'piAi' ? 'Primary Model' : 'Custom Providers'}
                      </span>
                    )}
                  </div>
                  {/* Expanded body */}
                  {isExpanded && (
                    <div className="px-3 py-3 space-y-3 border-t border-neutral-100 dark:border-neutral-800">
                      {(() => {
                        const defaultBaseUrl = builtinProviders[name] || undefined;
                        const resolvedBaseUrl = entry.baseUrl || defaultBaseUrl;
                        return source === 'providerKeys' ? (
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                            <Input label={t('settings.models.providerName')} value={name}
                              onChange={(e) => updateProviderKeyName(name, e.target.value)}
                              placeholder="e.g. deepseek" />
                            <Input label="API Key" type="password" value={entry.apiKey || ''}
                              onChange={(e) => updateProviderKey(name, 'apiKey', e.target.value)} />
                            <div>
                              <label className="text-[11px] font-medium text-neutral-500">Base URL</label>
                              <p className="text-sm text-neutral-700 dark:text-neutral-200 mt-1 truncate" title={resolvedBaseUrl}>
                                {resolvedBaseUrl || '—'}
                              </p>
                            </div>
                          </div>
                        ) : (
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                            <div>
                              <label className="text-[11px] font-medium text-neutral-500">{t('settings.models.providerName')}</label>
                              <p className="text-sm text-neutral-700 dark:text-neutral-200 mt-1">{name}</p>
                            </div>
                            <div>
                              <label className="text-[11px] font-medium text-neutral-500">API Key</label>
                              <p className="text-sm text-neutral-700 dark:text-neutral-200 mt-1 font-mono">
                                {entry.apiKey ? '••••••••' : '—'}
                              </p>
                            </div>
                            <div>
                              <label className="text-[11px] font-medium text-neutral-500">Base URL</label>
                              <p className="text-sm text-neutral-700 dark:text-neutral-200 mt-1 truncate" title={resolvedBaseUrl}>
                                {resolvedBaseUrl || '—'}
                              </p>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Custom Providers ── */}
        <div className="border-t border-neutral-200 dark:border-neutral-800 pt-3">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold text-neutral-600 dark:text-neutral-400">
              {t('settings.models.customProviders')}
            </h4>
            <button onClick={() => setShowCustomModal(true)}
              className="flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 transition-colors">
              <Plus size={12} />{t('settings.models.addProvider')}
            </button>
          </div>

          {customProviders.length === 0 ? (
            <p className="text-xs text-neutral-400 dark:text-neutral-500 py-3 text-center border border-dashed border-neutral-200 dark:border-neutral-800 rounded-lg">
              {t('settings.models.noProviders')}
            </p>
          ) : (
            <div className="space-y-2">
              {customProviders.map((cp, pIdx) => (
                <div key={pIdx} className="rounded-lg border border-neutral-100 dark:border-neutral-800 overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2 bg-neutral-50 dark:bg-neutral-950/50">
                    <button onClick={() => toggleCustomProvider(pIdx)}
                      className="text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors">
                      {expandedCustom.has(pIdx) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    </button>
                    <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200 flex-1">
                      {cp.provider || `Provider #${pIdx + 1}`}
                    </span>
                    <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
                      {cp.models.length}{t('settings.models.modelsCount')}
                    </span>
                    <button onClick={() => removeCustomProvider(pIdx)}
                      className="text-neutral-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                      title={t('settings.models.removeProvider')}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                  {expandedCustom.has(pIdx) && (
                    <div className="px-3 py-3 space-y-3 border-t border-neutral-100 dark:border-neutral-800">
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <Input label={t('settings.models.providerName')} value={cp.provider}
                          onChange={(e) => updateCustomProvider(pIdx, 'provider', e.target.value)}
                          placeholder="e.g. openrouter" />
                        <Input label={t('settings.models.providerApiKey')} type="password" value={cp.apiKey}
                          onChange={(e) => updateCustomProvider(pIdx, 'apiKey', e.target.value)} />
                        <Input label={t('settings.models.providerBaseUrl')} value={cp.baseUrl}
                          onChange={(e) => updateCustomProvider(pIdx, 'baseUrl', e.target.value)}
                          placeholder="e.g. https://api.example.com/v1" />
                      </div>
                      {/* Models */}
                      <div className="border-t border-neutral-100 dark:border-neutral-800 pt-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
                            {t('settings.models.models')}
                          </span>
                          <button onClick={() => openAddModelModal(pIdx)}
                            className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 transition-colors">
                            <Plus size={12} />{t('settings.models.addModel')}
                          </button>
                        </div>
                        {cp.models.length === 0 ? (
                          <p className="text-xs text-neutral-400 dark:text-neutral-500 py-2 text-center">
                            {t('settings.models.noModels')}
                          </p>
                        ) : (
                          <div className="space-y-2">
                            {cp.models.map((model, mIdx) => (
                              <div key={mIdx} className="rounded border border-neutral-100 dark:border-neutral-800 p-2.5 bg-neutral-50/50 dark:bg-neutral-950/30">
                                <div className="flex items-center justify-between mb-2">
                                  <span className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
                                    {model.name || model.id || `Model #${mIdx + 1}`}
                                  </span>
                                  <div className="flex items-center gap-2">
                                    <button onClick={() => openCopyModelModal(pIdx, mIdx)}
                                      className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
                                      title={t('settings.models.copyModel')}>
                                      <Copy size={11} />
                                    </button>
                                    <button onClick={() => removeModel(pIdx, mIdx)}
                                      className="text-neutral-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                                      title={t('settings.models.deleteModel')}>
                                      <Trash2 size={11} />
                                    </button>
                                  </div>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                  <Input label={t('settings.models.modelId')} value={model.id}
                                    onChange={(e) => updateModel(pIdx, mIdx, 'id', e.target.value)}
                                    placeholder="e.g. gpt-4o" />
                                  <Input label={t('settings.models.modelName')} value={model.name}
                                    onChange={(e) => updateModel(pIdx, mIdx, 'name', e.target.value)}
                                    placeholder="e.g. GPT-4o" />
                                  {(() => {
                                    const knownApis = [
                                      'anthropic-messages',
                                      'azure-openai-responses',
                                      'bedrock-converse-stream',
                                      'google-generative-ai',
                                      'google-vertex',
                                      'mistral-conversations',
                                      'openai-codex-responses',
                                      'openai-completions',
                                      'openai-responses',
                                    ];
                                    const currentApi = model.api || '';
                                    const isCustom = currentApi && !knownApis.includes(currentApi);
                                    const options = [
                                      ...(isCustom ? [{ value: currentApi, label: currentApi }] : []),
                                      ...knownApis.map(api => ({ value: api, label: api })),
                                    ];
                                    return (
                                      <Select label={t('settings.models.modelApi')}
                                        value={currentApi}
                                        onChange={(e) => updateModel(pIdx, mIdx, 'api', e.target.value)}
                                        options={options} />
                                    );
                                  })()}
                                  <div className="flex items-center gap-4">
                                    <div className="flex items-center gap-1.5 mt-[22px]">
                                      <Toggle checked={!!model.reasoning}
                                        onChange={(v) => updateModel(pIdx, mIdx, 'reasoning', v)} />
                                      <span className="text-[11px] font-semibold text-neutral-600 dark:text-neutral-400">{t('settings.models.modelReasoning')}</span>
                                    </div>
                                    <div className="flex-1">
                                    <Select label={t('settings.models.modelReasoningLevel')}
                                      value={model.reasoningLevel || 'off'}
                                      onChange={(e) => updateModel(pIdx, mIdx, 'reasoningLevel', e.target.value)}
                                      options={[
                                        { value: 'off', label: 'Off' },
                                        { value: 'minimal', label: 'Minimal' },
                                        { value: 'low', label: 'Low' },
                                        { value: 'medium', label: 'Medium' },
                                        { value: 'high', label: 'High' },
                                        { value: 'xhigh', label: 'Very High' },
                                      ]} />
                                    </div>
                                  </div>
                                  <Input label={t('settings.models.modelContextWindow')} type="number"
                                    value={model.contextWindow ? String(model.contextWindow) : ''}
                                    onChange={(e) => updateModel(pIdx, mIdx, 'contextWindow', e.target.value ? Number(e.target.value) : undefined)}
                                    placeholder="e.g. 128000" />
                                  <Input label={t('settings.models.modelMaxTokens')} type="number"
                                    value={model.maxTokens ? String(model.maxTokens) : ''}
                                    onChange={(e) => updateModel(pIdx, mIdx, 'maxTokens', e.target.value ? Number(e.target.value) : undefined)}
                                    placeholder="e.g. 16384" />
                                  <div className="col-span-2">
                                    <label className="text-[13px] font-medium text-neutral-700 dark:text-neutral-300 block mb-1.5">
                                      {t('settings.models.modelInput')}
                                    </label>
                                    <div className="flex items-center gap-4">
                                      {(['text', 'image', 'video'] as const).map(inputType => {
                                        const checked = (model.input || []).includes(inputType);
                                        return (
                                          <label key={inputType} className="flex items-center gap-1.5 cursor-pointer select-none">
                                            <input
                                              type="checkbox"
                                              checked={checked}
                                              onChange={() => toggleModelInput(pIdx, mIdx, inputType)}
                                              className="w-4 h-4 rounded border-neutral-300 dark:border-neutral-600 text-blue-600 focus:ring-blue-500 cursor-pointer"
                                            />
                                            <span className="text-[13px] text-neutral-700 dark:text-neutral-300">
                                              {inputType}
                                            </span>
                                          </label>
                                        );
                                      })}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Sub-tab: Router — primary model / fallback / default reasoning ── */}
      <div style={{ display: activeSubTab === 'router' ? undefined : 'none' }} className="space-y-6">
        {/* Primary Model */}
        <SettingsSection title={t('settings.models.title')}>
          <SettingsCard>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-3">
                <ModelPicker
                  provider={selectedProvider}
                  model={getField('piAi.model', piAi.model || '') as string}
                  extraProviders={extraProviderOptions}
                  onChangeProvider={(v) => setField('piAi.provider', v)}
                  onChangeModel={(v) => setField('piAi.model', v)}
                  providerLabel={t('settings.models.provider')}
                  modelLabel={t('settings.models.model')}
                  showMetaBadges={false}
                  configuredProviders={configuredProviders}
                />
              </div>
              <div className="space-y-3">
                <Input label={t('settings.models.apiKey')} type="password"
                  value={getField('piAi.apiKey', piAi.apiKey || '') as string}
                  onChange={(e) => setField('piAi.apiKey', e.target.value)}
                  placeholder={
                    selectedPkEntry?.apiKey ? t('settings.models.apiKeyFromBuiltin') :
                    selectedCustom?.apiKey ? t('settings.models.apiKeyFromCustom2') :
                    undefined
                  } />
                {hasProviderKey ? (
                  <p className="text-[11px] text-green-600 dark:text-green-400">
                    {t('settings.models.apiKeyInherited')}
                  </p>
                ) : !piAi.apiKey && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                    {t('settings.models.apiKeyNotConfigured')}
                  </p>
                )}
              </div>
              <Input label={t('settings.models.reasoningModel')}
                value={getField('piAi.reasoningModel', piAi.reasoningModel || '') as string}
                onChange={(e) => setField('piAi.reasoningModel', e.target.value)}
                placeholder={t('settings.models.reasoningModelPlaceholder')} />
              <Input label={t('settings.models.baseUrl')}
                value={getField('piAi.baseUrl', piAi.baseUrl || '') as string}
                onChange={(e) => setField('piAi.baseUrl', e.target.value)}
                placeholder={
                  selectedPkEntry?.baseUrl ? t('settings.models.baseUrlFromBuiltin') :
                  selectedCustom?.baseUrl ? t('settings.models.baseUrlFromCustom2') :
                  undefined
                } />
            </div>
          </SettingsCard>
        </SettingsSection>

        {/* Fallback Models */}
        <SettingsSection title={t('settings.models.fallbackModels')}>
          <SettingsCard>
            <FallbackModelsEditor
              value={getField('fallbackModels', fallbackModels) as string[]}
              onChange={(v) => setField('fallbackModels', v)}
              configuredProviders={configuredProviders}
              extraProviders={extraProviderOptions}
            />
          </SettingsCard>
        </SettingsSection>

        {/* Default Reasoning Level */}
        <SettingsSection title={t('settings.models.defaultReasoningLevel')}>
          <SettingsCard>
            <Select
              label={t('settings.models.defaultReasoningLevel')}
              value={getField('defaultReasoningLevel', defReasoningLevel || 'off') as string}
              onChange={(e) => setField('defaultReasoningLevel', e.target.value)}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'minimal', label: 'Minimal' },
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' },
                { value: 'xhigh', label: 'Very High' },
              ]}
            />
          </SettingsCard>
        </SettingsSection>
      </div>

      {/* ── Sub-tab: Auxiliary — memory aux models + embedding ── */}
      <div style={{ display: activeSubTab === 'auxiliary' ? undefined : 'none' }} className="space-y-6">
        <SettingsSection title={t('settings.models.memoryAuxModels')}>
          <SettingsCard>
            <ModelRefInput label={t('settings.models.memoryAuxPrimary')}
              value={getField('memoryAuxModels.primary', (memoryAux.primary as string) || '') as string}
              onChange={(v) => setField('memoryAuxModels.primary', v)}
              placeholder="e.g. deepseek-chat"
              configuredProviders={configuredProviders}
              extraProviders={extraProviderOptions} />
            <div className="pt-2">
              <label className="block text-[13px] font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                {t('settings.models.fallbackModels')}
              </label>
              <FallbackModelsEditor
                value={getField('memoryAuxModels.fallback_models', (memoryAux.fallback_models as string[]) || []) as string[]}
                onChange={(v) => setField('memoryAuxModels.fallback_models', v)}
                configuredProviders={configuredProviders}
                extraProviders={extraProviderOptions}
              />
            </div>
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title={t('settings.models.embeddingTitle')}>
          <SettingsCard>
            <Input label="Base URL"
              value={getField('embedding.baseUrl', (embedding.baseUrl as string) || '') as string}
              onChange={(e) => setField('embedding.baseUrl', e.target.value)} />
            <Input label="API Key" type="password"
              value={getField('embedding.apiKey', (embedding.apiKey as string) || '') as string}
              onChange={(e) => setField('embedding.apiKey', e.target.value)} />
            <Input label={t('settings.models.embeddingModel')}
              value={getField('embedding.model', (embedding.model as string) || '') as string}
              onChange={(e) => setField('embedding.model', e.target.value)} />
            <Input label={t('settings.models.embeddingDimension')} type="number"
              value={getField('embedding.dimension', embedding.dimension ? String(embedding.dimension) : '') as string}
              onChange={(e) => setField('embedding.dimension', e.target.value)} />
          </SettingsCard>
        </SettingsSection>
      </div>

      {/* ── Add Builtin Provider Modal ── */}
      {showBuiltinModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowBuiltinModal(false)}>
          <div className="bg-white dark:bg-neutral-900 rounded-lg border border-neutral-200 dark:border-neutral-800 shadow-xl mx-4 w-full max-w-[420px] p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t('settings.models.addProviderKey')}</h3>
              <button onClick={() => setShowBuiltinModal(false)} className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"><X size={16} /></button>
            </div>
            <div className="space-y-3">
              <Select label={t('settings.models.providerName')}
                value={newBuiltinForm.provider}
                onChange={(e) => setNewBuiltinForm({ ...newBuiltinForm, provider: e.target.value })}
                options={[
                  { value: '', label: `— ${t('settings.models.selectProvider')} —` },
                  ...Object.keys(builtinProviders).filter(p => p !== 'custom' && !providerKeys[p]).map(p => ({ value: p, label: p })),
                ]} />
              <Input label="API Key" type="password" value={newBuiltinForm.apiKey}
                onChange={(e) => setNewBuiltinForm({ ...newBuiltinForm, apiKey: e.target.value })} />
              <div>
                <label className="text-[13px] font-medium text-neutral-700 dark:text-neutral-300">Base URL</label>
                <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1.5 truncate"
                  title={newBuiltinForm.provider ? builtinProviders[newBuiltinForm.provider] || undefined : undefined}>
                  {newBuiltinForm.provider ? builtinProviders[newBuiltinForm.provider] || '—' : '—'}
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setShowBuiltinModal(false)}
                className="px-3 py-1.5 text-xs rounded border border-neutral-200 dark:border-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors">
                {t('common.cancel')}
              </button>
              <button onClick={addProviderKey} disabled={!newBuiltinForm.provider || !newBuiltinForm.apiKey}
                className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Custom Provider Modal ── */}
      {showCustomModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowCustomModal(false)}>
          <div className="bg-white dark:bg-neutral-900 rounded-lg border border-neutral-200 dark:border-neutral-800 shadow-xl mx-4 w-full max-w-[420px] p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t('settings.models.addProvider')}</h3>
              <button onClick={() => setShowCustomModal(false)} className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"><X size={16} /></button>
            </div>
            <div className="space-y-3">
              <Input label={t('settings.models.providerName')} value={newCustomForm.provider}
                onChange={(e) => setNewCustomForm({ ...newCustomForm, provider: e.target.value })}
                placeholder="e.g. openrouter" />
              <Input label="API Key" type="password" value={newCustomForm.apiKey}
                onChange={(e) => setNewCustomForm({ ...newCustomForm, apiKey: e.target.value })} />
              <Input label="Base URL" value={newCustomForm.baseUrl}
                onChange={(e) => setNewCustomForm({ ...newCustomForm, baseUrl: e.target.value })}
                placeholder="e.g. https://api.example.com/v1" />
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setShowCustomModal(false)}
                className="px-3 py-1.5 text-xs rounded border border-neutral-200 dark:border-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors">
                {t('common.cancel')}
              </button>
              <button onClick={addCustomProviderHandler} disabled={!newCustomForm.provider || !newCustomForm.apiKey}
                className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add/Copy Model Modal ── */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={t('settings.models.addModel')}
        size="lg"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setModalOpen(false)}>{t('common.cancel')}</Button>
            <Button size="sm" onClick={handleModalSave} disabled={!modalModel?.id.trim()}>{t('common.save')}</Button>
          </>
        }
      >
        {modalModel && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Input label={t('settings.models.modelId')} value={modalModel.id}
                onChange={(e) => setModalModel({ ...modalModel, id: e.target.value })}
                placeholder="e.g. gpt-4o" />
              <Input label={t('settings.models.modelName')} value={modalModel.name}
                onChange={(e) => setModalModel({ ...modalModel, name: e.target.value })}
                placeholder="e.g. GPT-4o" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Select label={t('settings.models.modelApi')}
                value={modalModel.api}
                onChange={(e) => setModalModel({ ...modalModel, api: e.target.value })}
                options={[
                  'anthropic-messages',
                  'azure-openai-responses',
                  'bedrock-converse-stream',
                  'google-generative-ai',
                  'google-vertex',
                  'mistral-conversations',
                  'openai-codex-responses',
                  'openai-completions',
                  'openai-responses',
                ].map(api => ({ value: api, label: api }))} />
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-1.5">
                  <Toggle checked={!!modalModel.reasoning}
                    onChange={(v) => setModalModel({ ...modalModel, reasoning: v })} />
                  <span className="text-[11px] font-semibold text-neutral-600 dark:text-neutral-400">{t('settings.models.modelReasoning')}</span>
                </div>
                <div className="flex-1">
                  <Select label={t('settings.models.modelReasoningLevel')}
                    value={modalModel.reasoningLevel || 'off'}
                    onChange={(e) => setModalModel({ ...modalModel, reasoningLevel: e.target.value })}
                    options={[
                      { value: 'off', label: 'Off' },
                      { value: 'minimal', label: 'Minimal' },
                      { value: 'low', label: 'Low' },
                      { value: 'medium', label: 'Medium' },
                      { value: 'high', label: 'High' },
                      { value: 'xhigh', label: 'Very High' },
                    ]} />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input label={t('settings.models.modelContextWindow')} type="number"
                value={modalModel.contextWindow ? String(modalModel.contextWindow) : ''}
                onChange={(e) => setModalModel({ ...modalModel, contextWindow: e.target.value ? Number(e.target.value) : undefined })}
                placeholder="e.g. 128000" />
              <Input label={t('settings.models.modelMaxTokens')} type="number"
                value={modalModel.maxTokens ? String(modalModel.maxTokens) : ''}
                onChange={(e) => setModalModel({ ...modalModel, maxTokens: e.target.value ? Number(e.target.value) : undefined })}
                placeholder="e.g. 16384" />
            </div>
            <div>
              <label className="text-[13px] font-medium text-neutral-700 dark:text-neutral-300 block mb-1.5">
                {t('settings.models.modelInput')}
              </label>
              <div className="flex items-center gap-4">
                {(['text', 'image', 'video'] as const).map(inputType => (
                  <label key={inputType} className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={(modalModel.input || []).includes(inputType)}
                      onChange={() => {
                        const current = modalModel.input || [];
                        const updated = current.includes(inputType)
                          ? current.filter(t => t !== inputType)
                          : [...current, inputType];
                        setModalModel({ ...modalModel, input: updated });
                      }}
                      className="w-4 h-4 rounded border-neutral-300 dark:border-neutral-600 text-blue-600 focus:ring-blue-500 cursor-pointer" />
                    <span className="text-[13px] text-neutral-700 dark:text-neutral-300">{inputType}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
