import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import { useToast } from '../../ui/Toast';
import { apiRequest } from '../../../utils/api';
import Button from '../../ui/Button';
import Spinner from '../../ui/Spinner';
import DeviceCodeModal from '../../subscription/DeviceCodeModal';

interface SubscriptionState {
  providerId: string;
  providerName: string;
  loggedIn: boolean;
  expiresAt: number | null;
}

interface DeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
}

type LoginStage =
  | { type: 'idle' }
  | { type: 'loading' }
  | { type: 'device_code'; info: DeviceCodeInfo }
  | { type: 'auth_url'; url: string }
  | { type: 'waiting' }
  | { type: 'error'; message: string };

export default function SubscriptionsSettings() {
  const { t } = useTranslation('common');
  const { showToast } = useToast();
  const { connected, subscribe, sendMessage } = useWebSocket();

  const [subscriptions, setSubscriptions] = useState<SubscriptionState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loginStage, setLoginStage] = useState<Record<string, LoginStage>>({});

  // ── Fetch subscription statuses ─────────────────────────────────────

  const fetchStatuses = useCallback(async () => {
    try {
      const data = await apiRequest<{ subscriptions: SubscriptionState[] }>('/api/subscriptions');
      setSubscriptions(data.subscriptions);
      setError(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load subscriptions';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatuses();
  }, [fetchStatuses]);

  // ── Listen for WebSocket progress events ────────────────────────────

  useEffect(() => {
    const unsub = subscribe('subscription_progress', (raw: unknown) => {
      const msg = raw as {
        type: string;
        stage: string;
        providerId: string;
        data: Record<string, unknown>;
      };

      if (msg.type === 'subscription_progress') {
        const { providerId, stage, data: innerData } = msg;
        switch (stage) {
          case 'device_code':
            setLoginStage((prev) => ({
              ...prev,
              [providerId]: {
                type: 'device_code',
                info: innerData as unknown as DeviceCodeInfo,
              },
            }));
            break;
          case 'auth_url':
            setLoginStage((prev) => ({
              ...prev,
              [providerId]: { type: 'auth_url', url: innerData.url as string },
            }));
            // Automatically open the auth URL in a new tab
            window.open(innerData.url as string, '_blank');
            break;
          case 'progress':
            setLoginStage((prev) => ({
              ...prev,
              [providerId]: { type: 'waiting' },
            }));
            break;
          case 'success':
            setLoginStage((prev) => ({ ...prev, [providerId]: { type: 'idle' } }));
            fetchStatuses();
            showToast(
              t('settings.subscriptions.loginSuccess', { provider: providerId }),
              'success',
            );
            break;
          case 'error':
            setLoginStage((prev) => ({
              ...prev,
              [providerId]: { type: 'error', message: innerData.message as string },
            }));
            showToast(
              t('settings.subscriptions.loginError', {
                provider: providerId,
                error: innerData.message as string,
              }),
              'error',
            );
            break;
        }
      }
    });
    return unsub;
  }, [subscribe, fetchStatuses, showToast, t]);

  // ── Login ───────────────────────────────────────────────────────────

  const handleLogin = useCallback(
    async (providerId: string) => {
      setLoginStage((prev) => ({ ...prev, [providerId]: { type: 'loading' } }));

      try {
        // Subscribe to WebSocket channel first
        if (connected) {
          sendMessage({ type: 'subscribe', channel: `subscription:${providerId}` });
        }

        await apiRequest('/api/subscriptions/login', {
          method: 'POST',
          body: JSON.stringify({ providerId }),
        });
        // Response is { accepted: true } — real progress comes via WebSocket
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Login failed';
        setLoginStage((prev) => ({
          ...prev,
          [providerId]: { type: 'error', message: msg },
        }));
        showToast(msg, 'error');
      }
    },
    [connected, sendMessage, showToast],
  );

  // ── Logout ──────────────────────────────────────────────────────────

  const handleLogout = useCallback(
    async (providerId: string) => {
      try {
        await apiRequest(`/api/subscriptions/${providerId}`, { method: 'DELETE' });
        showToast(t('settings.subscriptions.logoutSuccess', { provider: providerId }), 'success');
        fetchStatuses();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Logout failed';
        showToast(msg, 'error');
      }
    },
    [fetchStatuses, showToast, t],
  );

  // ── Dismiss error / device code ─────────────────────────────────────

  const dismissStage = useCallback((providerId: string) => {
    setLoginStage((prev) => ({ ...prev, [providerId]: { type: 'idle' } }));
  }, []);

  // ── Render ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-4">
        <p className="text-sm text-red-600 dark:text-red-400 mb-3">{error}</p>
        <Button variant="secondary" size="sm" onClick={fetchStatuses}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        {t('settings.subscriptions.description')}
      </p>

      {subscriptions.map((sub) => {
        const stage = loginStage[sub.providerId] || { type: 'idle' };
        const isBusy = stage.type !== 'idle' && stage.type !== 'error';

        return (
          <div
            key={sub.providerId}
            className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4"
          >
            <div className="flex items-center justify-between">
              <div className="flex-1 min-w-0">
                {/* Provider name */}
                <h4 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                  {sub.providerName}
                </h4>

                {/* Status */}
                <div className="mt-1 flex items-center gap-2">
                  {sub.loggedIn ? (
                    <>
                      <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
                      <span className="text-xs text-green-700 dark:text-green-400">
                        {t('settings.subscriptions.status.loggedIn')}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="inline-block w-2 h-2 rounded-full bg-neutral-400" />
                      <span className="text-xs text-neutral-500 dark:text-neutral-400">
                        {t('settings.subscriptions.status.loggedOut')}
                      </span>
                    </>
                  )}

                  {/* Expiration */}
                  {sub.expiresAt && sub.loggedIn && (
                    <span className="text-xs text-neutral-500 dark:text-neutral-400">
                      ·{' '}
                      {t('settings.subscriptions.expiresIn', {
                        time: formatRelativeTime(sub.expiresAt),
                      })}
                    </span>
                  )}
                </div>

                {/* Error message */}
                {stage.type === 'error' && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                    {stage.message}
                  </p>
                )}
              </div>

              {/* Actions */}
              <div className="ml-4 flex items-center gap-2 shrink-0">
                {isBusy ? (
                  <Button variant="secondary" size="sm" disabled>
                    <Spinner className="h-3 w-3 mr-1" />
                    {t('settings.subscriptions.loggingIn')}
                  </Button>
                ) : sub.loggedIn ? (
                  <Button variant="secondary" size="sm" onClick={() => handleLogout(sub.providerId)}>
                    {t('settings.subscriptions.logout')}
                  </Button>
                ) : (
                  <Button variant="primary" size="sm" onClick={() => handleLogin(sub.providerId)}>
                    {t('settings.subscriptions.login')}
                  </Button>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {/* Device Code Modal */}
      {Object.entries(loginStage).map(([providerId, stage]) =>
        stage.type === 'device_code' ? (
          <DeviceCodeModal
            key={providerId}
            providerName={subscriptions.find((s) => s.providerId === providerId)?.providerName ?? providerId}
            userCode={stage.info.userCode}
            verificationUri={stage.info.verificationUri}
            expiresInSeconds={stage.info.expiresInSeconds}
            onClose={() => dismissStage(providerId)}
          />
        ) : null,
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

function formatRelativeTime(expiresAt: number): string {
  const remaining = Math.max(0, expiresAt - Date.now());
  const days = Math.floor(remaining / 86400000);
  const hours = Math.floor((remaining % 86400000) / 3600000);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  const mins = Math.floor((remaining % 3600000) / 60000);
  return `${mins}m`;
}
