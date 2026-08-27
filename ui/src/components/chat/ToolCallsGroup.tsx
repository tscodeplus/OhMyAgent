import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import type { ToolCall } from '../../types/session';
import ToolCallCard from './ToolCallCard';

interface ToolCallsGroupProps {
  /** Two or more consecutive tool calls that should be folded together. */
  toolCalls: ToolCall[];
}

/**
 * Collapsible wrapper for two or more consecutive tool calls.
 *
 * Single tool calls are rendered directly as a ToolCallCard (no folding);
 * only groups of 2+ consecutive calls are folded under "多轮工具调用"
 * (multi-round tool calls) so the timeline stays compact. The group is
 * collapsed by default — the user clicks the arrow to expand.
 */
export default function ToolCallsGroup({ toolCalls }: ToolCallsGroupProps) {
  const { t } = useTranslation('common');
  const [expanded, setExpanded] = useState(false);

  if (toolCalls.length < 2) {
    // Defensive: should never happen — callers only use this for 2+ calls.
    return <ToolCallCard toolCall={toolCalls[0]} />;
  }

  return (
    <div className="border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden bg-white dark:bg-neutral-900">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-sm  text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/60 transition-colors"
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Wrench size={14} className="text-neutral-500 dark:text-neutral-400" />
        <span className="font-medium">{t('chat.multiToolCalls')}</span>
        <span className="text-xs text-neutral-400 dark:text-neutral-500">({toolCalls.length})</span>
      </button>
      {expanded && (
        <div className="px-3 py-2 border-t border-neutral-200 dark:border-neutral-800 space-y-2">
          {toolCalls.map((tc) => (
            <ToolCallCard key={tc.id} toolCall={tc} />
          ))}
        </div>
      )}
    </div>
  );
}
