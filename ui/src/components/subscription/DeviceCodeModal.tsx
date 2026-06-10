import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Copy, Check } from 'lucide-react';
import Button from '../ui/Button';

interface DeviceCodeModalProps {
  providerName: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds?: number;
  onClose: () => void;
}

export default function DeviceCodeModal({
  providerName,
  userCode,
  verificationUri,
  expiresInSeconds,
  onClose,
}: DeviceCodeModalProps) {
  const { t } = useTranslation('common');
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select the text
    }
  }, [userCode]);

  const handleOpenUrl = useCallback(() => {
    window.open(verificationUri, '_blank');
  }, [verificationUri]);

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 shadow-xl p-6 max-w-sm w-full mx-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {t('settings.subscriptions.deviceCodeTitle', { provider: providerName })}
          </h3>
          <button
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Instructions */}
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
          {t('settings.subscriptions.deviceCodeInstructions')}
        </p>

        {/* Verification URI */}
        <button
          onClick={handleOpenUrl}
          className="w-full text-left text-sm text-blue-600 dark:text-blue-400 hover:underline mb-3 truncate"
        >
          {verificationUri}
        </button>

        {/* User Code */}
        <div className="bg-neutral-100 dark:bg-neutral-800 rounded-lg p-3 mb-3">
          <div className="flex items-center justify-between">
            <code className="text-2xl font-mono font-bold tracking-wider text-neutral-900 dark:text-neutral-100 select-all">
              {userCode}
            </code>
            <button
              onClick={handleCopy}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-neutral-200 dark:hover:bg-neutral-700 shrink-0 ml-2"
              title={t('common.copy')}
            >
              {copied ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4 text-neutral-500" />
              )}
            </button>
          </div>
        </div>

        {/* Expiry */}
        {expiresInSeconds && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-4">
            {t('settings.subscriptions.deviceCodeExpires', {
              minutes: Math.round(expiresInSeconds / 60),
            })}
          </p>
        )}

        {/* Waiting indicator */}
        <div className="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
          <div className="h-3 w-3 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
          {t('settings.subscriptions.waitingForLogin')}
        </div>

        {/* Close button */}
        <div className="mt-4 flex justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    </div>
  );
}
