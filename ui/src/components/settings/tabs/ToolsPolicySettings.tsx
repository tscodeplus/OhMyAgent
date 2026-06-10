import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useConfigDirty, type SettingsTabHandle } from '../useConfigDirty';
import Input from '../../ui/Input';
import Select from '../../ui/Select';
import Toggle from '../../ui/Toggle';
import Spinner from '../../ui/Spinner';

function AccordionItem({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
      <button onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full px-4 py-2.5 text-sm font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/60 transition-colors">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {title}
      </button>
      {open && <div className="px-4 py-3 space-y-3 border-t border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">{children}</div>}
    </div>
  );
}

interface ToolsPolicySettingsProps {
  tabId?: string;
  registerHandle?: (tabId: string, handle: SettingsTabHandle | null) => void;
  onDirtyChange?: (tabId: string, dirty: boolean) => void;
}

export default function ToolsPolicySettings({ tabId = 'tools', registerHandle, onDirtyChange }: ToolsPolicySettingsProps) {
  const { t } = useTranslation('common');
  const { config, loading, getField, setField } = useConfigDirty(tabId, registerHandle, onDirtyChange);

  if (loading) return <div className="flex justify-center py-8"><Spinner /></div>;
  if (!config) return <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('common.error')}</p>;

  const tools = (config.tools as Record<string, unknown>) || {};
  const policy = (config.policy as Record<string, unknown>) || {};
  const approval = (policy.approval as Record<string, unknown>) || {};
  const fileRead = (tools.fileRead as Record<string, unknown>) || {};

  // Helper: safely extract a string value from an unknown record
  const str = (val: unknown, fallback: string): string => (typeof val === 'string' ? val : fallback);

  return (
    <div className="space-y-3">
      <AccordionItem title={t('settings.policy.globalPolicy')}>
        <Select label={t("settings.policy.modeLabel")} value={getField('policy.mode', str(policy.mode, 'balanced')) as string}
          onChange={(e) => setField('policy.mode', e.target.value)}
          options={[{ value: 'balanced', label: t('settings.policy.opt_balanced') }, { value: 'permissive', label: t('settings.policy.opt_permissive') }, { value: 'safe', label: t('settings.policy.opt_safe') }]} />
        <div className="grid grid-cols-2 gap-4">
          <Input label={t("settings.policy.approvalTimeout")} type="number" value={getField('policy.approval.timeoutSec', str(approval.timeoutSec, '')) as string}
            onChange={(e) => setField('policy.approval.timeoutSec', e.target.value)} />
          <Select label={t("settings.policy.timeoutAction")} value={getField('policy.approval.timeoutAction', str(approval.timeoutAction, 'deny')) as string}
            onChange={(e) => setField('policy.approval.timeoutAction', e.target.value)}
            options={[{ value: 'allow', label: t('settings.policy.opt_allow') }, { value: 'deny', label: t('settings.policy.opt_deny') }]} />
        </div>
      </AccordionItem>

      <AccordionItem title={t('settings.tools.shell')}>
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{t('settings.tools.shellEnabled')}</label>
          <Toggle checked={getField('tools.shellEnabled', !!tools.shellEnabled) as boolean} onChange={(v) => setField('tools.shellEnabled', v)} />
        </div>
        <Select label={t('settings.tools.execMode')} value={getField('tools.shellExecMode', str(tools.shellExecMode, 'balanced')) as string}
          onChange={(e) => setField('tools.shellExecMode', e.target.value)}
          options={[{ value: 'balanced', label: t('settings.tools.opt_balanced') }, { value: 'safe', label: 'safe' }, { value: 'trusted', label: 'trusted' }]} />
        <div className="grid grid-cols-2 gap-4">
          <Input label={t('settings.tools.defaultTimeout')} type="number" value={getField('tools.defaultTimeoutMs', str(tools.defaultTimeoutMs, '')) as string}
            onChange={(e) => setField('tools.defaultTimeoutMs', e.target.value)} />
          <Input label={t('settings.tools.maxOutput')} type="number" value={getField('tools.maxOutputLength', str(tools.maxOutputLength, '')) as string}
            onChange={(e) => setField('tools.maxOutputLength', e.target.value)} />
        </div>
        <Select label={t('settings.tools.toolsProfile')} value={getField('tools.toolsProfile', str(tools.toolsProfile, 'standard')) as string}
          onChange={(e) => setField('tools.toolsProfile', e.target.value)}
          options={['advanced', 'full', 'minimal', 'standard'].map(v => ({ value: v, label: v }))} />
      </AccordionItem>

      <AccordionItem title={t('settings.tools.shellApproval')}>
        <div className="grid grid-cols-2 gap-4">
          <Input label={t('settings.tools.approvalTimeout')} type="number" value={getField('tools.shellApprovalTimeoutSec', str(tools.shellApprovalTimeoutSec, '')) as string}
            onChange={(e) => setField('tools.shellApprovalTimeoutSec', e.target.value)} />
          <Select label={t('settings.tools.timeoutAction')} value={getField('tools.shellApprovalTimeoutAction', str(tools.shellApprovalTimeoutAction, 'deny')) as string}
            onChange={(e) => setField('tools.shellApprovalTimeoutAction', e.target.value)}
            options={[{ value: 'deny', label: t('settings.tools.opt_deny') }, { value: 'allow', label: t('settings.tools.opt_allow') }]} />
        </div>
        <Select label={t('settings.tools.approvalMode')} value={getField('tools.shellApprovalMode', str(tools.shellApprovalMode, 'balanced')) as string}
          onChange={(e) => setField('tools.shellApprovalMode', e.target.value)}
          options={[{ value: 'balanced', label: t('settings.tools.opt_balanced') }, { value: 'relaxed', label: t('settings.tools.opt_relaxed') }, { value: 'strict', label: t('settings.tools.opt_strict') }]} />
      </AccordionItem>

      <AccordionItem title={t('settings.tools.fileRead')}>
        <Input label={t('settings.tools.allowedRoots')} value={getField('tools.fileRead.allowedRoots', Array.isArray(fileRead.allowedRoots) ? (fileRead.allowedRoots as string[]).join(', ') : '') as string}
          onChange={(e) => setField('tools.fileRead.allowedRoots', e.target.value)} />
        <Input label={t('settings.tools.deniedPatterns')} value={getField('tools.fileRead.deniedPatterns', Array.isArray(fileRead.deniedPatterns) ? (fileRead.deniedPatterns as string[]).join(', ') : '') as string}
          onChange={(e) => setField('tools.fileRead.deniedPatterns', e.target.value)} />
      </AccordionItem>

    </div>
  );
}
