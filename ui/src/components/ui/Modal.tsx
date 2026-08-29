import { useEffect, useCallback, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'full';
  footer?: ReactNode;
}

const sizeClasses: Record<string, string> = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  full: 'max-w-[95vw] max-h-[95vh]',
};

export default function Modal({ open, onClose, title, children, size = 'md', footer }: ModalProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); },
    [onClose]
  );

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeyDown);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center sm:p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className={`relative w-full ${sizeClasses[size]} max-sm:rounded-t-2xl max-sm:rounded-b-none sm:rounded-xl border border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900 flex flex-col max-sm:max-h-[92dvh] sm:max-h-[90vh] animate-oma-sheet-up sm:animate-none pb-safe`}>
        {/* Mobile bottom-sheet grab handle */}
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-neutral-300 sm:hidden dark:bg-neutral-600" />
        {title && (
          <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-200 dark:border-neutral-800 shrink-0">
            <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{title}</h2>
            <button onClick={onClose} className="rounded-md p-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors">
              <X size={16} className="text-neutral-500" />
            </button>
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col min-h-0">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-neutral-200 dark:border-neutral-800 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
