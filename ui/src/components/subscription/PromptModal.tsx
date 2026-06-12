import { useState, useCallback, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { apiRequest } from '../../utils/api';
import Button from '../ui/Button';
import Input from '../ui/Input';

interface PromptModalProps {
  providerName: string;
  requestId: string;
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
  onClose: () => void;
}

/** Map hardcoded English OAuth prompt messages to i18n keys. */
const PROMPT_I18N_MAP: Record<string, string> = {
  'GitHub Enterprise URL/domain (blank for github.com)':
    'settings.subscriptions.oauthPrompt.githubEnterprise',
  'Paste the authorization code or full redirect URL:':
    'settings.subscriptions.oauthPrompt.pasteAuthCode',
  'Paste the authorization code (or full redirect URL):':
    'settings.subscriptions.oauthPrompt.pasteAuthCode',
};

function translatePrompt(message: string, t: (key: string) => string): string {
  const key = PROMPT_I18N_MAP[message];
  return key ? t(key) : message;
}

export default function PromptModal({
  providerName,
  requestId,
  message,
  placeholder,
  allowEmpty,
  onClose,
}: PromptModalProps) {
  const { t } = useTranslation('common');
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();

      if (!allowEmpty && !value.trim()) {
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
    [requestId, value, allowEmpty, onClose, t],
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
          {translatePrompt(message, t)}
        </p>

        {/* Input */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <Input
            type="text"
            value={value}
            onChange={(e) => { setValue(e.target.value); setError(''); }}
            placeholder={placeholder}
            error={error || undefined}
            autoFocus
          />

          <div className="flex justify-end gap-2">
            {allowEmpty && (
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={async () => {
                  setSubmitting(true);
                  try {
                    await apiRequest('/api/subscriptions/login/respond', {
                      method: 'POST',
                      body: JSON.stringify({ requestId, response: '' }),
                    });
                    onClose();
                  } catch {
                    setSubmitting(false);
                  }
                }}
              >
                {t('common.skip')}
              </Button>
            )}
            <Button variant="primary" size="sm" type="submit" disabled={submitting}>
              {submitting ? t('common.submitting') : t('common.confirm')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
