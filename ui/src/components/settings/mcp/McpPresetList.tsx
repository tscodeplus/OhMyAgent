// ---------------------------------------------------------------------------
// MCP settings — preset catalogue (§13.3a)
// ---------------------------------------------------------------------------
//
// `GET /api/mcp/presets` is a static table shipped by the backend; picking an
// entry does NOT install anything by itself — it hands the preset to the caller
// so the install form opens pre-filled and the user only fills the required
// env vars. Dependencies are never pre-downloaded (§19-9): the connection test
// in the form is the visible window for the first `npx -y` pull.

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, Plus } from 'lucide-react';
import Modal from '../../ui/Modal';
import Button from '../../ui/Button';
import Spinner from '../../ui/Spinner';
import { apiRequest } from '../../../utils/api';
import type { McpPreset } from './McpServerCard';

export interface McpPresetListProps {
  /** Server names already installed — used to mark presets as installed. */
  installedNames: string[];
  onPick: (preset: McpPreset) => void;
  onManual: () => void;
  onClose: () => void;
}

export default function McpPresetList({
  installedNames,
  onPick,
  onManual,
  onClose,
}: McpPresetListProps) {
  const { t } = useTranslation('common');
  const [presets, setPresets] = useState<McpPreset[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiRequest<McpPreset[]>('/api/mcp/presets')
      .then((list) => {
        if (!cancelled) setPresets(list);
      })
      .catch(() => {
        if (!cancelled) {
          setPresets([]);
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const installed = new Set(installedNames);

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('settings.mcp.installFromPreset')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button variant="secondary" onClick={onManual}>
            {t('settings.mcp.addManual')}
          </Button>
        </>
      }
    >
      {presets === null ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : failed ? (
        <p className="text-sm text-red-600 dark:text-red-400">{t('common.error')}</p>
      ) : presets.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('common.noData')}</p>
      ) : (
        <ul className="space-y-2">
          {presets.map((preset) => (
            <li
              key={preset.id}
              className="flex items-start gap-3 rounded-lg border border-neutral-200 px-3 py-2.5 dark:border-neutral-800"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    {preset.name}
                  </span>
                  <span className="rounded border border-neutral-200 px-1.5 py-0.5 text-[10px] uppercase leading-none text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                    {t(`settings.mcp.transport.${preset.transport}`)}
                  </span>
                  {installed.has(preset.id) && (
                    <span className="rounded border border-emerald-200 px-1.5 py-0.5 text-[10px] leading-none text-emerald-600 dark:border-emerald-900 dark:text-emerald-400">
                      {t('settings.mcp.preset.installed')}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                  {preset.description}
                </p>
                {preset.env.length > 0 && (
                  <p className="mt-1 font-mono text-[11px] text-amber-600 dark:text-amber-400">
                    {t('settings.mcp.preset.requiredEnv', {
                      vars: preset.env.map((e) => e.key).join(', '),
                    })}
                  </p>
                )}
                {preset.docsUrl && (
                  <a
                    href={preset.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-[11px] text-blue-600 hover:underline dark:text-blue-400"
                  >
                    <ExternalLink size={11} />
                    {t('settings.mcp.preset.docs')}
                  </a>
                )}
              </div>
              <Button size="sm" variant="secondary" onClick={() => onPick(preset)}>
                <Plus size={13} />
                {t('settings.mcp.form.install')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
