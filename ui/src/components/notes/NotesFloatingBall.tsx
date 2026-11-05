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
 * The second entry point is the drop. Selecting words in a conversation and
 * dragging them onto the ball is "keep these words", so the drop handler stores
 * them verbatim and opens the same review card a capture does — the card is where
 * a pile of words becomes a note (title, and, if the user wants it, an agent
 * rewrite). Dropping is a direct manipulation, so the hover state is a static ring
 * and a one-line hint rather than an animation: the ball only moves when work is
 * actually in flight.
 *
 * Holding Alt while dropping asks for the other treatment — distil the text
 * instead of storing it. A modifier-only gesture is invisible, so the hover hint
 * carries the teaching: at rest it says what a plain release will do and mentions
 * the modifier as the alternative, and while Alt is held it says what *that* will
 * do. `Alt`/`Option` rather than `Ctrl` because Ctrl+drag opens the context menu on
 * macOS, which makes the gesture unavailable exactly where it would be taught.
 *
 * Touch screens cannot drag a selection onto the ball, and this project's primary
 * target is a phone. The menu therefore carries the same entry as a command — 「存
 * 下选中的文字」, reading `window.getSelection()` — so the verbatim path exists
 * wherever the app does.
 *
 * It only appears where capturing makes sense — a chat or an IM transcript
 * (`/p/*`, `/inbox/*`, which is also what the archive opens). On the notes page
 * itself the page *is* the tool, and on settings/dashboard a capture button would
 * be noise.
 *
 * Two display preferences exist because a floating ball is the one control you
 * cannot get out of the way of: on a phone it covers the transcript, and whether it
 * does depends on the user, not on us. 「收小」 renders it as a dot (same badge, same
 * menu) and 「隐藏」 removes it; both are menu items, i.e. discoverable, and both
 * persist. Hiding is reversible from the notes page, which is where someone who
 * wants it back would go looking.
 *
 * A capture that produces several notes opens **one** card with **one tab per
 * draft**, and the footer verbs act on the selected tab: approving the draft on
 * screen moves the card to the next one, and the card leaves when the last tab
 * does. The earlier version showed a single draft plus a 「共 N 条」 line, which
 * meant the rest were never actually reviewed from the card — the drafts page was
 * the only place to find them, and the badge counted notes nobody had read.
 *
 * The card itself lives in `DraftCard.tsx` — it grew a second, full-height layout,
 * and it no longer retracts on a timer: a review card that vanishes while it is
 * being read is a card nobody approves.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  EyeOff,
  Inbox,
  Loader2,
  Minus,
  NotebookPen,
  Plus,
  Quote,
  Sparkles,
  Square,
  Wand2,
  X,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import Button from '../ui/Button';
import { useNotes } from './NotesContext';
import DraftCard from './DraftCard';
import { useBallPlacement } from './useBallPlacement';
import type { Note } from './types';

/** `h-14` / `h-7` on the button below — the stack-direction test needs the height. */
const BALL_HEIGHT = 56;
const BALL_HEIGHT_COMPACT = 28;

/**
 * What the server's failure codes say to a person.
 *
 * The route answers with a code and an English operator sentence; the notice is
 * read by the user, so the code picks the wording and the HTTP status is never
 * printed. An unknown code falls back to the server's sentence, stripped of its
 * `422: ` prefix — a status number is diagnostic detail, not a message.
 */
const CAPTURE_FAILURE_KEYS: Record<string, string> = {
  no_notes: 'notes.capture.failure.noNotes',
  invalid: 'notes.capture.failure.invalid',
  model_failed: 'notes.capture.failure.modelFailed',
  empty_window: 'notes.capture.failure.emptyWindow',
  no_session: 'notes.capture.noSession',
  duplicate: 'notes.capture.duplicate',
  disabled: 'notes.capture.failure.disabled',
};

/** Strip a leading `NNN: ` from a server sentence; the code is not the message. */
function withoutStatus(message: string | undefined): string | undefined {
  return message?.replace(/^\d{3}:\s*/, '');
}

export default function NotesFloatingBall() {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const location = useLocation();
  const {
    drafts,
    counts,
    capturing,
    draftCardIds,
    capture,
    saveDraft,
    discardDraft,
    dismissDraftCard,
    /** The store's own error line — the sentence a refused write is refused with. */
    error,
    /** False when the server has no notes API: capture would 404, so draw nothing. */
    available,
    ballHidden,
    setBallHidden,
    ballSize,
    setBallSize,
  } = useNotes();

  const [menuOpen, setMenuOpen] = useState(false);
  /** The "tidy this up my way" dialog; `null` when closed. */
  const [instruction, setInstruction] = useState<string | null>(null);
  const [instructionError, setInstructionError] = useState<string | null>(null);
  /**
   * The brief in the dialog is being distilled right now.
   *
   * The dialog's one button is a toggle — 开始整理 becomes 取消 — so this is also
   * what decides which verb is on it. Kept local rather than read from `capturing`:
   * that flag is the whole layer's, and a capture started elsewhere must not
   * relabel a dialog it knows nothing about.
   */
  const [instructionPending, setInstructionPending] = useState(false);
  /** The controller of the run in flight, so 取消 has something to abort. */
  const instructionAbort = useRef<AbortController | null>(null);
  /** True while a text selection is hovering the ball as a drop target. */
  const [dropHover, setDropHover] = useState(false);
  /** Alt is held: the release will distil rather than store verbatim. */
  const [dropTidy, setDropTidy] = useState(false);
  const dropDepth = useRef(0);
  /**
   * The selection as it was when the ball was pressed.
   *
   * Read on `pointerdown` because the press itself collapses the selection: by
   * `click` there is nothing left to ask the document for. A selection that is no
   * longer the current one is dropped rather than carried — see `startCapture`.
   */
  const [selectionText, setSelectionText] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  /** The notice card, so a press elsewhere on the page can dismiss it. */
  const noticeRef = useRef<HTMLDivElement>(null);

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

  /**
   * Which way the popover stack opens: up (the default) or down.
   *
   * Up is right because the ball lives at the bottom of the column and the
   * conversation is above it. But the ball is not always down there — on the
   * new-session layout it sits above a *centred* composer, and dragging it to the
   * top is allowed — and the stack grows upward out of a `bottom` anchor, so in
   * those positions the menu opened off the top of the viewport: open, invisible,
   * and indistinguishable from a button that does nothing. The side with more room
   * wins, and the anchor moves with it, so the ball itself does not move.
   */
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
  useEffect(() => {
    const onResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const ballHeight = ballSize === 'compact' ? BALL_HEIGHT_COMPACT : BALL_HEIGHT;
  const ballTop = viewportHeight - Number(placement.style.bottom) - ballHeight;
  const stackDown = viewportHeight - ballTop - ballHeight > ballTop;

  /**
   * How tall the review card may be, in px, measured off the ball it hangs from.
   *
   * A `dvh` cap is not enough. The ball is anchored above the composer, so on a tall
   * window with a multiline composer its `bottom` alone can be a couple of hundred
   * px; `56dvh` plus the card's own header and verb row then reached past the top of
   * the viewport, and the card opened with its top border and its close button
   * off-screen — on a large monitor, a card that looks undismissable. The ceiling is
   * therefore the room the card really has: above the ball when the stack opens up,
   * below it when it opens down (see `stackDown`), minus the stack's own gap.
   *
   * The `0.62` is not a safety margin but a preference: on a tall display the room is
   * large enough to hide the conversation behind the card, which is not what a
   * review card is for.
   */
  const cardMaxHeight = useMemo(() => {
    // `gap-2` on the stack below, plus 8px of breathing room at the viewport edge:
    // without it the card starts flush against the top of a short window, which
    // reads as clipped even when it is not.
    const gap = 16;
    const room = stackDown ? viewportHeight - (ballTop + ballHeight) - gap : ballTop - gap;
    return Math.max(120, Math.min(room, Math.round(viewportHeight * 0.62)));
  }, [stackDown, viewportHeight, ballTop, ballHeight]);

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

  // `dragover` fires a few times a second, which is enough to notice Alt being
  // pressed but too coarse to feel like a response. While the drop target is under
  // the pointer, the key events themselves update the hint.
  useEffect(() => {
    if (!dropHover) return;
    const sync = (event: KeyboardEvent) => setDropTidy(event.altKey);
    window.addEventListener('keydown', sync);
    window.addEventListener('keyup', sync);
    return () => {
      window.removeEventListener('keydown', sync);
      window.removeEventListener('keyup', sync);
    };
  }, [dropHover]);

  /**
   * What to say when a capture produced no card.
   *
   * `existingId` is set when the answer was "this already exists": that notice is a
   * door, not a complaint, so it offers to open the note that owns the title.
   */
  const [notice, setNotice] = useState<{
    text: string;
    existingId?: string;
    /**
     * "This already exists" is information with a door; anything else is a failure.
     * They used to share one amber card, which meant the app shouted at the common
     * case (a duplicate title) as hard as at the rare one (a capture that broke).
     */
    tone: 'info' | 'error';
  } | null>(null);
  /**
   * What the window actually held for the card on screen.
   *
   * A note distilled from the tail of a long conversation and one distilled from all
   * of it are different claims, and the card is the only place the reviewer sees
   * either of them. `dropped > 0` is rendered as a line under the card; silence would
   * let the first pass for the second.
   */
  const [cardScope, setCardScope] = useState<{
    read: number;
    dropped: number;
    head?: number;
  } | null>(null);
  // A capture outcome that is not a draft still has to be *said*, or the button
  // looks broken: "nothing worth keeping here" is an answer, not a failure.
  //
  // The notice never retires on a timer: it used to, which meant the one sentence
  // explaining why nothing appeared could vanish while it was being read. It goes
  // away when its × is pressed, or when the reader presses anywhere else — the
  // same "click outside dismisses it" every other popover in the app follows.
  useEffect(() => {
    if (!notice) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!noticeRef.current?.contains(event.target as Node)) setNotice(null);
    };
    // `mousedown`, like the menu beside it: the press is the dismissal, so a click
    // that started outside does not land on whatever it happened to end up over.
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [notice]);

  // Navigating away abandons a brief in flight: the dialog is gone, and a capture
  // nobody is waiting for would draw its card over a conversation the user left.
  useEffect(() => () => instructionAbort.current?.abort(), []);
  /**
   * The drafts the card is about — the ones in the group that still exist and still
   * belong to the conversation on screen.
   *
   * Resolved from ids rather than held as objects: the store owns the group (it is
   * what approving or deleting a tab writes to), and `drafts` is where the rows
   * live, so this is the join between the two. The card no longer retracts on a
   * timer (see `DraftCard`), so without the session filter it would follow the user
   * into whichever conversation they opened next and stand in front of a transcript
   * its drafts never came from. The badge still counts them and the drafts view
   * still lists them, so nothing is lost by not drawing them here.
   */
  const cardDrafts = useMemo(() => {
    const byId = new Map(drafts.map((item) => [item.id, item]));
    return draftCardIds
      .map((id) => byId.get(id))
      .filter((item): item is Note => Boolean(item))
      .filter((item) => !item.sessionId || !sessionId || item.sessionId === sessionId);
  }, [drafts, draftCardIds, sessionId]);

  /** One place that turns a capture outcome into what the user sees. */
  /**
   * The truncation line's payload, or `null` when the window read everything it
   * wanted. Absent fields mean "the server did not say", which is not the same as
   * zero — a verbatim drop has no window at all. `head` present = the session
   * exceeded the read cap and the server sampled opening + newest, so the line
   * must describe that shape instead of "read the last N".
   */
  const scopeOf = (outcome: {
    readMessages?: number;
    droppedMessages?: number;
    sampledHead?: number;
  }): { read: number; dropped: number; head?: number } | null => {
    const dropped = outcome.droppedMessages ?? 0;
    if (dropped <= 0) return null;
    const head = outcome.sampledHead ?? 0;
    return { read: outcome.readMessages ?? 0, dropped, ...(head > 0 ? { head } : {}) };
  };

  /** The sentence for a failed capture: its code, else the server's own words. */
  const failureText = (outcome: { code?: string; message?: string }): string => {
    const key = outcome.code ? CAPTURE_FAILURE_KEYS[outcome.code] : undefined;
    return key ? t(key) : (withoutStatus(outcome.message) ?? t('notes.capture.failed'));
  };

  const report = (outcome: {
    ok: boolean;
    notes: unknown[];
    code?: string;
    existingId?: string;
    message?: string;
  }) => {
    if (outcome.ok) return;
    // "Already have it" is the one refusal with somewhere to go, so it is offered as
    // a door: open the note the library already holds under that title.
    setNotice({
      text: outcome.existingId ? t('notes.capture.duplicate') : failureText(outcome),
      existingId: outcome.existingId,
      tone: outcome.existingId ? 'info' : 'error',
    });
  };

  const startCapture = (mode: 'conversation' | 'instruction' | 'manual') => {
    closeMenu();
    setNotice(null);
    if (mode !== 'manual' && !sessionId) {
      // "Write it myself" needs no session; the others read a conversation.
      setNotice({ text: t('notes.capture.noSession'), tone: 'info' });
      return;
    }

    if (mode === 'instruction') {
      // The dialog *is* the feature: an empty instruction means "just use the
      // default", which is the other menu item, so it opens empty rather than
      // prefilled with a guess about what the user wants.
      setInstruction('');
      setInstructionError(null);
      return;
    }
    void capture({ mode, sessionId }).then((outcome) => {
      setCardScope(scopeOf(outcome));
      // A capture that produced nothing is not an error: "this turn had nothing
      // worth keeping" is a normal answer, and 422 is how the server says it.
      report(outcome);
    });
  };

  /** Close the brief dialog, ending any run it started. */
  const closeInstruction = () => {
    instructionAbort.current?.abort();
    setInstruction(null);
    setInstructionError(null);
  };

  /**
   * The dialog's one button, in both of its verbs.
   *
   * Idle it distils; in flight it cancels. Cancelling aborts the request, which
   * stops the client from waiting on a distillation the user has walked away from;
   * the dialog keeps the brief so the same words can be sent again.
   */
  const submitInstruction = () => {
    if (instructionPending) {
      instructionAbort.current?.abort();
      return;
    }
    const text = (instruction ?? '').trim();
    if (!text) {
      setInstructionError(t('notes.capture.instructionEmpty'));
      return;
    }
    const controller = new AbortController();
    instructionAbort.current = controller;
    setInstructionPending(true);
    setInstructionError(null);
    void capture({
      mode: 'instruction',
      sessionId,
      instruction: text,
      signal: controller.signal,
    })
      .then((outcome) => {
        // A cancelled run is not an answer: the user's own stop needs no sentence.
        if (outcome.canceled) return;
        if (outcome.ok) {
          setCardScope(scopeOf(outcome));
          // The drafts are on screen as a review card now; a dialog that stays
          // open next to it asks to be dismissed for no reason.
          setInstruction(null);
          setInstructionError(null);
          return;
        }
        // Nothing generated: the brief stays so it can be adjusted and retried.
        setInstructionError(failureText(outcome));
      })
      .finally(() => {
        if (instructionAbort.current === controller) instructionAbort.current = null;
        setInstructionPending(false);
      });
  };

  /**
   * A dropped selection is stored verbatim: the user chose those words, and a
   * model paraphrasing them is the one thing that would make the note useless.
   * `text/plain` is the only type worth reading — dragging a file or an image onto
   * the ball is not a note, so it falls through to the browser.
   */
  const carriesText = (event: React.DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes('text/plain');

  const submitDrop = (text: string, tidy: boolean) => {
    if (!sessionId) {
      setNotice({ text: t('notes.capture.noSession'), tone: 'info' });
      return;
    }
    closeMenu();
    setNotice(null);
    void capture({
      mode: 'drop',
      sessionId,
      text,
      treatment: tidy ? 'distill' : 'verbatim',
    }).then((outcome) => {
      setCardScope(scopeOf(outcome));
      report(outcome);
    });
  };

  const onDrop = (event: React.DragEvent) => {
    if (!carriesText(event)) return;
    event.preventDefault();
    dropDepth.current = 0;
    setDropHover(false);
    setDropTidy(false);
    const text = event.dataTransfer.getData('text/plain').trim();
    if (!text) return;
    // The modifier at release is the authority, not the tracked state: the hint may
    // lag a frame behind, and the user's last act is what they meant.
    submitDrop(text, event.altKey);
  };

  // `ballHidden` is a user preference and the only way out of it is the notes page
  // switch, which is deliberate: a floating ball that keeps coming back after being
  // dismissed is worse than one that needs one visit to restore. `available` is not a
  // preference: with the layer off every capture answers 404, so the ball would only
  // offer a button that fails.
  if (!available || !onConversationPage || ballHidden) return null;

  return (
    <>
      <div
        ref={rootRef}
        className={cn(
          'pointer-events-none fixed z-40 flex items-end gap-2',
          // Reversed, the ball (the last child) is the *top* of the stack, i.e. the
          // one anchored to `top`, and everything it opens hangs below it. See
          // `stackDown` above.
          stackDown ? 'flex-col-reverse' : 'flex-col',
        )}
        // `right`/`bottom` come from the placement hook so the ball can be dragged
        // and lifted clear of the composer; see `useBallPlacement.ts`.
        style={
          stackDown
            ? { right: placement.style.right, top: ballTop }
            : { right: placement.style.right, bottom: placement.style.bottom }
        }
      >
        {notice && !menuOpen && (
          <div
            ref={noticeRef}
            role="status"
            className={cn(
              // The same popover surface as the instruction panel and the draft card
              // beside it — a notice is one of this stack, not a warning banner that
              // happened to land on it.
              'pointer-events-auto w-[min(320px,calc(100vw-2rem))] rounded-xl border bg-white px-3 py-2 text-[12px] leading-relaxed shadow-lg shadow-neutral-900/10 dark:bg-neutral-900',
              notice.tone === 'error'
                ? 'border-red-200/90 text-red-700 dark:border-red-500/30 dark:text-red-300'
                : 'border-neutral-200 text-neutral-600 dark:border-neutral-700 dark:text-neutral-300',
            )}
          >
            <div className="flex items-start gap-2">
              <span className="flex-1">{notice.text}</span>
              {notice.existingId && (
                <button
                  type="button"
                  onClick={() => {
                    const id = notice.existingId;
                    setNotice(null);
                    navigate(`/notes/${id}`);
                  }}
                  className="shrink-0 rounded-md border border-neutral-300 px-1.5 py-0.5 text-[11px] font-medium text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-600 dark:text-neutral-200 dark:hover:bg-neutral-800"
                >
                  {t('notes.capture.openExisting')}
                </button>
              )}
              <button
                type="button"
                onClick={() => setNotice(null)}
                aria-label={t('notes.close')}
                className="shrink-0 rounded p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {instruction !== null && (
          <div
            className="pointer-events-auto w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl shadow-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-900"
            role="dialog"
            aria-label={t('notes.capture.instructionTitle')}
          >
            <div className="flex items-center gap-1.5 border-b border-neutral-100 px-3 py-2 dark:border-neutral-800">
              <Sparkles className="h-3.5 w-3.5 text-neutral-400" />
              <span className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
                {t('notes.capture.instructionTitle')}
              </span>
              <button
                type="button"
                onClick={closeInstruction}
                aria-label={t('notes.close')}
                className="ml-auto rounded p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="px-3 py-2">
              <textarea
                autoFocus
                value={instruction}
                // The brief is what the run in flight is working from, so it is not
                // editable until that run ends — cancel first, then change it.
                disabled={instructionPending}
                onChange={(event) => setInstruction(event.target.value)}
                onKeyDown={(event) => {
                  // Enter asks; Shift+Enter is a new line — the same rule as the
                  // chat composer beside it. While a run is in flight the key does
                  // nothing: Enter must not double as the cancel button.
                  if (instructionPending) return;
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    submitInstruction();
                  }
                }}
                rows={3}
                placeholder={t('notes.capture.instructionPlaceholder')}
                className="w-full resize-y rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-[12.5px] leading-relaxed text-neutral-800 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              />
              {instructionError && (
                <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                  {instructionError}
                </p>
              )}
            </div>
            <div className="flex items-center gap-1 border-t border-neutral-100 px-2 py-1.5 dark:border-neutral-800">
              {/*
                One button, two verbs, in the spot the cancel button already
                occupied: 开始整理 sends the brief, and while that runs the same
                button becomes 取消. Two buttons would mean one of them is dead at
                any given moment, and a control that changes what it does is worth a
                label the user can read at a glance.
              */}
              <Button
                size="sm"
                variant={instructionPending ? 'ghost' : 'primary'}
                onClick={submitInstruction}
                className="h-7 ml-auto"
              >
                {t(instructionPending ? 'notes.cancel' : 'notes.capture.instructionSubmit')}
              </Button>
            </div>
          </div>
        )}

        {cardDrafts.length > 0 && !menuOpen && (
          <DraftCard
            // No `key`: the card is the *review*, not the draft. Approving one tab
            // removes its id from the group (which would remount a keyed card and
            // collapse the drawer the reviewer just opened); a new capture replaces
            // the group in place, and the card's own selection effect moves to its
            // first draft.
            drafts={cardDrafts}
            scope={cardScope}
            maxHeight={cardMaxHeight}
            storeError={error}
            onSave={(id) => saveDraft(id)}
            onEdit={(id) => {
              // Editing must not approve: an open editor on a draft stays a draft,
              // and the page's save path only rewrites the draft's text. It does end
              // this review — the reader left the conversation — and the other drafts
              // are still in the drafts view.
              dismissDraftCard();
              navigate(`/notes/${id}?edit=1`);
            }}
            onRegenerate={(id) => {
              // The same material, distilled again, then the draft on this tab
              // retires: the server has no "rewrite this draft" call, and a
              // re-distill is exactly what the button promises. The new capture
              // replaces the whole group, because it is a new review of the same
              // conversation — not an edit of one tab.
              //
              // For a draft the *user* supplied it is the material that differs,
              // not the window: dropped words are tidy-up-able, so the agent sees
              // the draft's own body instead of another reading of the transcript.
              const target = cardDrafts.find((item) => item.id === id);
              if (!target) return;
              const verbatim = target.origin === 'user';
              const intent = verbatim
                ? {
                    mode: 'drop' as const,
                    sessionId,
                    text: target.body,
                    treatment: 'distill' as const,
                  }
                : { mode: 'conversation' as const, sessionId };
              void capture(intent).then(async (outcome) => {
                if (!outcome.ok) {
                  report(outcome);
                  return;
                }
                setCardScope(scopeOf(outcome));
                // The old draft retires only if the server agrees, and by now the
                // card shows the *new* drafts — so a refusal has nowhere to appear.
                // Ignoring it left the old draft in the queue with no sign that the
                // button's second half had failed.
                if (!(await discardDraft(target.id))) {
                  setNotice({ text: t('common.submitError'), tone: 'error' });
                }
              });
            }}
            onDiscard={(id) => discardDraft(id)}
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
              label={t('notes.capture.conversation')}
              onClick={() => startCapture('conversation')}
            />
            <MenuItem
              icon={Wand2}
              label={t('notes.capture.instruction')}
              onClick={() => startCapture('instruction')}
            />
            {/* Rendered only when there *is* a selection — a greyed entry is worse
                than a missing one — and it is the only verbatim path a touch screen
                has, since nothing drags a selection onto a ball there. */}
            {selectionText && (
              <MenuItem
                icon={Quote}
                label={t('notes.capture.dropSelection')}
                hint={t('notes.capture.dropSelectionHint', { count: selectionText.length })}
                onClick={() => {
                  const text = selectionText;
                  setSelectionText('');
                  submitDrop(text, false);
                }}
              />
            )}
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
            {/* The ball is the one control you cannot get out of the way of, so it
                offers two ways out. Both are menu items rather than gestures: an
                invisible "drag it to the edge to shrink" would be exactly the
                discoverability problem the rest of this file keeps avoiding. */}
            <MenuItem
              icon={ballSize === 'compact' ? Square : Minus}
              label={t(ballSize === 'compact' ? 'notes.ball.expand' : 'notes.ball.compact')}
              onClick={() => {
                closeMenu();
                setBallSize(ballSize === 'compact' ? 'normal' : 'compact');
              }}
            />
            <MenuItem
              icon={EyeOff}
              label={t('notes.ball.hide')}
              // The item removes the only visible control, so it names the way back
              // at the moment of the decision instead of leaving a search behind it.
              hint={t('notes.ball.hideWhere')}
              title={t('notes.ball.hideHint')}
              onClick={() => {
                closeMenu();
                setBallHidden(true);
              }}
            />
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

        <div
          className="pointer-events-auto relative"
          // The drop target is the ball's own box, and it is entered/left by child
          // nodes constantly, so depth is counted rather than toggled: a naive
          // `dragleave` clears the highlight while the pointer is still inside.
          onDragEnter={(event) => {
            if (!carriesText(event)) return;
            dropDepth.current += 1;
            setDropHover(true);
          }}
          onDragOver={(event) => {
            if (!carriesText(event)) return;
            // Without this the drop never fires: the default action for text is
            // the browser's own, and this box is not a text field.
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }}
          onDragLeave={() => {
            dropDepth.current = Math.max(0, dropDepth.current - 1);
            if (dropDepth.current === 0) setDropHover(false);
          }}
          onDrop={onDrop}
        >
          {dropHover && (
            <div
              role="status"
              className="pointer-events-none absolute bottom-full right-0 mb-2 w-[220px] rounded-xl border border-indigo-200 bg-white px-2.5 py-1.5 text-[11px] leading-relaxed text-neutral-700 shadow-lg shadow-indigo-900/10 dark:border-indigo-400/30 dark:bg-neutral-900 dark:text-neutral-200"
            >
              <div>{t(dropTidy ? 'notes.capture.dropHintTidy' : 'notes.capture.dropHint')}</div>
              {/* The modifier is invisible, so the hint is where it is taught: shown
                  as the alternative until it is held, then it is what will happen. */}
              {!dropTidy && (
                <div className="mt-0.5 text-[10.5px] text-neutral-400 dark:text-neutral-500">
                  {t('notes.capture.dropHintAlt')}
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            {...placement.handlers}
            onPointerDown={(event) => {
              // Runs after `placement.handlers` installed its own listener: before
              // the press collapses it, because by `click` the document selection is
              // gone and this is the only moment the text is still there.
              placement.handlers.onPointerDown(event);
              const selected = window.getSelection()?.toString().trim() ?? '';
              setSelectionText(selected.slice(0, 4000));
            }}
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
              'relative flex items-center justify-center rounded-full text-white shadow-lg shadow-indigo-900/25 transition-colors',
              // A dot is a 28px target instead of 56: on a phone the ball can sit on
              // top of the last line of the transcript, and shrinking it keeps the
              // entry point while giving back the line.
              ballSize === 'compact' ? 'h-7 w-7' : 'h-14 w-14',
              // Only a capture animates; at rest the ball is still (see the header).
              capturing ? 'cursor-wait' : 'hover:opacity-90',
              capturing ? '' : placement.dragging ? 'cursor-grabbing' : 'cursor-grab',
              // A drop hovering is a state, not motion: a ring says "this will land
              // here", and the hint above says what landing means.
              dropHover &&
                (dropTidy
                  ? 'ring-4 ring-amber-300 ring-offset-2 ring-offset-white dark:ring-offset-neutral-950'
                  : 'ring-4 ring-indigo-300 ring-offset-2 ring-offset-white dark:ring-offset-neutral-950'),
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
              <NotebookPen
                className={ballSize === 'compact' ? 'h-3.5 w-3.5' : 'h-6 w-6'}
                strokeWidth={1.75}
              />
            )}
            {counts.draft > 0 && (
              // The badge shrinks with the ball but never disappears: it is the only
              // thing a compact ball still says. White rather than amber: draft
              // stopped being a yellow state everywhere else in the layer, and an
              // amber chip here would be the one place still shouting about it — on
              // the ball's indigo it is also the only value that stays legible at
              // 14px.
              <span
                className={cn(
                  'absolute inline-flex items-center justify-center rounded-full border-2 border-white bg-white px-1 font-semibold text-indigo-700 dark:border-neutral-950',
                  ballSize === 'compact'
                    ? '-right-1 -top-1 h-3.5 min-w-3.5 text-[8px]'
                    : '-right-0.5 -top-0.5 h-5 min-w-5 text-[10px]',
                )}
              >
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
  title,
  badge,
  onClick,
}: {
  icon: typeof Inbox;
  label: string;
  /** Short chip on the right, like a shortcut. A sentence belongs in `title`. */
  hint?: string;
  title?: string;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      title={title}
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
