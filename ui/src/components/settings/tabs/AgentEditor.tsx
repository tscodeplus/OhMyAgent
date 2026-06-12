import { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { apiRequest } from '../../../utils/api';
import { useToast } from '../../ui/Toast';
import { type SettingsTabHandle } from '../useConfigDirty';
import Input from '../../ui/Input';
import Select from '../../ui/Select';
import Textarea from '../../ui/Textarea';
import type { Agent } from '../../../types/agent';
import TemplateBrowser from './TemplateBrowser';

const PROFILE_OPTIONS = [
  { value: 'advanced', label: 'Advanced' },
  { value: 'full', label: 'Full' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'standard', label: 'Standard' },
];

interface AgentEditorProps {
  agent?: Agent | null;
  onSave: () => void;
  onCancel: () => void;
  registerHandle?: (tabId: string, handle: SettingsTabHandle | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export default function AgentEditor({ agent, onSave, onCancel, registerHandle, onDirtyChange }: AgentEditorProps) {
  const { t } = useTranslation('common');
  const { showToast } = useToast();
  const isNew = !agent;
  const [saving, setSaving] = useState(false);

  const initialForm = {
    id: agent?.id || '',
    name: agent?.name || '',
    description: agent?.description || '',
    systemPrompt: agent?.systemPrompt || '',
    model: agent?.model || '',
    profile: agent?.profile || 'advanced',
  };

  const [form, setForm] = useState(initialForm);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);

  const isDirty = useCallback(() => {
    return (
      form.id !== initialForm.id ||
      form.name !== initialForm.name ||
      form.description !== initialForm.description ||
      form.systemPrompt !== initialForm.systemPrompt ||
      form.model !== initialForm.model ||
      form.profile !== initialForm.profile
    );
  }, [form, initialForm]);

  // Notify parent of dirty state changes
  const dirty = isDirty();
  const prevDirtyRef = useRef(dirty);
  useEffect(() => {
    if (dirty !== prevDirtyRef.current) {
      prevDirtyRef.current = dirty;
      onDirtyChange?.(dirty);
    }
  }, [dirty, onDirtyChange]);
  // Initial notification
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSaveInternal = useCallback(async (silent: boolean) => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      if (isNew) {
        await apiRequest('/api/agents', { method: 'POST', body: JSON.stringify(form) });
      } else {
        await apiRequest(`/api/agents/${agent!.id}`, { method: 'PUT', body: JSON.stringify(form) });
      }
      if (!silent) showToast(t('settings.saved'), 'success');
      onSave();
    } catch {
      if (!silent) showToast(t('settings.saveError'), 'error');
      throw new Error('Save failed');
    } finally {
      setSaving(false);
    }
  }, [form, isNew, agent, showToast, t, onSave]);

  const handleSave = useCallback(async () => {
    await handleSaveInternal(false);
  }, [handleSaveInternal]);

  const handleImportFromTemplate = useCallback(
    (template: { name: string; systemPrompt: string; description?: string }) => {
      setForm((prev) => ({
        ...prev,
        name: prev.name || template.name,
        systemPrompt: template.systemPrompt,
        description: prev.description || template.description || '',
      }));
    },
    [],
  );

  const handleCancel = useCallback(() => {
    setForm(initialForm);
    onCancel();
  }, [initialForm, onCancel]);

  // Register this editor's handle with the settings modal
  const saveRef = useRef(handleSave);
  saveRef.current = handleSave;
  const saveInternalRef = useRef(handleSaveInternal);
  saveInternalRef.current = handleSaveInternal;
  const cancelRef = useRef(handleCancel);
  cancelRef.current = handleCancel;
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  useEffect(() => {
    const handle: SettingsTabHandle = {
      save: async (opts) => { await saveInternalRef.current(opts?.silent ?? false); },
      cancel: () => { cancelRef.current(); },
      isDirty: () => isDirtyRef.current(),
    };
    registerHandle?.('agents', handle);
    return () => registerHandle?.('agents', null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-6">
      <h3 className="text-sm font-semibold">{isNew ? t('settings.agents.new') : t('settings.agents.edit') + ': ' + agent?.name}</h3>

      <div className="space-y-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
        <div className="grid grid-cols-2 gap-4">
          {isNew && (
            <div>
              <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1.5">
                {t("settings.agents.id")}<span className="text-red-500 ml-0.5">*</span>
              </label>
              <Input
                value={form.id}
                onChange={(e) => setForm({ ...form, id: e.target.value })}
                placeholder={t("settings.agents.idPlaceholder")}
              />
            </div>
          )}
          <div>
            <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1.5">
              {t("settings.agents.name")}<span className="text-red-500 ml-0.5">*</span>
            </label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={t("settings.agents.namePlaceholder")}
            />
          </div>
        </div>
        <Textarea
          label={t("settings.agents.description")}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          rows={2}
        />
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300">
              {t("settings.agents.systemPrompt")}
            </label>
            <button
              type="button"
              onClick={() => setTemplateModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100 hover:border-blue-400 dark:border-blue-500/30 dark:bg-blue-900/20 dark:text-blue-400 dark:hover:bg-blue-900/35 dark:hover:text-blue-300 dark:hover:border-blue-500/50 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              {t("settings.agents.importFromTemplate")}
            </button>
          </div>
          <Textarea
            value={form.systemPrompt}
            onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
            rows={6}
            placeholder={t("settings.agents.promptPlaceholder")}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Select
            label={t("settings.agents.profile")}
            options={PROFILE_OPTIONS}
            value={form.profile}
            onChange={(e) => setForm({ ...form, profile: e.target.value })}
          />
          <Input
            label={t("settings.agents.defaultModel")}
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
            placeholder={t("settings.agents.modelPlaceholder")}
          />
        </div>
      </div>

      <TemplateBrowser
        open={templateModalOpen}
        onClose={() => setTemplateModalOpen(false)}
        onImport={handleImportFromTemplate}
      />
    </div>
  );
}
