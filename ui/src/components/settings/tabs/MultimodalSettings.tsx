import { useTranslation } from 'react-i18next';
import { useConfigDirty, type SettingsTabHandle } from '../useConfigDirty';
import AccordionItem from '../../ui/AccordionItem';
import Input from '../../ui/Input';
import Select from '../../ui/Select';
import Toggle from '../../ui/Toggle';
import Spinner from '../../ui/Spinner';

interface MultimodalSettingsProps {
  tabId?: string;
  registerHandle?: (tabId: string, handle: SettingsTabHandle | null) => void;
  onDirtyChange?: (tabId: string, dirty: boolean) => void;
}

/** Fields that are consumed only at startup (STT providers, image mode) and require a restart. */
const BOOT_FIELD_PREFIXES = [
  'multimodal.stt.',
  'multimodal.image.mode',
  'multimodal.imageGeneration.modelRef',
  'multimodal.videoGeneration.modelRef',
];

export default function MultimodalSettings({ tabId = 'multimodal', registerHandle, onDirtyChange }: MultimodalSettingsProps) {
  const { t } = useTranslation('common');
  const { config, loading, getField, setField } = useConfigDirty(tabId, registerHandle, onDirtyChange, BOOT_FIELD_PREFIXES);

  if (loading) return <div className="flex justify-center py-8"><Spinner /></div>;
  if (!config) return <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('common.error')}</p>;
  const mm = (config.multimodal as Record<string, unknown>) || {};

  return (
    <div className="space-y-3">
      {/* Master switch */}
      <div className="flex items-center justify-between rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{t("settings.multimodal.title")}</h3>
        </div>
        <Toggle checked={getField('multimodal.enabled', !!(mm.enabled)) as boolean} onChange={(v) => setField('multimodal.enabled', v)} />
      </div>

      <AccordionItem title={t('settings.multimodal.image')}>
        <Select label={t("settings.multimodal.imageMode")} value={getField('multimodal.image.mode', String((mm.image as Record<string, unknown>)?.mode || 'native_first')) as string}
          onChange={(e) => setField('multimodal.image.mode', e.target.value)}
          options={[{ value: 'bridge_only', label: t('settings.multimodal.opt_bridge_only') }, { value: 'native_first', label: t('settings.multimodal.opt_native_first') }, { value: 'native_only', label: t('settings.multimodal.opt_native_only') }]} />

        {/* Vision bridge settings — same level as mode */}
        {(() => {
          const bri = (mm.image as Record<string, unknown>)?.bridge as Record<string, unknown> || {};
          return <>
            <div className="mt-3 pt-3 border-t border-neutral-200 dark:border-neutral-700">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-2">{t('settings.vision.title')}</h4>
            </div>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{t("settings.vision.enabled")}</label>
              <Toggle checked={getField('multimodal.image.bridge.enabled', !!bri.enabled) as boolean}
                onChange={(v) => setField('multimodal.image.bridge.enabled', v)} />
            </div>
            <Input label={t('settings.vision.modelRef')} value={getField('multimodal.image.bridge.modelRef', String(bri.modelRef || '')) as string}
              onChange={(e) => setField('multimodal.image.bridge.modelRef', e.target.value)} />
            <Input label={t('settings.vision.apiKey')} value={getField('multimodal.image.bridge.apiKey', String(bri.apiKey || '')) as string}
              onChange={(e) => setField('multimodal.image.bridge.apiKey', e.target.value)} type="password" />
            <Input label="Base URL" value={getField('multimodal.image.bridge.baseUrl', String(bri.baseUrl || '')) as string}
              onChange={(e) => setField('multimodal.image.bridge.baseUrl', e.target.value)} />
            <Input label={t('settings.vision.timeout')} type="number" value={getField('multimodal.image.bridge.timeoutMs', String(bri.timeoutMs || 120000)) as string}
              onChange={(e) => setField('multimodal.image.bridge.timeoutMs', e.target.value)} />
            <Input label={t('settings.vision.maxNoteChars')} type="number" value={getField('multimodal.image.bridge.maxNoteChars', String(bri.maxNoteChars || 3200)) as string}
              onChange={(e) => setField('multimodal.image.bridge.maxNoteChars', e.target.value)} />
          </>;
        })()}
      </AccordionItem>

      <AccordionItem title={t('settings.multimodal.imageGeneration')}>
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{t("settings.multimodal.enabled")}</label>
          <Toggle checked={getField('multimodal.imageGeneration.enabled', !!((mm.imageGeneration as Record<string, unknown>)?.enabled)) as boolean}
            onChange={(v) => setField('multimodal.imageGeneration.enabled', v)} />
        </div>
        <Input label={t('settings.multimodal.modelRef')} value={getField('multimodal.imageGeneration.modelRef', String((mm.imageGeneration as Record<string, unknown>)?.modelRef || '')) as string}
          onChange={(e) => setField('multimodal.imageGeneration.modelRef', e.target.value)} />
        <Input label={t("settings.multimodal.outputDir")} value={getField('multimodal.imageGeneration.outputDir', String((mm.imageGeneration as Record<string, unknown>)?.outputDir || '')) as string}
          onChange={(e) => setField('multimodal.imageGeneration.outputDir', e.target.value)} />
        <Input label={t("settings.multimodal.maxPromptChars")} type="number" value={getField('multimodal.imageGeneration.maxPromptChars', String((mm.imageGeneration as Record<string, unknown>)?.maxPromptChars || '')) as string}
          onChange={(e) => setField('multimodal.imageGeneration.maxPromptChars', e.target.value)} />
      </AccordionItem>

      <AccordionItem title={t("settings.multimodal.videoGeneration")}>
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{t("settings.multimodal.enabled")}</label>
          <Toggle checked={getField('multimodal.videoGeneration.enabled', !!((mm.videoGeneration as Record<string, unknown>)?.enabled)) as boolean}
            onChange={(v) => setField('multimodal.videoGeneration.enabled', v)} />
        </div>
        <Input label={t('settings.multimodal.modelRef')} value={getField('multimodal.videoGeneration.modelRef', String((mm.videoGeneration as Record<string, unknown>)?.modelRef || '')) as string}
          onChange={(e) => setField('multimodal.videoGeneration.modelRef', e.target.value)} />
        <Input label={t("settings.multimodal.outputDir")} value={getField('multimodal.videoGeneration.outputDir', String((mm.videoGeneration as Record<string, unknown>)?.outputDir || '')) as string}
          onChange={(e) => setField('multimodal.videoGeneration.outputDir', e.target.value)} />
        <Input label={t("settings.multimodal.maxPromptChars")} type="number" value={getField('multimodal.videoGeneration.maxPromptChars', String((mm.videoGeneration as Record<string, unknown>)?.maxPromptChars || '')) as string}
          onChange={(e) => setField('multimodal.videoGeneration.maxPromptChars', e.target.value)} />
        <Input label={t("settings.multimodal.defaultSeconds")} value={getField('multimodal.videoGeneration.defaultSeconds', String((mm.videoGeneration as Record<string, unknown>)?.defaultSeconds || '5.0')) as string}
          onChange={(e) => setField('multimodal.videoGeneration.defaultSeconds', e.target.value)} />
        <Input label={t("settings.multimodal.defaultSize")} value={getField('multimodal.videoGeneration.defaultSize', String((mm.videoGeneration as Record<string, unknown>)?.defaultSize || '1280x768')) as string}
          onChange={(e) => setField('multimodal.videoGeneration.defaultSize', e.target.value)} />
      </AccordionItem>

      <AccordionItem title={t("settings.multimodal.stt")}>
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{t("settings.multimodal.enabled")}</label>
          <Toggle checked={getField('multimodal.stt.enabled', !!((mm.stt as Record<string, unknown>)?.enabled)) as boolean}
            onChange={(v) => setField('multimodal.stt.enabled', v)} />
        </div>
        <Input label={t("settings.multimodal.language")} value={getField('multimodal.stt.language', String((mm.stt as Record<string, unknown>)?.language || 'auto')) as string}
          onChange={(e) => setField('multimodal.stt.language', e.target.value)} />
        <Input label={t("settings.multimodal.maxDuration")} type="number" value={getField('multimodal.stt.maxDurationSec', String((mm.stt as Record<string, unknown>)?.maxDurationSec || 300)) as string}
          onChange={(e) => setField('multimodal.stt.maxDurationSec', e.target.value)} />
      </AccordionItem>

      <AccordionItem title={t("settings.multimodal.attachments")}>
        <Input label={t("settings.multimodal.cacheDir")} value={getField('multimodal.attachments.cacheDir', String((mm.attachments as Record<string, unknown>)?.cacheDir || '')) as string}
          onChange={(e) => setField('multimodal.attachments.cacheDir', e.target.value)} />
        <div className="flex items-center justify-between">
          <label className="text-sm">{t("settings.multimodal.autoParseImages")}</label>
          <Toggle checked={getField('multimodal.attachments.autoParseImages', !!((mm.attachments as Record<string, unknown>)?.autoParseImages)) as boolean}
            onChange={(v) => setField('multimodal.attachments.autoParseImages', v)} />
        </div>
      </AccordionItem>
    </div>
  );
}
