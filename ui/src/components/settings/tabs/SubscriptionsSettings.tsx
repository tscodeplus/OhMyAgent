import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import { useToast } from '../../ui/Toast';
import { apiRequest } from '../../../utils/api';
import Button from '../../ui/Button';
import Spinner from '../../ui/Spinner';
import DeviceCodeModal from '../../subscription/DeviceCodeModal';
import PromptModal from '../../subscription/PromptModal';
import SelectModal from '../../subscription/SelectModal';
import ManualCodeModal from '../../subscription/ManualCodeModal';

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

interface SelectOption {
  id: string;
  label: string;
}

type LoginStage =
  | { type: 'idle' }
  | { type: 'loading' }
  | { type: 'device_code'; info: DeviceCodeInfo }
  | { type: 'auth_url'; url: string }
  | { type: 'waiting' }
  | { type: 'prompt'; requestId: string; message: string; placeholder?: string; allowEmpty?: boolean }
  | { type: 'select'; requestId: string; message: string; options: SelectOption[] }
  | { type: 'manual_code_input'; requestId: string }
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
      const msg = err instanceof Error ? err.message : t('settings.subscriptions.loadError');
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [t]);

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
          case 'prompt':
            setLoginStage((prev) => ({
              ...prev,
              [providerId]: {
                type: 'prompt',
                requestId: innerData.requestId as string,
                message: innerData.message as string,
                placeholder: innerData.placeholder as string | undefined,
                allowEmpty: innerData.allowEmpty as boolean | undefined,
              },
            }));
            break;
          case 'select':
            setLoginStage((prev) => ({
              ...prev,
              [providerId]: {
                type: 'select',
                requestId: innerData.requestId as string,
                message: innerData.message as string,
                options: (innerData.options as SelectOption[]) || [],
              },
            }));
            break;
          case 'manual_code_input':
            setLoginStage((prev) => ({
              ...prev,
              [providerId]: {
                type: 'manual_code_input',
                requestId: innerData.requestId as string,
              },
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
              8000,
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
        const msg = err instanceof Error ? err.message : t('settings.subscriptions.loginFailed');
        setLoginStage((prev) => ({
          ...prev,
          [providerId]: { type: 'error', message: msg },
        }));
        showToast(msg, 'error', 8000);
      }
    },
    [connected, sendMessage, showToast, t],
  );

  // ── Logout ──────────────────────────────────────────────────────────

  const handleLogout = useCallback(
    async (providerId: string) => {
      try {
        await apiRequest(`/api/subscriptions/${providerId}`, { method: 'DELETE' });
        showToast(t('settings.subscriptions.logoutSuccess', { provider: providerId }), 'success');
        fetchStatuses();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : t('settings.subscriptions.logoutFailed');
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
      <div className="flex justify-center py-3">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-2">
        <p className="text-[11px] text-red-600 dark:text-red-400 mb-2">{error}</p>
        <Button variant="secondary" size="sm" onClick={fetchStatuses}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {t('settings.subscriptions.description')}
      </p>

      {subscriptions.map((sub) => {
        const stage = loginStage[sub.providerId] || { type: 'idle' };
        const isBusy = stage.type !== 'idle' && stage.type !== 'error';

        return (
          <div
            key={sub.providerId}
            className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-3 py-2"
          >
            <div className="flex items-center justify-between">
              <div className="flex-1 min-w-0">
                {/* Provider name */}
                <h4 className="text-xs font-medium text-neutral-900 dark:text-neutral-100">
                  {sub.providerName}
                </h4>

                {/* Status */}
                <div className="mt-0.5 flex items-center gap-1.5">
                  {sub.loggedIn ? (
                    <>
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500" />
                      <span className="text-[11px] text-green-700 dark:text-green-400">
                        {t('settings.subscriptions.status.loggedIn')}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-neutral-400" />
                      <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
                        {t('settings.subscriptions.status.loggedOut')}
                      </span>
                    </>
                  )}

                  {/* Expiration */}
                  {sub.expiresAt && sub.loggedIn && (
                    <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
                      ·{' '}
                      {t('settings.subscriptions.expiresIn', {
                        time: formatRelativeTime(sub.expiresAt),
                      })}
                    </span>
                  )}
                </div>

              </div>

              {/* Actions */}
              <div className="ml-3 flex items-center gap-1.5 shrink-0">
                {isBusy ? (
                  <Button variant="secondary" size="sm" disabled>
                    <Spinner className="h-3 w-3 mr-1" />
                    {t('settings.subscriptions.loggingIn')}
                  </Button>
                ) : sub.loggedIn ? (
                  <Button variant="danger" size="sm" onClick={() => handleLogout(sub.providerId)}>
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

      {/* Modals for interactive stages */}
      {Object.entries(loginStage).map(([providerId, stage]) => {
        const providerName =
          subscriptions.find((s) => s.providerId === providerId)?.providerName ?? providerId;

        switch (stage.type) {
          case 'device_code':
            return (
              <DeviceCodeModal
                key={providerId}
                providerName={providerName}
                userCode={stage.info.userCode}
                verificationUri={stage.info.verificationUri}
                expiresInSeconds={stage.info.expiresInSeconds}
                onClose={() => dismissStage(providerId)}
              />
            );
          case 'prompt':
            return (
              <PromptModal
                key={providerId}
                providerName={providerName}
                requestId={stage.requestId}
                message={stage.message}
                placeholder={stage.placeholder}
                allowEmpty={stage.allowEmpty}
                onClose={() => dismissStage(providerId)}
              />
            );
          case 'select':
            return (
              <SelectModal
                key={providerId}
                providerName={providerName}
                requestId={stage.requestId}
                message={stage.message}
                options={stage.options}
                onClose={() => dismissStage(providerId)}
              />
            );
          case 'manual_code_input':
            return (
              <ManualCodeModal
                key={providerId}
                providerName={providerName}
                requestId={stage.requestId}
                onClose={() => dismissStage(providerId)}
              />
            );
          default:
            return null;
        }
      })}
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
