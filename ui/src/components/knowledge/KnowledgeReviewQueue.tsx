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
import type { PendingKnowledgePagePayload, RejectionReason } from './types';
import { MAX_REJECTION_NOTE_CHARS, REJECTION_REASONS } from './types';
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

  const [pages, setPages] = useState<PendingKnowledgePagePayload[]>([]);
  /** The threshold the server judges recurrence by; only meaningful with `pages`. */
  const [requireSources, setRequireSources] = useState(2);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notEnabled, setNotEnabled] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  /** Id of the page a decision is in flight for, so its row shows the spinner. */
  const [actingId, setActingId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  /**
   * The row whose reason panel is open, and the note typed so far.
   *
   * Both live here rather than per row because only one rejection can be in
   * progress at a time: fifty panels holding their own half-typed sentences would
   * be state nobody can review, and the server takes one decision per request.
   */
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchPendingKnowledgePages(PENDING_LIMIT)
      .then((payload) => {
        if (cancelled) return;
        setPages(payload.pages);
        setRequireSources(payload.requireSources);
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
    async (
      page: PendingKnowledgePagePayload,
      action: 'approve' | 'archive',
      reason?: RejectionReason,
    ) => {
      setActingId(page.id);
      try {
        // Approve for a page still flagged by the write-side invalidation
        // republishes the frozen body — the server attaches a `warning`. That
        // detail text is developer-facing English, so the toast carries the
        // bilingual risk instead of the raw string, and lasts long enough to be
        // read before the page disappears from the queue.
        const result =
          action === 'approve'
            ? await approveKnowledgePage(page.id)
            : // The note travels with the chip when the reviewer typed one first:
              // "thin" plus a sentence they already wrote is a better record than
              // making them choose between the two.
              await archiveKnowledgePage(page.id, { reason, ...(note.trim() ? { note } : {}) });
        // Both decisions take the page out of `pending`, so the row goes with it
        // instead of staying behind with a new badge.
        setPages((current) => current.filter((entry) => entry.id !== page.id));
        if (previewId === page.id) setPreviewId(null);
        if (rejectingId === page.id) setRejectingId(null);
        setNote('');
        onChanged();
        if (action === 'approve' && result.warning) {
          showToast(
            t('knowledge.review.approvedStaleWarning', { title: page.title }),
            'warning',
            8000,
          );
        } else {
          showToast(
            action === 'approve'
              ? t('knowledge.review.approved', { title: page.title })
              : t('knowledge.review.archived', { title: page.title }),
            'success',
          );
        }
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
    [note, onChanged, previewId, rejectingId, showToast, t],
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="w-full p-3 sm:px-6 sm:py-4">
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
                  // The whole row opens the body: reading the draft is what the row is
                  // for, and hunting for a 14px button is the slow path. The button
                  // stays as the keyboard/AT path (`li` is not focusable by design — a
                  // toggle nested inside a row that also holds real buttons would offer
                  // a second tab stop with no distinct action).
                  onClick={() => setPreviewId(expanded ? null : page.id)}
                  className={`cursor-pointer rounded-lg border p-3 transition-colors ${
                    expanded
                      ? 'border-neutral-300 dark:border-neutral-700'
                      : 'border-neutral-200 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700'
                  }`}
                >
                  <div className="min-w-0">
                    {/*
                      Title and the preview button share a line, and only they do.
                      The button used to be a sibling of the title *and* the evidence
                      line, which on a phone left it ~70px wide and wrapped
                      "查看正文" onto two lines — a control that looks broken exactly
                      where the row toggle matters most. Up here it gets the title's
                      line, and the evidence line gets the full width, which it needs:
                      it carries type, scope, slug, author, time and two counters.
                      `shrink-0 whitespace-nowrap` is the other half — without them the
                      label still wraps inside the button instead of pushing back.
                    */}
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="min-w-0 truncate text-[13px] font-medium text-neutral-900 dark:text-neutral-100">
                        {page.title}
                      </h3>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0 whitespace-nowrap"
                        // The row already toggles on click; without this the click
                        // arrives twice and the body never opens.
                        onClick={(event) => {
                          event.stopPropagation();
                          setPreviewId(expanded ? null : page.id);
                        }}
                        aria-label={
                          expanded
                            ? t('knowledge.review.hidePreview')
                            : t('knowledge.review.preview')
                        }
                        aria-expanded={expanded}
                      >
                        {expanded ? <EyeOff size={14} /> : <Eye size={14} />}
                        <span>
                          {expanded
                            ? t('knowledge.review.hidePreview')
                            : t('knowledge.review.preview')}
                        </span>
                      </Button>
                    </div>
                    {/*
                        One line for everything a reviewer scans: what kind, whose
                        chat, which slug, who wrote it and when, and how much
                        evidence stands behind it. Evidence moved up here because a
                        second paragraph of grey text below the title is where a
                        number goes to be skipped — and "one conversation" is the
                        judgement the body cannot give you:
                        `independent` counts distinct conversations (the number
                        admission rule 2 was measured with), so a draft below
                        `requireSources` passed on rule 3 — "the user asked for it" —
                        and has never been corroborated. Confidence is deliberately
                        absent: every curated draft carries the mean source
                        confidence, i.e. the same 100%, and a number that never varies
                        invites a judgement it cannot support.
                        Defensive `?? 0`: a service worker can serve a cached older
                        bundle against a newer server and vice versa.
                      */}
                    {(() => {
                      const evidence = page.sources ?? { total: 0, independent: 0 };
                      const thin = evidence.independent < requireSources;
                      return (
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
                          <span>
                            ·{' '}
                            {t('knowledge.review.sourceSummary', {
                              sources: evidence.total,
                              conversations: evidence.independent,
                            })}
                          </span>
                          {thin && (
                            <span
                              title={t('knowledge.review.thinSourcesHint', {
                                required: requireSources,
                              })}
                              className="rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400"
                            >
                              {t('knowledge.review.thinSources', { required: requireSources })}
                            </span>
                          )}
                        </p>
                      );
                    })()}
                  </div>

                  {expanded && (
                    /* Selecting text to copy must not fold the row away. */
                    <pre
                      onClick={(event) => event.stopPropagation()}
                      className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-neutral-50 p-2 text-[11.5px] leading-relaxed text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
                    >
                      {page.content || t('knowledge.conflict.emptyContent')}
                    </pre>
                  )}

                  {/* Actions are their own island: a click here is a decision, never a toggle. */}
                  <div
                    className="mt-2 flex flex-wrap items-center gap-2"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <Button
                      size="sm"
                      loading={busy}
                      disabled={rejectingId === page.id}
                      onClick={() => void decide(page, 'approve')}
                    >
                      <Check size={14} strokeWidth={1.75} />
                      {t('knowledge.review.approve')}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy || rejectingId === page.id}
                      onClick={() => setRejectingId(rejectingId === page.id ? null : page.id)}
                    >
                      <Archive size={14} strokeWidth={1.75} />
                      {t('knowledge.review.reject')}
                    </Button>
                  </div>

                  {/*
                    The reason panel is the count that makes the tally real: seven
                    codes with two clicks total (reject, then a chip). It replaces a
                    free-text box on purpose — "other" exists for the sentence, and
                    asking for prose first would give us fifty sentences nobody can
                    group.
                  */}
                  {rejectingId === page.id && (
                    <div className="mt-2 rounded-md border border-neutral-200 p-2 dark:border-neutral-800">
                      <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                        {t('knowledge.review.rejectPrompt')}
                      </p>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {REJECTION_REASONS.map((reason) => (
                          <button
                            key={reason}
                            type="button"
                            disabled={busy}
                            onClick={() => void decide(page, 'archive', reason)}
                            className="rounded-full border border-neutral-200 px-2 py-0.5 text-[11px] text-neutral-700 hover:border-red-300 hover:bg-red-50 hover:text-red-700 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-red-500/40 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                          >
                            {t(`knowledge.review.reasons.${reason}`)}
                          </button>
                        ))}
                      </div>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <input
                          value={note}
                          onChange={(event) => setNote(event.target.value)}
                          maxLength={MAX_REJECTION_NOTE_CHARS}
                          placeholder={t('knowledge.review.rejectNotePlaceholder')}
                          className="min-w-0 flex-1 rounded-md border border-neutral-200 bg-transparent px-2 py-1 text-[11.5px] text-neutral-800 outline-none focus:border-neutral-400 dark:border-neutral-700 dark:text-neutral-200 dark:focus:border-neutral-500"
                        />
                        <Button
                          size="sm"
                          loading={busy}
                          onClick={() => void decide(page, 'archive', 'other')}
                        >
                          {t('knowledge.review.rejectConfirm')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setRejectingId(null)}
                        >
                          {t('knowledge.review.rejectCancel')}
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
