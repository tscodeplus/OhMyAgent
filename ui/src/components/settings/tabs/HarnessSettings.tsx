import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfigDirty, type SettingsTabHandle } from '../useConfigDirty';
import Toggle from '../../ui/Toggle';
import Input from '../../ui/Input';
import Select from '../../ui/Select';
import Spinner from '../../ui/Spinner';
import Button from '../../ui/Button';

interface HarnessSettingsProps {
  tabId?: string;
  registerHandle?: (tabId: string, handle: SettingsTabHandle | null) => void;
  onDirtyChange?: (tabId: string, dirty: boolean) => void;
}

const CHANNEL_KEYS = ['webui', 'feishu', 'telegram', 'wechat', 'qq'] as const;

const APPROVAL_PRESETS = [
  { value: 'always_ask', labelKey: 'settings.harness.interactive.approval.alwaysAsk' },
  { value: 'smart_approve', labelKey: 'settings.harness.interactive.approval.smartApprove' },
  { value: 'low_risk_auto', labelKey: 'settings.harness.interactive.approval.lowRiskAuto' },
] as const;

export default function HarnessSettings({ tabId = 'harness', registerHandle, onDirtyChange }: HarnessSettingsProps) {
  const { t } = useTranslation('common');
  const { config, loading, dirtyCount, getField, setField, save, cancel } = useConfigDirty(tabId, registerHandle, onDirtyChange);

  // Warn before leaving the page if there are unsaved changes
  useEffect(() => {
    if (dirtyCount === 0) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirtyCount]);

  if (loading) return <div className="flex justify-center py-8"><Spinner /></div>;
  if (!config) return <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('common.error')}</p>;

  const harness = (config.harness as Record<string, unknown>) || {};
  const interactive = (harness.interactive as Record<string, unknown>) || {};
  const channels = (interactive.channels as Record<string, boolean>) || {};
  const trigger = (interactive.trigger as Record<string, number>) || {};
  const rateLimit = (interactive.rateLimit as Record<string, number>) || {};
  const proposal = (interactive.proposal as Record<string, string>) || {};

  const sectionCardClass = 'rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4';
  const sectionTitleClass = 'text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3';

  return (
    <div className="space-y-6">
      {/* ── Section 1: Total Switch ── */}
      <section>
        <h3 className={sectionTitleClass}>{t('settings.harness.interactive.enabled')}</h3>
        <div className={sectionCardClass}>
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                {t('settings.harness.interactive.enabledLabel')}
              </label>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {t('settings.harness.interactive.enabledDesc')}
              </p>
            </div>
            <Toggle
              checked={getField('harness.interactive.enabled', !!interactive.enabled) as boolean}
              onChange={(v) => setField('harness.interactive.enabled', v)}
            />
          </div>
        </div>
      </section>

      {/* ── Section 2: Notification Channels ── */}
      <section>
        <h3 className={sectionTitleClass}>{t('settings.harness.interactive.channels.title')}</h3>
        <div className={`${sectionCardClass} space-y-3`}>
          {CHANNEL_KEYS.map((ch) => (
            <div key={ch} className="flex items-center justify-between">
              <span className="text-sm text-neutral-700 dark:text-neutral-300">
                {t(`settings.harness.interactive.channels.${ch}`)}
              </span>
              <Toggle
                checked={getField(`harness.interactive.channels.${ch}`, !!channels[ch]) as boolean}
                onChange={(v) => setField(`harness.interactive.channels.${ch}`, v)}
                ariaLabel={t(`settings.harness.interactive.channels.${ch}`)}
              />
            </div>
          ))}
        </div>
      </section>

      {/* ── Section 3: Trigger Conditions ── */}
      <section>
        <h3 className={sectionTitleClass}>{t('settings.harness.interactive.trigger.title')}</h3>
        <div className={`${sectionCardClass} grid grid-cols-2 gap-4`}>
          <Input
            label={t('settings.harness.interactive.trigger.minIdenticalRetries')}
            type="number"
            value={getField('harness.interactive.trigger.minIdenticalRetries', String(trigger.minIdenticalRetries ?? '')) as string}
            onChange={(e) => setField('harness.interactive.trigger.minIdenticalRetries', e.target.value)}
          />
          <Input
            label={t('settings.harness.interactive.trigger.minExplorationSteps')}
            type="number"
            value={getField('harness.interactive.trigger.minExplorationSteps', String(trigger.minExplorationSteps ?? '')) as string}
            onChange={(e) => setField('harness.interactive.trigger.minExplorationSteps', e.target.value)}
          />
          <Input
            label={t('settings.harness.interactive.trigger.minConsecutiveErrors')}
            type="number"
            value={getField('harness.interactive.trigger.minConsecutiveErrors', String(trigger.minConsecutiveErrors ?? '')) as string}
            onChange={(e) => setField('harness.interactive.trigger.minConsecutiveErrors', e.target.value)}
          />
          <Input
            label={t('settings.harness.interactive.trigger.cooldownMinutes')}
            type="number"
            value={getField('harness.interactive.rateLimit.cooldownMinutes', String(rateLimit.cooldownMinutes ?? '')) as string}
            onChange={(e) => setField('harness.interactive.rateLimit.cooldownMinutes', e.target.value)}
          />
        </div>
      </section>

      {/* ── Section 4: Approval Strategy ── */}
      <section>
        <h3 className={sectionTitleClass}>{t('settings.harness.interactive.approval.title')}</h3>
        <div className={`${sectionCardClass} space-y-3`}>
          {APPROVAL_PRESETS.map((preset) => {
            const currentMode = getField('harness.interactive.approval.mode', 'always_ask') as string;
            return (
              <label key={preset.value} className="flex items-center gap-3 cursor-pointer py-1">
                <input
                  type="radio"
                  name="harnessApprovalPreset"
                  value={preset.value}
                  checked={currentMode === preset.value}
                  onChange={(e) => setField('harness.interactive.approval.mode', e.target.value)}
                  className="h-4 w-4 text-blue-500 border-neutral-300 focus:ring-blue-500/30 dark:border-neutral-600 dark:bg-neutral-800"
                />
                <span className="text-sm text-neutral-700 dark:text-neutral-300">
                  {t(preset.labelKey)}
                </span>
              </label>
            );
          })}
          {/* Placeholder: "Manage Custom Rules" button — will be replaced later */}
          <div className="pt-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {}}
            >
              {t('settings.harness.interactive.approval.customRules')}
            </Button>
          </div>
        </div>
      </section>

      {/* ── Section 5: Rate Limits ── */}
      <section>
        <h3 className={sectionTitleClass}>{t('settings.harness.interactive.rateLimit.title')}</h3>
        <div className={`${sectionCardClass} space-y-4`}>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label={t('settings.harness.interactive.rateLimit.maxPerDay')}
              type="number"
              value={getField('harness.interactive.rateLimit.maxPerDay', String(rateLimit.maxPerDay ?? '')) as string}
              onChange={(e) => setField('harness.interactive.rateLimit.maxPerDay', e.target.value)}
            />
            <Input
              label={t('settings.harness.interactive.rateLimit.maxPerHour')}
              type="number"
              value={getField('harness.interactive.rateLimit.maxPerHour', String(rateLimit.maxPerHour ?? '')) as string}
              onChange={(e) => setField('harness.interactive.rateLimit.maxPerHour', e.target.value)}
            />
          </div>
          <Select
            label={t('settings.harness.interactive.proposal.model')}
            value={getField('harness.interactive.proposal.model', (proposal.model || '') as string) as string}
            onChange={(e) => setField('harness.interactive.proposal.model', e.target.value)}
            options={[
              { value: '', label: t('settings.harness.interactive.proposal.modelDefault') },
              { value: 'auto', label: 'Auto' },
            ]}
          />
        </div>
      </section>
    </div>
  );
}
