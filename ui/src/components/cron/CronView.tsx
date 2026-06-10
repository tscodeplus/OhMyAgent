import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil, Trash2, Play, Pause, Clock, Search } from 'lucide-react';
import { apiRequest } from '../../utils/api';
import { useToast } from '../ui/Toast';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Textarea from '../ui/Textarea';
import Select from '../ui/Select';
import Modal from '../ui/Modal';
import Toggle from '../ui/Toggle';
import Spinner from '../ui/Spinner';
import { formatRelativeTime } from '../../lib/utils';
import { cronToHuman } from '../../utils/cron-human';

const CHANNEL_LABELS: Record<string, string> = {
  webui: 'WebUI',
  feishu: 'Feishu',
  telegram: 'Telegram',
  wechat: 'WeChat',
  qq: 'QQ',
  cron: 'Cron',
};

interface CronJob {
  id: string;
  name: string;
  description?: string;
  expression: string;
  enabled: boolean;
  state: string;
  channel?: string;
  chat_id?: string;
  agent_id?: string;
  prompt?: string;
  last_run_at?: string;
  next_run_at?: string;
  created_at: string;
}

/** Convert ISO timestamp to local datetime-local string for <input type="datetime-local"> */
function toLocalDatetime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const STATE_COLORS: Record<string, string> = {
  idle: 'bg-blue-50 text-blue-600 dark:bg-blue-950/30 dark:text-blue-400',
  running: 'bg-amber-50 text-amber-600 dark:bg-amber-950/30 dark:text-amber-400',
  paused: 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
  completed: 'bg-green-50 text-green-600 dark:bg-green-950/30 dark:text-green-400',
};

export default function CronView() {
  const { t } = useTranslation('common');
  const { showToast } = useToast();
  const COMMON_EXPRESSIONS = [
    { value: '*/5 * * * *', label: t('cron.every_5min') },
    { value: '0 * * * *', label: t('cron.every_hour') },
    { value: '0 9 * * *', label: t('cron.every_9am') },
    { value: '0 9 * * 1-5', label: t('cron.weekday_9am') },
    { value: '0 0 1 * *', label: t('cron.monthly_1st') },
  ];
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [showEditor, setShowEditor] = useState(false);
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);
  const [saving, setSaving] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Form state
  const [formName, setFormName] = useState('');
  const [formExpr, setFormExpr] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formPrompt, setFormPrompt] = useState('');
  const [formAgentId, setFormAgentId] = useState('');
  const [formChannel, setFormChannel] = useState('webui');
  const [formNextRun, setFormNextRun] = useState('');
  const [formEnabled, setFormEnabled] = useState(true);
  // Resolve Select value: if formExpr matches a preset, use it; otherwise show "__custom__"
  const expressionSelectValue = COMMON_EXPRESSIONS.some(e => e.value === formExpr) ? formExpr : '__custom__';
  const humanExpr = cronToHuman(formExpr);

  const fetchJobs = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (searchQuery) params.set('q', searchQuery);
      const data = await apiRequest<CronJob[]>(`/api/cron/jobs?${params.toString()}`);
      setJobs(data);
    } catch {
      setJobs([]);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, searchQuery]);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  const openNew = () => {
    setEditingJob(null);
    setFormName('');
    setFormExpr('0 9 * * *');
    setFormDesc('');
    setFormPrompt('');
    setFormAgentId('');
    setFormChannel('webui');
    setFormNextRun('');
    setFormEnabled(true);
    setShowEditor(true);
  };

  const openEdit = (job: CronJob) => {
    setEditingJob(job);
    setFormName(job.name);
    setFormExpr(job.expression);
    setFormDesc(job.description || '');
    setFormPrompt(job.prompt || '');
    setFormAgentId(job.agent_id || '');
    setFormChannel(job.channel || 'webui');
    // Format next_run_at as local datetime-local string for the input
    setFormNextRun(job.next_run_at ? toLocalDatetime(job.next_run_at) : '');
    setFormEnabled(job.enabled);
    setShowEditor(true);
  };

  const handleSave = async () => {
    if (!formName.trim() || !formExpr.trim()) {
      showToast(t('cron.nameExprRequired'), 'error');
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: formName.trim(),
        expression: formExpr.trim(),
        description: formDesc.trim(),
        prompt: formPrompt.trim(),
        agent_id: formAgentId.trim() || undefined,
        channel: formChannel,
        enabled: formEnabled,
      };
      // Include next_run_at if user edited it
      if (formNextRun) {
        body.next_run_at = new Date(formNextRun).toISOString();
      } else if (formNextRun === '') {
        // Keep existing or let backend recompute
      }
      if (editingJob) {
        await apiRequest(`/api/cron/jobs/${editingJob.id}`, {
          method: 'PUT',
          body: JSON.stringify(body),
        });
      } else {
        await apiRequest('/api/cron/jobs', {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }
      showToast(t('cron.saved'), 'success');
      setShowEditor(false);
      fetchJobs();
    } catch { showToast(t('cron.saveError'), 'error'); } finally { setSaving(false); }
  };

  const handleDelete = async (id: string) => {
    try {
      await apiRequest(`/api/cron/jobs/${id}`, { method: 'DELETE' });
      showToast(t('project.deleted'), 'success');
      fetchJobs();
    } catch { showToast(t('project.deleteError'), 'error'); }
  };

  const handleToggle = async (job: CronJob) => {
    try {
      await apiRequest(`/api/cron/jobs/${job.id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: !job.enabled }),
      });
      fetchJobs();
    } catch { showToast(t('cron.operError'), 'error'); }
  };

  const handleRunNow = async (id: string) => {
    try {
      await apiRequest(`/api/cron/jobs/${id}/run`, { method: 'POST' });
      showToast(t('cron.triggered'), 'success');
      fetchJobs();
    } catch { showToast(t('cron.triggerError'), 'error'); }
  };

  return (
    <div className="h-full overflow-y-auto px-4 sm:px-8 py-4 sm:py-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl sm:text-2xl font-bold">{t('cron.title')}</h1>
        <Button size="sm" onClick={openNew}><Plus size={14} /> {t('cron.newJob')}</Button>
      </div>

      {/* Search & Filters */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 dark:text-neutral-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('cron.search')}
            className="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 pl-9 pr-3 py-2 text-sm focus:border-primary focus:outline-none"
          />
        </div>
        <Select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          options={[
            { value: 'all', label: t('cron.all') },
            { value: 'idle', label: t('cron.state.idle') },
            { value: 'running', label: t('cron.state.running') },
            { value: 'paused', label: t('cron.state.paused') },
            { value: 'completed', label: t('cron.state.completed') },
          ]}
          className="w-[140px]"
        />
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-12 text-neutral-500 dark:text-neutral-400 text-sm">{t('cron.noJobs')}</div>
      ) : (
        <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 overflow-hidden overflow-x-auto">
          <table className="w-full text-sm min-w-[600px]">
            <thead className="bg-neutral-100 dark:bg-neutral-800">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">{t('cron.name')}</th>
                <th className="text-left px-4 py-2.5 font-medium">{t('cron.expression')}</th>
                <th className="text-left px-4 py-2.5 font-medium">{t('cron.channel')}</th>
                <th className="text-left px-4 py-2.5 font-medium">{t('cron.status')}</th>
                <th className="text-left px-4 py-2.5 font-medium">{t('cron.lastRun')}</th>
                <th className="text-right px-4 py-2.5 font-medium">{t('cron.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {jobs.map((job) => {
                const jobHuman = cronToHuman(job.expression);
                return (
                <tr key={job.id} className="hover:bg-neutral-100/30 dark:bg-neutral-800/30">
                  <td className="px-4 py-2.5">
                    <p className="font-medium">{job.name}</p>
                    {job.description && <p className="text-xs text-neutral-500 dark:text-neutral-400">{job.description}</p>}
                  </td>
                  <td className="px-4 py-2.5">
                    <code className="text-xs">{job.expression}</code>
                    {jobHuman && <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-0.5">{jobHuman}</p>}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="text-xs px-2 py-0.5 rounded bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                      {CHANNEL_LABELS[job.channel || 'webui'] || job.channel || 'WebUI'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${STATE_COLORS[job.state] || STATE_COLORS.idle}`}>
                      {t(`cron.state.${job.state}`, { defaultValue: job.state })}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-neutral-500 dark:text-neutral-400">
                    {job.last_run_at ? formatRelativeTime(job.last_run_at) : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => handleRunNow(job.id)} className="p-1.5 hover:bg-neutral-100 dark:bg-neutral-800 rounded" title={t('cron.runNow')}>
                        <Play size={14} />
                      </button>
                      <button onClick={() => openEdit(job)} className="p-1.5 hover:bg-neutral-100 dark:bg-neutral-800 rounded" title={t('cron.edit')}>
                        <Pencil size={14} />
                      </button>
                      <button onClick={() => handleDelete(job.id)} className="p-1.5 hover:bg-neutral-100 dark:bg-neutral-800 rounded text-danger" title={t('cron.delete')}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              )})}
            </tbody>
          </table>
        </div>
      )}

      {/* Editor Modal */}
      {showEditor && (
        <Modal
          open={true}
          onClose={() => setShowEditor(false)}
          title={editingJob ? t('cron.edit') : t('cron.newJob')}
          size="sm"
          footer={
            <>
              <Button variant="secondary" onClick={() => setShowEditor(false)}>{t('common.cancel')}</Button>
              <Button onClick={handleSave} loading={saving}>{t("cron.save")}</Button>
            </>
          }
        >
          <div className="space-y-4">
            <Input label={t('cron.name')} value={formName} onChange={(e) => setFormName(e.target.value)} placeholder={t("cron.namePlaceholder")} />
            <Textarea label={t("cron.description")} value={formDesc} onChange={(e) => setFormDesc(e.target.value)} rows={2} />
            <div>
              <Select label={t('cron.expression')} value={expressionSelectValue} onChange={(e) => {
                const v = e.target.value;
                if (v === '__custom__') return; // keep current formExpr
                setFormExpr(v);
              }}
                options={[
                  ...COMMON_EXPRESSIONS.map((e) => ({ value: e.value, label: e.label })),
                  { value: '__custom__', label: t('cron.custom') },
                ]} />
              {expressionSelectValue === '__custom__' && (
                <Input value={formExpr} onChange={(e) => setFormExpr(e.target.value)} placeholder={t("cron.customExpr")} className="mt-2" />
              )}
              {humanExpr && (
                <p className="mt-1 text-xs text-blue-600 dark:text-blue-400">{t('cron.humanPreview')}: {humanExpr}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Select label={t('cron.channel')} value={formChannel} onChange={(e) => setFormChannel(e.target.value)}
                options={[
                  { value: 'webui', label: 'WebUI' },
                  { value: 'feishu', label: 'Feishu' },
                  { value: 'telegram', label: 'Telegram' },
                  { value: 'wechat', label: 'WeChat' },
                  { value: 'qq', label: 'QQ' },
                ]} />
              <Input label={t('cron.nextRun')} type="datetime-local" value={formNextRun} onChange={(e) => setFormNextRun(e.target.value)} />
            </div>
            {editingJob && (editingJob.state === 'completed' || editingJob.state === 'paused') && (
              <p className="text-xs text-amber-600 dark:text-amber-400">{t('cron.willReactivate')}</p>
            )}
            <Textarea label={t("cron.prompt_optional")} value={formPrompt} onChange={(e) => setFormPrompt(e.target.value)} rows={3} />
            <div className="flex items-center justify-between">
              <label className="text-sm">{t("cron.enabled")}</label>
              <Toggle checked={formEnabled} onChange={setFormEnabled} />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
