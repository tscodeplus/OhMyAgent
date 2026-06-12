import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { apiRequest } from '../../utils/api';
import Button from '../ui/Button';

interface SelectOption {
  id: string;
  label: string;
}

interface SelectModalProps {
  providerName: string;
  requestId: string;
  message: string;
  options: SelectOption[];
  onClose: () => void;
}

/** Map hardcoded English OAuth select messages to i18n keys. */
const SELECT_I18N_MAP: Record<string, string> = {
  'Select OpenAI Codex login method:': 'settings.subscriptions.oauthSelect.codexMethod',
};

/** Map hardcoded English OAuth select option labels to i18n keys. */
const SELECT_OPTION_I18N_MAP: Record<string, string> = {
  'Browser login (default)': 'settings.subscriptions.oauthSelectOption.browser',
  'Device code login (headless)': 'settings.subscriptions.oauthSelectOption.deviceCode',
};

function translateSelectMessage(message: string, t: (key: string) => string): string {
  const key = SELECT_I18N_MAP[message];
  return key ? t(key) : message;
}

function translateOptionLabel(label: string, t: (key: string) => string): string {
  const key = SELECT_OPTION_I18N_MAP[label];
  return key ? t(key) : label;
}

export default function SelectModal({
  providerName,
  requestId,
  message,
  options,
  onClose,
}: SelectModalProps) {
  const { t } = useTranslation('common');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSelect = useCallback(
    async (optionId: string) => {
      setSubmitting(true);
      setError('');

      try {
        await apiRequest('/api/subscriptions/login/respond', {
          method: 'POST',
          body: JSON.stringify({ requestId, response: optionId }),
        });
        onClose();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : t('common.submitError');
        setError(msg);
        setSubmitting(false);
      }
    },
    [requestId, onClose],
  );

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 shadow-xl p-6 max-w-sm w-full mx-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {providerName}
          </h3>
          <button
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Message */}
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
          {translateSelectMessage(message, t)}
        </p>

        {/* Options */}
        <div className="flex flex-col gap-2 mb-4">
          {options.map((opt) => (
            <button
              key={opt.id}
              onClick={() => handleSelect(opt.id)}
              disabled={submitting}
              className="w-full text-left px-4 py-3 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-50 text-sm font-medium text-neutral-900 dark:text-neutral-100 transition-colors"
            >
              {translateOptionLabel(opt.label, t)}
            </button>
          ))}
        </div>

        {/* Error */}
        {error && (
          <p className="text-xs text-red-600 dark:text-red-400 mb-3">{error}</p>
        )}

        {/* Cancel */}
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </Button>
        </div>
      </div>
    </div>
  );
}
