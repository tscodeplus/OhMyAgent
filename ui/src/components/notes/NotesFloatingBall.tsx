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
 * A capture that produces several notes shows **one** card, so the card says how
 * many there were: the rest are already in the drafts view, and a single card with
 * no count reads as "one note was kept".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Check,
  EyeOff,
  Inbox,
  Loader2,
  Minus,
  NotebookPen,
  Plus,
  Quote,
  RefreshCw,
  Sparkles,
  Square,
  Wand2,
  X,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import Button from '../ui/Button';
import { useNotes } from './NotesContext';
import { FacetRow, relativeTime } from './NoteBits';
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
    saveDraft,
    discardDraft,
    dismissDraftCard,
    ballHidden,
    setBallHidden,
    ballSize,
    setBallSize,
  } = useNotes();

  const [menuOpen, setMenuOpen] = useState(false);
  /** The "tidy this up my way" dialog; `null` when closed. */
  const [instruction, setInstruction] = useState<string | null>(null);
  const [instructionError, setInstructionError] = useState<string | null>(null);
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

  useEffect(() => {
    if (!draftCardId) return;
    const timer = window.setTimeout(dismissDraftCard, CARD_AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [draftCardId, dismissDraftCard]);

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
   * How many notes the last capture produced.
   *
   * The card shows one of them; without this the other two look like they were never
   * written. Reset on every new capture, so a stale number cannot outlive its group.
   */
  const [cardGroup, setCardGroup] = useState(0);
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
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const draft = drafts.find((item) => item.id === draftCardId) ?? null;

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

  const report = (outcome: {
    ok: boolean;
    notes: unknown[];
    existingId?: string;
    message?: string;
  }) => {
    if (outcome.ok) return;
    // "Already have it" is the one refusal with somewhere to go, so it is offered as
    // a door: open the note the library already holds under that title.
    setNotice({
      text: outcome.existingId
        ? t('notes.capture.duplicate')
        : (outcome.message ?? t('notes.capture.failed')),
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
      setCardGroup(outcome.notes.length);
      setCardScope(scopeOf(outcome));
      // A capture that produced nothing is not an error: "this turn had nothing
      // worth keeping" is a normal answer, and 422 is how the server says it.
      report(outcome);
    });
  };

  const submitInstruction = () => {
    const text = (instruction ?? '').trim();
    if (!text) {
      setInstructionError(t('notes.capture.instructionEmpty'));
      return;
    }
    void capture({ mode: 'instruction', sessionId, instruction: text }).then((outcome) => {
      if (outcome.ok) {
        setCardGroup(outcome.notes.length);
        setCardScope(scopeOf(outcome));
        setCardScope(scopeOf(outcome));
        setInstruction(null);
        setInstructionError(null);
        return;
      }
      setInstructionError(outcome.message ?? t('notes.capture.failed'));
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
      setCardGroup(outcome.notes.length);
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
  // dismissed is worse than one that needs one visit to restore.
  if (!onConversationPage || ballHidden) return null;

  return (
    <>
      <div
        ref={rootRef}
        className="pointer-events-none fixed z-40 flex flex-col items-end gap-2"
        // `right`/`bottom` come from the placement hook so the ball can be dragged
        // and lifted clear of the composer; see `useBallPlacement.ts`.
        style={{ right: placement.style.right, bottom: placement.style.bottom }}
      >
        {notice && !menuOpen && (
          <div
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
                onClick={() => setInstruction(null)}
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
                onChange={(event) => setInstruction(event.target.value)}
                onKeyDown={(event) => {
                  // Enter asks; Shift+Enter is a new line — the same rule as the
                  // chat composer beside it.
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    submitInstruction();
                  }
                }}
                rows={3}
                placeholder={t('notes.capture.instructionPlaceholder')}
                className="w-full resize-y rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-[12.5px] leading-relaxed text-neutral-800 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
              />
              {instructionError && (
                <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">
                  {instructionError}
                </p>
              )}
            </div>
            <div className="flex items-center gap-1 border-t border-neutral-100 px-2 py-1.5 dark:border-neutral-800">
              <Button size="sm" onClick={submitInstruction} className="h-7">
                {t('notes.capture.instructionSubmit')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setInstruction(null)}
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
            groupSize={cardGroup}
            scope={cardScope}
            onSave={() => void saveDraft(draft.id)}
            onEdit={() => {
              // Editing must not approve: an open editor on a draft stays a draft,
              // and the page's save path only rewrites the draft's text.
              dismissDraftCard();
              navigate(`/notes/${draft.id}?edit=1`);
            }}
            onRegenerate={() => {
              // The same material, distilled again, then the first draft retires:
              // the server has no "rewrite this draft" call, and a re-distill is
              // exactly what the button promises.
              //
              // For a draft the *user* supplied it is the material that differs,
              // not the window: dropped words are tidy-up-able, so the agent sees
              // the draft's own body instead of another reading of the transcript.
              const verbatim = draft.origin === 'user';
              const intent = verbatim
                ? {
                    mode: 'drop' as const,
                    sessionId,
                    text: draft.body,
                    treatment: 'distill' as const,
                  }
                : { mode: 'conversation' as const, sessionId };
              void capture(intent).then((outcome) => {
                if (outcome.ok) {
                  setCardGroup(outcome.notes.length);
                  setCardScope(scopeOf(outcome));
                  setCardScope(scopeOf(outcome));
                  setCardScope(scopeOf(outcome));
                  void discardDraft(draft.id);
                } else {
                  report(outcome);
                }
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

/**
 * The review card. It appears at the end of a capture instead of a modal: the
 * user's attention is already in the conversation, and a dialog would demand a
 * decision before the next sentence.
 */
function DraftCard({
  draft,
  groupSize,
  scope,
  onSave,
  onEdit,
  onRegenerate,
  onDiscard,
  onClose,
}: {
  draft: NonNullable<ReturnType<typeof useNotes>['drafts'][number]>;
  /** How many drafts this capture produced; `> 1` gets a line saying where the rest are. */
  groupSize: number;
  /**
   * The window the draft came from, when it was not the whole conversation. Rendering
   * it on the card (not in a toast) is deliberate: the toast disappears in five
   * seconds, and this is information for the decision the card is asking for.
   */
  scope: { read: number; dropped: number; head?: number } | null;
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
        <span className="ml-auto text-[10px] text-neutral-400">
          {/* The card can only show one draft, and a capture routinely produces two or
              three. One card with no count reads as "one note was kept". */}
          {groupSize > 1 && (
            <span className="mr-1.5">{t('notes.draftCard.group', { count: groupSize })}</span>
          )}
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

      {/* Not on the review card's face but directly under it: the note above may be
          about the tail of the conversation, and the reviewer decides with that in
          mind — or opens the note page to write the missing half themselves. */}
      {scope && (
        <p className="border-t border-amber-100 bg-amber-50/60 px-3 py-1.5 text-[10.5px] leading-snug text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/10 dark:text-amber-200">
          {scope.head
            ? t('notes.capture.windowSampled', {
                head: scope.head,
                tail: Math.max(scope.read - scope.head, 0),
                dropped: scope.dropped,
              })
            : t('notes.capture.windowTruncated', { read: scope.read, dropped: scope.dropped })}
        </p>
      )}

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
          {/* A draft distilled from the window is re-read; a draft the user dragged
              in is raw material, so the honest label is "tidy this up". */}
          {draft.origin === 'user' ? t('notes.draftCard.tidy') : t('notes.draftCard.regenerate')}
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
