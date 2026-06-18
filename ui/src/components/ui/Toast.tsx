import { useState, useEffect, useCallback, createContext, useContext, useRef, type ReactNode } from 'react';
import { X, CheckCircle, AlertCircle, Info } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info';

interface ToastAction {
  label: string;
  onClick: () => void;
  /** Render as a danger/confirm button (red) vs neutral (gray) */
  danger?: boolean;
}

interface Toast {
  id: number;
  message: string;
  type: ToastType;
  duration: number;
  actions?: ToastAction[];
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType, duration?: number, actions?: ToastAction[]) => void;
}

const ToastContext = createContext<ToastContextValue>({ showToast: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextIdRef = useRef(1);

  const showToast = useCallback(
    (message: string, type: ToastType = 'info', duration = 1500, actions?: ToastAction[]) => {
      const id = nextIdRef.current++;
      // When actions are present, default to sticky (duration=0) unless explicitly set
      const effectiveDuration = actions && actions.length > 0 && duration === 1500 ? 0 : duration;
      setToasts((prev) => [...prev, { id, message, type, duration: effectiveDuration, actions }]);
    },
    [],
  );

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toasts.length > 0 && (
        <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-2 pointer-events-none bg-black/20 dark:bg-black/50">
          {toasts.map((toast) => (
            <ToastItem key={toast.id} toast={toast} onRemove={() => removeToast(toast.id)} />
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onRemove }: { toast: Toast; onRemove: () => void }) {
  useEffect(() => {
    // If there's an action button, don't auto-dismiss (duration 0 = sticky)
    if (toast.duration <= 0) return;
    const timer = setTimeout(onRemove, toast.duration);
    return () => clearTimeout(timer);
  }, [onRemove, toast.duration]);

  const icons: Record<ToastType, typeof CheckCircle> = {
    success: CheckCircle,
    error: AlertCircle,
    info: Info,
  };

  // Type-specific colored background — stands out clearly from page bg
  const typeCard: Record<ToastType, string> = {
    success:
      'bg-emerald-50 dark:bg-emerald-950 ' +
      'border-2 border-emerald-300 dark:border-emerald-700 ' +
      'shadow-2xl shadow-emerald-500/10 dark:shadow-black/50',
    error:
      'bg-red-50 dark:bg-red-950 ' +
      'border-2 border-red-300 dark:border-red-700 ' +
      'shadow-2xl shadow-red-500/10 dark:shadow-black/50',
    info:
      'bg-blue-50 dark:bg-blue-950 ' +
      'border-2 border-blue-300 dark:border-blue-700 ' +
      'shadow-2xl shadow-blue-500/10 dark:shadow-black/50',
  };

  const typeIcon: Record<ToastType, string> = {
    success: 'text-emerald-700 dark:text-emerald-300',
    error:   'text-red-700 dark:text-red-300',
    info:    'text-blue-700 dark:text-blue-300',
  };

  const card = typeCard[toast.type];
  const ic = typeIcon[toast.type];
  const Icon = icons[toast.type];

  return (
    <div
      className={`pointer-events-auto flex flex-col rounded-lg px-4 py-3 min-w-[320px] max-w-[520px] animate-[toast-in_0.2s_ease-out] ${card}`}
    >
      <div className="flex items-start gap-3 w-full">
        <Icon size={18} className={`shrink-0 mt-0.5 ${ic}`} />
        <span className="text-sm flex-1 whitespace-pre-wrap leading-snug text-neutral-900 dark:text-neutral-100 max-h-[55vh] overflow-y-auto break-words">{toast.message}</span>
        <button
          onClick={onRemove}
          className={`shrink-0 rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10 transition-colors ${ic}`}
        >
          <X size={16} strokeWidth={2} />
        </button>
      </div>
      {toast.actions && toast.actions.length > 0 && (
        <div className="flex items-center gap-2 mt-3 justify-end">
          {toast.actions.map((act, i) => (
            <button
              key={i}
              onClick={() => {
                act.onClick();
                onRemove();
              }}
              className={
                act.danger
                  ? 'shrink-0 rounded-md bg-red-600 dark:bg-red-500 px-3 py-1 text-xs font-medium text-white hover:bg-red-700 dark:hover:bg-red-400 transition-colors'
                  : 'shrink-0 rounded-md bg-neutral-200 dark:bg-neutral-700 px-3 py-1 text-xs font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-300 dark:hover:bg-neutral-600 transition-colors'
              }
            >
              {act.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
