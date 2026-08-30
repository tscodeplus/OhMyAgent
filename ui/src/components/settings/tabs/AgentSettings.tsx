import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { apiRequest } from '../../../utils/api';
import { useToast } from '../../ui/Toast';
import { useConfigDirty, type SettingsTabHandle } from '../useConfigDirty';
import Button from '../../ui/Button';
import Input from '../../ui/Input';
import Toggle from '../../ui/Toggle';
import Spinner from '../../ui/Spinner';
import AgentEditor from './AgentEditor';
import type { Agent } from '../../../types/agent';

interface AgentSettingsProps {
  tabId?: string;
  registerHandle?: (tabId: string, handle: SettingsTabHandle | null) => void;
  onDirtyChange?: (tabId: string, dirty: boolean) => void;
}

export default function AgentSettings({ tabId = 'agents', registerHandle, onDirtyChange }: AgentSettingsProps) {
  const { t } = useTranslation('common');
  const { showToast } = useToast();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [isNew, setIsNew] = useState(false);
  // Whether the AgentEditor pane is visible. After clicking "back" the editor
  // stays MOUNTED but hidden, so its draft survives until the modal's global
  // Save/Cancel is used (same stash semantics as the other settings tabs).
  const [editorVisible, setEditorVisible] = useState(true);
  const isEditing = !!(editingAgent || isNew);

  // Handles captured from children (AgentEditor + useConfigDirty). The modal
  // only ever receives ONE composite handle (registered below) that covers
  // both the pending agent draft and this tab's config fields.
  const editorHandleRef = useRef<SettingsTabHandle | null>(null);
  const configHandleRef = useRef<SettingsTabHandle | null>(null);
  const [editorDirty, setEditorDirty] = useState(false);
  const [configDirty, setConfigDirty] = useState(false);

  const { config, loading: configLoading, getField, setField } = useConfigDirty(
    tabId,
    // Capture the config handle locally — do NOT forward it to the modal,
    // this tab registers its own combined handle below.
    (tid: string, handle: SettingsTabHandle | null) => {
      configHandleRef.current = handle;
    },
    (tid: string, dirty: boolean) => {
      setConfigDirty(dirty);
    },
  );

  // Capture the AgentEditor handle locally (same reasoning as above).
  const handleEditorRegister = useCallback((tid: string, handle: SettingsTabHandle | null) => {
    editorHandleRef.current = handle;
  }, []);

  // Register ONE composite handle with the SettingsModal. The modal's global
  // Save/Cancel therefore covers BOTH the agent draft (AgentEditor) and the
  // config fields of this tab — even after the user clicks "back" (which only
  // hides the editor, keeping the draft alive until Save/Cancel is pressed).
  useEffect(() => {
    if (!registerHandle) return;
    const combined: SettingsTabHandle = {
      save: async (opts) => {
        if (editorHandleRef.current?.isDirty()) {
          await editorHandleRef.current.save(opts);
        }
        if (configHandleRef.current?.isDirty()) {
          await configHandleRef.current.save(opts);
        }
      },
      cancel: () => {
        editorHandleRef.current?.cancel();
        configHandleRef.current?.cancel();
      },
      isDirty: () =>
        !!editorHandleRef.current?.isDirty() || !!configHandleRef.current?.isDirty(),
      needsRestart: () => configHandleRef.current?.needsRestart?.() ?? false,
    };
    registerHandle(tabId, combined);
    return () => registerHandle(tabId, null);
  }, [registerHandle, tabId]);

  // Report the combined dirty state to the modal (drives the sidebar badge
  // and the unsaved-changes confirmation on close).
  useEffect(() => {
    onDirtyChange?.(tabId, editorDirty || configDirty);
  }, [tabId, editorDirty, configDirty, onDirtyChange]);

  const fetchAgents = useCallback(async () => {
    setAgentsLoading(true);
    try {
      const agentsData = await apiRequest<Agent[]>('/api/agents');
      setAgents(agentsData);
    } catch {
      showToast(t('settings.loadError'), 'error');
    } finally {
      setAgentsLoading(false);
    }
  }, [showToast, t]);

  useEffect(() => { fetchAgents(); }, [fetchAgents]);

  const handleDelete = async (id: string) => {
    try {
      await apiRequest(`/api/agents/${id}`, { method: 'DELETE' });
      showToast(t('project.deleted'), 'success');
      fetchAgents();
    } catch (err: unknown) {
      const apiErr = err as { status?: number };
      if (apiErr.status === 409) {
        showToast(t('settings.agents.deleteBlocked'), 'error');
      } else {
        showToast(t('project.deleteError'), 'error');
      }
    }
  };

  // Closing the editor (after save/cancel) unmounts it and drops the draft.
  // After "back" the editor stays hidden instead — the draft is preserved
  // until the modal's global Save/Cancel is pressed.
  const closeEditor = useCallback((saved: boolean) => {
    setEditingAgent(null);
    setIsNew(false);
    setEditorVisible(true);
    setEditorDirty(false);
    if (saved) fetchAgents();
  }, [fetchAgents]);

  const startNewAgent = useCallback(() => {
    setEditingAgent(null);
    setIsNew(true);
    setEditorVisible(true);
  }, []);

  const startEditAgent = useCallback((agent: Agent) => {
    setEditingAgent(agent);
    setIsNew(false);
    setEditorVisible(true);
  }, []);

  if (configLoading) return <div className="flex justify-center py-8"><Spinner /></div>;
  if (!config) return <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('common.error')}</p>;

  const orchestrator = (config?.orchestrator as Record<string, unknown>) || {};
  const smartTeam = (config?.smart_agent_team as Record<string, unknown>) || {};

  return (
    <>
      {isEditing && (
        <div style={{ display: editorVisible ? undefined : 'none' }}>
          <AgentEditor
            key={editingAgent?.id ?? 'new'}
            agent={editingAgent}
            registerHandle={handleEditorRegister}
            onDirtyChange={(dirty) => setEditorDirty(dirty)}
            onBack={() => setEditorVisible(false)}
            onSave={() => closeEditor(true)}
            onCancel={() => closeEditor(false)}
          />
        </div>
      )}

      {(!isEditing || !editorVisible) && (
        <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold">{t("settings.agents.list")}</h3>
          <Button size="sm" onClick={startNewAgent}>
            <Plus size={14} /> {t("settings.agents.new")}
          </Button>
        </div>

        <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 overflow-x-auto">
          <table className="w-full text-sm max-sm:min-w-[640px]">
            <thead className="bg-neutral-100 dark:bg-neutral-800">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">ID</th>
                <th className="text-left px-4 py-2.5 font-medium">{t("settings.agents.name")}</th>
                <th className="text-left px-4 py-2.5 font-medium">{t("settings.agents.profile")}</th>
                <th className="text-left px-4 py-2.5 font-medium">{t("settings.agents.model")}</th>
                <th className="text-right px-4 py-2.5 font-medium">{t("settings.agents.actions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {agents.map((agent) => (
                <tr key={agent.id} className="hover:bg-neutral-100/30 dark:bg-neutral-800/30">
                  <td className="px-4 py-2.5 text-neutral-500 dark:text-neutral-400 font-mono text-xs">{agent.id}</td>
                  <td className="px-4 py-2.5">{agent.name}</td>
                  <td className="px-4 py-2.5">
                    <span className="inline-block rounded-full bg-neutral-100 dark:bg-neutral-700 text-xs px-2 py-0.5 font-medium text-neutral-600 dark:text-neutral-300">
                      {agent.profile || 'advanced'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-neutral-500 dark:text-neutral-400">{agent.model || '—'}</td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => startEditAgent(agent)}
                        className="p-1.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-600 dark:text-neutral-300"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => handleDelete(agent.id)}
                        disabled={agent.id === 'default'}
                        className="p-1.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 text-danger disabled:opacity-30 disabled:cursor-not-allowed"
                        title={agent.id === 'default' ? t('settings.agents.cannotDeleteDefault', 'The default agent cannot be deleted') : ''}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Orchestrator ── */}
      <section>
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">{t('settings.policy.orchestrator')}</h3>
        <div className="space-y-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{t("settings.policy.orchestratorEnabled")}</label>
            <Toggle checked={getField('orchestrator.enabled', !!orchestrator.enabled) as boolean} onChange={(v) => setField('orchestrator.enabled', v)} />
          </div>
          <Input label={t("settings.policy.maxChildAgents")} type="number"
            value={getField('orchestrator.maxChildAgents', String(orchestrator.maxChildAgents ?? '')) as string}
            onChange={(e) => setField('orchestrator.maxChildAgents', e.target.value)} />
          <div className="flex items-center justify-between">
            <label className="text-sm">{t("settings.policy.inheritApprovals")}</label>
            <Toggle checked={getField('orchestrator.inheritApprovals', !!orchestrator.inheritApprovals) as boolean} onChange={(v) => setField('orchestrator.inheritApprovals', v)} />
          </div>
        </div>
      </section>

      {/* ── Smart Agent Team ── */}
      <section>
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">{t('settings.policy.smartTeam')}</h3>
        <div className="space-y-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{t("settings.policy.smartTeamEnabled")}</label>
            <Toggle checked={getField('smart_agent_team.enabled', !!smartTeam.enabled) as boolean} onChange={(v) => setField('smart_agent_team.enabled', v)} />
          </div>
          <Input label={t("settings.policy.maxChildren")} type="number"
            value={getField('smart_agent_team.max_children', String(smartTeam.max_children ?? '')) as string}
            onChange={(e) => setField('smart_agent_team.max_children', e.target.value)} />
        </div>
      </section>
        </div>
      )}
    </>
  );
}
