import { useTranslation } from 'react-i18next';
import { ArchiveRestore, CheckSquare, Pencil, Archive, Trash2 } from 'lucide-react';

/**
 * Right-click / long-press menu for a conversation row.
 *
 * Shared by the project session list, the IM inbox and the archive, so the three
 * lists cannot disagree about what a row menu contains or where it may be
 * placed: the menu is fixed-positioned and clamped to the viewport, otherwise
 * opening it near the bottom edge (or a long press near the right edge on a
 * phone) puts the buttons off screen.
 *
 * Every item but `onDelete` is optional: the archive has no rename, the project
 * list has no restore, and both only grow the menu when the caller passes the
 * handler. The clamp reads the rendered item count, so adding an item here
 * cannot push the menu off the bottom of the screen.
 */
export interface SessionContextMenuProps {
  x: number;
  y: number;
  onRename?: () => void;
  onDelete?: () => void;
  /** Move the conversation out of its list and into 归档. */
  onArchive?: () => void;
  /** Put an archived conversation back into its list. */
  onRestore?: () => void;
  /** Enter selection mode for a batch archive / restore. */
  onSelectMultiple?: () => void;
}

const MENU_WIDTH = 176;
const ITEM_HEIGHT = 32;
const MENU_PADDING = 8;

export default function SessionContextMenu({
  x,
  y,
  onRename,
  onDelete,
  onArchive,
  onRestore,
  onSelectMultiple,
}: SessionContextMenuProps) {
  const { t } = useTranslation('common');
  const itemCount = [onRename, onRestore ?? onArchive, onDelete, onSelectMultiple].filter(
    Boolean,
  ).length;
  const height = itemCount * ITEM_HEIGHT + MENU_PADDING;
  const left = Math.max(4, Math.min(x, window.innerWidth - MENU_WIDTH - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - height - 4));

  const itemClass =
    'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-neutral-800 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800';
  const iconClass = 'h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400';

  return (
    <div
      role="menu"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className="fixed z-50 w-44 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
      style={{ left, top }}
    >
      {onRename && (
        <button type="button" role="menuitem" onClick={onRename} className={itemClass}>
          <Pencil className={iconClass} strokeWidth={1.75} />
          <span>{t('sidebar.rename')}</span>
        </button>
      )}
      {onRestore && (
        <button type="button" role="menuitem" onClick={onRestore} className={itemClass}>
          <ArchiveRestore className={iconClass} strokeWidth={1.75} />
          <span>{t('archive.restore')}</span>
        </button>
      )}
      {onArchive && (
        <button type="button" role="menuitem" onClick={onArchive} className={itemClass}>
          <Archive className={iconClass} strokeWidth={1.75} />
          <span>{t('sidebar.archive')}</span>
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          role="menuitem"
          onClick={onDelete}
          className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
        >
          <Trash2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          <span>{t('sidebar.delete')}</span>
        </button>
      )}
      {/* 多选 sits last on purpose: it is a mode switch, not an action on this
          row, and keeping the destructive 删除 away from it is worth the extra
          thumb travel on a phone. */}
      {onSelectMultiple && (
        <button type="button" role="menuitem" onClick={onSelectMultiple} className={itemClass}>
          <CheckSquare className={iconClass} strokeWidth={1.75} />
          <span>{t('selection.mode')}</span>
        </button>
      )}
    </div>
  );
}
