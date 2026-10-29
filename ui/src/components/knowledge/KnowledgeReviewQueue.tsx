import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Eye, EyeOff, Archive } from 'lucide-react';
import { formatRelativeTime } from '../../lib/utils';
import Button from '../ui/Button';
import Spinner from '../ui/Spinner';
import { useToast } from '../ui/Toast';
import {
  KnowledgeApiError,
  approveKnowledgePage,
  archiveKnowledgePage,
  fetchPendingKnowledgePages,
} from './knowledge-api';
import type { KnowledgePagePayload } from './types';
import KnowledgeScopeBadge from './KnowledgeScopeBadge';

/** The route's own default; the queue is a review list, not a browsing surface. */
const PENDING_LIMIT = 50;

interface KnowledgeReviewQueueProps {
  /** Bumped by the parent after a mutation elsewhere (e.g. a save). */
  refreshKey: number;
  /** A page left the queue — the parent refreshes the counts. */
  onChanged: () => void;
}

/**
 * The `curate.shadow` review queue.
 *
 * Pending pages are invisible to search and to the agent, so this list is the
 * one place they can be seen — and the only place they can be promoted. Archive
 * is offered next to approve because the second most common judgement on a
 * shadow draft is "this should not exist", and leaving it pending forever hides
 * that decision without recording it.
 */
export default function KnowledgeReviewQueue({ refreshKey, onChanged }: KnowledgeReviewQueueProps) {
  const { t } = useTranslation('common');
  const { showToast } = useToast();

  const [pages, setPages] = useState<KnowledgePagePayload[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notEnabled, setNotEnabled] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  /** Id of the page a decision is in flight for, so its row shows the spinner. */
  const [actingId, setActingId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchPendingKnowledgePages(PENDING_LIMIT)
      .then((payload) => {
        if (cancelled) return;
        setPages(payload.pages);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setPages([]);
          setError(t('knowledge.review.loadError'));
          // An unmatched endpoint means `knowledge.enabled` is false — the routes
          // are only registered while the layer is on.
          setNotEnabled(err instanceof KnowledgeApiError && err.status === 404);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, reloadToken, t]);

  const decide = useCallback(
    async (page: KnowledgePagePayload, action: 'approve' | 'archive') => {
      setActingId(page.id);
      try {
        if (action === 'approve') {
          await approveKnowledgePage(page.id);
        } else {
          await archiveKnowledgePage(page.id);
        }
        // Both decisions take the page out of `pending`, so the row goes with it
        // instead of staying behind with a new badge.
        setPages((current) => current.filter((entry) => entry.id !== page.id));
        if (previewId === page.id) setPreviewId(null);
        onChanged();
        showToast(
          action === 'approve'
            ? t('knowledge.review.approved', { title: page.title })
            : t('knowledge.review.archived', { title: page.title }),
          'success',
        );
      } catch {
        // The server's message here is developer-facing English ("No knowledge
        // page with id …"); the failure a human can act on is "it did not
        // happen", which is already translated.
        showToast(
          t(
            action === 'approve'
              ? 'knowledge.review.approveError'
              : 'knowledge.review.archiveError',
          ),
          'error',
          6000,
        );
      } finally {
        setActingId(null);
      }
    },
    [onChanged, previewId, showToast, t],
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl p-3 sm:p-4">
        <header className="mb-3">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {t('knowledge.review.title')}
          </h2>
          <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
            {t('knowledge.review.subtitle')}
          </p>
        </header>

        {loading ? (
          <div className="flex justify-center py-10">
            <Spinner size="sm" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
            {notEnabled && (
              <p className="max-w-xs text-[11px] text-neutral-500 dark:text-neutral-400">
                {t('knowledge.notEnabledHint')}
              </p>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setReloadToken((token) => token + 1)}
            >
              {t('knowledge.retry')}
            </Button>
          </div>
        ) : pages.length === 0 ? (
          <p className="py-10 text-center text-xs text-neutral-500 dark:text-neutral-400">
            {t('knowledge.review.empty')}
          </p>
        ) : (
          <ul className="space-y-2">
            {pages.map((page) => {
              const busy = actingId === page.id;
              const expanded = previewId === page.id;
              return (
                <li
                  key={page.id}
                  className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate text-[13px] font-medium text-neutral-900 dark:text-neutral-100">
                        {page.title}
                      </h3>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500 dark:text-neutral-400">
                        <span className="rounded bg-neutral-100 px-1.5 py-0.5 dark:bg-neutral-800">
                          {t(`knowledge.pageTypes.${page.pageType}`)}
                        </span>
                        {/* The queue is where the scope decides the answer: the
                            same subject curated in two chats is two drafts, and
                            only one of them belongs here. */}
                        <KnowledgeScopeBadge scope={page.scope} />
                        <span className="truncate">{page.slug}</span>
                        {page.updatedAt && (
                          <span>
                            ·{' '}
                            {t('knowledge.review.written', {
                              time: formatRelativeTime(page.updatedAt),
                              actor: page.updatedBy || t('knowledge.editor.actorUnknown'),
                            })}
                          </span>
                        )}
                        {page.confidence !== null && (
                          <span>
                            ·{' '}
                            {t('knowledge.confidence', {
                              value: Math.round(page.confidence * 100),
                            })}
                          </span>
                        )}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setPreviewId(expanded ? null : page.id)}
                      aria-label={
                        expanded ? t('knowledge.review.hidePreview') : t('knowledge.review.preview')
                      }
                    >
                      {expanded ? <EyeOff size={14} /> : <Eye size={14} />}
                      <span>
                        {expanded
                          ? t('knowledge.review.hidePreview')
                          : t('knowledge.review.preview')}
                      </span>
                    </Button>
                  </div>

                  {expanded && (
                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-neutral-50 p-2 text-[11.5px] leading-relaxed text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
                      {page.content || t('knowledge.conflict.emptyContent')}
                    </pre>
                  )}

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button size="sm" loading={busy} onClick={() => void decide(page, 'approve')}>
                      <Check size={14} strokeWidth={1.75} />
                      {t('knowledge.review.approve')}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy}
                      onClick={() => void decide(page, 'archive')}
                    >
                      <Archive size={14} strokeWidth={1.75} />
                      {t('knowledge.review.archive')}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
