import { useState, useCallback, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import Input from '../ui/Input';

export default function LoginPage() {
  const { t } = useTranslation('common');
  const { login } = useAuth();
  const [token, setTokenVal] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!token.trim()) { setError(t('auth.error')); return; }
      setLoading(true); setError('');
      const ok = await login(token.trim());
      if (!ok) setError(t('auth.error'));
      setLoading(false);
    },
    [token, login, t],
  );

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-neutral-50 dark:bg-neutral-950">
      <div className="w-full max-w-sm mx-4">
        <div className="rounded-xl border border-neutral-200 bg-white p-8 dark:border-neutral-700 dark:bg-neutral-900">
          <div className="mb-10 text-center">
            <h1 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
              {t('auth.title')}
            </h1>
            <p className="mt-2 text-[13px] text-neutral-500 dark:text-neutral-400">
              {t('auth.loginTitle')}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <Input
              type="password"
              value={token}
              onChange={e => setTokenVal(e.target.value)}
              placeholder={t('auth.tokenPlaceholder')}
              error={error || undefined}
              autoFocus
            />
            <button
              type="submit"
              disabled={loading}
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-700"
            >
              {loading ? (
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
                  <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" className="opacity-75" />
                </svg>
              ) : null}
              {t('auth.loginButton')}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
