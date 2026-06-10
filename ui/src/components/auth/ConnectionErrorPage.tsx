import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { WifiOff, ArrowLeft, RefreshCw, Settings } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { isElectron } from '../../utils/env';

interface ConnectionErrorPageProps {
  /** The error message to display. */
  error: string;
  /** The remote gateway URL that was attempted (for display). */
  remoteUrl: string;
  /** Called after switching to local gateway to re-run auth. */
  onRetry: () => void;
}

export default function ConnectionErrorPage({
  error,
  remoteUrl,
  onRetry,
}: ConnectionErrorPageProps) {
  const { t } = useTranslation('common');
  const [switching, setSwitching] = useState(false);
  const [retrying, setRetrying] = useState(false);

  /** Switch to local gateway mode, then retry auth. */
  const handleSwitchToLocal = useCallback(async () => {
    setSwitching(true);
    try {
      if (isElectron()) {
        // Persist the mode change to Electron store so it sticks on next launch
        await window.electronAPI!.setGatewayConfig({
          mode: 'local',
          remoteUrl: remoteUrl,
          remoteToken: '',
        });
      }
      // Also update localStorage for the web context (belt-and-suspenders)
      localStorage.setItem('ohmyagent_gateway_mode', 'local');
    } catch (err) {
      console.error('[ConnectionErrorPage] Failed to switch to local mode:', err);
    }
    // Reload the page so AuthContext picks up the new mode cleanly
    window.location.reload();
  }, [remoteUrl]);

  const handleRetry = useCallback(() => {
    setRetrying(true);
    onRetry();
    // After a short delay, reset the button state (retry triggers re-auth in AuthContext)
    setTimeout(() => setRetrying(false), 2000);
  }, [onRetry]);

  const electron = isElectron();

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-neutral-50 dark:bg-neutral-950">
      <div className="w-full max-w-md mx-4">
        <div className="rounded-xl border border-red-200 dark:border-red-800 bg-white dark:bg-neutral-900 p-8 shadow-lg">
          {/* ── Icon + Title ── */}
          <div className="flex flex-col items-center mb-6">
            <div className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/40 mb-4">
              <WifiOff className="h-7 w-7 text-red-600 dark:text-red-400" strokeWidth={1.5} />
            </div>
            <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 text-center">
              {t('auth.connectionError', '连接失败')}
            </h1>
            <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400 text-center leading-relaxed">
              {t(
                'auth.connectionErrorDesc',
                '无法连接到远程网关，请检查网关地址和网络连接。',
              )}
            </p>
          </div>

          {/* ── Remote URL ── */}
          {remoteUrl && (
            <div className="mb-6 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 px-4 py-3">
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-1">
                {t('auth.remoteUrlLabel', '目标网关')}
              </p>
              <p className="text-sm font-mono text-neutral-700 dark:text-neutral-300 break-all">
                {remoteUrl}
              </p>
            </div>
          )}

          {/* ── Error detail ── */}
          <div className="mb-6 rounded-lg border border-red-100 dark:border-red-900/40 bg-red-50 dark:bg-red-950/30 px-4 py-3">
            <p className="text-xs text-red-600 dark:text-red-400 break-all">{error}</p>
          </div>

          {/* ── Action Buttons ── */}
          <div className="space-y-3">
            {electron && (
              <button
                onClick={handleSwitchToLocal}
                disabled={switching}
                className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-500 dark:hover:bg-blue-600 transition-colors"
              >
                {switching ? (
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                    <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" className="opacity-75" />
                  </svg>
                ) : (
                  <ArrowLeft size={16} />
                )}
                {t('auth.switchToLocal', '切换到本地网关')}
              </button>
            )}
            <button
              onClick={handleRetry}
              disabled={retrying}
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700 transition-colors"
            >
              {retrying ? (
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                  <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" className="opacity-75" />
                </svg>
              ) : (
                <RefreshCw size={16} />
              )}
              {t('auth.retryConnection', '重试连接')}
            </button>
            {!electron && (
              <button
                onClick={handleSwitchToLocal}
                disabled={switching}
                className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700 transition-colors"
              >
                <Settings size={16} />
                {t('auth.configureGateway', '配置网关设置')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
