import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { apiRequest } from '../../utils/api';
import Spinner from '../ui/Spinner';
import { cn } from '../../lib/utils';

interface ChannelInfo {
  name: string;
  status: 'running' | 'stopped' | 'error';
  mode?: string;
}

export default function ChannelStatus() {
  const { t } = useTranslation('common');
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchChannels = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiRequest<{ channels: ChannelInfo[] }>('/api/channels/status');
      setChannels(data.channels || []);
    } catch { /* fallback */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchChannels(); }, [fetchChannels]);

  const statusDot = (status: string) => (
    <span className={cn(
      'block h-2 w-2 rounded-full shrink-0',
      status === 'running' ? 'bg-green-500' : status === 'error' ? 'bg-red-500' : 'bg-neutral-300 dark:bg-neutral-600',
    )} />
  );

  if (loading) return <Spinner size="sm" />;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
      {channels.map((ch) => (
        <div
          key={ch.name}
          className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900"
        >
          {statusDot(ch.status)}
          <div>
            <p className="text-[13px] font-medium text-neutral-900 dark:text-neutral-100">{ch.name}</p>
            <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
              {ch.status === 'running' ? t('dashboard.running') : t('dashboard.stopped')}
              {ch.mode && <span className="ml-1">· {ch.mode}</span>}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
