import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../../i18n/config';
import { useTheme } from '../../../contexts/ThemeContext';
import { useConfigDirty, type SettingsTabHandle } from '../useConfigDirty';
import { SettingsSection, SettingsCard } from '../SettingsSection';
import { syncLanguageToServer } from '../../../utils/syncLanguage';
import Input from '../../ui/Input';
import Select from '../../ui/Select';
import Toggle from '../../ui/Toggle';
import Button from '../../ui/Button';
import Spinner from '../../ui/Spinner';
import { useToast } from '../../ui/Toast';
import { apiRequest } from '../../../utils/api';
import { getElectronAPI } from '../../../utils/env';

interface GeneralSettingsProps {
  tabId?: string;
  registerHandle?: (tabId: string, handle: SettingsTabHandle | null) => void;
  onDirtyChange?: (tabId: string, dirty: boolean) => void;
}

export default function GeneralSettings({
  tabId = 'general',
  registerHandle,
  onDirtyChange,
}: GeneralSettingsProps) {
  const { t } = useTranslation('common');
  const { themeMode, setThemeMode } = useTheme();
  const { config, loading, dirtyCount, getField, setField, save, cancel } = useConfigDirty(
    tabId,
    registerHandle,
    onDirtyChange,
  );

  // Warn before leaving the page if there are unsaved changes
  useEffect(() => {
    if (dirtyCount === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirtyCount]);

  if (loading)
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  if (!config)
    return <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('common.error')}</p>;

  const logging = (config.logging as Record<string, string>) || {};
  const footer = (config.footer as Record<string, boolean>) || {};
  const showToolCalls = (config.showToolCalls as boolean) ?? true;
  const database = (config.database as Record<string, string>) || {};
  const rateLimit = (config.rateLimit as Record<string, number>) || {};
  const dbPath = database.path || '';
  const rateLimitMaxStr = String(rateLimit.webhookMaxRequests || 100);
  const rateLimitWindowStr = String(rateLimit.webhookWindowMs || 60000);

  // ── Auto-archive ──
  const autoArchive = (config.archive as Record<string, unknown> | undefined)?.auto as
    Record<string, unknown> | undefined;
  const autoArchiveEnabled = getField(
    'archive.auto.enabled',
    (autoArchive?.enabled as boolean) ?? false,
  ) as boolean;
  const autoArchiveDays = String(getField('archive.auto.days', autoArchive?.days ?? 30));

  const themeDesc =
    themeMode === 'system'
      ? t('settings.appearance.themeSystemDesc')
      : themeMode === 'dark'
        ? t('settings.appearance.themeDarkDesc')
        : t('settings.appearance.themeLightDesc');

  return (
    <div className="space-y-6">
      {/* ── Appearance (immediate — not part of save/cancel) ── */}
      <SettingsSection title={t('settings.appearance.title')}>
        <SettingsCard>
          <Select
            label={t('settings.appearance.theme')}
            value={themeMode}
            onChange={(e) => setThemeMode(e.target.value as 'system' | 'light' | 'dark')}
            options={[
              { value: 'dark', label: t('settings.appearance.themeDark') },
              { value: 'light', label: t('settings.appearance.themeLight') },
              { value: 'system', label: t('settings.appearance.themeSystem') },
            ]}
          />
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{themeDesc}</p>
          <Select
            label={t('settings.appearance.language')}
            value={i18n.language}
            onChange={(e) => {
              const lang = e.target.value;
              i18n.changeLanguage(lang).then(() => {
                getElectronAPI()?.setDesktopLanguage(lang);
              });
              void syncLanguageToServer(lang);
            }}
            options={[
              { value: 'en', label: 'English' },
              { value: 'zh-CN', label: '简体中文' },
            ]}
          />
          <Select
            label={t('settings.appearance.projectSort')}
            value="name"
            onChange={() => {}}
            options={[
              { value: 'date', label: t('settings.appearance.sortByDate') },
              { value: 'name', label: t('settings.appearance.sortByName') },
            ]}
          />
        </SettingsCard>
      </SettingsSection>

      {/* ── Log Level ── */}
      <SettingsCard>
        <Select
          label={t('settings.general.logLevel')}
          value={getField('logging.level', logging.level || 'info') as string}
          onChange={(e) => setField('logging.level', e.target.value)}
          options={['debug', 'error', 'fatal', 'info', 'trace', 'warn'].map((v) => ({
            value: v,
            label: v,
          }))}
        />
      </SettingsCard>

      {/* ── Show Tool Calls ── */}
      <SettingsCard>
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {t('settings.general.showToolCalls')}
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {t('settings.general.showToolCallsDesc')}
            </p>
          </div>
          <Toggle
            checked={getField('showToolCalls', showToolCalls) as boolean}
            onChange={(v) => setField('showToolCalls', v)}
          />
        </div>
      </SettingsCard>

      {/* ── Show Skill Calls ── */}
      <SettingsCard>
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {t('settings.general.showSkillCalls')}
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {t('settings.general.showSkillCallsDesc')}
            </p>
          </div>
          <Toggle
            checked={
              getField('showSkillCalls', (config.showSkillCalls as boolean) ?? true) as boolean
            }
            onChange={(v) => setField('showSkillCalls', v)}
          />
        </div>
      </SettingsCard>

      {/* ── Auto-archive ── */}
      <SettingsSection title={t('settings.general.autoArchiveTitle')}>
        <SettingsCard>
          <AutoArchiveCard
            enabled={autoArchiveEnabled}
            days={autoArchiveDays}
            onToggle={(v) => setField('archive.auto.enabled', v)}
            onDaysChange={(v) => setField('archive.auto.days', v)}
          />
        </SettingsCard>
      </SettingsSection>

      {/* ── Footer ── */}
      <SettingsSection title={t('settings.footer.title')}>
        <SettingsCard>
          {[
            { key: 'showAgentName', label: t('settings.footer.showAgentName') },
            { key: 'showModel', label: t('settings.footer.showModel') },
            { key: 'showCompleted', label: t('settings.footer.showCompleted') },
            { key: 'showElapsed', label: t('settings.footer.showElapsed') },
            { key: 'showUsage', label: t('settings.footer.showUsage') },
            { key: 'showCacheHitRate', label: t('settings.footer.showCacheHitRate') },
          ].map(({ key, label }) => (
            <div key={key} className="flex items-center justify-between">
              <span className="text-sm text-neutral-700 dark:text-neutral-300">{label}</span>
              <Toggle
                checked={getField(`footer.${key}`, !!footer[key]) as boolean}
                onChange={(v) => setField(`footer.${key}`, v)}
                ariaLabel={label}
              />
            </div>
          ))}
        </SettingsCard>
      </SettingsSection>

      {/* ── Advanced ── */}
      <SettingsSection title={t('settings.general.advanced')}>
        <SettingsCard className="space-y-4">
          <Input
            label={t('settings.general.databasePath')}
            value={getField('database.path', dbPath) as string}
            onChange={(e) => setField('database.path', e.target.value)}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label={t('settings.general.rateLimit')}
              type="number"
              value={getField('rateLimit.webhookMaxRequests', rateLimitMaxStr) as string}
              onChange={(e) => setField('rateLimit.webhookMaxRequests', e.target.value)}
            />
            <Input
              label={t('settings.general.rateLimitWindow')}
              type="number"
              value={getField('rateLimit.webhookWindowMs', rateLimitWindowStr) as string}
              onChange={(e) => setField('rateLimit.webhookWindowMs', e.target.value)}
            />
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}

/**
 * 自动归档 row: switch + threshold + a preview of the blast radius.
 *
 * Split into its own component so the preview's fetch/debounce state lives below
 * the tab's early returns (`loading` / `config === null`), which would otherwise
 * make the hook order conditional.
 *
 * The preview is the point of this card. Turning auto-archive on moves the whole
 * existing backlog on the first tick, so the count is shown *before* saving —
 * from `GET /api/archive/auto/preview`, which runs the same predicate the
 * maintenance job runs, so the number cannot drift from what will happen.
 */
function AutoArchiveCard({
  enabled,
  days,
  onToggle,
  onDaysChange,
}: {
  enabled: boolean;
  days: string;
  onToggle: (value: boolean) => void;
  onDaysChange: (value: string) => void;
}) {
  const { t } = useTranslation('common');
  const { showToast } = useToast();
  const [preview, setPreview] = useState<number | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [running, setRunning] = useState(false);
  const requestId = useRef(0);

  const daysNumber = Number.parseInt(days, 10);
  const effectiveDays = Number.isFinite(daysNumber) && daysNumber > 0 ? daysNumber : 30;

  useEffect(() => {
    // Debounced: the threshold field is a free-text number input, so every
    // keystroke would otherwise be a COUNT over the sessions table.
    const id = ++requestId.current;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await apiRequest<{ count: number }>(
            `/api/archive/auto/preview?days=${effectiveDays}`,
          );
          if (id !== requestId.current) return;
          setPreview(res.count);
          setPreviewFailed(false);
        } catch {
          if (id !== requestId.current) return;
          setPreviewFailed(true);
        }
      })();
    }, 400);
    return () => clearTimeout(timer);
  }, [effectiveDays]);

  const runNow = async () => {
    setRunning(true);
    try {
      const res = await apiRequest<{ archived: number; remaining: number }>(
        '/api/archive/auto/run',
        { method: 'POST', body: JSON.stringify({}) },
      );
      showToast(t('settings.general.autoArchiveRan', { count: res.archived }), 'success');
      setPreview(res.remaining);
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('common.error'), 'error');
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <label className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {t('settings.general.autoArchive')}
          </label>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {t('settings.general.autoArchiveDesc')}
          </p>
        </div>
        <Toggle
          checked={enabled}
          onChange={onToggle}
          ariaLabel={t('settings.general.autoArchive')}
        />
      </div>

      {/* The field keeps the default Input box (same height as every other numeric
          field in this tab); the button is matched to it by copying that box
          (border + py-2.5 + text-sm) instead of picking a Button size, whose
          paddings are smaller than an Input's. */}
      <div className="mt-3 flex items-end gap-2">
        <div className="w-32 min-w-0 shrink-0">
          <Input
            label={t('settings.general.autoArchiveDays')}
            type="number"
            min={1}
            max={3650}
            value={days}
            disabled={!enabled}
            onChange={(e) => onDaysChange(e.target.value)}
          />
        </div>
        <Button
          variant="secondary"
          size="md"
          className="shrink-0 py-2.5!"
          onClick={() => void runNow()}
          disabled={!enabled || running || preview === 0}
          loading={running}
        >
          {t('settings.general.autoArchiveRunNow')}
        </Button>
      </div>

      <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
        {previewFailed
          ? t('settings.general.autoArchivePreviewFailed')
          : preview === null
            ? t('settings.general.autoArchivePreviewLoading')
            : t('settings.general.autoArchivePreview', { count: preview, days: effectiveDays })}
      </p>
    </>
  );
}
