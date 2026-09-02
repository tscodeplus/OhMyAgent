import { isElectron } from '../../utils/env';
import WindowControls from './WindowControls';

interface DesktopCaptionProps {
  /** macOS keeps its native traffic lights — the strip stays as a drag
   *  region but renders no custom buttons. */
  mac?: boolean;
  /** Optional subtle label at the strip's left (the shell has no visible
   *  toolbar, so this stays muted and doubles as part of the drag region). */
  text?: string;
}

/**
 * Frameless-caption strip for the immersive desktop shell: an invisible
 * 44px row that doubles as the window drag region (deep — clicks on the
 * label drag; buttons keep working) with window controls at the top right.
 * Rendered only inside the desktop shell; browser mode has no strip at all.
 */
export default function DesktopCaption({ mac, text }: DesktopCaptionProps) {
  if (!isElectron()) return null;
  return (
    <div
      data-tauri-drag-region="deep"
      className="relative z-20 flex h-11 shrink-0 select-none items-center pl-4"
    >
      {text ? (
        <span title={text} className="truncate text-[12px] text-neutral-400 dark:text-neutral-500">
          {text}
        </span>
      ) : null}
      <div className="ml-auto flex h-full items-stretch" data-tauri-drag-region="false">
        <WindowControls hidden={mac} />
      </div>
    </div>
  );
}
