import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HelpCircle, Send } from 'lucide-react';
import { apiRequest } from '../../utils/api';
import Button from '../ui/Button';

export interface UserQuestionData {
  requestId: string;
  question: string;
  options: Array<{ label: string; value: string }>;
}

interface UserQuestionCardProps {
  data: UserQuestionData;
  /** Initial status from SSE events (persisted across re-renders). */
  initialStatus?: 'pending' | 'answered';
  initialAnswer?: string;
  onResolve?: (requestId: string, answer: string) => void;
}

export default function UserQuestionCard({
  data,
  initialStatus,
  initialAnswer,
  onResolve,
}: UserQuestionCardProps) {
  const { t } = useTranslation('common');
  const [localStatus, setLocalStatus] = useState<'pending' | 'answered' | null>(null);
  const [textInput, setTextInput] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const status = initialStatus === 'answered'
    ? 'answered'
    : localStatus || 'pending';

  const handleOptionClick = async (value: string) => {
    setLocalStatus('answered');
    setSubmitting(true);
    try {
      await apiRequest(`/api/questions/${data.requestId}/answer`, {
        method: 'POST',
        body: JSON.stringify({ answer: value }),
      });
      onResolve?.(data.requestId, value);
    } catch (err) {
      console.error('Failed to submit answer:', err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleTextSubmit = async () => {
    const answer = textInput.trim();
    if (!answer) return;

    setLocalStatus('answered');
    setSubmitting(true);
    try {
      await apiRequest(`/api/questions/${data.requestId}/answer`, {
        method: 'POST',
        body: JSON.stringify({ answer }),
      });
      onResolve?.(data.requestId, answer);
    } catch (err) {
      console.error('Failed to submit answer:', err);
    } finally {
      setSubmitting(false);
    }
  };

  if (status === 'answered') {
    return (
      <div className="rounded-lg border px-4 py-3 text-sm bg-success/10 border-success/30">
        ✅ {t('chat.questionAnswered', '收到回答')}: {initialAnswer || '—'}
      </div>
    );
  }

  return (
    <div className="rounded-lg border px-4 py-3 bg-blue-50/50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-800">
      <div className="flex items-center gap-2 mb-2">
        <HelpCircle size={16} className="text-blue-500" />
        <span className="font-semibold text-sm">{data.question}</span>
      </div>

      {data.options && data.options.length > 0 && (
        <div className="flex flex-col gap-1.5 mb-3">
          {data.options.map((opt, i) => (
            <Button
              key={i}
              size="sm"
              variant="primary"
              onClick={() => handleOptionClick(opt.value)}
              disabled={submitting}
              className="w-full text-left justify-start"
            >
              {opt.label}
            </Button>
          ))}
        </div>
      )}

      {/* Free-text input */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={textInput}
          onChange={(e) => setTextInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleTextSubmit();
            }
          }}
          placeholder={t('chat.questionPlaceholder', '输入你的回答...')}
          disabled={submitting}
          className="flex-1 text-sm rounded-lg border border-neutral-300 bg-white px-3 py-1.5 placeholder:text-neutral-400 focus:border-blue-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500"
        />
        <Button
          size="sm"
          variant="primary"
          onClick={handleTextSubmit}
          disabled={!textInput.trim() || submitting}
        >
          <Send size={14} />
        </Button>
      </div>
    </div>
  );
}
