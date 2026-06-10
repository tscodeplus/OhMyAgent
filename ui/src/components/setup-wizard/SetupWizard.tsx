import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X, ChevronLeft, ChevronRight, Check, Pencil } from 'lucide-react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Select from '../ui/Select';
import PasswordInput from '../ui/PasswordInput';
import { apiRequest } from '../../utils/api';

// ─── Types ───

interface ProviderInfo {
  id: string;
  name: string;
  knownModels: string[];
}

interface SetupWizardProps {
  initialLanguage: 'zh-CN' | 'en';
  providers: ProviderInfo[];
  onComplete: () => void;
  onDismiss: () => void;
}

interface WizardState {
  uiLanguage: 'zh-CN' | 'en';
  theme: 'system' | 'light' | 'dark';
  provider: string;
  customProviderName: string;
  customApiKey: string;
  customBaseUrl: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
  reasoningModelId: string;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
}

const TOTAL_STEPS = 7;

const DEFAULT_EMBEDDING_BASE_URL = 'https://api.siliconflow.cn/v1';
const DEFAULT_EMBEDDING_MODEL = 'BAAI/bge-m3';

// ─── Step Indicator ───

function StepIndicator({ currentStep }: { currentStep: number }) {
  return (
    <div className="flex items-center justify-center gap-0 py-6">
      {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map((step) => (
        <div key={step} className="flex items-center">
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
              step < currentStep
                ? 'bg-emerald-500 text-white'
                : step === currentStep
                  ? 'bg-blue-600 text-white'
                  : 'bg-neutral-200 text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400'
            }`}
          >
            {step < currentStep ? <Check size={14} strokeWidth={2.5} /> : step}
          </div>
          {step < TOTAL_STEPS && (
            <div
              className={`h-0.5 w-8 sm:w-12 transition-colors ${
                step < currentStep ? 'bg-emerald-500' : 'bg-neutral-200 dark:bg-neutral-700'
              }`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Main Component ───

export default function SetupWizard({ initialLanguage, providers, onComplete, onDismiss }: SetupWizardProps) {
  const { t } = useTranslation('common');

  const [currentStep, setCurrentStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  const [state, setState] = useState<WizardState>({
    uiLanguage: initialLanguage,
    theme: 'system',
    provider: '',
    customProviderName: '',
    customApiKey: '',
    customBaseUrl: '',
    modelId: '',
    apiKey: '',
    baseUrl: '',
    reasoningModelId: '',
    embeddingBaseUrl: DEFAULT_EMBEDDING_BASE_URL,
    embeddingApiKey: '',
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
  });

  const update = useCallback(
    (patch: Partial<WizardState>) => setState((s) => ({ ...s, ...patch })),
    [],
  );

  const isCustomProvider = state.provider === '__custom__';
  const resolvedProvider = isCustomProvider ? state.customProviderName : state.provider;

  // ─── Validation ───

  function canProceed(step: number): boolean {
    switch (step) {
      case 1:
        return true;
      case 2:
        return true;
      case 3:
        if (isCustomProvider) {
          return state.customProviderName.trim().length > 0 && state.customApiKey.trim().length > 0;
        }
        return state.provider.length > 0;
      case 4:
        if (isCustomProvider) return state.modelId.trim().length > 0;
        return state.modelId.trim().length > 0 && state.apiKey.trim().length > 0;
      default:
        return true;
    }
  }

  // ─── Navigation ───

  function handleNext() {
    if (currentStep < TOTAL_STEPS) setCurrentStep((s) => s + 1);
  }

  function handleBack() {
    if (currentStep > 1) setCurrentStep((s) => s - 1);
  }

  function goToStep(step: number) {
    setCurrentStep(step);
  }

  // ─── Save ───

  async function handleSave() {
    setSaving(true);
    setSaveError('');
    try {
      const payload: Record<string, unknown> = {
        setupWizardDone: true,
        uiLanguage: state.uiLanguage,
      };

      // Theme — persist via localStorage (the WebUI theme system reads from it)
      try { localStorage.setItem('oma-theme-mode', state.theme); } catch {}

      // Provider + model
      payload['piAi.provider'] = resolvedProvider;
      payload['piAi.model'] = state.modelId;
      if (isCustomProvider) {
        payload['piAi.apiKey'] = state.customApiKey;
        if (state.customBaseUrl) payload['piAi.baseUrl'] = state.customBaseUrl;
      } else {
        payload['piAi.apiKey'] = state.apiKey;
        if (state.baseUrl) payload['piAi.baseUrl'] = state.baseUrl;

        // Also save to provider_keys so the settings UI shows editable entries
        // (not the read-only piAi fallback display)
        const providerKeyEntry: Record<string, unknown> = {
          apiKey: state.apiKey,
        };
        if (state.baseUrl) {
          providerKeyEntry.baseUrl = state.baseUrl;
        }
        payload['providerKeys'] = {
          [resolvedProvider]: providerKeyEntry,
        };
      }

      // Reasoning model (optional) — always use provider/model format
      if (state.reasoningModelId) {
        // If reasoning model already has provider/ prefix, use as-is; otherwise prepend provider
        const reasoningRef = state.reasoningModelId.includes('/')
          ? state.reasoningModelId
          : `${resolvedProvider}/${state.reasoningModelId}`;
        payload['piAi.reasoningModel'] = reasoningRef;
      }

      // Embedding (optional — only if user filled in both fields)
      if (state.embeddingApiKey && state.embeddingBaseUrl) {
        payload['embedding.baseUrl'] = state.embeddingBaseUrl;
        payload['embedding.apiKey'] = state.embeddingApiKey;
        payload['embedding.model'] = state.embeddingModel;
      }

      await apiRequest('/api/config', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });

      onComplete();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(msg || t('setupWizard.saveError'));
    } finally {
      setSaving(false);
    }
  }

  // ─── Close with confirm ───

  function handleClose() {
    setShowCloseConfirm(true);
  }

  function confirmClose() {
    setShowCloseConfirm(false);
    onDismiss();
  }

  // ─── Provider options ───

  const providerOptions = [
    { value: '', label: t('setupWizard.provider.selectPlaceholder'), disabled: true },
    ...providers.map((p) => ({ value: p.id, label: p.name })),
    { value: '__custom__', label: t('setupWizard.provider.customOption') },
  ];

  const languageOptions = [
    { value: 'zh-CN', label: '简体中文' },
    { value: 'en', label: 'English' },
  ];

  const themeOptions = [
    { value: 'system', label: t('setupWizard.theme.system') },
    { value: 'light', label: t('setupWizard.theme.light') },
    { value: 'dark', label: t('setupWizard.theme.dark') },
  ];

  // ─── Build review items ───

  const reviewItems = [
    {
      step: 1,
      label: t('setupWizard.review.language'),
      value: state.uiLanguage === 'zh-CN' ? '简体中文' : 'English',
    },
    {
      step: 2,
      label: t('setupWizard.review.theme'),
      value: themeOptions.find(o => o.value === state.theme)?.label ?? state.theme,
    },
    {
      step: 3,
      label: t('setupWizard.review.provider'),
      value: resolvedProvider || undefined,
      fallback: t('setupWizard.review.providerNotSet'),
    },
    {
      step: 4,
      label: t('setupWizard.review.mainModel'),
      value: state.modelId ? `${resolvedProvider}/${state.modelId}` : undefined,
      fallback: t('setupWizard.review.mainModelNotSet'),
    },
    {
      step: 5,
      label: t('setupWizard.review.reasoningModel'),
      value: state.reasoningModelId || undefined,
      fallback: t('setupWizard.review.reasoningNotSet'),
    },
    {
      step: 6,
      label: t('setupWizard.review.embedding'),
      value: state.embeddingApiKey
        ? `${state.embeddingModel} @ ${state.embeddingBaseUrl}`
        : undefined,
      fallback: t('setupWizard.review.embeddingNotSet'),
    },
  ];

  // ─── Render ───

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Card */}
      <div className="relative flex w-full max-w-2xl flex-col rounded-2xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900 max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 dark:border-neutral-700 shrink-0">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
            {t('setupWizard.title')}
          </h2>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-400">
              {t('setupWizard.step', { current: currentStep, total: TOTAL_STEPS })}
            </span>
            <button
              onClick={handleClose}
              className="rounded-md p-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            >
              <X size={16} className="text-neutral-500" />
            </button>
          </div>
        </div>

        {/* Step indicator */}
        <StepIndicator currentStep={currentStep} />

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-2 min-h-0">
          {/* Step 1 — Language */}
          {currentStep === 1 && (
            <div className="flex flex-col gap-4">
              <div>
                <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                  {t('setupWizard.language.title')}
                </h3>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  {t('setupWizard.language.description')}
                </p>
              </div>
              <Select
                label={t('setupWizard.review.language')}
                options={languageOptions}
                value={state.uiLanguage}
                onChange={(e) => update({ uiLanguage: e.target.value as 'zh-CN' | 'en' })}
              />
            </div>
          )}

          {/* Step 2 — Theme */}
          {currentStep === 2 && (
            <div className="flex flex-col gap-4">
              <div>
                <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                  {t('setupWizard.theme.title')}
                </h3>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  {t('setupWizard.theme.description')}
                </p>
              </div>
              <Select
                label={t('setupWizard.review.theme')}
                options={themeOptions}
                value={state.theme}
                onChange={(e) => update({ theme: e.target.value as 'system' | 'light' | 'dark' })}
              />
            </div>
          )}

          {/* Step 3 — Provider */}
          {currentStep === 3 && (
            <div className="flex flex-col gap-4">
              <div>
                <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                  {t('setupWizard.provider.title')}
                </h3>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  {t('setupWizard.provider.description')}
                </p>
              </div>
              <Select
                label={t('setupWizard.review.provider')}
                options={providerOptions}
                value={state.provider}
                onChange={(e) => update({ provider: e.target.value })}
              />
              {isCustomProvider && (
                <div className="flex flex-col gap-3 rounded-lg border border-blue-200 bg-blue-50/50 p-4 dark:border-blue-800 dark:bg-blue-950/30">
                  <Input
                    label={t('setupWizard.provider.customName')}
                    placeholder={t('setupWizard.provider.customNamePlaceholder')}
                    value={state.customProviderName}
                    onChange={(e) => update({ customProviderName: e.target.value })}
                  />
                  <PasswordInput
                    label={t('setupWizard.provider.customApiKey')}
                    value={state.customApiKey}
                    onChange={(e) => update({ customApiKey: e.target.value })}
                  />
                  <Input
                    label={t('setupWizard.provider.customBaseUrl')}
                    placeholder={t('setupWizard.provider.customBaseUrlPlaceholder')}
                    value={state.customBaseUrl}
                    onChange={(e) => update({ customBaseUrl: e.target.value })}
                  />
                </div>
              )}
            </div>
          )}

          {/* Step 4 — Main Model */}
          {currentStep === 4 && (
            <div className="flex flex-col gap-4">
              <div>
                <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                  {t('setupWizard.mainModel.title')}
                </h3>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  {t('setupWizard.mainModel.description')}
                </p>
                {resolvedProvider && (
                  <p className="mt-1 text-xs text-neutral-400">
                    {t('setupWizard.mainModel.providerLabel')}: <span className="font-medium text-neutral-600 dark:text-neutral-300">{resolvedProvider}</span>
                  </p>
                )}
              </div>
              <Input
                label={t('setupWizard.mainModel.modelId')}
                placeholder={t('setupWizard.mainModel.modelIdPlaceholder')}
                value={state.modelId}
                onChange={(e) => update({ modelId: e.target.value })}
                autoFocus
              />
              {!isCustomProvider && (
                <>
                  <PasswordInput
                    label={t('setupWizard.mainModel.apiKey')}
                    value={state.apiKey}
                    onChange={(e) => update({ apiKey: e.target.value })}
                  />
                  <Input
                    label={t('setupWizard.mainModel.baseUrl')}
                    placeholder={t('setupWizard.mainModel.baseUrlPlaceholder')}
                    value={state.baseUrl}
                    onChange={(e) => update({ baseUrl: e.target.value })}
                  />
                </>
              )}
            </div>
          )}

          {/* Step 5 — Reasoning Model (optional) */}
          {currentStep === 5 && (
            <div className="flex flex-col gap-4">
              <div>
                <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                  {t('setupWizard.reasoningModel.title')}
                </h3>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  {t('setupWizard.reasoningModel.description')}
                </p>
              </div>
              <Input
                label={t('setupWizard.reasoningModel.modelId')}
                placeholder={t('setupWizard.reasoningModel.modelIdPlaceholder')}
                value={state.reasoningModelId}
                onChange={(e) => update({ reasoningModelId: e.target.value })}
              />
              <div className="flex items-center justify-between rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 dark:border-neutral-700 dark:bg-neutral-800/50">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    update({ reasoningModelId: `${resolvedProvider}/${state.modelId}` });
                  }}
                >
                  {t('setupWizard.reasoningModel.useMainModel')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    update({ reasoningModelId: '' });
                    handleNext();
                  }}
                >
                  {t('setupWizard.reasoningModel.skipButton')}
                </Button>
              </div>
            </div>
          )}

          {/* Step 6 — Embedding (optional but recommended) */}
          {currentStep === 6 && (
            <div className="flex flex-col gap-4">
              <div>
                <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                  {t('setupWizard.embedding.title')}
                  <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/50 dark:text-amber-300">
                    {t('setupWizard.embedding.recommend')}
                  </span>
                </h3>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  {t('setupWizard.embedding.description')}
                </p>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  {t('setupWizard.embedding.siliconflowHint')}
                </p>
              </div>
              <Input
                label={t('setupWizard.embedding.baseUrl')}
                value={state.embeddingBaseUrl}
                onChange={(e) => update({ embeddingBaseUrl: e.target.value })}
              />
              <PasswordInput
                label={t('setupWizard.embedding.apiKey')}
                value={state.embeddingApiKey}
                onChange={(e) => update({ embeddingApiKey: e.target.value })}
              />
              <Input
                label={t('setupWizard.embedding.model')}
                placeholder={t('setupWizard.embedding.modelPlaceholder')}
                value={state.embeddingModel}
                onChange={(e) => update({ embeddingModel: e.target.value })}
              />
              <div className="flex items-center justify-end rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 dark:border-neutral-700 dark:bg-neutral-800/50">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    update({ embeddingApiKey: '', embeddingBaseUrl: DEFAULT_EMBEDDING_BASE_URL, embeddingModel: DEFAULT_EMBEDDING_MODEL });
                    handleNext();
                  }}
                >
                  {t('setupWizard.embedding.skip')}
                </Button>
              </div>
            </div>
          )}

          {/* Step 7 — Review */}
          {currentStep === 7 && (
            <div className="flex flex-col gap-4">
              <div>
                <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                  {t('setupWizard.review.title')}
                </h3>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  {t('setupWizard.review.description')}
                </p>
              </div>
              <div className="flex flex-col gap-2">
                {reviewItems.map((item) => (
                  <div
                    key={item.step}
                    className="flex items-center justify-between rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-700"
                  >
                    <div className="flex flex-col min-w-0">
                      <span className="text-xs text-neutral-400">{item.label}</span>
                      <span className={`text-sm truncate ${item.value ? 'text-neutral-900 dark:text-neutral-100' : 'text-neutral-400'}`}>
                        {item.value || item.fallback}
                      </span>
                    </div>
                    <button
                      onClick={() => goToStep(item.step)}
                      className="ml-3 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/30 shrink-0 transition-colors"
                    >
                      <Pencil size={12} />
                      {t('setupWizard.review.edit')}
                    </button>
                  </div>
                ))}
              </div>
              {saveError && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-400">
                  {saveError}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-neutral-200 dark:border-neutral-700 shrink-0">
          <div>
            {currentStep > 1 && (
              <Button variant="secondary" size="md" onClick={handleBack}>
                <ChevronLeft size={16} />
                {t('setupWizard.back')}
              </Button>
            )}
          </div>
          <div>
            {currentStep < TOTAL_STEPS ? (
              <Button variant="primary" size="md" onClick={handleNext} disabled={!canProceed(currentStep)}>
                {t('setupWizard.next')}
                <ChevronRight size={16} />
              </Button>
            ) : (
              <Button variant="primary" size="md" onClick={handleSave} loading={saving}>
                {saving ? t('setupWizard.saving') : t('setupWizard.saveAndStart')}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Close confirmation dialog */}
      {showCloseConfirm && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/30">
          <div className="w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-6 shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
            <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              {t('setupWizard.closeConfirmTitle')}
            </h3>
            <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
              {t('setupWizard.closeConfirm')}
            </p>
            <div className="mt-4 flex justify-end gap-3">
              <Button variant="secondary" size="sm" onClick={() => setShowCloseConfirm(false)}>
                {t('setupWizard.back')}
              </Button>
              <Button variant="danger" size="sm" onClick={confirmClose}>
                {t('setupWizard.closeConfirmTitle')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
