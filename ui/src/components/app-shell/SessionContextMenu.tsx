import { useTranslation } from 'react-i18next';
import { Pencil, Trash2 } from 'lucide-react';

/**
 * Right-click / long-press menu for a conversation row.
 *
 * Shared by the project session list and the IM inbox so the two lists cannot
 * disagree about what a row menu contains or where it may be placed: the menu is
 * fixed-positioned and clamped to the viewport, otherwise opening it near the
 * bottom edge (or a long press near the right edge on a phone) puts the buttons
 * off screen.
 */
export interface SessionContextMenuProps {
  x: number;
  y: number;
  onRename: () => void;
  onDelete: () => void;
}

const MENU_WIDTH = 176;
const MENU_HEIGHT = 72;

export default function SessionContextMenu({ x, y, onRename, onDelete }: SessionContextMenuProps) {
  const { t } = useTranslation('common');
  const left = Math.max(4, Math.min(x, window.innerWidth - MENU_WIDTH - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - MENU_HEIGHT - 4));

  return (
    <div
      role="menu"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className="fixed z-50 w-44 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
      style={{ left, top }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={onRename}
        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-neutral-800 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800"
      >
        <Pencil
          className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400"
          strokeWidth={1.75}
        />
        <span>{t('sidebar.rename')}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={onDelete}
        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
      >
        <Trash2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
        <span>{t('sidebar.delete')}</span>
      </button>
    </div>
  );
}
