import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';
import Spinner from '../ui/Spinner';

export interface SelectionAction {
  label: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  onClick: () => void;
  /** Red styling for destructive actions (delete). */
  danger?: boolean;
  /** Disable while nothing is selected, or while a request is in flight. */
  disabled?: boolean;
}

interface SelectionActionBarProps {
  count: number;
  /** Ids currently loaded — bound of what "全选" can mean without a server round trip. */
  loadedIds: string[];
  /** Selected ids, so the bar can flip 全选 / 取消全选. */
  selectedIds: ReadonlySet<string>;
  onSetMany: (ids: string[], on: boolean) => void;
  actions: SelectionAction[];
  onExit: () => void;
  /** Shows a spinner and disables the actions while a batch write runs. */
  busy?: boolean;
}

/**
 * Sticky action bar for a list in selection mode.
 *
 * It sticks to the top of the sidebar's scrolling column rather than floating
 * over the content: the sidebar is only ~250px wide, so a floating bar would
 * cover the rows it acts on. `sticky` also keeps it reachable while the list is
 * scrolled, which is the whole point of a batch action on a paged list.
 */
export default function SelectionActionBar({
  count,
  loadedIds,
  selectedIds,
  onSetMany,
  actions,
  onExit,
  busy = false,
}: SelectionActionBarProps) {
  const { t } = useTranslation('common');
  const allSelected = loadedIds.length > 0 && loadedIds.every((id) => selectedIds.has(id));
  const nothingSelected = count === 0;

  return (
    <div className="sticky top-0 z-10 mb-1 rounded-lg border border-neutral-200 bg-white/95 px-1.5 py-1 shadow-sm backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/95">
      <div className="flex items-center gap-1">
        <span className="shrink-0 px-1 text-[11px] font-medium tabular-nums text-neutral-600 dark:text-neutral-300">
          {t('selection.count', { count })}
        </span>
        <button
          type="button"
          onClick={() => onSetMany(loadedIds, !allSelected)}
          disabled={loadedIds.length === 0 || busy}
          className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] text-neutral-600 hover:bg-neutral-100 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {allSelected ? t('selection.clearAll') : t('selection.selectAll')}
        </button>
        <button
          type="button"
          onClick={onExit}
          disabled={busy}
          title={t('selection.exit')}
          aria-label={t('selection.exit')}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-100 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          <X className="h-3 w-3" strokeWidth={2} />
        </button>
      </div>
      <div className="mt-1 flex items-center gap-1">
        {busy && (
          <span className="flex h-6 w-6 shrink-0 items-center justify-center">
            <Spinner size="sm" />
          </span>
        )}
        {actions.map((action) => {
          const Icon = action.icon;
          const disabled = busy || action.disabled || nothingSelected;
          return (
            <button
              key={action.label}
              type="button"
              onClick={action.onClick}
              disabled={disabled}
              className={cn(
                'flex h-6 flex-1 items-center justify-center gap-1 rounded-md px-1 text-[11px] font-medium transition-colors disabled:opacity-40',
                action.danger
                  ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40'
                  : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800',
              )}
            >
              <Icon className="h-3 w-3 shrink-0" strokeWidth={1.75} />
              <span className="truncate">{action.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
