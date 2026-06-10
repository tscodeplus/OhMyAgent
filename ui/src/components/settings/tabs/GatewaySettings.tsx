import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { getElectronAPI, isElectron } from '../../../utils/env';
import Toggle from '../../ui/Toggle';
import Input from '../../ui/Input';
import Button from '../../ui/Button';
import PasswordInput from '../../ui/PasswordInput';
import type { SettingsTabHandle } from '../useConfigDirty';

interface GatewayConfig {
  mode: 'local' | 'remote';
  remoteUrl: string;
  remoteToken: string;
}

interface GatewaySettingsProps {
  registerHandle?: (tabId: string, handle: SettingsTabHandle | null) => void;
  onDirtyChange?: (tabId: string, dirty: boolean) => void;
}

const TAB_ID = 'gateway';

export default function GatewaySettings({ registerHandle, onDirtyChange }: GatewaySettingsProps) {
  const { t } = useTranslation('common');

  // Saved config (from electron-store)
  const [savedConfig, setSavedConfig] = useState<GatewayConfig>({ mode: 'local', remoteUrl: '', remoteToken: '' });
  // Working copy (modified by user, not yet saved)
  const [mode, setMode] = useState<'local' | 'remote'>('local');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remoteToken, setRemoteToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Dirty check
  const isDirty = useMemo(() => {
    return mode !== savedConfig.mode
      || remoteUrl !== savedConfig.remoteUrl
      || remoteToken !== savedConfig.remoteToken;
  }, [mode, remoteUrl, remoteToken, savedConfig]);

  // Report dirty state to SettingsModal
  useEffect(() => {
    onDirtyChange?.(TAB_ID, isDirty);
  }, [isDirty, onDirtyChange]);

  // Load from electron-store (or use localStorage in browser for debugging)
  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      if (!isElectron()) { setLoading(false); return; }
      const api = getElectronAPI()!;
      const config = (await api.getGatewayConfig()) as GatewayConfig;
      if (config) {
        const cfg = { mode: config.mode || 'local' as const, remoteUrl: config.remoteUrl || '', remoteToken: config.remoteToken || '' };
        setSavedConfig(cfg);
        setMode(cfg.mode);
        setRemoteUrl(cfg.remoteUrl);
        setRemoteToken(cfg.remoteToken);
      }
    } catch (err) {
      console.error('[GatewaySettings] Failed to load gateway config:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  // ── Save / Cancel via SettingsTabHandle ──
  const save = useCallback(async () => {
    if (!isElectron()) return;
    setSaving(true);
    try {
      await getElectronAPI()!.setGatewayConfig({ mode, remoteUrl, remoteToken });
      setSavedConfig({ mode, remoteUrl, remoteToken });
      setTestResult(null);
    } catch (err) {
      console.error('[GatewaySettings] Failed to save:', err);
      throw err;
    } finally {
      setSaving(false);
    }
  }, [mode, remoteUrl, remoteToken]);

  const cancel = useCallback(() => {
    setMode(savedConfig.mode);
    setRemoteUrl(savedConfig.remoteUrl);
    setRemoteToken(savedConfig.remoteToken);
    setTestResult(null);
  }, [savedConfig]);

  // Register handle with SettingsModal
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;
  const saveRef = useRef(save);
  saveRef.current = save;
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;

  useEffect(() => {
    const handle: SettingsTabHandle = {
      save: (opts) => saveRef.current(),
      cancel: () => cancelRef.current(),
      isDirty: () => isDirtyRef.current,
      needsRestart: () => isDirtyRef.current,
    };
    registerHandle?.(TAB_ID, handle);
    return () => registerHandle?.(TAB_ID, null);
  }, []); // Only on mount/unmount

  // ── Test connection ──
  const handleTestConnection = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    const cleanUrl = remoteUrl.replace(/\/+$/, '');
    const healthUrl = `${cleanUrl}/api/health`;
    try {
      // Step 1: health check
      const ctrl = new AbortController();
      const healthTimer = setTimeout(() => ctrl.abort(), 5000);
      let res: Response;
      try {
        res = await fetch(healthUrl, {
          headers: remoteToken ? { Authorization: `Bearer ${remoteToken}` } : {},
          signal: ctrl.signal,
        });
      } catch (err: any) {
        clearTimeout(healthTimer);
        const detail = err?.message || String(err);
        setTestResult({ ok: false, message: t('settings.gateway.gatewayUnreachable', '网关无法连接或不在线') + ` (${detail})` });
        setTesting(false);
        return;
      }
      clearTimeout(healthTimer);
      if (!res.ok) {
        setTestResult({ ok: false, message: t('settings.gateway.gatewayUnreachable', '网关无法连接或不在线') + ` (HTTP ${res.status})` });
        setTesting(false);
        return;
      }
      let version = '?';
      try { const data = await res.json(); version = data.version || '?'; } catch { /* ignore */ }
      const versionSuffix = ` (v${version})`;
      // Step 2: verify token (required for remote gateway)
      if (!remoteToken) {
        setTestResult({ ok: false, message: t('settings.gateway.serverOnlineTokenInvalid', '网关在线但令牌无效') + versionSuffix });
      } else {
        const ctrl2 = new AbortController();
        const verifyTimer = setTimeout(() => ctrl2.abort(), 5000);
        try {
          const vres = await fetch(`${cleanUrl}/api/auth/verify`, {
            headers: { Authorization: `Bearer ${remoteToken}` },
            signal: ctrl2.signal,
          });
          clearTimeout(verifyTimer);
          if (vres.ok) {
            setTestResult({ ok: true, message: t('settings.gateway.connected', '连接成功') + versionSuffix });
          } else {
            setTestResult({ ok: false, message: t('settings.gateway.serverOnlineTokenInvalid', '网关在线但令牌无效') + versionSuffix });
          }
        } catch {
          clearTimeout(verifyTimer);
          setTestResult({ ok: false, message: t('settings.gateway.serverOnlineTokenInvalid', '网关在线但令牌无效') + versionSuffix });
        }
      }
    } catch (err: any) {
      setTestResult({ ok: false, message: t('settings.gateway.gatewayUnreachable', '网关无法连接或不在线') + ` (${err?.message || String(err)})` });
    } finally {
      setTesting(false);
    }
  }, [remoteUrl, remoteToken, t]);

  return (
    <div className="space-y-6">
      {/* ── Gateway Mode ── */}
      <section>
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">
          {t('settings.gateway.title', 'Gateway Connection')}
        </h3>

        <div className="flex items-center justify-between rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 mb-3">
          <div>
            <label className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {t('settings.gateway.remote', 'Remote Gateway')}
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {mode === 'remote'
                ? t('settings.gateway.remoteDesc', 'Connected to a remote OhMyAgent instance')
                : t('settings.gateway.localDesc', 'Using the embedded local server')}
            </p>
          </div>
          <Toggle
            checked={mode === 'remote'}
            onChange={(isRemote) => setMode(isRemote ? 'remote' : 'local')}
            ariaLabel={t('settings.gateway.remote', 'Remote Gateway')}
            disabled={loading || saving}
          />
        </div>

        <p className="text-xs text-amber-600 dark:text-amber-400">
          {t('settings.gateway.restartHint', 'Changes take effect after restarting the app.')}
        </p>
      </section>

      {/* ── Remote Config ── */}
      {mode === 'remote' && (
        <section>
          <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">
            {t('settings.gateway.remoteConfig', 'Remote Gateway Configuration')}
          </h3>
          <div className="space-y-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
            <Input
              label={t('settings.gateway.url', 'Gateway URL')}
              placeholder={t('settings.gateway.urlPlaceholder', 'http://192.168.1.100:9191') || ''}
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
            />
            <PasswordInput
              label={t('settings.gateway.token', 'Auth Token')}
              value={remoteToken}
              onChange={(e) => setRemoteToken(e.target.value)}
              placeholder={t('settings.gateway.tokenPlaceholder', 'Look up token from remote .env file or startup log') || ''}
            />

            {/* ── Test Connection ── */}
            <div className="flex items-center gap-3 pt-1">
              <Button
                variant="secondary"
                size="sm"
                loading={testing}
                onClick={handleTestConnection}
                disabled={!remoteUrl.trim()}
              >
                {testing
                  ? t('settings.gateway.testing', 'Testing...')
                  : t('settings.gateway.testConnection', 'Test Connection')}
              </Button>
              {testResult && (
                <span className={`text-xs ${testResult.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                  {testResult.message}
                </span>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ── Local Status ── */}
      {mode === 'local' && (
        <section>
          <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3">
            {t('settings.gateway.local', 'Local Gateway')}
          </h3>
          <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4">
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {t('settings.gateway.localStatus', 'Using the embedded local server. Enable "Remote Gateway" above to connect to another instance.')}
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
