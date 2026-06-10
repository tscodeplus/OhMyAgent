import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { apiRequest } from '../../../utils/api';
import { setNestedValue } from '../../../utils/nested-value';
import { useToast } from '../../ui/Toast';
import Input from '../../ui/Input';
import Select from '../../ui/Select';
import Toggle from '../../ui/Toggle';
import Spinner from '../../ui/Spinner';

export default function ToolsSettings() {
  const { t } = useTranslation('common');
  const { showToast } = useToast();
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [defaultTimeout, setDefaultTimeout] = useState('');
  const [maxOutput, setMaxOutput] = useState('');
  const [approvalTimeout, setApprovalTimeout] = useState('');
  const [allowedRoots, setAllowedRoots] = useState('');
  const [deniedPatterns, setDeniedPatterns] = useState('');

  useEffect(() => {
    apiRequest<Record<string, unknown>>('/api/config')
      .then((data) => {
        setConfig(data);
        const tools = (data.tools as Record<string, unknown>) || {};
        const fileRead = (tools.fileRead as Record<string, unknown>) || {};
        setDefaultTimeout(String(tools.defaultTimeoutMs ?? ''));
        setMaxOutput(String(tools.maxOutputLength ?? ''));
        setApprovalTimeout(String(tools.shellApprovalTimeoutSec ?? ''));
        setAllowedRoots(Array.isArray(fileRead.allowedRoots) ? (fileRead.allowedRoots as string[]).join(', ') : '');
        setDeniedPatterns(Array.isArray(fileRead.deniedPatterns) ? (fileRead.deniedPatterns as string[]).join(', ') : '');
      }).catch(() => showToast(t('settings.loadError'), 'error')).finally(() => setLoading(false));
  }, [showToast, t]);

  const saveField = async (path: string, value: unknown) => {
    setConfig(prev => setNestedValue(prev, path, value));
    try { await apiRequest('/api/config', { method: 'PUT', body: JSON.stringify({ [path]: value }) }); showToast(t('settings.saved'), 'success'); }
    catch { showToast(t('settings.saveError'), 'error'); }
  };

  if (loading) return <div className="flex justify-center py-8"><Spinner /></div>;
  const tools = (config?.tools as Record<string, unknown>) || {};

  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">{t('settings.tools.shell')}</h3>
        <div className="space-y-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{t('settings.tools.shellEnabled')}</label>
            <Toggle checked={!!tools.shellEnabled} onChange={(v) => saveField('tools.shellEnabled', v)} />
          </div>
          <Select label={t('settings.tools.execMode')} value={String(tools.shellExecMode || 'balanced')}
            onChange={(e) => saveField('tools.shellExecMode', e.target.value)}
            options={[{ value: 'balanced', label: t('settings.tools.opt_balanced') }, { value: 'safe', label: t('settings.policy.mode') + ': safe' }, { value: 'trusted', label: 'trusted' }]} />
          <div className="grid grid-cols-2 gap-4">
            <Input label={t('settings.tools.defaultTimeout')} type="number" value={defaultTimeout}
              onChange={(e) => setDefaultTimeout(e.target.value)}
              onBlur={() => saveField('tools.defaultTimeoutMs', Number(defaultTimeout))} />
            <Input label={t('settings.tools.maxOutput')} type="number" value={maxOutput}
              onChange={(e) => setMaxOutput(e.target.value)}
              onBlur={() => saveField('tools.maxOutputLength', Number(maxOutput))} />
          </div>
          <Select label={t('settings.tools.toolsProfile')} value={String(tools.toolsProfile || 'standard')}
            onChange={(e) => saveField('tools.toolsProfile', e.target.value)}
            options={['advanced', 'full', 'minimal', 'standard'].map(v => ({ value: v, label: v }))} />
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">{t('settings.tools.approval')}</h3>
        <div className="space-y-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
          <div className="grid grid-cols-2 gap-4">
            <Input label={t('settings.tools.approvalTimeout')} type="number" value={approvalTimeout}
              onChange={(e) => setApprovalTimeout(e.target.value)}
              onBlur={() => saveField('tools.shellApprovalTimeoutSec', Number(approvalTimeout))} />
            <Select label={t('settings.tools.timeoutAction')} value={String(tools.shellApprovalTimeoutAction || 'deny')}
              onChange={(e) => saveField('tools.shellApprovalTimeoutAction', e.target.value)}
              options={[{ value: 'allow', label: t('settings.tools.opt_allow') }, { value: 'deny', label: t('settings.tools.opt_deny') }]} />
          </div>
          <Select label={t('settings.tools.approvalMode')} value={String(tools.shellApprovalMode || 'balanced')}
            onChange={(e) => saveField('tools.shellApprovalMode', e.target.value)}
            options={[{ value: 'balanced', label: t('settings.tools.opt_balanced') }, { value: 'relaxed', label: t('settings.tools.opt_relaxed') }, { value: 'strict', label: t('settings.tools.opt_strict') }]} />
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">{t('settings.tools.fileRead')}</h3>
        <div className="space-y-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
          <Input label={t('settings.tools.allowedRoots')} value={allowedRoots}
            onChange={(e) => setAllowedRoots(e.target.value)}
            onBlur={() => saveField('tools.fileRead.allowedRoots', allowedRoots.split(',').map(s => s.trim()).filter(Boolean))} />
          <Input label={t('settings.tools.deniedPatterns')} value={deniedPatterns}
            onChange={(e) => setDeniedPatterns(e.target.value)}
            onBlur={() => saveField('tools.fileRead.deniedPatterns', deniedPatterns.split(',').map(s => s.trim()).filter(Boolean))} />
        </div>
      </section>
    </div>
  );
}
