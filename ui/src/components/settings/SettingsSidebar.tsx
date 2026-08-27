import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';

interface SettingsSidebarProps {
  groups: readonly { id: string; labelKey: string }[];
  activeGroup: string;
  onSelect: (id: string) => void;
  /** Rendered beside the picker on phones only (e.g. save/cancel/close). */
  mobileActions?: ReactNode;
}

export default function SettingsSidebar({ groups, activeGroup, onSelect, mobileActions }: SettingsSidebarProps) {
  const { t } = useTranslation('common');

  return (
    <>
      {/* Desktop: vertical sidebar */}
      <nav className="hidden sm:flex flex-1 flex-col overflow-y-auto py-1">
        {groups.map((group) => (
          <button
            key={group.id}
            type="button"
            onClick={() => onSelect(group.id)}
            className={cn(
              'w-full text-left px-4 py-2 text-[13px] transition-colors whitespace-nowrap',
              activeGroup === group.id
                ? 'bg-neutral-200/70 text-neutral-900 font-medium dark:bg-neutral-800 dark:text-neutral-100'
                : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100',
            )}
          >
            {t(group.labelKey)}
          </button>
        ))}
      </nav>

      {/* Mobile: single header row — section picker (shortened) shares the
          line with the dialog actions; no duplicate group-title row below. */}
      <div className="sm:hidden flex items-center gap-2 px-3 py-2 min-w-0">
        <select
          value={activeGroup}
          onChange={(e) => onSelect(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-white px-2.5 py-2 text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-blue-500/30 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        >
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {t(group.labelKey)}
            </option>
          ))}
        </select>
        {mobileActions}
      </div>
    </>
  );
}
