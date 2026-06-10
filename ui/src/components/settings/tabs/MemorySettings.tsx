import { useTranslation } from 'react-i18next';
import AccordionItem from '../../ui/AccordionItem';
import Input from '../../ui/Input';
import Select from '../../ui/Select';
import Toggle from '../../ui/Toggle';
import Spinner from '../../ui/Spinner';
import { useConfigDirty, type SettingsTabHandle } from '../useConfigDirty';

interface FieldRowProps {
  label: string;
  description?: string;
  children: React.ReactNode;
}

function FieldRow({ label, description, children }: FieldRowProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex-1">
        <label className="text-sm font-medium">{label}</label>
        {description && <p className="text-xs text-neutral-500 dark:text-neutral-400">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Fields that are consumed only at startup and require a restart to pick up changes. */
const BOOT_FIELD_PREFIXES = [
  'memory.recallMinScore',
  'memory.summarizeInterval',
  'memory.decayHalfLifeDays',
  'memory.outputLanguage',
  'memory.embeddingCacheMaxEntries',
  'memory.queryEmbeddingTimeoutMs',
  'memory.embeddingCircuitBreaker.',
  'memory.hygiene.retentionDays',
  'memory.persona.',
  'memory.sceneClustering.',
  'memory.maintenance.',
];

export default function MemorySettings({
  tabId = 'memory',
  registerHandle,
  onDirtyChange,
}: {
  tabId?: string;
  registerHandle?: (tabId: string, handle: SettingsTabHandle | null) => void;
  onDirtyChange?: (tabId: string, dirty: boolean) => void;
}) {
  const { t } = useTranslation('common');
  const { config, loading, getField, setField } = useConfigDirty(tabId, registerHandle, onDirtyChange, BOOT_FIELD_PREFIXES);

  if (loading) return <div className="flex justify-center py-8"><Spinner /></div>;
  const mem = (config?.memory as Record<string, unknown>) || {};

  return (
    <div className="space-y-3">
      {/* 1. Basic */}
      <AccordionItem title={t("settings.memory.basic")}>
        <div className="grid grid-cols-2 gap-4">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Toggle checked={getField('memory.autoRecall', !!mem.autoRecall) as boolean} onChange={(v) => setField('memory.autoRecall', v)} />
            <span className="text-neutral-700 dark:text-neutral-300">{t("settings.memory.autoRecall")}</span>
          </label>
          <div>
            <Select label={t("settings.memory.recallFrequency")} value={getField('memory.autoRecallFrequency', String(mem.autoRecallFrequency || 'first')) as string} onChange={(e) => setField('memory.autoRecallFrequency', e.target.value)}
              options={[{ value: 'every', label: t('settings.memory.every_msg') }, { value: 'first', label: t('settings.memory.first_only') }]} />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <Input label={t("settings.memory.recallTopK")} type="number" value={getField('memory.recallTopK', String(mem.recallTopK ?? '')) as string}
            onChange={(e) => setField('memory.recallTopK', e.target.value)} />
          <Input label={t("settings.memory.minScore")} type="number" value={getField('memory.recallMinScore', String(mem.recallMinScore ?? '')) as string}
            onChange={(e) => setField('memory.recallMinScore', e.target.value)} />
          <Input label={t("settings.memory.maxCaptureChars")} type="number" value={getField('memory.captureMaxChars', String(mem.captureMaxChars ?? '')) as string}
            onChange={(e) => setField('memory.captureMaxChars', e.target.value)} />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <Input label={t("settings.memory.summarizeInterval")} type="number" value={getField('memory.summarizeInterval', String(mem.summarizeInterval ?? '')) as string}
            onChange={(e) => setField('memory.summarizeInterval', e.target.value)} />
          <Input label={t("settings.memory.decayHalfLife")} type="number" value={getField('memory.decayHalfLifeDays', String(mem.decayHalfLifeDays ?? '')) as string}
            onChange={(e) => setField('memory.decayHalfLifeDays', e.target.value)} />
          <Select label={t("settings.memory.outputLanguage")} value={getField('memory.outputLanguage', String(mem.outputLanguage || 'Auto')) as string}
            onChange={(e) => setField('memory.outputLanguage', e.target.value)}
            options={['Auto', 'English', 'Japanese', 'Simplified Chinese', 'Traditional Chinese'].map(v => ({ value: v, label: v }))} />
        </div>
      </AccordionItem>

      {/* 2. Embedding cache */}
      <AccordionItem title={t("settings.memory.embedding")}>
        <div className="grid grid-cols-2 gap-4">
          <Input label={t("settings.memory.cacheMaxEntries")} type="number" value={getField('memory.embeddingCacheMaxEntries', String(mem.embeddingCacheMaxEntries ?? '')) as string}
            onChange={(e) => setField('memory.embeddingCacheMaxEntries', e.target.value)} />
          <Input label={t("settings.memory.queryTimeout")} type="number" value={getField('memory.queryEmbeddingTimeoutMs', String(mem.queryEmbeddingTimeoutMs ?? '')) as string}
            onChange={(e) => setField('memory.queryEmbeddingTimeoutMs', e.target.value)} />
        </div>
      </AccordionItem>

      {/* 3. Hygiene */}
      <AccordionItem title={t("settings.memory.hygiene")}>
        <div className="grid grid-cols-2 gap-4">
          <FieldRow label={t("settings.memory.enabled")}>
            <Toggle checked={getField('memory.hygiene.enabled', !!(mem.hygiene as Record<string, unknown>)?.enabled) as boolean} onChange={(v) => setField('memory.hygiene.enabled', v)} />
          </FieldRow>
          <Input label={t("settings.memory.retentionDays")} type="number" value={getField('memory.hygiene.retentionDays', String((mem.hygiene as Record<string, unknown>)?.retentionDays ?? '')) as string}
            onChange={(e) => setField('memory.hygiene.retentionDays', e.target.value)} />
        </div>
      </AccordionItem>

      {/* 4. Circuit breaker */}
      <AccordionItem title={t("settings.memory.circuitBreaker")}>
        <div className="grid grid-cols-2 gap-4">
          <Input label={t("settings.memory.failureThreshold")} type="number" value={getField('memory.embeddingCircuitBreaker.failureThreshold', String((mem.embeddingCircuitBreaker as Record<string, unknown>)?.failureThreshold ?? '')) as string}
            onChange={(e) => setField('memory.embeddingCircuitBreaker.failureThreshold', e.target.value)} />
          <Input label={t("settings.memory.cooldownSec")} type="number" value={getField('memory.embeddingCircuitBreaker.cooldownSec', String((mem.embeddingCircuitBreaker as Record<string, unknown>)?.cooldownSec ?? '')) as string}
            onChange={(e) => setField('memory.embeddingCircuitBreaker.cooldownSec', e.target.value)} />
        </div>
      </AccordionItem>

      {/* 5. Offloading */}
      <AccordionItem title={t("settings.memory.offloading")}>
        <FieldRow label={t("settings.memory.enabled")}>
          <Toggle checked={getField('memory.offloading.enabled', !!(mem.offloading as Record<string, unknown>)?.enabled) as boolean} onChange={(v) => setField('memory.offloading.enabled', v)} />
        </FieldRow>
        <div className="grid grid-cols-3 gap-4">
          <Input label={t("settings.memory.maxRefs")} type="number" value={getField('memory.offloading.maxRefsInContext', String((mem.offloading as Record<string, unknown>)?.maxRefsInContext ?? '')) as string}
            onChange={(e) => setField('memory.offloading.maxRefsInContext', e.target.value)} />
          <Input label={t("settings.memory.preserveMsgs")} type="number" value={getField('memory.offloading.preserveInMessages', String((mem.offloading as Record<string, unknown>)?.preserveInMessages ?? '')) as string}
            onChange={(e) => setField('memory.offloading.preserveInMessages', e.target.value)} />
          <Input label={t("settings.memory.retentionDays")} type="number" value={getField('memory.offloading.retentionDays', String((mem.offloading as Record<string, unknown>)?.retentionDays ?? '')) as string}
            onChange={(e) => setField('memory.offloading.retentionDays', e.target.value)} />
        </div>
      </AccordionItem>

      {/* 6. Persona */}
      <AccordionItem title={t("settings.memory.persona")}>
        <FieldRow label={t("settings.memory.enabled")}>
          <Toggle checked={getField('memory.persona.enabled', !!(mem.persona as Record<string, unknown>)?.enabled) as boolean} onChange={(v) => setField('memory.persona.enabled', v)} />
        </FieldRow>
        <div className="grid grid-cols-2 gap-4">
          <Input label={t("settings.memory.distillThreshold")} type="number" value={getField('memory.persona.distillThreshold', String((mem.persona as Record<string, unknown>)?.distillThreshold ?? '')) as string}
            onChange={(e) => setField('memory.persona.distillThreshold', e.target.value)} />
          <Input label={t("settings.memory.minDistillInterval")} type="number" value={getField('memory.persona.minDistillIntervalHours', String((mem.persona as Record<string, unknown>)?.minDistillIntervalHours ?? '')) as string}
            onChange={(e) => setField('memory.persona.minDistillIntervalHours', e.target.value)} />
        </div>
      </AccordionItem>

      {/* 7. Mermaid Canvas */}
      <AccordionItem title={t("settings.memory.mermaid")}>
        <FieldRow label={t("settings.memory.enabled")}>
          <Toggle checked={getField('memory.mermaidCanvas.enabled', !!(mem.mermaidCanvas as Record<string, unknown>)?.enabled) as boolean} onChange={(v) => setField('memory.mermaidCanvas.enabled', v)} />
        </FieldRow>
        <div className="grid grid-cols-3 gap-4">
          <Select label={t("settings.memory.injectFormat")} value={getField('memory.mermaidCanvas.injectFormat', String((mem.mermaidCanvas as Record<string, unknown>)?.injectFormat || 'summary')) as string}
            onChange={(e) => setField('memory.mermaidCanvas.injectFormat', e.target.value)}
            options={[{ value: 'full', label: t('settings.memory.keyword_full') }, { value: 'summary', label: t('settings.memory.keyword_summary') }]} />
          <Select label={t("settings.memory.phaseTagging")} value={getField('memory.mermaidCanvas.phaseTagging', String((mem.mermaidCanvas as Record<string, unknown>)?.phaseTagging || 'auto')) as string}
            onChange={(e) => setField('memory.mermaidCanvas.phaseTagging', e.target.value)}
            options={[{ value: 'auto', label: t('settings.memory.keyword_auto') }, { value: 'llm', label: t('settings.memory.keyword_llm') }, { value: 'off', label: t('settings.memory.keyword_off') }]} />
          <Input label={t("settings.memory.maxNodes")} type="number" value={getField('memory.mermaidCanvas.maxNodesInContext', String((mem.mermaidCanvas as Record<string, unknown>)?.maxNodesInContext ?? '')) as string}
            onChange={(e) => setField('memory.mermaidCanvas.maxNodesInContext', e.target.value)} />
        </div>
      </AccordionItem>

      {/* 8. Scene Clustering */}
      <AccordionItem title={t("settings.memory.sceneClustering")}>
        <FieldRow label={t("settings.memory.enabled")}>
          <Toggle checked={getField('memory.sceneClustering.enabled', !!(mem.sceneClustering as Record<string, unknown>)?.enabled) as boolean} onChange={(v) => setField('memory.sceneClustering.enabled', v)} />
        </FieldRow>
        <div className="grid grid-cols-2 gap-4">
          <Input label={t("settings.memory.windowDays")} type="number" value={getField('memory.sceneClustering.windowDays', String((mem.sceneClustering as Record<string, unknown>)?.windowDays ?? '')) as string}
            onChange={(e) => setField('memory.sceneClustering.windowDays', e.target.value)} />
          <Input label={t("settings.memory.minMemories")} type="number" value={getField('memory.sceneClustering.minMemories', String((mem.sceneClustering as Record<string, unknown>)?.minMemories ?? '')) as string}
            onChange={(e) => setField('memory.sceneClustering.minMemories', e.target.value)} />
        </div>
      </AccordionItem>

      {/* 9. Maintenance */}
      <AccordionItem title={t("settings.memory.maintenance")}>
        <FieldRow label={t("settings.memory.enabled")}>
          <Toggle checked={getField('memory.maintenance.enabled', !!(mem.maintenance as Record<string, unknown>)?.enabled) as boolean} onChange={(v) => setField('memory.maintenance.enabled', v)} />
        </FieldRow>
        <Input label={t("settings.memory.interval")} type="number" value={getField('memory.maintenance.intervalMs', String((mem.maintenance as Record<string, unknown>)?.intervalMs ?? '')) as string}
          onChange={(e) => setField('memory.maintenance.intervalMs', e.target.value)} />
        <div className="grid grid-cols-4 gap-x-4 gap-y-1.5">
          {['memory_hygiene', 'embedding_backfill', 'embedding_cache_trim', 'entity_backfill',
            'persona_consistency', 'offload_hygiene', 'scene_cluster', 'memory_doctor'].map(job => {
              const jobs = ((mem.maintenance as Record<string, unknown>)?.jobs as Record<string, boolean>) || {};
              return (
                <label key={job} className="flex items-center gap-2 text-sm cursor-pointer">
                  <Toggle checked={getField(`memory.maintenance.jobs.${job}`, !!jobs[job]) as boolean} onChange={(v) => setField(`memory.maintenance.jobs.${job}`, v)} />
                  <span className="text-neutral-700 dark:text-neutral-300">{t(`settings.memory.job_${job}`)}</span>
                </label>
              );
            })}
        </div>
      </AccordionItem>

      {/* 10. Auto Compress */}
      <AccordionItem title={t("settings.memory.autoCompress")}>
        <FieldRow label={t("settings.memory.enabled")}>
          <Toggle checked={getField('memory.autoCompress.enabled', !!(mem.autoCompress as Record<string, unknown>)?.enabled) as boolean} onChange={(v) => setField('memory.autoCompress.enabled', v)} />
        </FieldRow>
        <div className="grid grid-cols-2 gap-4">
          <Input label={t("settings.memory.reserveTokens")} type="number" value={getField('memory.autoCompress.reserveTokens', String((mem.autoCompress as Record<string, unknown>)?.reserveTokens ?? '')) as string}
            onChange={(e) => setField('memory.autoCompress.reserveTokens', e.target.value)} />
          <Input label={t("settings.memory.keepRecentTokens")} type="number" value={getField('memory.autoCompress.keepRecentTokens', String((mem.autoCompress as Record<string, unknown>)?.keepRecentTokens ?? '')) as string}
            onChange={(e) => setField('memory.autoCompress.keepRecentTokens', e.target.value)} />
        </div>
      </AccordionItem>
    </div>
  );
}
