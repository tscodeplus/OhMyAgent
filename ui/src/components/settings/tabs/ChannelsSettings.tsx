import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useConfigDirty, SettingsTabHandle } from '../useConfigDirty';
import Input from '../../ui/Input';
import Select from '../../ui/Select';
import Toggle from '../../ui/Toggle';
import Spinner from '../../ui/Spinner';

function ChannelCard({ name, children }: { name: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
      <button onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full px-4 py-2.5 text-sm font-medium  text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/60 transition-colors">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {name}
      </button>
      {open && <div className="px-4 py-3 space-y-3 border-t border-neutral-200 dark:border-neutral-800">{children}</div>}
    </div>
  );
}

interface ChannelsSettingsProps {
  tabId?: string;
  registerHandle?: (tabId: string, handle: SettingsTabHandle | null) => void;
  onDirtyChange?: (tabId: string, dirty: boolean) => void;
}

export default function ChannelsSettings({ tabId = 'channels', registerHandle, onDirtyChange }: ChannelsSettingsProps) {
  const { t } = useTranslation('common');
  const { config, loading, getField, setField } = useConfigDirty(tabId, registerHandle, onDirtyChange);

  if (loading) return <div className="flex justify-center py-8"><Spinner /></div>;

  const feishu = (config?.feishu as Record<string, unknown>) || {};
  const telegram = (config?.telegram as Record<string, unknown>) || {};
  const wechat = (config?.wechat as Record<string, unknown>) || {};
  const qq = (config?.qq as Record<string, unknown>) || {};

  return (
    <div className="space-y-3">
      <ChannelCard name={t("settings.channels.feishu")}>
        <div className="flex items-center justify-between">
          <label className="text-sm">{t("settings.channels.enabled")}</label>
          <Toggle checked={getField('feishu.enabled', !!feishu.enabled)} onChange={(v) => setField('feishu.enabled', v)} />
        </div>
        {feishu.enabled ? (<>
          <Input label="App ID" value={getField('feishu.appId', String(feishu.appId || ''))} onChange={(e) => setField('feishu.appId', e.target.value)} />
          <Input label={t("settings.channels.appSecret")} type="password" value={getField('feishu.appSecret', String(feishu.appSecret || ''))} onChange={(e) => setField('feishu.appSecret', e.target.value)} placeholder={getField('feishu.appSecret', String(feishu.appSecret || '')) ? undefined : ''} />
          <div className="flex items-center justify-between">
            <label className="text-sm">{t("settings.channels.wsEnabled")}</label>
            <Toggle checked={getField('feishu.wsEnabled', !!feishu.wsEnabled)} onChange={(v) => setField('feishu.wsEnabled', v)} />
          </div>
        </>) : null}
      </ChannelCard>

      <ChannelCard name="Telegram">
        <div className="flex items-center justify-between">
          <label className="text-sm">{t("settings.channels.enabled")}</label>
          <Toggle checked={getField('telegram.enabled', !!telegram.enabled)} onChange={(v) => setField('telegram.enabled', v)} />
        </div>
        {telegram.enabled ? (<>
          <Input label={t("settings.channels.botToken")} type="password" value={getField('telegram.botToken', String(telegram.botToken || ''))} onChange={(e) => setField('telegram.botToken', e.target.value)} placeholder={getField('telegram.botToken', String(telegram.botToken || '')) ? undefined : ''} />
          <Select label={t("settings.channels.mode")} value={getField('telegram.mode', String(telegram.mode || 'polling'))} onChange={(e) => setField('telegram.mode', e.target.value)} options={[{ value: 'polling', label: 'Polling' }, { value: 'webhook', label: 'Webhook' }]} />
          <Select label={t("settings.channels.streamMode")} value={getField('telegram.streamMode', String(telegram.streamMode || 'edit'))} onChange={(e) => setField('telegram.streamMode', e.target.value)} options={[{ value: 'edit', label: t('settings.channels.opt_edit') }, { value: 'send', label: t('settings.channels.opt_send') }]} />
        </>) : null}
      </ChannelCard>

      <ChannelCard name={t("settings.channels.wechat")}>
        <div className="flex items-center justify-between">
          <label className="text-sm">{t("settings.channels.enabled")}</label>
          <Toggle checked={getField('wechat.enabled', !!wechat.enabled)} onChange={(v) => setField('wechat.enabled', v)} />
        </div>
        {wechat.enabled ? (<>
          <Input label={t("settings.channels.botToken")} type="password" value={getField('wechat.botToken', String(wechat.botToken || ''))} onChange={(e) => setField('wechat.botToken', e.target.value)} placeholder={getField('wechat.botToken', String(wechat.botToken || '')) ? undefined : ''} />
          <Input label={t("settings.channels.apiBase")} value={getField('wechat.apiBase', String(wechat.apiBase || ''))} onChange={(e) => setField('wechat.apiBase', e.target.value)} />
        </>) : null}
      </ChannelCard>

      <ChannelCard name="QQ">
        <div className="flex items-center justify-between">
          <label className="text-sm">{t("settings.channels.enabled")}</label>
          <Toggle checked={getField('qq.enabled', !!qq.enabled)} onChange={(v) => setField('qq.enabled', v)} />
        </div>
        {qq.enabled ? (<>
          <Input label="App ID" value={getField('qq.appId', String(qq.appId || ''))} onChange={(e) => setField('qq.appId', e.target.value)} />
          <Input label={t("settings.channels.clientSecret")} type="password" value={getField('qq.clientSecret', String(qq.clientSecret || ''))} onChange={(e) => setField('qq.clientSecret', e.target.value)} placeholder={getField('qq.clientSecret', String(qq.clientSecret || '')) ? undefined : ''} />
        </>) : null}
      </ChannelCard>
    </div>
  );
}
