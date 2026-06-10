import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../../i18n/config';
import { useTheme } from '../../../contexts/ThemeContext';
import { useConfigDirty, type SettingsTabHandle } from '../useConfigDirty';
import Input from '../../ui/Input';
import Select from '../../ui/Select';
import Toggle from '../../ui/Toggle';
import Spinner from '../../ui/Spinner';

interface GeneralSettingsProps {
  tabId?: string;
  registerHandle?: (tabId: string, handle: SettingsTabHandle | null) => void;
  onDirtyChange?: (tabId: string, dirty: boolean) => void;
}

export default function GeneralSettings({ tabId = 'general', registerHandle, onDirtyChange }: GeneralSettingsProps) {
  const { t } = useTranslation('common');
  const { themeMode, setThemeMode } = useTheme();
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

  const logging = (config.logging as Record<string, string>) || {};
  const footer = (config.footer as Record<string, boolean>) || {};
  const showToolCalls = config.showToolCalls as boolean ?? true;
  const database = (config.database as Record<string, string>) || {};
  const rateLimit = (config.rateLimit as Record<string, number>) || {};
  const dbPath = database.path || '';
  const rateLimitMaxStr = String(rateLimit.webhookMaxRequests || 100);
  const rateLimitWindowStr = String(rateLimit.webhookWindowMs || 60000);

  const themeDesc = themeMode === 'system' ? t('settings.appearance.themeSystemDesc')
    : themeMode === 'dark' ? t('settings.appearance.themeDarkDesc')
    : t('settings.appearance.themeLightDesc');

  return (
    <div className="space-y-6">
      {/* ── Appearance (immediate — not part of save/cancel) ── */}
      <section>
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">{t('settings.appearance.title')}</h3>
        <div className="space-y-3 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
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
              i18n.changeLanguage(e.target.value).then(() => {
                // Language change is immediate (client-side only)
              });
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
        </div>
      </section>

      {/* ── Log Level ── */}
      <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
        <Select
          label={t('settings.general.logLevel')}
          value={getField('logging.level', logging.level || 'info') as string}
          onChange={(e) => setField('logging.level', e.target.value)}
          options={['debug', 'error', 'fatal', 'info', 'trace', 'warn'].map(v => ({ value: v, label: v }))}
        />
      </section>

      {/* ── Show Tool Calls ── */}
      <section className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
        <div className="flex items-center justify-between">
          <div>
            <label className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{t('settings.general.showToolCalls')}</label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('settings.general.showToolCallsDesc')}</p>
          </div>
          <Toggle
            checked={getField('showToolCalls', showToolCalls) as boolean}
            onChange={(v) => setField('showToolCalls', v)}
          />
        </div>
      </section>

      {/* ── Footer ── */}
      <section>
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">{t('settings.footer.title')}</h3>
        <div className="space-y-3 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
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
        </div>
      </section>

      {/* ── Advanced ── */}
      <section>
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">{t('settings.general.advanced')}</h3>
        <div className="space-y-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
          <Input
            label={t('settings.general.databasePath')}
            value={getField('database.path', dbPath) as string}
            onChange={(e) => setField('database.path', e.target.value)}
          />
          <div className="grid grid-cols-2 gap-4">
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
        </div>
      </section>
    </div>
  );
}
