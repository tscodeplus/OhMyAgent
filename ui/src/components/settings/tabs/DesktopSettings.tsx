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

/** Strip HTML tags and decode common entities for plain-text display. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Truncate release notes to a reasonable length for the toast. */
function truncateReleaseNotes(body: string, maxLen = 2000): string {
  if (!body) return '';
  const plain = stripHtml(body);
  if (plain.length <= maxLen) return plain;
  return plain.slice(0, maxLen).replace(/\n[^\n]*$/, '') + '\n…';
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
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [updateStep, setUpdateStep] = useState('');

  // Prevent duplicate toasts for the same version
  const toastedVersionRef = useRef('');
  // Track whether a download was attempted (to classify errors accurately)
  const downloadAttemptedRef = useRef(false);
  // Polling interval ref for WebUI update progress
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      // Show progress bar and start polling for status
      setDownloadPercent(0);
      setUpdateStep(t('settings.about.updateProgress.starting'));
      setUpdateStatus('downloading');

      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);

      let pollCount = 0;
      const MAX_POLLS = 18; // 3 minutes with 10s interval
      pollIntervalRef.current = setInterval(async () => {
        pollCount++;
        if (pollCount > MAX_POLLS) {
          if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null; }
          setUpdateError(t('settings.about.updateTimeout'));
          setUpdateStatus('error');
          return;
        }
        try {
          const statusRes = await fetch('/api/system/update-status');
          const statusData = await statusRes.json();
          setDownloadPercent(statusData.percent ?? 0);

          // Map status code to i18n text; use raw step for error messages
          const code = statusData.status;
          const progressKey = (code && code !== 'complete' && code !== 'error')
            ? t(`settings.about.updateProgress.${code}`, statusData.step || '')
            : (statusData.step || '');
          setUpdateStep(progressKey);

          if (code === 'complete') {
            if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null; }
            setUpdateStatus('downloaded');
          } else if (code === 'error') {
            if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null; }
            setUpdateError(statusData.step || 'Update failed');
            setUpdateStatus('error');
          }
        } catch {
          // Server may be restarting — keep polling
        }
      }, 10_000);
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
        label: t('common.cancel'),
        onClick: () => {
          toastedVersionRef.current = '';
        },
      },
      {
        label: t('settings.about.upgradeToLatest'),
        onClick: () => {
          if (isElectron()) {
            downloadAttemptedRef.current = true;
            setUpdateStatus('downloading');
            getElectronAPI()!.downloadUpdate();
          } else {
            handleWebUIUpdate();
          }
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

    api.onUpdateDownloadProgress((info: any) => {
      setDownloadPercent(Math.round(info.percent || 0));
    });

    api.onUpdateDownloaded((info: any) => {
      downloadAttemptedRef.current = false;
      setLatestVersion(info.version || latestVersion);
      setUpdateStatus('downloaded');
    });

    api.onUpdateError((info: any) => {
      const msg = info?.message || t('settings.about.githubUnreachable');
      setUpdateError(msg);
      setUpdateStatus('error');

      // If a download was attempted, offer a fallback to GitHub Releases
      if (downloadAttemptedRef.current) {
        downloadAttemptedRef.current = false;
        showToast(msg, 'error', 0, [
          {
            label: t('settings.about.openGithubReleases'),
            onClick: () => window.open(GITHUB_REPO_URL + '/releases', '_blank', 'noopener,noreferrer'),
          },
          {
            label: t('common.cancel'),
            onClick: () => {},
          },
        ]);
      }
    });

    return () => {
      api.removeUpdateListeners();
    };
  }, [latestVersion, showUpdateToast, showToast, t]);

  // ── Cleanup polling interval on unmount ──
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  // ── Check for updates ──
  const handleCheckUpdates = useCallback(async () => {
    // Clear any ongoing polling from a previous upgrade attempt
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    setUpdateStatus('checking');
    setUpdateError('');
    setLatestVersion('');
    setReleaseNotes('');

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

  // ── Cancel download / upgrade ──
  const handleCancelDownload = useCallback(async () => {
    if (isElectron()) {
      try {
        await getElectronAPI()!.cancelDownload();
      } catch {
        // ignore
      }
    }
    // Clear polling interval (WebUI) and reset all state
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    setUpdateStatus('idle');
    setDownloadPercent(0);
    setUpdateStep('');
    setUpdateError('');
    downloadAttemptedRef.current = false;
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
        showToast(t('settings.about.updateComplete'), 'success', 3000);
      }
      setUpdateStatus('idle');
    }
  }, [updateStatus, showToast, t, handleInstallUpdate]);

  useEffect(() => {
    // Show error toast. For Electron download errors, onUpdateError callback
    // already shows a toast with fallback actions — skip the duplicate here.
    // For WebUI, always show the error toast (including upgrade failures).
    if (updateStatus === 'error' && updateError) {
      const isElectronDownloadError = isElectron() && !!latestVersion;
      if (!isElectronDownloadError) {
        showToast(updateError, 'error', 5000);
      }
    }
  }, [updateStatus, updateError, latestVersion, showToast]);

  // ── Open external links ──
  const handleOpenUrl = useCallback((url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  const isChecking = updateStatus === 'checking';
  const isDownloading = updateStatus === 'downloading';

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
        <div className="flex flex-col items-start gap-3 mt-4">
          <Button
            variant="secondary"
            size="sm"
            loading={isChecking}
            disabled={isDownloading}
            onClick={handleCheckUpdates}
          >
            {isChecking
              ? t('settings.about.checking')
              : t('settings.about.checkUpdates')}
          </Button>

          {/* Download progress bar */}
          {isDownloading && (
            <div className="w-full max-w-[320px] space-y-2">
              <div className="flex items-center justify-between text-xs text-neutral-500 dark:text-neutral-400">
                <span>{updateStep || t('settings.about.downloading')}</span>
                <span className="font-mono tabular-nums">{downloadPercent}%</span>
              </div>
              <div className="w-full h-2 rounded-full bg-neutral-200 dark:bg-neutral-700 overflow-hidden">
                <div
                  className="h-full rounded-full bg-indigo-500 transition-[width] duration-300 ease-out"
                  style={{ width: `${downloadPercent}%` }}
                />
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleCancelDownload}
                className="w-full"
              >
                {t('common.cancel')}
              </Button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
