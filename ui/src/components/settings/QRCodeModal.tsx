import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../ui/Modal';
import Spinner from '../ui/Spinner';
import { apiRequest, ApiError } from '../../utils/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QrStatusInfo {
  status: string;
  credentials?: Record<string, string>;
  botToken?: string;
  error?: string;
}

export interface QRCodeModalProps {
  channel: 'feishu' | 'wechat' | 'qq' | 'telegram';
  channelLabel: string;
  onClose: () => void;
  onComplete: (credentials: Record<string, string>) => void;
  /** For Feishu: the region to use ('feishu' or 'lark'). */
  feishuRegion?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function QRCodeModal({
  channel,
  channelLabel,
  onClose,
  onComplete,
  feishuRegion,
}: QRCodeModalProps) {
  const { t } = useTranslation('common');
  const [phase, setPhase] = useState<'loading' | 'show-qr' | 'polling' | 'confirmed' | 'expired' | 'error'>('loading');
  const [qrcodeDataUrl, setQrcodeDataUrl] = useState<string>('');
  const [directUrl, setDirectUrl] = useState<string>('');
  const [errMsg, setErrMsg] = useState<string>('');
  const [pollStatus, setPollStatus] = useState<string>('waiting');
  const [manualToken, setManualToken] = useState<string>('');
  const [manualAppId, setManualAppId] = useState<string>('');
  const [manualAppSecret, setManualAppSecret] = useState<string>('');

  /** Channels that use inline credential input instead of server-side polling */
  const isInlineChannel = channel === 'telegram' || channel === 'qq';

  // Refs to avoid stale closures in async callbacks
  const sessionIdRef = useRef<string>('');
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  // ── Polling helper (uses ref, avoids stale closures) ──
  const doPoll = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || !mountedRef.current) return;

    try {
      const data = await apiRequest<QrStatusInfo>(
        `/api/channels/${channel}/qr/poll`,
        {
          method: 'POST',
          body: JSON.stringify({ sessionId: sid }),
        },
      );

      if (!mountedRef.current) return;

      const status = data.status || 'waiting';
      setPollStatus(status);

      if (status === 'confirmed') {
        setPhase('confirmed');
        const creds: Record<string, string> = data.credentials || {};

        // WeChat: call /start to persist token and start the bot
        if (channel === 'wechat' && data.botToken) {
          creds.botToken = data.botToken;
          try {
            await apiRequest(`/api/channels/wechat/qr/start`, {
              method: 'POST',
              body: JSON.stringify({ botToken: data.botToken }),
            });
          } catch {
            // Non-fatal
          }
        }

        // Delay then close
        setTimeout(() => {
          if (mountedRef.current) {
            onCompleteRef.current(creds);
          }
        }, 1500);
        return;
      }

      if (status === 'expired') {
        setPhase('expired');
        return;
      }

      if (status === 'error') {
        setErrMsg(data.error || 'Poll error');
        setPhase('error');
        return;
      }

      // Continue polling
      if (mountedRef.current) {
        pollTimerRef.current = setTimeout(doPoll, 2000);
      }
    } catch {
      // Network error — retry after delay
      if (mountedRef.current) {
        pollTimerRef.current = setTimeout(doPoll, 3000);
      }
    }
  }, [channel]);

  // ── Generate QR code on mount ──
  const generateQr = useCallback(async () => {
    setPhase('loading');
    setErrMsg('');
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    try {
      const data = await apiRequest<{
        ok: boolean;
        sessionId: string;
        qrcodeImageDataUrl: string;
        directUrl?: string;
        instructions?: string;
        error?: string;
      }>(`/api/channels/${channel}/qr`, {
        method: 'POST',
        body: JSON.stringify({
          region: feishuRegion || 'feishu',
        }),
      });

      if (!mountedRef.current) return;

      if (!data.ok) {
        setErrMsg(data.error || 'Failed to generate QR code');
        setPhase('error');
        return;
      }

      setQrcodeDataUrl(data.qrcodeImageDataUrl);
      if (data.directUrl) setDirectUrl(data.directUrl);

      // Store sessionId in ref for polling
      sessionIdRef.current = data.sessionId;

      // Telegram / QQ: show QR + inline input, no polling
      if (isInlineChannel) {
        setPhase('show-qr');
        return;
      }

      // Start polling
      setPhase('polling');
      setPollStatus('waiting');
      pollTimerRef.current = setTimeout(doPoll, 1500);
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message
        : (err as ApiError)?.message ? (err as ApiError).message
        : String(err);
      setErrMsg(msg);
      setPhase('error');
    }
  }, [channel, feishuRegion, doPoll]);

  // Trigger generation on mount
  useEffect(() => {
    generateQr();
  }, [generateQr]);

  // ── Telegram / QQ: confirm manual credentials ──
  const handleInlineConfirm = useCallback(() => {
    if (channel === 'qq') {
      if (!manualAppId.trim() || !manualAppSecret.trim()) return;
      onComplete({ appId: manualAppId.trim(), clientSecret: manualAppSecret.trim() });
    } else {
      if (!manualToken.trim()) return;
      onComplete({ botToken: manualToken.trim() });
    }
  }, [channel, manualToken, manualAppId, manualAppSecret, onComplete]);

  // ── Render helpers ──
  const statusBadge = () => {
    switch (pollStatus) {
      case 'waiting':
        return (
          <span className="inline-block px-3 py-1 text-xs font-medium rounded-full bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300">
            {t('settings.channels.qrAwaitingScan')}
          </span>
        );
      case 'scanned':
        return (
          <span className="inline-block px-3 py-1 text-xs font-medium rounded-full bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
            {t('settings.channels.qrScanned')}
          </span>
        );
      case 'confirmed':
        return (
          <span className="inline-block px-3 py-1 text-xs font-medium rounded-full bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300">
            {t('settings.channels.qrConfirmed')}
          </span>
        );
      default:
        return null;
    }
  };

  const getInstructions = () => {
    const keyMap: Record<string, string> = {
      feishu: 'feishuQrInstructions',
      qq: 'qqQrInstructions',
      wechat: 'wechatQrInstructions',
      telegram: 'telegramQrInstructions',
    };
    const key = keyMap[channel] || 'qrInstructions';
    return t(`settings.channels.${key}`);
  };

  // ── Render ──
  return (
    <Modal
      open
      onClose={onClose}
      title={`${t('settings.channels.qrTitle')} — ${channelLabel}`}
      size="sm"
      footer={
        <div className="flex gap-2">
          {phase === 'expired' || phase === 'error' ? (
            <button
              onClick={generateQr}
              className="px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors"
            >
              {t('settings.channels.qrRetry')}
            </button>
          ) : null}
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium rounded-md border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          >
            {t('settings.channels.qrCancel')}
          </button>
        </div>
      }
    >
      <div className="flex flex-col items-center gap-4 py-2">
        {/* Loading */}
        {phase === 'loading' && (
          <div className="flex flex-col items-center gap-3 py-8">
            <Spinner />
            <p className="text-sm text-neutral-500">{t('settings.channels.qrAwaitingScan')}</p>
          </div>
        )}

        {/* Show QR, Polling, Confirmed, Expired */}
        {(phase === 'show-qr' || phase === 'polling' || phase === 'confirmed' || phase === 'expired') && (
          <>
            {qrcodeDataUrl && (
              <img
                src={qrcodeDataUrl}
                alt="QR Code"
                className={`w-64 h-64 rounded-lg border-2 ${
                  phase === 'expired'
                    ? 'border-red-300 opacity-40'
                    : phase === 'confirmed'
                    ? 'border-green-400'
                    : 'border-neutral-300 dark:border-neutral-600'
                }`}
              />
            )}

            {phase === 'polling' && statusBadge()}

            {phase === 'confirmed' && (
              <p className="text-sm text-green-600 dark:text-green-400 font-medium">
                {t('settings.channels.qrConfirmed')}
              </p>
            )}

            {phase === 'expired' && (
              <p className="text-sm text-red-600 dark:text-red-400">
                {t('settings.channels.qrExpired')}
              </p>
            )}

            <p className="text-xs text-neutral-500 dark:text-neutral-400 text-center max-w-sm">
              {getInstructions()}
            </p>

            {/* Telegram: BotFather deep link with inline token input */}
            {channel === 'telegram' && (
              <div className="w-full space-y-3 mt-2">
                {directUrl && (
                  <a
                    href={directUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-600 dark:text-blue-400 underline block text-center"
                  >
                    {directUrl}
                  </a>
                )}
                <input
                  type="password"
                  value={manualToken}
                  onChange={(e) => setManualToken(e.target.value)}
                  placeholder={t('settings.channels.qrManualTokenPlaceholder')}
                  className="w-full px-3 py-2 text-sm border border-neutral-300 dark:border-neutral-600 rounded-md bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={handleInlineConfirm}
                  disabled={!manualToken.trim()}
                  className="w-full px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {t('settings.channels.qrConfirmToken')}
                </button>
              </div>
            )}

            {/* QQ: QQ Open Platform deep link with inline App ID + Client Secret input */}
            {channel === 'qq' && (
              <div className="w-full space-y-3 mt-2">
                {directUrl && (
                  <a
                    href={directUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-600 dark:text-blue-400 underline block text-center"
                  >
                    {t('settings.channels.qqOpenPlatform')}
                  </a>
                )}
                <input
                  type="text"
                  value={manualAppId}
                  onChange={(e) => setManualAppId(e.target.value)}
                  placeholder={t('settings.channels.qqAppIdPlaceholder')}
                  className="w-full px-3 py-2 text-sm border border-neutral-300 dark:border-neutral-600 rounded-md bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <input
                  type="password"
                  value={manualAppSecret}
                  onChange={(e) => setManualAppSecret(e.target.value)}
                  placeholder={t('settings.channels.qqClientSecretPlaceholder')}
                  className="w-full px-3 py-2 text-sm border border-neutral-300 dark:border-neutral-600 rounded-md bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={handleInlineConfirm}
                  disabled={!manualAppId.trim() || !manualAppSecret.trim()}
                  className="w-full px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {t('settings.channels.qrConfirmToken')}
                </button>
              </div>
            )}
          </>
        )}

        {/* Error */}
        {phase === 'error' && (
          <div className="flex flex-col items-center gap-3 py-4">
            <p className="text-sm text-red-600 dark:text-red-400">{t('settings.channels.qrError')}</p>
            {errMsg && (
              <p className="text-xs text-neutral-500 dark:text-neutral-400 font-mono break-all text-center max-w-xs">
                {errMsg}
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
