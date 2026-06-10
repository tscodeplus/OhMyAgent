import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { isElectron, getElectronAPI } from '../../../utils/env';
import Toggle from '../../ui/Toggle';
import Button from '../../ui/Button';

export default function DesktopSettings() {
  const { t } = useTranslation('common');

  const [autoStart, setAutoStart] = useState(false);
  const [closeToTray, setCloseToTray] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [loading, setLoading] = useState(true);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  const loadSettings = useCallback(async () => {
    console.log('[OhMyAgent] DesktopSettings loadSettings called, isElectron:', isElectron());
    if (!isElectron()) return;
    setLoading(true);
    try {
      const api = getElectronAPI()!;
      console.log('[OhMyAgent] DesktopSettings: electronAPI keys:', Object.keys(api));
      const [as, ct, ver] = await Promise.all([
        api.getAutoStart(),
        api.getConfig('closeToTray') as Promise<boolean>,
        api.getAppVersion(),
      ]);
      console.log('[OhMyAgent] DesktopSettings loaded:', { autoStart: as, closeToTray: ct, appVersion: ver });
      setAutoStart(as);
      setCloseToTray(!!ct);
      setAppVersion(ver);
    } catch (err) {
      console.error('[OhMyAgent] DesktopSettings loadSettings error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const handleAutoStartToggle = useCallback(async (enable: boolean) => {
    try {
      await getElectronAPI()!.setAutoStart(enable);
      setAutoStart(enable);
    } catch {
      // ignore
    }
  }, []);

  const handleCloseToTrayToggle = useCallback(async (value: boolean) => {
    try {
      await getElectronAPI()!.setConfig('closeToTray', value);
      setCloseToTray(value);
    } catch {
      // ignore
    }
  }, []);

  const handleCheckUpdates = useCallback(async () => {
    setCheckingUpdate(true);
    try {
      await getElectronAPI()!.checkForUpdates();
    } catch {
      // ignore
    } finally {
      setCheckingUpdate(false);
    }
  }, []);

  const handleOpenDataDir = useCallback(async () => {
    try {
      await getElectronAPI()!.openDataDir();
    } catch {
      // ignore
    }
  }, []);

  // Only render in Electron
  if (!isElectron()) return null;

  return (
    <div className="space-y-6">
      {/* ── Desktop Settings ── */}
      <section>
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">
          {t('settings.desktop.title')}
        </h3>

        {/* Auto-start */}
        <div className="flex items-center justify-between rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 mb-3">
          <div>
            <label className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {t('settings.desktop.autoStart')}
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {t('settings.desktop.autoStartDesc')}
            </p>
          </div>
          <Toggle
            checked={autoStart}
            onChange={handleAutoStartToggle}
            ariaLabel={t('settings.desktop.autoStart')}
            disabled={loading}
          />
        </div>

        {/* Close to Tray */}
        <div className="flex items-center justify-between rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 mb-3">
          <div>
            <label className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {t('settings.desktop.closeToTray')}
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {t('settings.desktop.closeToTrayDesc')}
            </p>
          </div>
          <Toggle
            checked={closeToTray}
            onChange={handleCloseToTrayToggle}
            ariaLabel={t('settings.desktop.closeToTray')}
            disabled={loading}
          />
        </div>

        {/* App Version */}
        <div className="flex items-center justify-between rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 mb-3">
          <div>
            <label className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {t('settings.desktop.appVersion')}
            </label>
          </div>
          <span className="text-sm text-neutral-600 dark:text-neutral-400">
            {appVersion || '...'}
          </span>
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap gap-3">
          <Button
            variant="secondary"
            size="sm"
            loading={checkingUpdate}
            onClick={handleCheckUpdates}
          >
            {checkingUpdate
              ? t('settings.desktop.checkingUpdates')
              : t('settings.desktop.checkUpdates')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleOpenDataDir}
          >
            {t('settings.desktop.openDataDir')}
          </Button>
        </div>
      </section>
    </div>
  );
}
