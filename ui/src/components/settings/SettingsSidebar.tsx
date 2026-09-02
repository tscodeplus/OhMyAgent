import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';
import Select from '../ui/Select';
import type { SettingsTabDef, SettingsGroupId } from './SettingsModal';
import { SETTINGS_GROUP_DEFS } from './SettingsModal';

interface SettingsSidebarProps {
  groups: readonly SettingsTabDef[];
  activeGroup: string;
  onSelect: (id: string) => void;
  /** Tabs with unsaved changes — shown as a dot on the sidebar (B2). */
  dirtyTabs?: ReadonlySet<string>;
  /** Rendered beside the picker on phones only (e.g. save/cancel/close). */
  mobileActions?: ReactNode;
}

interface GroupedTabs {
  id: SettingsGroupId;
  tabs: SettingsTabDef[];
}

const GROUP_ORDER: SettingsGroupId[] = ['general', 'agent', 'integration', 'system'];

function groupTabs(groups: readonly SettingsTabDef[]): GroupedTabs[] {
  return GROUP_ORDER.map((id) => ({
    id,
    tabs: groups.filter((g) => g.group === id),
  })).filter((g) => g.tabs.length > 0);
}

export default function SettingsSidebar({
  groups,
  activeGroup,
  onSelect,
  dirtyTabs,
  mobileActions,
}: SettingsSidebarProps) {
  const { t } = useTranslation('common');
  const grouped = groupTabs(groups);

  return (
    <>
      {/* Desktop: vertical sidebar with grouped section headers + icons */}
      <nav className="hidden sm:flex flex-1 flex-col overflow-y-auto py-1">
        {grouped.map(({ id, tabs }) => {
          const def = SETTINGS_GROUP_DEFS[id];
          const GroupIcon = def.icon;
          return (
            <div key={id} className="mt-1 first:mt-0">
              <div className="flex items-center gap-1.5 px-2 pt-3 pb-1">
                <GroupIcon
                  size={11}
                  strokeWidth={2}
                  className="text-neutral-400 dark:text-neutral-500"
                />
                <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-neutral-400 dark:text-neutral-500">
                  {t(def.labelKey)}
                </span>
              </div>
              {tabs.map((tab) => {
                const TabIcon = tab.icon;
                const active = activeGroup === tab.id;
                const dirty = dirtyTabs?.has(tab.id) ?? false;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => onSelect(tab.id)}
                    className={cn(
                      'flex w-full items-center gap-2 px-4 py-2 text-left text-[13px] transition-colors whitespace-nowrap',
                      active
                        ? 'bg-neutral-200/70 text-neutral-900 font-medium dark:bg-neutral-800 dark:text-neutral-100'
                        : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100',
                    )}
                  >
                    <TabIcon size={13} strokeWidth={1.75} className="shrink-0 opacity-80" />
                    <span className="flex-1 truncate">{t(tab.labelKey)}</span>
                    {dirty && !active && (
                      <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                        title={t('settings.unsavedBadge')}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </nav>

      {/* Mobile: single header row — section picker (shortened) shares the
          line with the dialog actions; grouped via <optgroup>. */}
      <div className="sm:hidden flex items-center gap-2 px-3 py-2 min-w-0">
        <Select
          value={activeGroup}
          onChange={(e) => onSelect(e.target.value)}
          className="min-w-0 flex-1"
          groups={grouped.map(({ id, tabs }) => ({
            label: t(SETTINGS_GROUP_DEFS[id].labelKey),
            options: tabs.map((tab) => ({ value: tab.id, label: t(tab.labelKey) })),
          }))}
        />
        {mobileActions}
      </div>
    </>
  );
}
