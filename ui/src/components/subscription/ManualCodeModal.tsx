import { useState, useCallback, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { apiRequest } from '../../utils/api';
import Button from '../ui/Button';

interface ManualCodeModalProps {
  providerName: string;
  requestId: string;
  onClose: () => void;
}

export default function ManualCodeModal({
  providerName,
  requestId,
  onClose,
}: ManualCodeModalProps) {
  const { t } = useTranslation('common');
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();

      if (!value.trim()) {
        setError(t('common.required'));
        return;
      }

      setSubmitting(true);
      setError('');

      try {
        await apiRequest('/api/subscriptions/login/respond', {
          method: 'POST',
          body: JSON.stringify({ requestId, response: value.trim() }),
        });
        onClose();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : t('common.submitError');
        setError(msg);
        setSubmitting(false);
      }
    },
    [requestId, value, onClose, t],
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

        {/* Instructions */}
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
          {t('settings.subscriptions.manualCodeInstructions')}
        </p>

        {/* Input */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <textarea
            value={value}
            onChange={(e) => { setValue(e.target.value); setError(''); }}
            placeholder={t('settings.subscriptions.manualCodePlaceholder')}
            className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 dark:placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none h-24"
            autoFocus
          />

          {error && (
            <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" type="button" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" size="sm" type="submit" disabled={submitting}>
              {submitting ? t('common.submitting') : t('common.confirm')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
