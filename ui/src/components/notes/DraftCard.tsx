/**
 * The review card a capture leaves behind, in two sizes.
 *
 * A capture runs against a remote provider for tens of seconds, so the card has to
 * appear on its own when the answer lands — the user has long since gone back to the
 * conversation. It therefore *never retracts on a timer*: a card that disappears
 * while it is being read is a card whose approve button never gets pressed, and the
 * draft it was asking about looks lost even though it is sitting in the drafts view.
 * It leaves when the user approves, deletes, or closes it.
 *
 * **Nothing on the card is truncated.** An earlier version showed the title, a
 * two-line summary and `fields[0]`, which meant the body — the authoritative half of
 * a note — was never on screen, and the approve button was asking for a verdict on
 * text the reviewer had not seen. The card now renders summary, every field and the
 * body inside a scroll region, and it is *sized by the room it has* rather than by a
 * fixed `dvh` guess — see `maxHeight`.
 *
 * **It leaves when the user says so**: approve, delete, close, or a press anywhere
 * outside it. A timer is not one of those (see above), and neither is the pointer
 * being somewhere else — a card that has to be hunted for a dismiss control is the
 * other failure mode of a card that never goes away.
 *
 * **「放大阅读」 buys room, not content.** On a phone the compact card is ~360px wide
 * beside the ball, and a note about a command contains a code block: readable, but
 * not comfortable. Expanding moves the same preview onto a taller surface — a
 * full-width bottom sheet on a phone, and on a wide screen a drawer that takes the
 * conversation column's rails (8px inside each edge, see `measureColumn`) rather
 * than a dialog floating over the sidebar. It is one tap on the path "read this
 * properly", and zero taps on the path "delete it" or "approve a two-line note" —
 * which is why the compact card still exists instead of opening a sheet
 * automatically and demanding a decision mid-sentence.
 *
 * Both sizes render the same preview and the same four verbs from this file, so a
 * change to one cannot drift from the other.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Maximize2, Minimize2, RefreshCw, X } from 'lucide-react';
import Button from '../ui/Button';
import { FacetRow, NoteBody, relativeTime } from './NoteBits';
import type { Note } from './types';

/** The window a draft was distilled from, when it was not the whole conversation. */
export interface DraftScope {
  read: number;
  dropped: number;
  head?: number;
}

/** Air between the expanded drawer and the conversation column's own edges. */
const COLUMN_INSET = 8;

/**
 * Where the expanded drawer belongs on a wide screen: the conversation column's
 * rails, inset by `COLUMN_INSET` on both sides.
 *
 * Measured rather than assumed because the sidebar is resizable and collapsible —
 * a `max-w-*` drawer floated over the sidebar, which is what the first version did.
 * The column marks itself with `data-notes-column` (`AppShell`), the same way the
 * ball finds the composer through `data-notes-avoid`; the sidebar's right edge is the
 * same boundary and is used as a fallback, so a build where the marker is missing
 * still does not draw a drawer flush against the sidebar.
 *
 * `null` means "full-width bottom sheet": a phone has no column to align to, and the
 * sheet should reach both edges.
 */
function measureColumn(): { left: number; width: number } | null {
  if (!window.matchMedia('(min-width: 640px)').matches) return null;
  const rails = (leftEdge: number, rightEdge: number) => ({
    left: Math.round(leftEdge) + COLUMN_INSET,
    width: Math.max(0, Math.round(rightEdge - leftEdge) - COLUMN_INSET * 2),
  });
  const column = document.querySelector('[data-notes-column]');
  if (column instanceof HTMLElement) {
    const rect = column.getBoundingClientRect();
    if (rect.width > 0) return rails(rect.left, rect.right);
  }
  const sidebar = document.querySelector('[data-sidebar]');
  if (sidebar instanceof HTMLElement) {
    const rect = sidebar.getBoundingClientRect();
    if (rect.width > 0 && rect.right < window.innerWidth)
      return rails(rect.right, window.innerWidth);
  }
  return null;
}

export default function DraftCard({
  draft,
  groupSize,
  scope,
  storeError,
  maxHeight,
  onSave,
  onEdit,
  onRegenerate,
  onDiscard,
  onClose,
}: {
  draft: Note;
  /** How many drafts this capture produced; `> 1` gets a line saying where the rest are. */
  groupSize: number;
  /**
   * The window the draft came from, when it was not the whole conversation. Rendering
   * it on the card (not in a toast) is deliberate: the toast disappears in five
   * seconds, and this is information for the decision the card is asking for.
   */
  scope: DraftScope | null;
  /**
   * The ceiling for the compact card, in px, measured by the caller from where the
   * ball actually sits.
   *
   * A `dvh`-based guess is not enough: the ball is anchored above the composer, and
   * on a tall window with a multiline composer that anchor alone can be a couple of
   * hundred px, so `56dvh` plus header and verbs reached past the top of the viewport
   * and the card opened with its top border and close button off-screen. The parent
   * knows the real room, so it measures it and the card is clamped to it. The whole
   * card is capped (not just the reading area), which is what lets the reading area
   * below scroll with `flex-1` — the same contract `Modal.tsx` uses.
   */
  maxHeight: number;
  /**
   * The store's `error` line at render time.
   *
   * A refused write resolves `false` and puts its sentence there (the same line the
   * notes page prints at the top), so the card explains the refusal with the server's
   * own words instead of inventing a second vocabulary for it.
   */
  storeError: string | null;
  /** Resolves `false` when the server refused the approval. */
  onSave: () => Promise<boolean>;
  onEdit: () => void;
  onRegenerate: () => void;
  /** Resolves `false` when the server refused the rejection. */
  onDiscard: () => Promise<boolean>;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation('common');
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  /**
   * A write the server refused. The card is deliberately *not* closed on it: a
   * draft that could not be approved still exists, and closing the card over a red
   * line the reader never saw is how "approved" and "still a draft" got confused.
   */
  const [refused, setRefused] = useState(false);
  /** The compact card's own box, for the press-anywhere-else dismissal below. */
  const rootRef = useRef<HTMLDivElement>(null);
  /**
   * The drawer's rails while it is open, or `null` for a full-width bottom sheet.
   *
   * Measured when the drawer opens (and again on resize), not on every render: the
   * sidebar is resizable, and a measurement taken once at mount would be wrong the
   * first time someone widened it.
   */
  const [column, setColumn] = useState<{ left: number; width: number } | null>(null);

  const toggleExpanded = () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setColumn(measureColumn());
    setExpanded(true);
  };

  useEffect(() => {
    if (!expanded) return;
    const onResize = () => setColumn(measureColumn());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [expanded]);

  /**
   * A press anywhere that is not the card puts it away.
   *
   * The card no longer has a timer, so this is what keeps it from becoming a
   * permanent 360px slab beside the transcript: the same gesture the menu and every
   * other popover in the app already answers to. It only *hides* the card —
   * `dismissDraftCard` is not a rejection — so the draft is still in the queue and
   * the badge still counts it.
   *
   * Not while expanded: the drawer is a layer of its own and answers presses itself
   * (its backdrop dismisses both the drawer and the card — see below), so this
   * listener would otherwise fire twice for one press.
   */
  useEffect(() => {
    if (expanded) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [expanded, onClose]);

  /**
   * The expanded drawer owns the whole screen, so it borrows the modal's contract:
   * Esc and a press on the backdrop put the whole review away, the same way they
   * close every other popover here. 收起 (the header toggle) is the one gesture that
   * goes back to the compact card instead of leaving.
   */
  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [expanded, onClose]);

  const approve = () => {
    if (saving) return;
    setRefused(false);
    setSaving(true);
    void onSave().then((ok) => {
      setSaving(false);
      if (!ok) {
        setRefused(true);
        return;
      }
      setSaved(true);
      window.setTimeout(onClose, 600);
    });
  };

  const discard = () => {
    if (saving) return;
    setRefused(false);
    setSaving(true);
    void onDiscard().then((ok) => {
      setSaving(false);
      if (!ok) setRefused(true);
    });
  };

  /**
   * Summary → fields → body, the same order the notes page reads a note in, so the
   * reviewer is not asked to learn a second arrangement for the same object.
   */
  const preview = (
    <div className="space-y-3">
      <div>
        <h3 className="text-[13.5px] font-semibold leading-snug text-neutral-900 dark:text-neutral-100">
          {draft.title}
        </h3>
        {draft.summary && (
          <p className="mt-1 text-[12px] leading-relaxed text-neutral-500 dark:text-neutral-400">
            {draft.summary}
          </p>
        )}
        <FacetRow note={draft} className="mt-1.5" />
      </div>

      {draft.fields.length > 0 && (
        // Every field, not just the first: `fields` is up to six slots and the second
        // one is routinely the fix while the first is the symptom.
        <dl className="divide-y divide-neutral-200/70 overflow-hidden rounded-lg border border-neutral-200/80 dark:divide-neutral-800 dark:border-neutral-800">
          {draft.fields.map((field) => (
            <div
              key={field.key}
              className="flex flex-col gap-0.5 px-2.5 py-1.5 sm:flex-row sm:gap-3"
            >
              <dt className="w-14 shrink-0 pt-0.5 text-[10.5px] font-medium text-neutral-500 dark:text-neutral-400">
                {t(`notes.field.${field.key}`, { defaultValue: field.key })}
              </dt>
              {/* `pre-wrap` + `break-words`, not the old horizontally scrolling `pre`:
                  a command long enough to overflow is exactly the one worth reading,
                  and a phone has no room for a sideways scroll. */}
              <dd className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-neutral-700 dark:text-neutral-200">
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {/* The body is markdown and renders through the same component the notes page
          reads it with, so a code block or a table is not previewed as raw source. */}
      {draft.body && <NoteBody body={draft.body} />}
    </div>
  );

  const scopeBanner = scope && (
    <p className="border-t border-amber-100 bg-amber-50/60 px-3 py-1.5 text-[10.5px] leading-snug text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/10 dark:text-amber-200">
      {scope.head
        ? t('notes.capture.windowSampled', {
            head: scope.head,
            tail: Math.max(scope.read - scope.head, 0),
            dropped: scope.dropped,
          })
        : t('notes.capture.windowTruncated', { read: scope.read, dropped: scope.dropped })}
    </p>
  );

  const refusedBanner = refused && storeError && (
    <p className="border-t border-red-100 bg-red-50/60 px-3 py-1.5 text-[10.5px] leading-snug text-red-700 dark:border-red-900/40 dark:bg-red-900/10 dark:text-red-300">
      {storeError}
    </p>
  );

  /**
   * The verbs, in one place. 批准 first and filled, the destructive one last and
   * quiet, in both sizes.
   */
  const actions = (
    <div className="flex shrink-0 items-center gap-1 border-t border-neutral-100 px-2 py-1.5 dark:border-neutral-800">
      <Button size="sm" onClick={approve} loading={saving} disabled={saved} className="h-7">
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
        onClick={discard}
        disabled={saving || saved}
        className="ml-auto rounded-md px-2 py-1 text-[11px] text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-red-500/10 dark:hover:text-red-400"
      >
        {t('notes.draftCard.discard')}
      </button>
    </div>
  );

  const header = (showingExpanded: boolean) => (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-neutral-100 px-3 py-2 dark:border-neutral-800">
      <span className="shrink-0 text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
        {t('notes.draftCard.title')}
      </span>
      {/* `min-w-0 truncate` and `shrink-0` on the icons: without them a long
          "共 12 条 · 3 分钟前" squeezed the two buttons — flex shrinks them like any
          other item — and the close control became a few invisible pixels. */}
      <span className="ml-auto min-w-0 truncate text-[10px] text-neutral-400">
        {/* The card can only show one draft, and a capture routinely produces two or
            three. One card with no count reads as "one note was kept". */}
        {groupSize > 1 && (
          <span className="mr-1.5">{t('notes.draftCard.group', { count: groupSize })}</span>
        )}
        {relativeTime(draft.updatedAt, i18n.language)}
      </span>
      <button
        type="button"
        onClick={toggleExpanded}
        aria-label={t(showingExpanded ? 'notes.draftCard.collapse' : 'notes.draftCard.expand')}
        title={t(showingExpanded ? 'notes.draftCard.collapse' : 'notes.draftCard.expand')}
        className="shrink-0 rounded p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
      >
        {showingExpanded ? (
          <Minimize2 className="h-3.5 w-3.5" />
        ) : (
          <Maximize2 className="h-3.5 w-3.5" />
        )}
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('notes.close')}
        className="shrink-0 rounded p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );

  if (expanded) {
    return (
      <div className="pointer-events-auto fixed inset-0 z-[60] flex items-end justify-center">
        <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
        <div
          role="dialog"
          aria-label={t('notes.draftCard.title')}
          // On a wide screen this is a drawer on the conversation's rails, not a
          // dialog floating over the sidebar; on a phone it is the usual full-width
          // bottom sheet (`column` is `null` below 640px).
          style={
            column
              ? { position: 'absolute', left: column.left, width: column.width, bottom: 0 }
              : undefined
          }
          className="relative flex max-h-[92dvh] w-full animate-oma-sheet-up flex-col overflow-hidden rounded-t-2xl border border-neutral-200 bg-white pb-safe shadow-2xl sm:max-h-[calc(100dvh-24px)] dark:border-neutral-700 dark:bg-neutral-900"
        >
          {/* The grab handle the app's other bottom sheets carry, so the sheet reads as
              draggable-by-habit even though it closes on its own controls. */}
          <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-neutral-300 sm:hidden dark:bg-neutral-600" />
          {header(true)}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{preview}</div>
          {scopeBanner}
          {refusedBanner}
          {actions}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      // The ceiling comes from the caller, which knows how much room is actually left
      // above (or below) the ball. `overflow-hidden` + `flex-col` is what makes the
      // reading area below the only thing that scrolls.
      style={{ maxHeight }}
      className="pointer-events-auto flex w-[min(360px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl shadow-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-900"
    >
      {header(false)}
      {/* The scroll region is a plain div, not a button: the old card wrapped its whole
          face in a `<button>` so a tap opened the editor, which left the draft's own
          text unselectable and made an inner scroll awkward on touch. Editing has a
          named verb in the footer. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">{preview}</div>
      {scopeBanner}
      {refusedBanner}
      {actions}
    </div>
  );
}
