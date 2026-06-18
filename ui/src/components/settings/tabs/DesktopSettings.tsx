import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { isElectron, getElectronAPI } from '../../../utils/env';
import { getToken } from '../../../utils/api';
import { useToast } from '../../ui/Toast';
import Spinner from '../../ui/Spinner';
import Button from '../../ui/Button';

type UpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error';

const GITHUB_REPO_URL = 'https://github.com/tscodeplus/OhMyAgent';
const GITHUB_ISSUES_URL = 'https://github.com/tscodeplus/OhMyAgent/issues';

/** Truncate release notes to a reasonable length for the toast. */
function truncateReleaseNotes(body: string, maxLen = 600): string {
  if (!body) return '';
  if (body.length <= maxLen) return body;
  return body.slice(0, maxLen).replace(/\n[^\n]*$/, '') + '\n…';
}

export default function DesktopSettings() {
  const { t } = useTranslation('common');
  const { showToast } = useToast();

  const [appVersion, setAppVersion] = useState('');
  const [loading, setLoading] = useState(true);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('idle');
  const [latestVersion, setLatestVersion] = useState('');
  const [updateError, setUpdateError] = useState('');
  const [releaseNotes, setReleaseNotes] = useState('');

  // Prevent duplicate toasts for the same version
  const toastedVersionRef = useRef('');

  // ── Load current version ──
  const loadVersion = useCallback(async () => {
    setLoading(true);
    try {
      if (isElectron()) {
        const ver = await getElectronAPI()!.getAppVersion();
        setAppVersion(ver);
      } else {
        const res = await fetch('/api/health');
        const data = await res.json();
        setAppVersion(data.version || '');
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadVersion();
  }, [loadVersion]);

  // ── WebUI: trigger server-side update (defined early — referenced by toast) ──
  const handleWebUIUpdate = useCallback(async () => {
    setUpdateError('');
    try {
      const token = getToken();
      const res = await fetch('/api/system/perform-update', {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await res.json();
      if (!data.ok) {
        throw new Error(data.error || 'Update failed');
      }
      setUpdateStatus('downloaded');
    } catch (err: any) {
      setUpdateError(err.message || 'Update failed');
      setUpdateStatus('error');
    }
  }, []);

  // ── Show update-available toast with release notes ──
  const showUpdateToast = useCallback((version: string, notes: string) => {
    if (toastedVersionRef.current === version) return;
    toastedVersionRef.current = version;

    const body = truncateReleaseNotes(notes);
    const message = body
      ? `${t('settings.about.newVersionAvailable', { version })}\n\n${body}`
      : t('settings.about.newVersionAvailable', { version });

    showToast(message, 'info', 0, [
      {
        label: t('settings.about.upgradeToLatest'),
        onClick: () => {
          if (isElectron()) {
            setUpdateStatus('downloading');
            getElectronAPI()!.downloadUpdate();
          } else {
            handleWebUIUpdate();
          }
        },
      },
      {
        label: t('common.cancel'),
        onClick: () => {
          toastedVersionRef.current = '';
        },
      },
    ]);
  }, [showToast, t, handleWebUIUpdate]);

  // ── Electron update event listeners ──
  useEffect(() => {
    if (!isElectron()) return;
    const api = getElectronAPI()!;

    api.onUpdateAvailable((info: any) => {
      const ver = info.version || '';
      const notes = info.releaseNotes || '';
      setLatestVersion(ver);
      setReleaseNotes(typeof notes === 'string' ? notes : '');
      setUpdateStatus('available');
      showUpdateToast(ver, typeof notes === 'string' ? notes : '');
    });

    api.onUpdateNotAvailable(() => {
      setUpdateStatus('up-to-date');
      showToast(t('settings.about.upToDate'), 'success', 3000);
    });

    api.onUpdateDownloaded((info: any) => {
      setLatestVersion(info.version || latestVersion);
      setUpdateStatus('downloaded');
    });

    api.onUpdateError((info: any) => {
      setUpdateError(info?.message || t('settings.about.githubUnreachable'));
      setUpdateStatus('error');
    });

    return () => {
      api.removeUpdateListeners();
    };
  }, [latestVersion, showUpdateToast, showToast, t]);

  // ── Check for updates ──
  const handleCheckUpdates = useCallback(async () => {
    setUpdateStatus('checking');
    setUpdateError('');

    if (isElectron()) {
      try {
        await getElectronAPI()!.checkForUpdates();
        // Result comes via event listeners above
      } catch {
        setUpdateError(t('settings.about.githubUnreachable'));
        setUpdateStatus('error');
      }
    } else {
      try {
        const token = getToken();
        const res = await fetch('/api/system/check-update', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const data = await res.json();

        if (!data.ok) {
          if (data.error === 'github_unreachable' || data.error === 'github_error') {
            setUpdateError(t('settings.about.githubUnreachable'));
          } else {
            setUpdateError(data.message || 'Unknown error');
          }
          setUpdateStatus('error');
          return;
        }

        setLatestVersion(data.latestVersion);
        setReleaseNotes(data.releaseNotes || '');
        setAppVersion(data.currentVersion);

        if (data.updateAvailable) {
          setUpdateStatus('available');
          showUpdateToast(data.latestVersion, data.releaseNotes || '');
        } else {
          setUpdateStatus('up-to-date');
          showToast(t('settings.about.upToDate'), 'success', 3000);
        }
      } catch (err: any) {
        setUpdateError(t('settings.about.githubUnreachable'));
        setUpdateStatus('error');
      }
    }
  }, [appVersion, showUpdateToast, showToast, t]);

  // ── Download update (Electron only) ──
  const handleDownloadUpdate = useCallback(async () => {
    setUpdateStatus('downloading');
    try {
      await getElectronAPI()!.downloadUpdate();
    } catch {
      setUpdateError('Failed to download update');
      setUpdateStatus('error');
    }
  }, []);

  // ── Install & restart (Electron only) ──
  const handleInstallUpdate = useCallback(async () => {
    try {
      await getElectronAPI()!.installUpdate();
    } catch {
      setUpdateError('Failed to install update');
      setUpdateStatus('error');
    }
  }, []);

  // ── Toast on downloaded / error status ──
  useEffect(() => {
    if (updateStatus === 'downloaded') {
      if (isElectron()) {
        showToast(t('settings.about.updateDownloaded'), 'success', 0, [
          {
            label: t('settings.about.installAndRestart'),
            onClick: () => handleInstallUpdate(),
          },
        ]);
      } else {
        showToast(t('settings.about.updateDownloaded'), 'success', 3000);
      }
      setUpdateStatus('idle');
    }
  }, [updateStatus, showToast, t, handleInstallUpdate]);

  useEffect(() => {
    if (updateStatus === 'error' && updateError) {
      showToast(updateError, 'error', 5000);
    }
  }, [updateStatus, updateError, showToast]);

  // ── Open external links ──
  const handleOpenUrl = useCallback((url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  const isChecking = updateStatus === 'checking';

  if (loading) return <div className="flex justify-center py-8"><Spinner /></div>;

  return (
    <div className="space-y-6">
      <section>
        {/* ── Logo ── */}
        <div className="flex flex-col items-center mb-6">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" fill="none" className="w-24 h-24">
            <defs>
              <linearGradient id="logo-bg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#6366f1"/>
                <stop offset="100%" stop-color="#4f46e5"/>
              </linearGradient>
            </defs>
            <rect x="64" y="64" width="896" height="896" rx="224" fill="url(#logo-bg)"/>
            <text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="580" font-weight="bold" fill="white">O</text>
          </svg>
          <p className="mt-3 text-sm font-semibold text-neutral-500 dark:text-neutral-400 text-center">
            OhMyAgent {appVersion ? `v${appVersion}` : ''}
          </p>
          <p className="mt-1 text-lg font-semibold text-neutral-800 dark:text-neutral-200 text-center">
            {t('settings.about.slogan')}
          </p>
        </div>

        {/* ── GitHub repo link + Submit Issue button ── */}
        <div className="flex items-center gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3 mb-3">
          <span className="text-xs text-neutral-500 dark:text-neutral-400 shrink-0 font-semibold">
            {t('settings.about.githubRepo')}
          </span>
          <a
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline truncate flex items-center gap-1"
          >
            {GITHUB_REPO_URL}
          </a>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => handleOpenUrl(GITHUB_ISSUES_URL)}
            className="ml-auto shrink-0"
          >
            <ExternalLink size={14} />
            {t('settings.about.submitIssue')}
          </Button>
        </div>

        {/* ── Action Buttons ── */}
        <div className="flex justify-start mt-4">
          <Button
            variant="secondary"
            size="sm"
            loading={isChecking}
            onClick={handleCheckUpdates}
          >
            {isChecking
              ? t('settings.about.checking')
              : t('settings.about.checkUpdates')}
          </Button>
        </div>
      </section>
    </div>
  );
}
