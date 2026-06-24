import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, QrCode } from 'lucide-react';
import { useConfigDirty, SettingsTabHandle } from '../useConfigDirty';
import Input from '../../ui/Input';
import Select from '../../ui/Select';
import Toggle from '../../ui/Toggle';
import Spinner from '../../ui/Spinner';
import QRCodeModal from '../QRCodeModal';

function ChannelCard({ name, children }: { name: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
      <button onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full px-4 py-2.5 text-sm font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/60 transition-colors">
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

type ChannelType = 'feishu' | 'wechat' | 'qq' | 'telegram';

export default function ChannelsSettings({ tabId = 'channels', registerHandle, onDirtyChange }: ChannelsSettingsProps) {
  const { t } = useTranslation('common');
  const { config, loading, getField, setField, fetchConfig } = useConfigDirty(tabId, registerHandle, onDirtyChange);

  const [qrModal, setQrModal] = useState<ChannelType | null>(null);
  const [confirmChannel, setConfirmChannel] = useState<ChannelType | null>(null);

  if (loading) return <div className="flex justify-center py-8"><Spinner /></div>;

  const feishu = (config?.feishu as Record<string, unknown>) || {};
  const telegram = (config?.telegram as Record<string, unknown>) || {};
  const wechat = (config?.wechat as Record<string, unknown>) || {};
  const qq = (config?.qq as Record<string, unknown>) || {};

  const feishuEnabled = getField('feishu.enabled', !!feishu.enabled);
  const telegramEnabled = getField('telegram.enabled', !!telegram.enabled);
  const wechatEnabled = getField('wechat.enabled', !!wechat.enabled);
  const qqEnabled = getField('qq.enabled', !!qq.enabled);

  const feishuRegion = getField('feishu.region', String(feishu.region || 'feishu'));

  const handleQrComplete = (channel: ChannelType, credentials: Record<string, string>) => {
    switch (channel) {
      case 'feishu':
        if (credentials.appId) setField('feishu.appId', credentials.appId);
        if (credentials.appSecret) setField('feishu.appSecret', credentials.appSecret);
        if (credentials.region) setField('feishu.region', credentials.region);
        break;
      case 'qq':
        if (credentials.appId) setField('qq.appId', credentials.appId);
        if (credentials.clientSecret) setField('qq.clientSecret', credentials.clientSecret);
        break;
      case 'wechat':
        if (credentials.botToken) setField('wechat.botToken', credentials.botToken);
        fetchConfig(false);
        break;
      case 'telegram':
        if (credentials.botToken) setField('telegram.botToken', credentials.botToken);
        break;
    }
    setQrModal(null);
  };

  // Detect existing credentials: appId is non-secret and always returned by API;
  // botToken may be redacted but still non-empty when configured. Use getField
  // to respect dirty state (user-typed values not yet saved).
  const hasFeishuConfig = getField('feishu.appId', String(feishu.appId || '')).length > 0;
  const hasQQConfig = getField('qq.appId', String(qq.appId || '')).length > 0;
  const hasWechatConfig = getField('wechat.botToken', String(wechat.botToken || '')).length > 0;
  const hasTelegramConfig = getField('telegram.botToken', String(telegram.botToken || '')).length > 0;

  const handleScanClick = (channel: ChannelType) => {
    const hasConfig: Record<ChannelType, boolean> = {
      feishu: hasFeishuConfig,
      qq: hasQQConfig,
      wechat: hasWechatConfig,
      telegram: hasTelegramConfig,
    };
    // Only warn about overwriting when there ARE existing credentials
    if (hasConfig[channel]) {
      setConfirmChannel(channel);
    } else {
      setQrModal(channel);
    }
  };

  const scanButton = (channel: ChannelType) => (
    <button
      onClick={() => handleScanClick(channel)}
      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
    >
      <QrCode size={13} />
      {t('settings.channels.scanQrToConfigure')}
    </button>
  );

  return (
    <div className="space-y-3">
      {/* Feishu / Lark */}
      <ChannelCard name={t("settings.channels.feishu")}>
        <div className="flex items-center justify-between">
          <label className="text-sm">{t("settings.channels.enabled")}</label>
          <Toggle checked={getField('feishu.enabled', !!feishu.enabled)} onChange={(v) => setField('feishu.enabled', v)} />
        </div>
        {feishuEnabled ? (<>
          {scanButton('feishu')}
          <Select
            label={t("settings.channels.region")}
            value={feishuRegion}
            onChange={(e) => setField('feishu.region', e.target.value)}
            options={[
              { value: 'feishu', label: t('settings.channels.regionFeishu') },
              { value: 'lark', label: t('settings.channels.regionLark') },
            ]}
          />
          <Input label="App ID" value={getField('feishu.appId', String(feishu.appId || ''))} onChange={(e) => setField('feishu.appId', e.target.value)} />
          <Input label={t("settings.channels.appSecret")} type="password" value={getField('feishu.appSecret', String(feishu.appSecret || ''))} onChange={(e) => setField('feishu.appSecret', e.target.value)} placeholder={getField('feishu.appSecret', String(feishu.appSecret || '')) ? undefined : ''} />
          <div className="flex items-center justify-between">
            <label className="text-sm">{t("settings.channels.wsEnabled")}</label>
            <Toggle checked={getField('feishu.wsEnabled', !!feishu.wsEnabled)} onChange={(v) => setField('feishu.wsEnabled', v)} />
          </div>
        </>) : null}
      </ChannelCard>

      {/* Telegram */}
      <ChannelCard name="Telegram">
        <div className="flex items-center justify-between">
          <label className="text-sm">{t("settings.channels.enabled")}</label>
          <Toggle checked={getField('telegram.enabled', !!telegram.enabled)} onChange={(v) => setField('telegram.enabled', v)} />
        </div>
        {telegramEnabled ? (<>
          {scanButton('telegram')}
          <Input label={t("settings.channels.botToken")} type="password" value={getField('telegram.botToken', String(telegram.botToken || ''))} onChange={(e) => setField('telegram.botToken', e.target.value)} placeholder={getField('telegram.botToken', String(telegram.botToken || '')) ? undefined : ''} />
          <Input label={t("settings.channels.botName")} value={getField('telegram.botName', String(telegram.botName || ''))} onChange={(e) => setField('telegram.botName', e.target.value)} placeholder={t('settings.channels.botNamePlaceholder')} />
          <Select label={t("settings.channels.mode")} value={getField('telegram.mode', String(telegram.mode || 'polling'))} onChange={(e) => setField('telegram.mode', e.target.value)} options={[{ value: 'polling', label: 'Polling' }, { value: 'webhook', label: 'Webhook' }]} />
          <Select label={t("settings.channels.streamMode")} value={getField('telegram.streamMode', String(telegram.streamMode || 'edit'))} onChange={(e) => setField('telegram.streamMode', e.target.value)} options={[{ value: 'edit', label: t('settings.channels.opt_edit') }, { value: 'send', label: t('settings.channels.opt_send') }]} />
        </>) : null}
      </ChannelCard>

      {/* WeChat */}
      <ChannelCard name={t("settings.channels.wechat")}>
        <div className="flex items-center justify-between">
          <label className="text-sm">{t("settings.channels.enabled")}</label>
          <Toggle checked={getField('wechat.enabled', !!wechat.enabled)} onChange={(v) => setField('wechat.enabled', v)} />
        </div>
        {wechatEnabled ? (<>
          {scanButton('wechat')}
          <Input label={t("settings.channels.botToken")} type="password" value={getField('wechat.botToken', String(wechat.botToken || ''))} onChange={(e) => setField('wechat.botToken', e.target.value)} placeholder={getField('wechat.botToken', String(wechat.botToken || '')) ? undefined : ''} />
          <Input label={t("settings.channels.apiBase")} value={getField('wechat.apiBase', String(wechat.apiBase || ''))} onChange={(e) => setField('wechat.apiBase', e.target.value)} />
        </>) : null}
      </ChannelCard>

      {/* QQ */}
      <ChannelCard name="QQ">
        <div className="flex items-center justify-between">
          <label className="text-sm">{t("settings.channels.enabled")}</label>
          <Toggle checked={getField('qq.enabled', !!qq.enabled)} onChange={(v) => setField('qq.enabled', v)} />
        </div>
        {qqEnabled ? (<>
          {scanButton('qq')}
          <Input label="App ID" value={getField('qq.appId', String(qq.appId || ''))} onChange={(e) => setField('qq.appId', e.target.value)} />
          <Input label={t("settings.channels.clientSecret")} type="password" value={getField('qq.clientSecret', String(qq.clientSecret || ''))} onChange={(e) => setField('qq.clientSecret', e.target.value)} placeholder={getField('qq.clientSecret', String(qq.clientSecret || '')) ? undefined : ''} />
        </>) : null}
      </ChannelCard>

      {/* Reconfigure confirmation — centered overlay */}
      {confirmChannel && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setConfirmChannel(null)} />
          <div className="relative w-full max-w-sm rounded-xl border border-amber-200 dark:border-amber-800 bg-white dark:bg-neutral-900 shadow-2xl p-5 space-y-4">
            <div className="flex items-start gap-3">
              <span className="text-amber-500 text-xl leading-none mt-0.5">⚠</span>
              <div>
                <h4 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
                  {t('settings.channels.qrReconfigureTitle')}
                </h4>
                <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
                  {t('settings.channels.qrReconfigureMessage', { channel: t(`settings.channels.${confirmChannel}`) })}
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmChannel(null)}
                className="px-3 py-1.5 text-xs font-medium rounded-md border border-neutral-300 dark:border-neutral-600 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => {
                  const ch = confirmChannel;
                  setConfirmChannel(null);
                  setQrModal(ch);
                }}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors"
              >
                {t('settings.channels.scanQrToConfigure')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* QR Code Modal */}
      {qrModal && (
        <QRCodeModal
          channel={qrModal}
          channelLabel={t(`settings.channels.${qrModal}`)}
          feishuRegion={qrModal === 'feishu' ? feishuRegion : undefined}
          onClose={() => setQrModal(null)}
          onComplete={(credentials) => handleQrComplete(qrModal, credentials)}
        />
      )}
    </div>
  );
}
