import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, ClipboardCheck, FileText } from 'lucide-react';
import KnowledgePageList, { type KnowledgeSelection } from './KnowledgePageList';
import KnowledgePageEditor from './KnowledgePageEditor';
import KnowledgeReviewQueue from './KnowledgeReviewQueue';
import { fetchKnowledgeStats } from './knowledge-api';
import type { KnowledgeStatsPayload } from './types';

type KnowledgeTab = 'pages' | 'review';

/**
 * The knowledge workbench: pages (browse, search, edit) and the shadow review
 * queue.
 *
 * The two live under one route because they are two views of the same table —
 * the queue is the subset of pages a human has not confirmed yet — and because
 * approving a page should land the reader in the list it just became part of.
 * Counts come from `/stats`, which is also the only place pending rows are
 * counted: the browse list never returns them.
 */
export default function KnowledgeView() {
  const { t } = useTranslation('common');

  const [tab, setTab] = useState<KnowledgeTab>('pages');
  const [stats, setStats] = useState<KnowledgeStatsPayload | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected] = useState<KnowledgeSelection | null>(null);
  /** Mobile: the list and the editor share the column, so one is shown at a time. */
  const [mobileEditor, setMobileEditor] = useState(false);
  /** The editor has unsaved text — switching pages would drop it. */
  const [editorDirty, setEditorDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchKnowledgeStats()
      .then((payload) => {
        if (!cancelled) setStats(payload);
      })
      .catch(() => {
        if (!cancelled) setStats(null);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const bump = useCallback(() => setRefreshKey((key) => key + 1), []);

  const handleSelect = useCallback(
    (selection: KnowledgeSelection) => {
      if (selection.id !== selected?.id && editorDirty) {
        if (!window.confirm(t('knowledge.editor.confirmDiscard') as string)) return;
      }
      setEditorDirty(false);
      setSelected(selection);
      setMobileEditor(true);
    },
    [editorDirty, selected?.id, t],
  );

  const handleCloseEditor = useCallback(() => {
    if (editorDirty && !window.confirm(t('knowledge.editor.confirmDiscard') as string)) return;
    setEditorDirty(false);
    setMobileEditor(false);
    setSelected(null);
  }, [editorDirty, t]);

  const pendingCount = stats?.byStatus.pending ?? 0;
  const indexWarning = stats?.fts && !stats.fts.consistent ? stats.fts : null;

  const tabs: Array<{ id: KnowledgeTab; label: string; icon: typeof FileText; badge?: number }> = [
    { id: 'pages', label: t('knowledge.tabPages'), icon: FileText },
    { id: 'review', label: t('knowledge.tabReview'), icon: ClipboardCheck, badge: pendingCount },
  ];

  return (
    <div className="flex h-full flex-col bg-white dark:bg-neutral-950">
      <header className="shrink-0 border-b border-neutral-200 px-3 pt-3 sm:px-6 dark:border-neutral-800">
        <h1 className="flex items-center gap-2 text-base font-semibold text-neutral-900 dark:text-neutral-100">
          <BookOpen size={18} strokeWidth={1.75} />
          {t('knowledge.title')}
        </h1>
        <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
          {t('knowledge.subtitle')}
        </p>
        {stats && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-500 dark:text-neutral-400">
            <span>{t('knowledge.statsTotal', { count: stats.total })}</span>
            <span>{t('knowledge.statsPending', { count: pendingCount })}</span>
            <span>{t('knowledge.statsArchived', { count: stats.byStatus.archived })}</span>
          </div>
        )}
        {indexWarning && (
          // `fts` is null when the knowledge tables do not exist yet; only a real
          // parity report can be inconsistent, and then it is worth saying so.
          <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
            {t('knowledge.indexWarning', {
              pages: indexWarning.pageCount,
              indexed: indexWarning.indexedRowCount,
            })}
          </p>
        )}
        <nav className="mt-2 flex items-center gap-1" role="tablist">
          {tabs.map((entry) => {
            const Icon = entry.icon;
            const active = tab === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(entry.id)}
                className={`inline-flex items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-1.5 text-[13px] font-medium transition-colors ${
                  active
                    ? 'border-neutral-800 text-neutral-900 dark:border-neutral-200 dark:text-neutral-100'
                    : 'border-transparent text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200'
                }`}
              >
                <Icon size={14} strokeWidth={1.75} />
                <span>{entry.label}</span>
                {entry.badge !== undefined && entry.badge > 0 && (
                  <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
                    {entry.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </header>

      {tab === 'pages' ? (
        <div className="flex min-h-0 flex-1">
          <div
            className={`flex min-h-0 w-full shrink-0 flex-col border-r border-neutral-200 max-sm:border-r-0 sm:w-80 dark:border-neutral-800 ${
              mobileEditor ? 'max-sm:hidden' : ''
            }`}
          >
            <KnowledgePageList
              selectedId={selected?.id ?? null}
              onSelect={handleSelect}
              refreshKey={refreshKey}
            />
          </div>
          <div className={`flex min-h-0 flex-1 flex-col ${mobileEditor ? '' : 'max-sm:hidden'}`}>
            {selected ? (
              <KnowledgePageEditor
                key={selected.id}
                selection={selected}
                onClose={handleCloseEditor}
                onSaved={bump}
                onDirtyChange={setEditorDirty}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center px-6 text-center">
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {t('knowledge.selectPrompt')}
                </p>
              </div>
            )}
          </div>
        </div>
      ) : (
        <KnowledgeReviewQueue refreshKey={refreshKey} onChanged={bump} />
      )}
    </div>
  );
}
