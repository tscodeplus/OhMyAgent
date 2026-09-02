import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Minus, Square, Copy, X } from 'lucide-react';
import { isElectron } from '../../utils/env';

interface WindowControlsProps {
  /** macOS keeps its native traffic lights — hide the custom buttons there. */
  hidden?: boolean;
}

/**
 * Frameless-caption window buttons (minimize / maximize-restore / close),
 * drawn by the WebUI at the top right — the deepseek-harness-desktop-style
 * immersive shell has no visible toolbar, but window controls stay available.
 *
 * The maximize button doubles as restore: the Rust command toggles, and the
 * icon follows the window state (re-queried on webview resize, which fires
 * whenever the OS window is maximized/restored).
 */
export default function WindowControls({ hidden }: WindowControlsProps) {
  const { t } = useTranslation('common');
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isElectron() || hidden) return;
    let alive = true;
    const api = window.electronAPI;
    const refresh = () => {
      api
        ?.isMaximized?.()
        .then((v) => {
          if (alive) setMaximized(v);
        })
        .catch(() => {});
    };
    refresh();
    window.addEventListener('resize', refresh);
    return () => {
      alive = false;
      window.removeEventListener('resize', refresh);
    };
  }, [hidden]);

  if (!isElectron() || hidden) return null;

  const base =
    'inline-flex h-full w-[46px] items-center justify-center text-neutral-600 transition-colors ' +
    'hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/10';

  return (
    <div className="flex h-full items-stretch">
      <button
        type="button"
        title={t('window.minimize')}
        aria-label={t('window.minimize')}
        className={base}
        onClick={() => window.electronAPI?.minimize()}
      >
        <Minus className="h-3.5 w-3.5" strokeWidth={1.5} />
      </button>
      <button
        type="button"
        title={maximized ? t('window.restore') : t('window.maximize')}
        aria-label={maximized ? t('window.restore') : t('window.maximize')}
        className={base}
        onClick={() => window.electronAPI?.maximize()}
      >
        {maximized ? (
          <Copy className="h-3 w-3" strokeWidth={1.5} />
        ) : (
          <Square className="h-3 w-3" strokeWidth={1.5} />
        )}
      </button>
      <button
        type="button"
        title={t('window.close')}
        aria-label={t('window.close')}
        className={`${base} hover:bg-[#e81123] hover:text-white dark:hover:bg-[#e81123]`}
        onClick={() => window.electronAPI?.close()}
      >
        <X className="h-4 w-4" strokeWidth={1.5} />
      </button>
    </div>
  );
}
