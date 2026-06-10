import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Wrench, ChevronDown, ChevronRight, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import type { ToolCall } from '../../types/session';

interface ToolCallCardProps {
  toolCall: ToolCall;
}

export default function ToolCallCard({ toolCall }: ToolCallCardProps) {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState(false);

  const statusIcon = {
    running: <Loader2 size={14} className="animate-spin text-warning" />,
    success: <CheckCircle2 size={14} className="text-success" />,
    error: <XCircle size={14} className="text-danger" />,
  };

  return (
    <div className="border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden bg-white dark:bg-neutral-900">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-sm  text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/60 transition-colors"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Wrench size={14} className="text-neutral-500 dark:text-neutral-400" />
        <span className="font-medium">{t('chat.toolCall')}: {toolCall.name}</span>
        {statusIcon[toolCall.status]}
      </button>
      {expanded && (
        <div className="px-4 py-2 border-t border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-800/50 text-xs space-y-2">
          <div>
            <span className="font-semibold text-neutral-500 dark:text-neutral-400">Parameters:</span>
            <pre className="mt-1 whitespace-pre-wrap text-neutral-900 dark:text-neutral-100">
              {JSON.stringify(toolCall.arguments, null, 2)}
            </pre>
          </div>
          {toolCall.output && (
            <div>
              <span className="font-semibold text-neutral-500 dark:text-neutral-400">Output:</span>
              <pre className="mt-1 whitespace-pre-wrap text-neutral-900 dark:text-neutral-100">{toolCall.output}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
