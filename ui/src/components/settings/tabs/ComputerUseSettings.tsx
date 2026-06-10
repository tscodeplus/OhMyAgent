import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfigDirty, type SettingsTabHandle } from '../useConfigDirty';
import Input from '../../ui/Input';
import Select from '../../ui/Select';
import Toggle from '../../ui/Toggle';
import Spinner from '../../ui/Spinner';

interface ComputerUseSettingsProps {
  tabId?: string;
  registerHandle?: (tabId: string, handle: SettingsTabHandle | null) => void;
  onDirtyChange?: (tabId: string, dirty: boolean) => void;
}

export default function ComputerUseSettings({ tabId = 'computer', registerHandle, onDirtyChange }: ComputerUseSettingsProps) {
  const { t } = useTranslation('common');
  const { config, loading, dirtyCount, getField, setField } = useConfigDirty(tabId, registerHandle, onDirtyChange);

  // Warn before leaving the page if there are unsaved changes
  useEffect(() => {
    if (dirtyCount === 0) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirtyCount]);

  if (loading) return <div className="flex justify-center py-8"><Spinner /></div>;
  if (!config) return <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('common.error')}</p>;

  const cu = (config.computerUse as Record<string, unknown>) || {};
  const cuSsh = (cu.ssh as Record<string, unknown>) || {};
  const cuNode = (cu.node as Record<string, unknown>) || {};

  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">{t("settings.computer.title")}</h3>
        <div className="space-y-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{t("settings.computer.enabled")}</label>
            <Toggle checked={getField('computerUse.enabled', !!cu.enabled) as boolean} onChange={(v) => setField('computerUse.enabled', v)} />
          </div>
          <Select label="Provider" value={getField('computerUse.provider', String(cu.provider || 'auto')) as string}
            onChange={(e) => setField('computerUse.provider', e.target.value)}
            options={['auto', 'local', 'node', 'ssh'].map(v => ({ value: v, label: v }))} />
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">{t("settings.computer.ssh")}</h3>
        <div className="space-y-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
          <Input label="Host" value={getField('computerUse.ssh.host', String(cuSsh.host || '')) as string}
            onChange={(e) => setField('computerUse.ssh.host', e.target.value)} />
          <div className="grid grid-cols-2 gap-4">
            <Input label="User" value={getField('computerUse.ssh.user', String(cuSsh.user || '')) as string}
              onChange={(e) => setField('computerUse.ssh.user', e.target.value)} />
            <Input label="Port" type="number" value={getField('computerUse.ssh.port', String(cuSsh.port || 22)) as string}
              onChange={(e) => setField('computerUse.ssh.port', e.target.value)} />
          </div>
          <Input label="Key Path" value={getField('computerUse.ssh.keyPath', String(cuSsh.keyPath || '')) as string}
            onChange={(e) => setField('computerUse.ssh.keyPath', e.target.value)} />
          <Input label="Jump Host" value={getField('computerUse.ssh.jumpHost', String(cuSsh.jumpHost || '')) as string}
            onChange={(e) => setField('computerUse.ssh.jumpHost', e.target.value)} />
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">{t("settings.computer.node")}</h3>
        <div className="space-y-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
          <Input label="URL" value={getField('computerUse.node.url', String(cuNode.url || '')) as string}
            onChange={(e) => setField('computerUse.node.url', e.target.value)} />
        </div>
      </section>
    </div>
  );
}
