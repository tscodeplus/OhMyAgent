import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, ChevronDown, ChevronRight, X } from 'lucide-react';
import { apiRequest } from '../../../utils/api';
import { useToast } from '../../ui/Toast';
import { useConfigDirty, type SettingsTabHandle } from '../useConfigDirty';
import Input from '../../ui/Input';
import Select from '../../ui/Select';
import Toggle from '../../ui/Toggle';
import Spinner from '../../ui/Spinner';
import SubscriptionsSettings from './SubscriptionsSettings';

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

/* ───────── Accordion helper ───────── */

function AccordionItem({ title, defaultOpen = false, children }: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full px-4 py-2.5 text-sm font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/60 transition-colors"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {title}
      </button>
      {open && (
        <div className="px-4 py-3 space-y-3 border-t border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
          {children}
        </div>
      )}
    </div>
  );
}

/* ───────── Main component ───────── */

interface ModelSettingsProps {
  tabId?: string;
  registerHandle?: (tabId: string, handle: SettingsTabHandle | null) => void;
  onDirtyChange?: (tabId: string, dirty: boolean) => void;
}

export default function ModelSettings({ tabId = 'models', registerHandle, onDirtyChange }: ModelSettingsProps) {
  const { t } = useTranslation('common');
  const { showToast } = useToast();
  const { config, loading, getField, setField, save: saveSimple, cancel: cancelSimple, fetchConfig, dirtyCount } = useConfigDirty(tabId, undefined, undefined);

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

  const addModel = (pIdx: number) => {
    const updated = customProviders.map((p, i) => {
      if (i !== pIdx) return p;
      return { ...p, models: [...p.models, { id: '', name: '', api: 'openai-completions', reasoning: false }] };
    });
    setCustomProviders(updated);
    setCustomProvidersDirty(true);
    setCustomProvidersNeedsRestart(true);
  };

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

  const selectedProvider = piAi.provider || 'deepseek';
  const selectedPkEntry = providerKeys[selectedProvider];
  const selectedCustom = customProviders.find(cp => cp.provider === selectedProvider);
  const hasProviderKey = !!selectedPkEntry || !!selectedCustom;

  const providerOptions = [
    ...Object.keys(builtinProviders).map(v => ({ value: v, label: v })),
    ...customProviders.filter(cp => cp.provider && !builtinProviders[cp.provider]).map(cp => ({
      value: cp.provider,
      label: `custom/${cp.provider}`,
    })),
  ];

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

  return (
    <div className="space-y-3">

      {/* 1. Global Defaults */}
      <AccordionItem title={t('settings.models.globalDefaults')}>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('settings.models.globalDefaultsDesc')}</p>
        <Select
          label={t('settings.models.defaultReasoningLevel')}
          value={getField('defaultReasoningLevel', defReasoningLevel || 'off') as string}
          onChange={(e) => setField('defaultReasoningLevel', e.target.value)}
          options={[
            { value: 'high', label: 'high' },
            { value: 'low', label: 'low' },
            { value: 'medium', label: 'medium' },
            { value: 'minimal', label: 'minimal' },
            { value: 'off', label: 'off' },
            { value: 'xhigh', label: 'xhigh' },
          ]}
        />
      </AccordionItem>

      {/* 2. Providers (Builtin + Custom) */}
      <AccordionItem title={t('settings.models.providers')}>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('settings.models.providersDesc')}</p>

        {/* ── Subscription logins ── */}
        <div className="mb-4">
          <SubscriptionsSettings />
        </div>

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
                          <div className="grid grid-cols-3 gap-3">
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
                          <div className="grid grid-cols-3 gap-3">
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
                      {cp.models.length} {t('settings.models.models').toLowerCase()}
                    </span>
                    <button onClick={() => removeCustomProvider(pIdx)}
                      className="text-neutral-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                      title={t('settings.models.removeProvider')}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                  {expandedCustom.has(pIdx) && (
                    <div className="px-3 py-3 space-y-3 border-t border-neutral-100 dark:border-neutral-800">
                      <div className="grid grid-cols-3 gap-3">
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
                          <button onClick={() => addModel(pIdx)}
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
                                  <button onClick={() => removeModel(pIdx, mIdx)}
                                    className="text-neutral-400 hover:text-red-500 dark:hover:text-red-400 transition-colors">
                                    <Trash2 size={11} />
                                  </button>
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
                                    <div className="flex items-center gap-1.5">
                                      <Toggle checked={!!model.reasoning}
                                        onChange={(v) => updateModel(pIdx, mIdx, 'reasoning', v)} />
                                      <span className="text-[11px] font-semibold text-neutral-600 dark:text-neutral-400">{t('settings.models.modelReasoning')}</span>
                                    </div>
                                    <Select label={t('settings.models.modelReasoningLevel')}
                                      value={model.reasoningLevel || 'off'}
                                      onChange={(e) => updateModel(pIdx, mIdx, 'reasoningLevel', e.target.value)}
                                      options={[
                                        { value: 'high', label: 'high' },
                                        { value: 'low', label: 'low' },
                                        { value: 'medium', label: 'medium' },
                                        { value: 'minimal', label: 'minimal' },
                                        { value: 'off', label: 'off' },
                                        { value: 'xhigh', label: 'xhigh' },
                                      ]} />
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
      </AccordionItem>

      {/* 3. Models Router */}
      <AccordionItem title={t('settings.models.modelsRouter')}>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('settings.models.modelsRouterDesc')}</p>

        {/* Primary Model */}
        <div className="rounded border border-neutral-100 dark:border-neutral-800 p-3">
          <h4 className="text-xs font-semibold text-neutral-600 dark:text-neutral-400 mb-3">{t('settings.models.title')}</h4>
          <div className="space-y-3">
            <Select
              label={t('settings.models.provider')}
              value={getField('piAi.provider', selectedProvider) as string}
              onChange={(e) => setField('piAi.provider', e.target.value)}
              options={providerOptions}
            />
            <Input label={t('settings.models.model')}
              value={getField('piAi.model', piAi.model || '') as string}
              onChange={(e) => setField('piAi.model', e.target.value)} />
            <Input label={t('settings.models.reasoningModel')}
              value={getField('piAi.reasoningModel', piAi.reasoningModel || '') as string}
              onChange={(e) => setField('piAi.reasoningModel', e.target.value)}
              placeholder={t('settings.models.reasoningModelPlaceholder')} />
            <Input label={t('settings.models.apiKey')} type="password"
              value={getField('piAi.apiKey', piAi.apiKey || '') as string}
              onChange={(e) => setField('piAi.apiKey', e.target.value)}
              placeholder={
                selectedPkEntry?.apiKey ? t('settings.models.apiKeyFromBuiltin') :
                selectedCustom?.apiKey ? t('settings.models.apiKeyFromCustom2') :
                undefined
              } />
            {hasProviderKey && !piAi.apiKey && (
              <p className="text-[11px] text-green-600 dark:text-green-400">
                {t('settings.models.apiKeyInherited')}
              </p>
            )}
            {!hasProviderKey && !piAi.apiKey && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                {t('settings.models.apiKeyNotConfigured')}
              </p>
            )}
            <Input label={t('settings.models.baseUrl')}
              value={getField('piAi.baseUrl', piAi.baseUrl || '') as string}
              onChange={(e) => setField('piAi.baseUrl', e.target.value)}
              placeholder={
                selectedPkEntry?.baseUrl ? t('settings.models.baseUrlFromBuiltin') :
                selectedCustom?.baseUrl ? t('settings.models.baseUrlFromCustom2') :
                undefined
              } />
          </div>
        </div>

        {/* Fallback Models */}
        <div className="rounded border border-neutral-100 dark:border-neutral-800 p-3">
          <h4 className="text-xs font-semibold text-neutral-600 dark:text-neutral-400 mb-3">{t('settings.models.fallbackModels')}</h4>
          <Input label={t('settings.models.fallbackModelsHint')}
            value={(getField('fallbackModels', fallbackModels) as string[]).join(', ')}
            onChange={(e) => setField('fallbackModels', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
            placeholder="e.g. gpt-4o, claude-sonnet-4-6" />
        </div>
      </AccordionItem>

      {/* 4. Memory Aux Models */}
      <AccordionItem title={t('settings.models.memoryAuxModels')}>
        <Input label={t('settings.models.memoryAuxPrimary')}
          value={getField('memoryAuxModels.primary', (memoryAux.primary as string) || '') as string}
          onChange={(e) => setField('memoryAuxModels.primary', e.target.value)}
          placeholder="e.g. deepseek-chat" />
        <Input label={t('settings.models.fallbackModels')}
          value={(getField('memoryAuxModels.fallback_models', (memoryAux.fallback_models as string[]) || []) as string[]).join(', ')}
          onChange={(e) => setField('memoryAuxModels.fallback_models', e.target.value.split(',').map(s => s.trim()).filter(Boolean))}
          placeholder="e.g. gpt-4o-mini" />
      </AccordionItem>

      {/* 5. Embedding Model */}
      <AccordionItem title={t('settings.models.embeddingTitle')}>
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
      </AccordionItem>

      {/* ── Add Builtin Provider Modal ── */}
      {showBuiltinModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowBuiltinModal(false)}>
          <div className="bg-white dark:bg-neutral-900 rounded-lg border border-neutral-200 dark:border-neutral-800 shadow-xl w-[420px] p-5" onClick={e => e.stopPropagation()}>
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
                className="px-3 py-1.5 text-xs rounded border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors">
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
          <div className="bg-white dark:bg-neutral-900 rounded-lg border border-neutral-200 dark:border-neutral-800 shadow-xl w-[420px] p-5" onClick={e => e.stopPropagation()}>
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
                className="px-3 py-1.5 text-xs rounded border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors">
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
    </div>
  );
}
