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
  const isEditing = !!(editingAgent || isNew);

  // AgentEditor handle — populated by AgentEditor via registerHandle prop
  const editorHandleRef = useRef<SettingsTabHandle | null>(null);
  // Config dirty handle from useConfigDirty
  const configHandleRef = useRef<SettingsTabHandle | null>(null);
  // Whether the config (non-editor) part is dirty
  const [configDirty, setConfigDirty] = useState(false);

  const { config, loading: configLoading, getField, setField } = useConfigDirty(
    tabId,
    // Capture config handle + dirty state
    (tid: string, handle: SettingsTabHandle | null) => {
      configHandleRef.current = handle;
      if (!isEditing && registerHandle) {
        registerHandle(tid, handle);
      }
    },
    (tid: string, dirty: boolean) => {
      setConfigDirty(dirty);
      if (!isEditing) {
        onDirtyChange?.(tid, dirty);
      }
    },
  );

  // When AgentEditor registers its handle, wire it to SettingsModal
  const handleEditorRegister = useCallback((tid: string, handle: SettingsTabHandle | null) => {
    editorHandleRef.current = handle;
    if (isEditing && registerHandle) {
      registerHandle(tabId, handle);
    }
  }, [isEditing, registerHandle, tabId]);

  // Report dirty state: from editor if editing, otherwise from config
  useEffect(() => {
    if (isEditing) {
      // We don't know editor's dirty state here — it reports via onDirtyChange
      // from AgentEditor's own tracking. The SettingsModal will check isDirty().
    } else {
      onDirtyChange?.(tabId, configDirty);
    }
  }, [isEditing, configDirty, onDirtyChange, tabId]);

  // When switching to/from editing mode, re-register the correct handle
  useEffect(() => {
    if (!registerHandle) return;
    if (isEditing) {
      if (editorHandleRef.current) {
        registerHandle(tabId, editorHandleRef.current);
      } else {
        registerHandle(tabId, null);
      }
    } else {
      if (configHandleRef.current) {
        registerHandle(tabId, configHandleRef.current);
      } else {
        registerHandle(tabId, null);
      }
    }
  }, [isEditing, registerHandle, tabId]);

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

  if (configLoading) return <div className="flex justify-center py-8"><Spinner /></div>;
  if (!config) return <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('common.error')}</p>;

  if (editingAgent || isNew) {
    return (
      <AgentEditor
        agent={editingAgent}
        registerHandle={handleEditorRegister}
        onDirtyChange={(dirty) => onDirtyChange?.(tabId, dirty)}
        onSave={() => {
          setEditingAgent(null);
          setIsNew(false);
          fetchAgents();
          onDirtyChange?.(tabId, false);
        }}
        onCancel={() => {
          setEditingAgent(null);
          setIsNew(false);
          onDirtyChange?.(tabId, false);
        }}
      />
    );
  }

  const orchestrator = (config?.orchestrator as Record<string, unknown>) || {};
  const smartTeam = (config?.smart_agent_team as Record<string, unknown>) || {};

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold">{t("settings.agents.list")}</h3>
          <Button size="sm" onClick={() => setIsNew(true)}>
            <Plus size={14} /> {t("settings.agents.new")}
          </Button>
        </div>

        <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 overflow-hidden">
          <table className="w-full text-sm">
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
                        onClick={() => setEditingAgent(agent)}
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
  );
}
