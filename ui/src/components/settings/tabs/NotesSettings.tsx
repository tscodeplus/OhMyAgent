/**
 * Notes settings — the `notes:` section of `config.yaml`.
 *
 * The section existed in the schema, the composer and the plan long before this tab
 * did, which meant the only way to change any of it was to edit YAML by hand. Two
 * decisions make this tab honest rather than decorative:
 *
 * 1. **Startup-owned fields say so.** `notes.enabled` gates *construction* of the
 *    service (`createNotesServices` returns `{}` when it is false, so no routes, no
 *    capture tools, no curation) and nothing rebuilds it on reload; `capture.modelRef`
 *    rewrites the aux model chain at construction. Both go through
 *    `restartFieldPrefixes`, which is what makes the save prompt appear — listing them
 *    at tab level would nag on the hot fields too, and no list at all is how the
 *    knowledge tab once looked applied while nothing had changed.
 * 2. **Everything else is read per call.** `capture.*` is read by `CapturePipeline`
 *    through `getConfig()` on every capture, and `draft.ttlDays` /
 *    `logRetentionDays` are mutated into `MemoryHygiene`'s config object by its reload
 *    listener, so those apply on the next capture / next hygiene run without a restart.
 *
 * What is deliberately absent: any switch for the review gate. `origin='agent'` is
 * always `draft`, and no key can make distillation land straight in the library.
 */

import { useTranslation } from 'react-i18next';
import { useConfigDirty, type SettingsTabHandle } from '../useConfigDirty';
import AccordionItem from '../../ui/AccordionItem';
import Input from '../../ui/Input';
import Select from '../../ui/Select';
import Toggle from '../../ui/Toggle';
import Spinner from '../../ui/Spinner';
import ModelRefInput from '../ModelRefInput';

interface NotesSettingsProps {
  tabId?: string;
  registerHandle?: (tabId: string, handle: SettingsTabHandle | null) => void;
  onDirtyChange?: (tabId: string, dirty: boolean) => void;
}

/**
 * Consumed at construction only — see the file header. Kept narrow on purpose: every
 * extra prefix here costs the user a restart prompt for a value that did not need one.
 */
const BOOT_FIELD_PREFIXES = ['notes.enabled', 'notes.capture.modelRef'];

export default function NotesSettings({
  tabId = 'notes',
  registerHandle,
  onDirtyChange,
}: NotesSettingsProps) {
  const { t } = useTranslation('common');
  const { config, loading, getField, setField } = useConfigDirty(
    tabId,
    registerHandle,
    onDirtyChange,
    BOOT_FIELD_PREFIXES,
  );

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const notes = (config?.notes as Record<string, unknown>) || {};
  const capture = (notes.capture as Record<string, unknown>) || {};
  const draft = (notes.draft as Record<string, unknown>) || {};

  const num = (path: string, node: Record<string, unknown>, key: string, fallback: number) =>
    getField(path, String(node[key] ?? fallback)) as string;

  return (
    <div className="space-y-4">
      <AccordionItem title={t('settings.notes.basics')} defaultOpen>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <label className="text-sm font-medium">{t('settings.notes.enabled')}</label>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {t('settings.notes.enabledHint')}
              </p>
            </div>
            <div className="shrink-0">
              <Toggle
                checked={getField('notes.enabled', notes.enabled !== false) as boolean}
                onChange={(value) => setField('notes.enabled', value)}
              />
            </div>
          </div>

          <div className="rounded-lg border border-neutral-200 bg-neutral-50/60 px-3 py-2 text-[11px] leading-relaxed text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/40 dark:text-neutral-400">
            {t('settings.notes.reviewGate')}
          </div>
        </div>
      </AccordionItem>

      <AccordionItem title={t('settings.notes.capture')} defaultOpen>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ModelRefInput
            label={t('settings.notes.modelRef')}
            value={getField('notes.capture.modelRef', String(capture.modelRef ?? '')) as string}
            onChange={(value) => setField('notes.capture.modelRef', value)}
          />
          <Input
            label={t('settings.notes.maxNotes')}
            type="number"
            min={0}
            value={num('notes.capture.maxNotesPerCapture', capture, 'maxNotesPerCapture', 3)}
            onChange={(event) => setField('notes.capture.maxNotesPerCapture', event.target.value)}
          />
          <Input
            label={t('settings.notes.windowTurns')}
            type="number"
            min={1}
            max={20}
            value={num('notes.capture.windowTurns', capture, 'windowTurns', 5)}
            onChange={(event) => setField('notes.capture.windowTurns', event.target.value)}
          />
          <Input
            label={t('settings.notes.tokenBudget')}
            type="number"
            min={500}
            value={num('notes.capture.tokenBudget', capture, 'tokenBudget', 4000)}
            onChange={(event) => setField('notes.capture.tokenBudget', event.target.value)}
          />
        </div>

        {/* The two switches below change what the model is allowed to see, so they
            carry a line each rather than relying on the label to explain them. */}
        <div className="mt-4 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <label className="text-sm font-medium">{t('settings.notes.includeTools')}</label>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {t('settings.notes.includeToolsHint')}
              </p>
            </div>
            <div className="w-32 shrink-0">
              <Select
                compact
                value={
                  getField(
                    'notes.capture.includeTools',
                    String(capture.includeTools ?? 'off'),
                  ) as string
                }
                onChange={(event) => setField('notes.capture.includeTools', event.target.value)}
                options={[
                  { value: 'off', label: t('settings.notes.includeToolsOff') },
                  { value: 'args', label: t('settings.notes.includeToolsArgs') },
                ]}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <label className="text-sm font-medium">{t('settings.notes.redact')}</label>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                {t('settings.notes.redactHint')}
              </p>
            </div>
            <div className="shrink-0">
              <Toggle
                checked={getField('notes.capture.redact', capture.redact !== false) as boolean}
                onChange={(value) => setField('notes.capture.redact', value)}
              />
            </div>
          </div>
        </div>
      </AccordionItem>

      <AccordionItem title={t('settings.notes.retention')}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label={t('settings.notes.draftTtlDays')}
            type="number"
            min={0}
            value={num('notes.draft.ttlDays', draft, 'ttlDays', 14)}
            onChange={(event) => setField('notes.draft.ttlDays', event.target.value)}
          />
          <Input
            label={t('settings.notes.logRetentionDays')}
            type="number"
            min={0}
            value={num('notes.logRetentionDays', notes, 'logRetentionDays', 90)}
            onChange={(event) => setField('notes.logRetentionDays', event.target.value)}
          />
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-neutral-500 dark:text-neutral-400">
          {t('settings.notes.retentionHint')}
        </p>
      </AccordionItem>

      <p className="text-[11px] leading-relaxed text-neutral-400 dark:text-neutral-500">
        {t('settings.notes.restartHint')}
      </p>
    </div>
  );
}
