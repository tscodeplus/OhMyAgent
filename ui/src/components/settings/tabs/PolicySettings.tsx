import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { apiRequest } from '../../../utils/api';
import { setNestedValue } from '../../../utils/nested-value';
import { useToast } from '../../ui/Toast';
import Input from '../../ui/Input';
import Select from '../../ui/Select';
import Toggle from '../../ui/Toggle';
import Spinner from '../../ui/Spinner';

export default function PolicySettings() {
  const { t } = useTranslation('common');
  const { showToast } = useToast();
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [approvalTimeout, setApprovalTimeout] = useState('');
  const [orchMaxChildAgents, setOrchMaxChildAgents] = useState('');
  const [smartTeamMaxChildren, setSmartTeamMaxChildren] = useState('');

  useEffect(() => {
    apiRequest<Record<string, unknown>>('/api/config')
      .then((data) => {
        setConfig(data);
        const approval = ((data.policy as Record<string, unknown>)?.approval as Record<string, unknown>) || {};
        const orch = (data.orchestrator as Record<string, unknown>) || {};
        const smartTeam = (data.smart_agent_team as Record<string, unknown>) || {};
        setApprovalTimeout(String(approval.timeoutSec ?? ''));
        setOrchMaxChildAgents(String(orch.maxChildAgents ?? ''));
        setSmartTeamMaxChildren(String(smartTeam.max_children ?? ''));
      }).catch(() => showToast(t('settings.loadError'), 'error')).finally(() => setLoading(false));
  }, [showToast]);

  const saveField = async (path: string, value: unknown) => {
    setConfig(prev => setNestedValue(prev, path, value));
    try {
      await apiRequest('/api/config', { method: 'PUT', body: JSON.stringify({ [path]: value }) });
      showToast(t('settings.saved'), 'success');
    } catch { showToast(t('settings.saveError'), 'error'); }
  };

  if (loading) return <div className="flex justify-center py-8"><Spinner /></div>;
  const policy = (config?.policy as Record<string, unknown>) || {};
  const approval = (policy.approval as Record<string, unknown>) || {};
  const orchestrator = (config?.orchestrator as Record<string, unknown>) || {};
  const smartTeam = (config?.smart_agent_team as Record<string, unknown>) || {};

  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">{t('settings.policy.mode')}</h3>
        <div className="space-y-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
          <Select label={t("settings.policy.modeLabel")} value={String(policy.mode || 'balanced')}
            onChange={(e) => saveField('policy.mode', e.target.value)}
            options={[{ value: 'balanced', label: t('settings.policy.opt_balanced') }, { value: 'permissive', label: t('settings.policy.opt_permissive') }, { value: 'safe', label: t('settings.policy.opt_safe') }]} />
          <div className="grid grid-cols-2 gap-4">
            <Input label={t("settings.policy.approvalTimeout")} type="number" value={approvalTimeout}
              onChange={(e) => setApprovalTimeout(e.target.value)}
              onBlur={() => saveField('policy.approval.timeoutSec', Number(approvalTimeout))} />
            <Select label={t("settings.policy.timeoutAction")} value={String(approval.timeoutAction || 'deny')}
              onChange={(e) => saveField('policy.approval.timeoutAction', e.target.value)}
              options={[{ value: 'allow', label: t('settings.policy.opt_allow') }, { value: 'deny', label: t('settings.policy.opt_deny') }]} />
          </div>
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">{t('settings.policy.orchestrator')}</h3>
        <div className="space-y-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{t("settings.policy.orchestratorEnabled")}</label>
            <Toggle checked={!!orchestrator.enabled} onChange={(v) => saveField('orchestrator.enabled', v)} />
          </div>
          <Input label={t("settings.policy.maxChildAgents")} type="number" value={orchMaxChildAgents}
            onChange={(e) => setOrchMaxChildAgents(e.target.value)}
            onBlur={() => saveField('orchestrator.maxChildAgents', Number(orchMaxChildAgents))} />
          <div className="flex items-center justify-between">
            <label className="text-sm">{t("settings.policy.inheritApprovals")}</label>
            <Toggle checked={!!orchestrator.inheritApprovals} onChange={(v) => saveField('orchestrator.inheritApprovals', v)} />
          </div>
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold mb-3">Smart Agent Team</h3>
        <div className="space-y-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{t("settings.policy.smartTeamEnabled")}</label>
            <Toggle checked={!!smartTeam.enabled} onChange={(v) => saveField('smart_agent_team.enabled', v)} />
          </div>
          <Input label={t("settings.policy.maxChildren")} type="number" value={smartTeamMaxChildren}
            onChange={(e) => setSmartTeamMaxChildren(e.target.value)}
            onBlur={() => saveField('smart_agent_team.max_children', Number(smartTeamMaxChildren))} />
        </div>
      </section>
    </div>
  );
}
