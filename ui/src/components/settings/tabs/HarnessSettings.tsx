import { useEffect, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfigDirty, type SettingsTabHandle } from '../useConfigDirty';
import Toggle from '../../ui/Toggle';
import Input from '../../ui/Input';
import Select from '../../ui/Select';
import Spinner from '../../ui/Spinner';
import Button from '../../ui/Button';
import { useToast } from '../../ui/Toast';

interface HarnessSettingsProps {
  tabId?: string;
  registerHandle?: (tabId: string, handle: SettingsTabHandle | null) => void;
  onDirtyChange?: (tabId: string, dirty: boolean) => void;
}

const APPROVAL_PRESETS = [
  { value: 'always_ask', labelKey: 'settings.harness.interactive.approval.alwaysAsk' },
  { value: 'smart_approve', labelKey: 'settings.harness.interactive.approval.smartApprove' },
  { value: 'low_risk_auto', labelKey: 'settings.harness.interactive.approval.lowRiskAuto' },
] as const;

export default function HarnessSettings({ tabId = 'harness', registerHandle, onDirtyChange }: HarnessSettingsProps) {
  const { t } = useTranslation('common');
  const { showToast } = useToast();
  const { config, loading, dirtyCount, getField, setField, save, cancel } = useConfigDirty(tabId, registerHandle, onDirtyChange);

  // Proposal model mode — use a flag to remember user's explicit dropdown choice,
  // avoiding the bug where setField('') causes derived mode to flip back to 'default'.
  const getConfigModel = () => {
    if (!config) return '';
    return (((config.harness as Record<string, unknown>)?.proposal as Record<string, string>)?.model || '');
  };
  const [userSelectedCustom, setUserSelectedCustom] = useState(() => {
    const m = getConfigModel();
    return !!(m && m !== 'default');
  });
  // Reset flag on config change (save / initial load)
  useEffect(() => {
    const m = getConfigModel();
    setUserSelectedCustom(!!(m && m !== 'default'));
  }, [config]);
  // Reset flag on cancel (dirtyFields cleared while config unchanged)
  const prevDirtyCount = useRef(dirtyCount);
  useEffect(() => {
    if (dirtyCount === 0 && prevDirtyCount.current > 0) {
      const m = getConfigModel();
      setUserSelectedCustom(!!(m && m !== 'default'));
    }
    prevDirtyCount.current = dirtyCount;
  }, [dirtyCount]);
  const proposalModelMode: 'default' | 'custom' = userSelectedCustom ? 'custom' : 'default';

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
  const trigger = (harness.trigger as Record<string, number>) || {};
  const rateLimit = (harness.rateLimit as Record<string, number>) || {};
  const proposal = (harness.proposal as Record<string, string>) || {};

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

      {/* ── Section 2: Trigger Conditions ── */}
      <section>
        <h3 className={sectionTitleClass}>{t('settings.harness.interactive.trigger.title')}</h3>
        <div className={`${sectionCardClass} grid grid-cols-2 gap-4`}>
          <Input
            label={t('settings.harness.interactive.trigger.minIdenticalRetries')}
            type="number"
            value={getField('harness.trigger.minIdenticalRetries', String(trigger.minIdenticalRetries ?? 3)) as string}
            onChange={(e) => setField('harness.trigger.minIdenticalRetries', e.target.value)}
          />
          <Input
            label={t('settings.harness.interactive.trigger.minExplorationSteps')}
            type="number"
            value={getField('harness.trigger.minExplorationSteps', String(trigger.minExplorationSteps ?? 8)) as string}
            onChange={(e) => setField('harness.trigger.minExplorationSteps', e.target.value)}
          />
          <Input
            label={t('settings.harness.interactive.trigger.minConsecutiveErrors')}
            type="number"
            value={getField('harness.trigger.minConsecutiveErrors', String(trigger.minConsecutiveErrors ?? 3)) as string}
            onChange={(e) => setField('harness.trigger.minConsecutiveErrors', e.target.value)}
          />
          <Input
            label={t('settings.harness.interactive.trigger.cooldownMinutes')}
            type="number"
            value={getField('harness.rateLimit.cooldownMinutes', String(rateLimit.cooldownMinutes ?? 30)) as string}
            onChange={(e) => setField('harness.rateLimit.cooldownMinutes', e.target.value)}
          />
        </div>
      </section>

      {/* ── Section 3: Approval Strategy ── */}
      <section>
        <h3 className={sectionTitleClass}>{t('settings.harness.interactive.approval.title')}</h3>
        <div className={`${sectionCardClass} space-y-3`}>
          {APPROVAL_PRESETS.map((preset) => {
            const currentMode = getField('harness.interactive.approval.mode',
              ((interactive?.approval as Record<string, string>)?.mode || 'always_ask')) as string;
            return (
              <label key={preset.value} className="flex items-center gap-3 cursor-pointer py-1">
                <input
                  type="radio"
                  name="harnessApprovalPreset"
                  value={preset.value}
                  checked={currentMode === preset.value}
                  onChange={(e) => setField('harness.interactive.approval.mode', e.target.value)}
                  className="h-4 w-4 accent-blue-500 dark:accent-blue-400 border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-700 text-blue-500 dark:text-blue-400 focus:ring-blue-500/30 dark:focus:ring-blue-400/30"
                />
                <span className="text-sm text-neutral-700 dark:text-neutral-300">
                  {t(preset.labelKey)}
                </span>
              </label>
            );
          })}
          <div className="pt-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => showToast(t('settings.harness.interactive.approval.comingSoon'), 'info')}
            >
              {t('settings.harness.interactive.approval.customRules')}
            </Button>
          </div>
        </div>
      </section>

      {/* ── Section 4: Rate Limits ── */}
      <section>
        <h3 className={sectionTitleClass}>{t('settings.harness.interactive.rateLimit.title')}</h3>
        <div className={`${sectionCardClass} space-y-4`}>
          <div className="grid grid-cols-2 gap-4">
            <Input
              label={t('settings.harness.interactive.rateLimit.maxPerDay')}
              type="number"
              value={getField('harness.rateLimit.maxPerDay', String(rateLimit.maxPerDay ?? 10)) as string}
              onChange={(e) => setField('harness.rateLimit.maxPerDay', e.target.value)}
            />
            <Input
              label={t('settings.harness.interactive.rateLimit.maxPerHour')}
              type="number"
              value={getField('harness.rateLimit.maxPerHour', String(rateLimit.maxPerHour ?? 2)) as string}
              onChange={(e) => setField('harness.rateLimit.maxPerHour', e.target.value)}
            />
          </div>
          <Select
            label={t('settings.harness.interactive.proposal.model')}
            options={[
              { value: 'default', label: t('settings.harness.interactive.proposal.modelDefault') },
              { value: 'custom', label: t('settings.harness.interactive.proposal.modelCustom') },
            ]}
            value={proposalModelMode}
            onChange={(e) => {
              const mode = e.target.value as 'default' | 'custom';
              if (mode === 'default') {
                setUserSelectedCustom(false);
                setField('harness.proposal.model', 'default');
              } else {
                setUserSelectedCustom(true);
                const cur = getField('harness.proposal.model', proposal.model || '') as string;
                if (!cur || cur === 'default') {
                  setField('harness.proposal.model', '');
                }
              }
            }}
          />
          {proposalModelMode === 'custom' && (
            <Input
              value={getField('harness.proposal.model', (proposal.model || '') as string) as string}
              onChange={(e) => setField('harness.proposal.model', e.target.value)}
              placeholder={t('settings.harness.interactive.proposal.modelPlaceholder')}
            />
          )}
        </div>
      </section>
    </div>
  );
}
