import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3, MessageSquare, Activity } from 'lucide-react';
import { apiRequest } from '../../utils/api';
import ChannelStatus from './ChannelStatus';
import Spinner from '../ui/Spinner';

interface DashboardStats {
  activeProjects: number;
  todaySessions: number;
  monthlyTokens: number;
}

export default function DashboardView() {
  const { t } = useTranslation('common');
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    try {
      setLoading(true);
      const data = await apiRequest<DashboardStats>('/api/dashboard/stats');
      setStats(data);
    } catch { /* fallback */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  if (loading) {
    return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  }

  const cards = [
    { title: t('dashboard.activeProjects'), value: stats?.activeProjects ?? 0, icon: BarChart3, color: 'text-neutral-600 dark:text-neutral-400', bg: 'bg-neutral-100 dark:bg-neutral-800' },
    { title: t('dashboard.todaySessions'), value: stats?.todaySessions ?? 0, icon: MessageSquare, color: 'text-neutral-600 dark:text-neutral-400', bg: 'bg-neutral-100 dark:bg-neutral-800' },
    { title: t('dashboard.monthlyTokens'), value: stats?.monthlyTokens?.toLocaleString() ?? '0', icon: Activity, color: 'text-neutral-600 dark:text-neutral-400', bg: 'bg-neutral-100 dark:bg-neutral-800' },
  ];

  return (
    <div className="h-full overflow-y-auto px-4 sm:px-8 py-4 sm:py-6">
      <h1 className="text-base sm:text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4 sm:mb-6">
        {t('dashboard.title')}
      </h1>

      {/* Stats cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        {cards.map((card, i) => {
          const Icon = card.icon;
          return (
            <div key={i} className="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
              <div className="flex items-center gap-3">
                <div className={`inline-flex h-10 w-10 items-center justify-center rounded-lg ${card.bg}`}>
                  <Icon className={`h-5 w-5 ${card.color}`} strokeWidth={1.75} />
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-[0.04em] text-neutral-500 dark:text-neutral-400">
                    {card.title}
                  </p>
                  <p className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
                    {card.value}
                  </p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Channel status */}
      <div>
        <h2 className="text-[13px] font-semibold text-neutral-700 dark:text-neutral-300 mb-4">
          {t('dashboard.channelStatus')}
        </h2>
        <ChannelStatus />
      </div>
    </div>
  );
}
