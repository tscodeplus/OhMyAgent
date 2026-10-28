/**
 * Knowledge settings — the `knowledge:` and `conversation_search:` blocks of
 * config.yaml (MyDocs/KNOWLEDGE_WORKBENCH_PLAN.md §9.1 for the key list and
 * defaults, §6 K2-5 for what each switch does).
 *
 * Values travel through `useConfigDirty`'s dotted-path helpers like every other
 * tab: `PUT /api/config` expands `knowledge.curate.mode` back into a nested
 * object and `jsConfigToYaml()` writes it as `curate.mode`, so this tab needs no
 * second config transport. The paths are the camelCase JS spelling the schema in
 * `src/app/config.ts` uses (`curate.maxPagesPerRun`, not `max_pages_per_run`);
 * the numeric ones are listed in `useConfigDirty`'s `numericPaths`, so a number
 * reaches the server, not a numeric string.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import AccordionItem from '../../ui/AccordionItem';
import Input from '../../ui/Input';
import Select from '../../ui/Select';
import Toggle from '../../ui/Toggle';
import Spinner from '../../ui/Spinner';
import { SettingsCard } from '../SettingsSection';
import { useConfigDirty, type SettingsTabHandle } from '../useConfigDirty';

interface KnowledgeSettingsProps {
  tabId?: string;
  registerHandle?: (tabId: string, handle: SettingsTabHandle | null) => void;
  onDirtyChange?: (tabId: string, dirty: boolean) => void;
}

const CURATE_MODES = ['off', 'manual', 'nightly'] as const;

interface FieldRowProps {
  label: string;
  description?: string;
  children: ReactNode;
}

function FieldRow({ label, description, children }: FieldRowProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex-1">
        <label className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
          {label}
        </label>
        {description && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">{description}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export default function KnowledgeSettings({
  tabId = 'knowledge',
  registerHandle,
  onDirtyChange,
}: KnowledgeSettingsProps) {
  const { t } = useTranslation('common');
  const { config, loading, getField, setField } = useConfigDirty(
    tabId,
    registerHandle,
    onDirtyChange,
  );

  if (loading)
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  if (!config)
    return <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('common.error')}</p>;

  const knowledge = (config.knowledge as Record<string, unknown>) || {};
  const read = (knowledge.read as Record<string, unknown>) || {};
  const curate = (knowledge.curate as Record<string, unknown>) || {};
  const inject = (knowledge.inject as Record<string, unknown>) || {};
  const conversation = (config.conversationSearch as Record<string, unknown>) || {};

  // `enabled` defaults to true in the schema, so an explicit `false` (or an
  // absent config.yaml section, which the loader maps to `enabled: false`) is
  // the only value that means off.
  const layerEnabled = getField('knowledge.enabled', knowledge.enabled !== false) as boolean;
  const curateMode = getField('knowledge.curate.mode', String(curate.mode ?? 'nightly')) as string;

  const sectionTitleClass = 'text-sm font-semibold text-neutral-900 dark:text-neutral-100 mb-3';
  const hintClass = 'text-[11px] text-neutral-500 dark:text-neutral-400';

  return (
    <div className="space-y-6">
      {/* ── Group A: knowledge pages (`knowledge.*`) ── */}
      <section>
        <h3 className={sectionTitleClass}>{t('settings.knowledge.pagesTitle')}</h3>
        <div className="space-y-3">
          {/* Master switch */}
          <SettingsCard>
            <FieldRow
              label={t('settings.knowledge.enabledLabel')}
              description={t('settings.knowledge.enabledDesc')}
            >
              <Toggle checked={layerEnabled} onChange={(v) => setField('knowledge.enabled', v)} />
            </FieldRow>
          </SettingsCard>
          {!layerEnabled && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-900/20">
              <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                {t('settings.knowledge.inactiveTitle')}
              </p>
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                {t('settings.knowledge.inactiveDesc')}
              </p>
            </div>
          )}

          {/* Read surface */}
          <AccordionItem title={t('settings.knowledge.read.title')} defaultOpen>
            <FieldRow
              label={t('settings.knowledge.read.enabled')}
              description={t('settings.knowledge.read.enabledDesc')}
            >
              <Toggle
                checked={getField('knowledge.read.enabled', read.enabled !== false) as boolean}
                onChange={(v) => setField('knowledge.read.enabled', v)}
              />
            </FieldRow>
          </AccordionItem>

          {/* Curation */}
          <AccordionItem title={t('settings.knowledge.curate.title')} defaultOpen>
            <Select
              label={t('settings.knowledge.curate.mode')}
              value={curateMode}
              onChange={(e) => setField('knowledge.curate.mode', e.target.value)}
              options={CURATE_MODES.map((mode) => ({
                value: mode,
                label: t(`settings.knowledge.curate.mode_${mode}`),
              }))}
            />
            {/* The consequence of the current choice — the switch table's last
                column (§6 K2-5): what stops happening when you pick this one. */}
            <p className={hintClass}>{t(`settings.knowledge.curate.mode_${curateMode}_desc`)}</p>

            <FieldRow
              label={t('settings.knowledge.curate.shadow')}
              description={t('settings.knowledge.curate.shadowDesc')}
            >
              <Toggle
                checked={getField('knowledge.curate.shadow', !!curate.shadow) as boolean}
                onChange={(v) => setField('knowledge.curate.shadow', v)}
              />
            </FieldRow>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Input
                  label={t('settings.knowledge.curate.maxPagesPerRun')}
                  type="number"
                  min={0}
                  max={50}
                  step={1}
                  value={
                    getField(
                      'knowledge.curate.maxPagesPerRun',
                      String(curate.maxPagesPerRun ?? 5),
                    ) as string
                  }
                  onChange={(e) => setField('knowledge.curate.maxPagesPerRun', e.target.value)}
                />
                <p className={hintClass}>{t('settings.knowledge.curate.maxPagesPerRunHint')}</p>
              </div>
              <div className="space-y-1.5">
                <Input
                  label={t('settings.knowledge.curate.requireSources')}
                  type="number"
                  min={1}
                  step={1}
                  value={
                    getField(
                      'knowledge.curate.requireSources',
                      String(curate.requireSources ?? 2),
                    ) as string
                  }
                  onChange={(e) => setField('knowledge.curate.requireSources', e.target.value)}
                />
                <p className={hintClass}>{t('settings.knowledge.curate.requireSourcesHint')}</p>
              </div>
              <div className="space-y-1.5">
                <Input
                  label={t('settings.knowledge.curate.minMemoryConfidence')}
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={
                    getField(
                      'knowledge.curate.minMemoryConfidence',
                      String(curate.minMemoryConfidence ?? 0.6),
                    ) as string
                  }
                  onChange={(e) => setField('knowledge.curate.minMemoryConfidence', e.target.value)}
                />
                <p className={hintClass}>
                  {t('settings.knowledge.curate.minMemoryConfidenceHint')}
                </p>
              </div>
            </div>

            {/* Plain text, not ModelRefInput: an empty value is the meaningful
                default ("reuse memory_aux_models"), and ModelPicker auto-selects
                the first provider on mount — which would dirty this tab the
                moment it is opened. */}
            <div className="space-y-1.5">
              <Input
                label={t('settings.knowledge.curate.modelRef')}
                placeholder={t('settings.knowledge.curate.modelRefPlaceholder')}
                value={
                  getField('knowledge.curate.modelRef', String(curate.modelRef ?? '')) as string
                }
                onChange={(e) => setField('knowledge.curate.modelRef', e.target.value)}
              />
              <p className={hintClass}>{t('settings.knowledge.curate.modelRefHint')}</p>
            </div>
          </AccordionItem>

          {/* Per-turn injection */}
          <AccordionItem title={t('settings.knowledge.inject.title')} defaultOpen>
            <FieldRow
              label={t('settings.knowledge.inject.enabled')}
              description={t('settings.knowledge.inject.enabledDesc')}
            >
              <Toggle
                checked={getField('knowledge.inject.enabled', inject.enabled !== false) as boolean}
                onChange={(v) => setField('knowledge.inject.enabled', v)}
              />
            </FieldRow>
            <div className="space-y-1.5">
              <Input
                label={t('settings.knowledge.inject.maxPages')}
                type="number"
                min={0}
                max={10}
                step={1}
                value={
                  getField('knowledge.inject.maxPages', String(inject.maxPages ?? 2)) as string
                }
                onChange={(e) => setField('knowledge.inject.maxPages', e.target.value)}
              />
              <p className={hintClass}>{t('settings.knowledge.inject.maxPagesHint')}</p>
            </div>
          </AccordionItem>

          {/* Change log retention */}
          <AccordionItem title={t('settings.knowledge.log.title')}>
            <div className="space-y-1.5">
              <Input
                label={t('settings.knowledge.log.retentionDays')}
                type="number"
                min={0}
                step={1}
                value={
                  getField(
                    'knowledge.logRetentionDays',
                    String(knowledge.logRetentionDays ?? 90),
                  ) as string
                }
                onChange={(e) => setField('knowledge.logRetentionDays', e.target.value)}
              />
              <p className={hintClass}>{t('settings.knowledge.log.retentionDaysHint')}</p>
            </div>
          </AccordionItem>
        </div>
      </section>

      {/* ── Group B: past conversation search (`conversation_search.*`) ── */}
      <section>
        <h3 className={sectionTitleClass}>{t('settings.knowledge.conversation.title')}</h3>
        <SettingsCard>
          <FieldRow
            label={t('settings.knowledge.conversation.enabled')}
            description={t('settings.knowledge.conversation.enabledDesc')}
          >
            <Toggle
              checked={
                getField('conversationSearch.enabled', conversation.enabled !== false) as boolean
              }
              onChange={(v) => setField('conversationSearch.enabled', v)}
            />
          </FieldRow>
          <div className="space-y-1.5">
            <Input
              label={t('settings.knowledge.conversation.autoInjectMaxItems')}
              type="number"
              min={0}
              max={10}
              step={1}
              value={
                getField(
                  'conversationSearch.autoInjectMaxItems',
                  String(conversation.autoInjectMaxItems ?? 2),
                ) as string
              }
              onChange={(e) => setField('conversationSearch.autoInjectMaxItems', e.target.value)}
            />
            <p className={hintClass}>
              {t('settings.knowledge.conversation.autoInjectMaxItemsHint')}
            </p>
          </div>
        </SettingsCard>
      </section>
    </div>
  );
}
