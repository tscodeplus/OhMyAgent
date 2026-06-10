import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../../../i18n/config';
import { useTheme } from '../../../contexts/ThemeContext';
import Select from '../../ui/Select';
import { useToast } from '../../ui/Toast';

export default function AppearanceSettings() {
  const { t } = useTranslation('common');
  const { showToast } = useToast();
  const { themeMode, setThemeMode } = useTheme();
  const [projectSortOrder, setProjectSortOrder] = useState('name');

  const handleLanguageChange = useCallback((lang: string) => {
    i18n.changeLanguage(lang).then(() => {
      showToast(i18n.t('common:settings.appearance.languageChanged'), 'success');
    });
  }, [showToast]);

  const themeDesc = themeMode === 'system' ? t('settings.appearance.themeSystemDesc')
    : themeMode === 'dark' ? t('settings.appearance.themeDarkDesc')
    : t('settings.appearance.themeLightDesc');

  return (
    <div className="space-y-8">
      <section>
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">{t('settings.appearance.title')}</h3>
        <div className="space-y-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
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
            onChange={(e) => handleLanguageChange(e.target.value)}
            options={[
              { value: 'en', label: 'English' },
              { value: 'zh-CN', label: '简体中文' },
            ]}
          />
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">{t('settings.appearance.projectSort')}</h3>
        <div className="space-y-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
          <Select
            label={t('settings.appearance.sortLabel')}
            value={projectSortOrder}
            onChange={(e) => setProjectSortOrder(e.target.value)}
            options={[
              { value: 'date', label: t('settings.appearance.sortByDate') },
              { value: 'name', label: t('settings.appearance.sortByName') },
            ]}
          />
        </div>
      </section>
    </div>
  );
}
