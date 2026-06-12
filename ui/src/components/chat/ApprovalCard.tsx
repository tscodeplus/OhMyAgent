import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Shield, Check, Star, X } from 'lucide-react';
import Button from '../ui/Button';

export type ApprovalDecision = 'approve_once' | 'approve_session' | 'approve_always' | 'reject_once';

interface ApprovalCardProps {
  approvalId: string;
  toolName: string;
  commandText: string;
  riskLevel: 'low' | 'medium' | 'high';
  reason: string;
  /** Initial status from persisted data (e.g. 'approved' from API after page refresh). */
  initialStatus?: 'pending' | 'approved' | 'rejected';
  /** Set when auto-rejected by timeout. Shows a specific reason message. */
  timeoutReason?: string;
  expiresAt?: string;
  onResolve?: (id: string, decision: ApprovalDecision) => void;
}

const riskColors: Record<string, string> = {
  low: 'bg-success/10 text-success border-success/30',
  medium: 'bg-warning/10 text-warning border-warning/30',
  high: 'bg-danger/10 text-danger border-danger/30',
};

const decisionLabels: Record<ApprovalDecision, { icon: ReactNode; text: string }> = {
  approve_once:    { icon: <Check size={14} className="text-green-500" />, text: 'chat.approveOnce' },
  approve_session: { icon: <Check size={14} className="text-green-500" />, text: 'chat.approveSession' },
  approve_always:  { icon: <Star size={14} className="text-yellow-500" />, text: 'chat.alwaysAllow' },
  reject_once:     { icon: <X size={14} className="text-red-500" />,    text: 'chat.reject' },
};

export default function ApprovalCard({
  approvalId,
  toolName,
  commandText,
  riskLevel,
  reason,
  initialStatus,
  timeoutReason,
  expiresAt: _expiresAt,
  onResolve,
}: ApprovalCardProps) {
  const { t } = useTranslation('common');
  const [localStatus, setLocalStatus] = useState<'pending' | 'approved' | 'rejected' | null>(null);

  // Derive effective status: initialStatus from props (SSE / page refresh)
  // takes precedence over local state set by button clicks. This ensures
  // approval_resolved SSE events update the card immediately.
  const status = (initialStatus && initialStatus !== 'pending') ? initialStatus : (localStatus || initialStatus || 'pending');

  const handleResolve = (decision: ApprovalDecision) => {
    if (decision.startsWith('approve')) {
      setLocalStatus('approved');
    } else {
      setLocalStatus('rejected');
    }
    onResolve?.(approvalId, decision);
  };

  if (status !== 'pending') {
    const rejectedLabel = timeoutReason
      ? (timeoutReason === 'steered'
          ? t('chat.steeredRejected', '收到新消息，自动拒绝未审批项')
          : t('chat.timeoutRejected', '超时已自动拒绝'))
      : t('chat.rejected');
    return (
      <div className={`rounded-lg border px-4 py-3 text-sm ${status === 'approved' ? 'bg-success/10 border-success/30' : 'bg-danger/10 border-danger/30'}`}>
        {status === 'approved' ? t('chat.approved') : rejectedLabel} — {toolName}
      </div>
    );
  }

  return (
    <div className={`rounded-lg border px-4 py-3 ${riskColors[riskLevel]}`}>
      <div className="flex items-center gap-2 mb-2">
        <Shield size={16} />
        <span className="font-semibold text-sm">{t("chat.approvalRequest")}: {toolName}</span>
      </div>
      <pre className="text-xs mb-2 whitespace-pre-wrap bg-black/10 rounded px-2 py-1">
        {commandText}
      </pre>
      {reason && <p className="text-xs mb-3">{reason}</p>}
      <div className="flex flex-wrap gap-1.5 sm:gap-2">
        {(['approve_once', 'approve_session', 'approve_always', 'reject_once'] as ApprovalDecision[]).map((decision) => (
          <Button
            key={decision}
            size="sm"
            variant={decision === 'reject_once' ? 'danger' : 'primary'}
            onClick={() => handleResolve(decision)}
          >
            {decisionLabels[decision].icon}
            <span className="hidden sm:inline">{t(decisionLabels[decision].text)}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}
