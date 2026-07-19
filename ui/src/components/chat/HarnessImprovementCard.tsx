import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X, Edit3, EyeOff, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Button from '../ui/Button';
import Textarea from '../ui/Textarea';

export type HarnessDecision = 'approve' | 'reject' | 'ignore' | 'edit_submit';

interface HarnessAction {
  id: string;
  label: string;
  style: 'primary' | 'default' | 'danger';
  inputField?: any;
}

export interface HarnessImprovementProposal {
  id: string;
  title: string;
  failureSummary: string;
  detail: string;
  diff: { surface: string; before: string; after: string };
  impact: { scope: string; riskLevel: string; expectedEffect: string };
  actions: Array<HarnessAction>;
}

interface HarnessImprovementCardProps {
  proposal: HarnessImprovementProposal;
  onDecision: (action: string, editedValue?: string) => void;
}

export default function HarnessImprovementCard({
  proposal,
  onDecision,
}: HarnessImprovementCardProps) {
  const { t } = useTranslation('common');
  const [status, setStatus] = useState<'idle' | 'approved' | 'rejected' | 'editing' | 'dismissed'>('idle');
  const [editedValue, setEditedValue] = useState(proposal.diff.after);
  const [submitting, setSubmitting] = useState(false);

  const handleAction = useCallback(async (action: HarnessAction) => {
    if (action.style === 'danger') {
      setStatus('rejected');
      onDecision(action.id);
      return;
    }

    if (action.inputField) {
      setStatus('editing');
      return;
    }

    setSubmitting(true);
    try {
      setStatus('approved');
      onDecision(action.id);
    } finally {
      setSubmitting(false);
    }
  }, [onDecision]);

  const handleEditSubmit = useCallback(() => {
    setSubmitting(true);
    try {
      setStatus('approved');
      onDecision('edit_submit', editedValue);
    } finally {
      setSubmitting(false);
    }
  }, [onDecision, editedValue]);

  const handleEditCancel = useCallback(() => {
    setStatus('idle');
    setEditedValue(proposal.diff.after);
  }, [proposal.diff.after]);

  const handleDismiss = useCallback(() => {
    setStatus('dismissed');
    onDecision('ignore');
  }, [onDecision]);

  if (status === 'dismissed') {
    return null;
  }

  if (status === 'approved') {
    return (
      <div className="rounded-lg border border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-950/30 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-green-500">
            <Check size={12} className="text-white" />
          </div>
          <span className="text-sm font-medium text-green-800 dark:text-green-300">
            {t('chat.harnessImprovement.applied', 'Applied')}
          </span>
          <span className="text-xs text-green-600 dark:text-green-400 ml-1">
            &mdash; {proposal.title}
          </span>
        </div>
      </div>
    );
  }

  if (status === 'rejected') {
    return (
      <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-4 py-3 opacity-60 transition-opacity">
        <div className="flex items-center gap-2">
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-red-500">
            <X size={12} className="text-white" />
          </div>
          <span className="text-sm font-medium text-red-800 dark:text-red-300">
            {t('chat.harnessImprovement.rejected', 'Rejected')}
          </span>
          <span className="text-xs text-red-600 dark:text-red-400 ml-1">
            &mdash; {proposal.title}
          </span>
        </div>
      </div>
    );
  }

  if (status === 'editing') {
    return (
      <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden">
        <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
          <div className="flex items-center gap-2">
            <Edit3 size={15} className="text-neutral-500 dark:text-neutral-400" />
            <span className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">
              {t('chat.harnessImprovement.title')}
            </span>
          </div>
        </div>
        <div className="px-4 py-3 space-y-3">
          <p className="text-xs text-neutral-600 dark:text-neutral-400 leading-relaxed">
            {proposal.failureSummary}
          </p>
          <Textarea
            label={t('chat.harnessImprovement.editLabel', 'Modified Value')}
            value={editedValue}
            onChange={(e) => setEditedValue(e.target.value)}
            rows={4}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={handleEditSubmit}
              disabled={submitting}
            >
              {submitting ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Check size={14} />
              )}
              {t('chat.harnessImprovement.editSubmit', 'Submit Changes')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleEditCancel}
              disabled={submitting}
            >
              {t('chat.harnessImprovement.editCancel', 'Cancel')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // idle state
  const riskColor =
    proposal.impact.riskLevel === 'high'
      ? 'text-red-600 dark:text-red-400'
      : proposal.impact.riskLevel === 'medium'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-green-600 dark:text-green-400';

  return (
    <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50">
        <Edit3 size={15} className="text-neutral-500 dark:text-neutral-400" />
        <span className="text-sm font-semibold text-neutral-800 dark:text-neutral-200">
          {t('chat.harnessImprovement.title')}
        </span>
      </div>

      {/* Body */}
      <div className="px-4 py-3 space-y-3">
        {/* Failure Summary */}
        <p className="text-sm text-neutral-700 dark:text-neutral-300 leading-relaxed">
          {proposal.failureSummary}
        </p>

        {/* Detail (markdown rendered) */}
        {proposal.detail && (
          <div className="text-sm text-neutral-600 dark:text-neutral-400 markdown-content prose prose-sm max-w-none dark:prose-invert">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {proposal.detail}
            </ReactMarkdown>
          </div>
        )}

        {/* Diff Section */}
        <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
          <div className="px-3 py-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400 bg-neutral-100 dark:bg-neutral-800 border-b border-neutral-200 dark:border-neutral-700">
            {t('chat.harnessImprovement.diff')}
            {proposal.diff.surface && (
              <span className="ml-1.5 text-neutral-400 dark:text-neutral-500 font-normal">
                ({proposal.diff.surface})
              </span>
            )}
          </div>
          <div className="px-3 py-2 space-y-1 text-xs font-mono">
            <div className="flex items-start gap-2 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 rounded px-2 py-1">
              <span className="select-none shrink-0">-</span>
              <span className="whitespace-pre-wrap">{proposal.diff.before}</span>
            </div>
            <div className="flex items-start gap-2 text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 rounded px-2 py-1">
              <span className="select-none shrink-0">+</span>
              <span className="whitespace-pre-wrap">{proposal.diff.after}</span>
            </div>
          </div>
        </div>

        {/* Impact */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
          <span>
            {t('chat.harnessImprovement.impact')}:{' '}
            <span className="font-medium text-neutral-700 dark:text-neutral-300">
              {proposal.impact.scope}
            </span>
          </span>
          <span>
            {t('chat.harnessImprovement.risk')}:{' '}
            <span className={`font-medium ${riskColor}`}>
              {proposal.impact.riskLevel}
            </span>
          </span>
          {proposal.impact.expectedEffect && (
            <span className="text-neutral-400 dark:text-neutral-500">
              &middot; {proposal.impact.expectedEffect}
            </span>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-1.5 sm:gap-2 px-4 py-3 border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50">
        {proposal.actions.map((action) => {
          const icon =
            action.style === 'primary' ? (
              <Check size={14} />
            ) : action.style === 'danger' ? (
              <X size={14} />
            ) : (
              <EyeOff size={14} />
            );

          const variant =
            action.style === 'primary'
              ? 'primary'
              : action.style === 'danger'
                ? 'danger'
                : 'ghost';

          return (
            <Button
              key={action.id}
              size="sm"
              variant={variant}
              onClick={() => handleAction(action)}
              disabled={submitting}
            >
              {icon}
              <span>{action.label}</span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
