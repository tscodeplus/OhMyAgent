/**
 * The floating ball: the one always-available way to write a note from inside a
 * conversation.
 *
 * Three pieces live here because they share one anchor point and one state
 * machine — the ball, its capture menu, and the review card a capture produces:
 *
 *   idle → (capture) → capturing → draft card → saved / discarded
 *
 * It is deliberately still at rest: no pulse, no hover scale, no idle spin. A ball
 * that keeps moving is a thing you learn to ignore, and this one is meant to be
 * found on the first try. The exception is a capture in flight — distillation takes
 * tens of seconds against a remote provider, and a button that looks identical
 * before and after a tap reads as "nothing happened". So while `capturing` the icon
 * becomes a spinner, a ring pulses outward, and a label says what is going on.
 *
 * It only appears where capturing makes sense — a chat or an IM transcript
 * (`/p/*`, `/inbox/*`, which is also what the archive opens). On the notes page
 * itself the page *is* the tool, and on settings/dashboard a capture button would
 * be noise.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Check,
  Inbox,
  Loader2,
  NotebookPen,
  Plus,
  Quote,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import Button from '../ui/Button';
import { useNotes } from './NotesContext';
import { FacetRow, KIND_META, KindChip, relativeTime } from './NoteBits';
import { useBallPlacement } from './useBallPlacement';

/** The draft card retracts after this long; the draft itself never expires here. */
const CARD_AUTO_HIDE_MS = 30_000;
/** How long a "nothing worth keeping" notice stays; long enough to read, short enough to ignore. */
const NOTICE_AUTO_HIDE_MS = 8_000;

export default function NotesFloatingBall() {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const location = useLocation();
  const {
    drafts,
    counts,
    capturing,
    draftCardId,
    capture,
    prefill,
    saveDraft,
    discardDraft,
    dismissDraftCard,
  } = useNotes();

  const [menuOpen, setMenuOpen] = useState(false);
  /** The "keep this sentence" dialog; `null` when closed. */
  const [sentence, setSentence] = useState<string | null>(null);
  const [sentenceError, setSentenceError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  /**
   * Where the ball belongs: a conversation. `/p/*` covers project chats (both
   * the empty draft and an open session), `/inbox/*` covers IM transcripts — and
   * the archive opens one of those two, so an archived conversation keeps it too.
   * `/` is the boot redirect and lasts long enough to be worth including.
   */
  const onConversationPage =
    location.pathname === '/' ||
    location.pathname.startsWith('/p/') ||
    location.pathname.startsWith('/inbox/');

  /**
   * The session this page is showing.
   *
   * The capture API takes a session id and reads its own window from it, so the
   * ball has to say which conversation it is standing in. The router has it:
   * `/p/:projectId/s/:sessionId` for a project chat, `/inbox/:sessionId` for an IM
   * transcript. Parsed here rather than taken from a route hook because the ball is
   * mounted in the shell, outside the route element that owns those params.
   */
  const sessionId = useMemo(() => {
    const match = location.pathname.match(/^\/p\/[^/]+\/s\/([^/?#]+)/);
    if (match) return decodeURIComponent(match[1]);
    const inbox = location.pathname.match(/^\/inbox\/([^/?#]+)/);
    if (inbox) return decodeURIComponent(inbox[1]);
    return null;
  }, [location.pathname]);

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const placement = useBallPlacement(onConversationPage);

  // Click outside closes the menu; Esc closes whichever layer is topmost.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen, closeMenu]);

  // Ctrl/Cmd+Shift+N opens the capture menu from anywhere inside a conversation.
  useEffect(() => {
    if (!onConversationPage) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const combo = (event.metaKey || event.ctrlKey) && event.shiftKey;
      if (combo && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        setMenuOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onConversationPage]);

  useEffect(() => {
    if (!draftCardId) return;
    const timer = window.setTimeout(dismissDraftCard, CARD_AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [draftCardId, dismissDraftCard]);

  const [captureError, setCaptureError] = useState<string | null>(null);
  // A capture outcome that is not a draft still has to be *said*, or the button
  // looks broken: "nothing worth keeping here" is an answer, not a failure.
  useEffect(() => {
    if (!captureError) return;
    const timer = window.setTimeout(() => setCaptureError(null), NOTICE_AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [captureError]);
  const draft = drafts.find((item) => item.id === draftCardId) ?? null;

  const startCapture = (mode: 'turn' | 'text' | 'manual') => {
    closeMenu();
    setCaptureError(null);
    if (mode !== 'manual' && !sessionId) {
      // "Write it myself" needs no session; the other two read a conversation.
      setCaptureError(t('notes.capture.noSession'));
      return;
    }

    if (mode === 'text' && sessionId) {
      // The server keeps a sentence verbatim (no model, no draft), so the dialog is
      // the whole feature: prefill it with what the user just said and let them
      // trim it, because "只记我这句话" is usually "keep the last thing I wrote".
      setSentence(null);
      setSentenceError(null);
      void prefill(sessionId).then((text) => setSentence(text));
      return;
    }
    void capture(mode, sessionId).then((outcome) => {
      if (outcome.ok) return;
      // A capture that produced nothing is not an error: "this turn had nothing
      // worth keeping" is a normal answer, and 422 is how the server says it.
      setCaptureError(outcome.message ?? t('notes.capture.failed'));
    });
  };

  const submitSentence = () => {
    const text = (sentence ?? '').trim();
    if (!text) {
      setSentenceError(t('notes.capture.quoteEmpty'));
      return;
    }
    void capture('text', sessionId, text).then((outcome) => {
      if (outcome.ok) {
        setSentence(null);
        setSentenceError(null);
        return;
      }
      setSentenceError(outcome.message ?? t('notes.capture.failed'));
    });
  };

  if (!onConversationPage) return null;

  return (
    <>
      <div
        ref={rootRef}
        className="pointer-events-none fixed z-40 flex flex-col items-end gap-2"
        // `right`/`bottom` come from the placement hook so the ball can be dragged
        // and lifted clear of the composer; see `useBallPlacement.ts`.
        style={{ right: placement.style.right, bottom: placement.style.bottom }}
      >
        {captureError && !menuOpen && (
          <div
            role="status"
            className="pointer-events-auto w-[min(320px,calc(100vw-2rem))] rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-800 shadow-lg shadow-neutral-900/10 dark:border-amber-400/25 dark:bg-amber-500/10 dark:text-amber-200"
          >
            <div className="flex items-start gap-2">
              <span className="flex-1">{captureError}</span>
              <button
                type="button"
                onClick={() => setCaptureError(null)}
                aria-label={t('notes.close')}
                className="shrink-0 rounded p-0.5 text-amber-700/70 hover:text-amber-900 dark:text-amber-300/70 dark:hover:text-amber-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {sentence !== null && (
          <div
            className="pointer-events-auto w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl shadow-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-900"
            role="dialog"
            aria-label={t('notes.capture.quoteTitle')}
          >
            <div className="flex items-center gap-1.5 border-b border-neutral-100 px-3 py-2 dark:border-neutral-800">
              <Quote className="h-3.5 w-3.5 text-neutral-400" />
              <span className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
                {t('notes.capture.quoteTitle')}
              </span>
              <button
                type="button"
                onClick={() => setSentence(null)}
                aria-label={t('notes.close')}
                className="ml-auto rounded p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="px-3 py-2">
              <textarea
                autoFocus
                value={sentence}
                onChange={(event) => setSentence(event.target.value)}
                onKeyDown={(event) => {
                  // Enter keeps; Shift+Enter is a new line — the same rule as the
                  // chat composer beside it.
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    submitSentence();
                  }
                }}
                rows={3}
                placeholder={t('notes.capture.quotePlaceholder')}
                className="w-full resize-y rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-[12.5px] leading-relaxed text-neutral-800 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              />
              {sentenceError && (
                <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{sentenceError}</p>
              )}
            </div>
            <div className="flex items-center gap-1 border-t border-neutral-100 px-2 py-1.5 dark:border-neutral-800">
              <Button size="sm" onClick={submitSentence} className="h-7">
                {t('notes.capture.keep')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSentence(null)}
                className="h-7 ml-auto"
              >
                {t('notes.cancel')}
              </Button>
            </div>
          </div>
        )}

        {draft && !menuOpen && (
          <DraftCard
            draft={draft}
            onSave={() => void saveDraft(draft.id)}
            onEdit={() => {
              // Editing must not approve: an open editor on a draft stays a draft,
              // and the page's save path only rewrites the draft's text.
              dismissDraftCard();
              navigate(`/notes/${draft.id}?edit=1`);
            }}
            onRegenerate={() => {
              // A second pass over the same window, then retire the first draft:
              // the server has no "rewrite this draft" call, and a re-distill is
              // exactly what the button promises.
              void capture('turn', sessionId).then((outcome) => {
                if (outcome.ok) void discardDraft(draft.id);
                else setCaptureError(outcome.message ?? t('notes.capture.failed'));
              });
            }}
            onDiscard={() => void discardDraft(draft.id)}
            onClose={dismissDraftCard}
          />
        )}

        {menuOpen && (
          <div
            role="menu"
            className="pointer-events-auto w-[248px] rounded-xl border border-neutral-200 bg-white p-1 shadow-xl shadow-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-900"
          >
            <div className="px-2 py-1.5 text-[11px] font-medium text-neutral-400 dark:text-neutral-500">
              {t('notes.capture.title')}
            </div>
            <MenuItem
              icon={Sparkles}
              label={t('notes.capture.turn')}
              hint="↵"
              onClick={() => startCapture('turn')}
            />
            <MenuItem
              icon={Quote}
              label={t('notes.capture.quote')}
              onClick={() => startCapture('text')}
            />
            <div className="my-1 h-px bg-neutral-200 dark:bg-neutral-800" />
            <MenuItem
              icon={Plus}
              label={t('notes.capture.manual')}
              onClick={() => startCapture('manual')}
            />
            <MenuItem
              icon={Inbox}
              label={t('notes.capture.drafts')}
              badge={counts.draft}
              onClick={() => {
                closeMenu();
                // Reviewing is a page, not a drawer: the notes page already has
                // the list, the preview and the real editor, and a note body
                // (commands, tables, steps) needs more than 380px to be judged.
                navigate('/notes?drafts=1');
              }}
            />
            <div className="my-1 h-px bg-neutral-200 dark:bg-neutral-800" />
            <button
              type="button"
              onClick={() => {
                closeMenu();
                navigate('/notes');
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-neutral-600 transition-colors hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              <NotebookPen className="h-3.5 w-3.5" strokeWidth={1.75} />
              {t('notes.open')}
            </button>
          </div>
        )}

        {capturing && (
          <div
            role="status"
            className="pointer-events-none rounded-full bg-neutral-900/90 px-2.5 py-1 text-[11px] font-medium text-white shadow-lg shadow-neutral-900/20 dark:bg-neutral-100/95 dark:text-neutral-900"
          >
            {t('notes.capture.working')}
          </div>
        )}

        <div className="pointer-events-auto relative">
          <button
            type="button"
            {...placement.handlers}
            onClick={() => {
              // A drag ends with a click event too; only a real tap opens the menu.
              if (placement.wasDrag()) return;
              setMenuOpen((value) => !value);
            }}
            aria-label={t('notes.ballLabel')}
            aria-expanded={menuOpen}
            title={t('notes.ballLabel')}
            aria-busy={capturing}
            className={cn(
              'relative flex h-14 w-14 items-center justify-center rounded-full text-white shadow-lg shadow-indigo-900/25 transition-colors',
              // Only a capture animates; at rest the ball is still (see the header).
              capturing ? 'cursor-wait' : 'hover:opacity-90',
              capturing ? '' : placement.dragging ? 'cursor-grabbing' : 'cursor-grab',
            )}
            // The logo's indigo, flat — a gradient read as "decorative" and the
            // ball is an entry point, not an ornament. `touchAction: none` lets a
            // vertical drag move the ball instead of scrolling the transcript.
            style={{ backgroundColor: '#4f46e5', touchAction: 'none' }}
          >
            {capturing ? (
              <>
                {/* A radar ring plus a spinner: one says "busy", the other says
                    "still moving" — a frozen spinner is what a stuck request looks
                    like, and a capture takes tens of seconds. */}
                <span
                  aria-hidden
                  className="absolute inset-0 animate-ping rounded-full opacity-40"
                  style={{ backgroundColor: '#4f46e5' }}
                />
                <Loader2 className="relative h-6 w-6 animate-spin" strokeWidth={2} />
              </>
            ) : (
              <NotebookPen className="h-6 w-6" strokeWidth={1.75} />
            )}
            {counts.draft > 0 && (
              <span className="absolute -right-0.5 -top-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-white bg-amber-500 px-1 text-[10px] font-semibold text-white dark:border-neutral-950">
                {counts.draft}
              </span>
            )}
          </button>
        </div>
      </div>
    </>
  );
}

function MenuItem({
  icon: Icon,
  label,
  hint,
  badge,
  onClick,
}: {
  icon: typeof Inbox;
  label: string;
  hint?: string;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-neutral-700 transition-colors hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
    >
      <Icon
        className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400"
        strokeWidth={1.75}
      />
      <span className="flex-1 truncate">{label}</span>
      {typeof badge === 'number' && badge > 0 && (
        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-indigo-600 px-1 text-[10px] font-semibold text-white">
          {badge}
        </span>
      )}
      {hint && (
        <span className="rounded border border-neutral-200 px-1 text-[10px] text-neutral-400 dark:border-neutral-700 dark:text-neutral-500">
          {hint}
        </span>
      )}
    </button>
  );
}

/**
 * The review card. It appears at the end of a capture instead of a modal: the
 * user's attention is already in the conversation, and a dialog would demand a
 * decision before the next sentence.
 */
function DraftCard({
  draft,
  onSave,
  onEdit,
  onRegenerate,
  onDiscard,
  onClose,
}: {
  draft: NonNullable<ReturnType<typeof useNotes>['drafts'][number]>;
  onSave: () => void;
  onEdit: () => void;
  onRegenerate: () => void;
  onDiscard: () => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation('common');
  const [saved, setSaved] = useState(false);

  return (
    <div className="pointer-events-auto w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl shadow-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-900">
      <div className="flex items-center gap-1.5 border-b border-neutral-100 px-3 py-2 dark:border-neutral-800">
        <span className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
          {t('notes.draftCard.title')}
        </span>
        <KindChip kind={draft.kind} />
        <span className="ml-auto text-[10px] text-neutral-400">
          {relativeTime(draft.updatedAt, i18n.language)}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('notes.close')}
          className="rounded p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* The card is a preview of something editable: tapping the text opens the
          editor, because reading a draft is usually the first step of fixing it.
          The buttons below stay separate so approving is never a mis-tap. */}
      <button
        type="button"
        onClick={onEdit}
        className="block w-full px-3 py-2 text-left transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
        title={t('notes.draftCard.edit')}
      >
        <p className="text-[13px] font-medium leading-snug text-neutral-900 dark:text-neutral-100">
          {draft.title}
        </p>
        {draft.summary && (
          <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-neutral-500 dark:text-neutral-400">
            {draft.summary}
          </p>
        )}
        {draft.fields[0] && (
          <pre className="mt-2 overflow-x-auto rounded-md bg-neutral-900 px-2 py-1 text-[11px] text-neutral-100">
            {draft.fields[0].value}
          </pre>
        )}
        <FacetRow note={draft} className="mt-2" />
      </button>

      <div className="flex items-center gap-1 border-t border-neutral-100 px-2 py-1.5 dark:border-neutral-800">
        <Button
          size="sm"
          onClick={() => {
            onSave();
            setSaved(true);
            window.setTimeout(onClose, 600);
          }}
          className="h-7"
        >
          {saved ? <Check className="h-3.5 w-3.5" /> : null}
          {t('notes.draftCard.save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit} className="h-7">
          {t('notes.draftCard.edit')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onRegenerate} className="h-7">
          <RefreshCw className="h-3 w-3" />
          {t('notes.draftCard.regenerate')}
        </Button>
        <button
          type="button"
          onClick={onDiscard}
          className="ml-auto rounded-md px-2 py-1 text-[11px] text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
        >
          {t('notes.draftCard.discard')}
        </button>
      </div>
    </div>
  );
}
