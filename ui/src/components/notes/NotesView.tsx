/**
 * The notes page: list on the left, one note on the right.
 *
 * Rows come from `/api/notes` through `NotesContext`, and every filter is a
 * server-side predicate: a tag filter that scanned the loaded page would disagree
 * with the tag row rendered beside it. What the components still own is the shape
 * the plan commits to — facets are read-only and come from columns (not from
 * `tags`), source chips are a trace back to the conversation (§4.7), and
 * structured slots are optional because a note that fits no template is a note.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Archive,
  Check,
  Clock,
  Inbox,
  Link2,
  Loader2,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { apiRequest } from '../../utils/api';
import { cn } from '../../lib/utils';
import Button from '../ui/Button';
import Modal from '../ui/Modal';
import MultiSelect from '../ui/MultiSelect';
import Select from '../ui/Select';
import { useToast } from '../ui/Toast';
import { toSearchParams, useNotes, type PurgeOutcome } from './NotesContext';
import {
  CHANNEL_LABEL,
  CopyableValue,
  DraftBadge,
  FacetRow,
  NoteBody,
  ScopeChip,
  relativeTime,
  SourceChip,
  TagChip,
  sessionLabel,
} from './NoteBits';
import MarkdownEditor from './MarkdownEditor';
import SearchContextPanel from '../search/SearchContextPanel';
import type { SearchResult } from '../../types/search';
import {
  NOTE_REJECTION_CODES,
  type Note,
  type NoteField,
  type NoteRejectionCode,
  type NoteSource,
  type NoteStatus,
} from './types';

/**
 * Idle time before typing becomes one search request.
 *
 * Long enough that a typed word is one query instead of one per key, short enough that
 * the list still feels like it follows the box (the old behaviour: one request per
 * keystroke, each carrying four facet aggregations and a hydrated page).
 */
const SEARCH_DEBOUNCE_MS = 280;

/** Breathing room between the citation sheet and the column it belongs to. */
const DRAWER_INSET_PX = 6;

/**
 * How many rows one page holds.
 *
 * Matches the server's `DEFAULT_LIST_LIMIT`, because page 1 is whatever the provider
 * fetched without asking: a different number here would make "加载更多" skip rows.
 */
const NOTE_PAGE_SIZE = 50;

export default function NotesView() {
  const { t, i18n } = useTranslation('common');
  const { showToast } = useToast();
  const navigate = useNavigate();
  const { noteId } = useParams<{ noteId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    notes: rows,
    drafts,
    counts,
    tags: tagFacets,
    channels: channelFacets,
    projects: projectFacets,
    loading,
    error,
    query,
    setQuery,
    refresh,
    createNote,
    updateNote,
    saveDraft,
    discardDraft,
    togglePin,
    archiveNote,
    restoreNote,
    purgeNote,
    markViewed,
    fetchNote,
    stats,
  } = useNotes();

  /**
   * Rows after the first page, and whether there are any.
   *
   * `NotesQuery` in `NotesContext` carries no `limit`/`offset`: the provider fetches one
   * page per filter and replaces it. So "加载更多" is one explicit request from here,
   * using the same predicates the provider sends — and the extras are dropped whenever
   * the filter changes, so the two sources cannot show the same row twice or keep a row
   * the new filter excluded. The real fix is a paged query in the provider; the list
   * lives in a component this page is allowed to change during a shared working tree.
   */
  const [more, setMore] = useState<Note[]>([]);
  const [moreState, setMoreState] = useState<'idle' | 'loading' | 'end'>('idle');
  const queryKey = JSON.stringify(query);
  useEffect(() => {
    setMore([]);
    setMoreState('idle');
  }, [queryKey]);

  /**
   * Drafts are notes that have not been approved yet, so they live in the same
   * list and the same detail view — the server returns whichever status the query
   * asks for, and `rows` is already that list. Keeping drafts in a separate drawer
   * was the reason approving one happened on a different screen from editing it.
   */
  const allNotes = useMemo(() => {
    if (more.length === 0) return rows;
    const known = new Set(rows.map((note) => note.id));
    return [...rows, ...more.filter((note) => !known.has(note.id))];
  }, [more, rows]);

  const loadMore = useCallback(async () => {
    setMoreState('loading');
    // The provider's own builder, with the two paging keys on top: a facet added to
    // `toSearchParams` reaches this page for free, whereas the hand-written copy that
    // used to be here would have paged an unfiltered list the day one was added.
    // The page count, not the number of rows on screen: an offset is a position in the
    // server's list, and a row deleted from page 1 shifts everything after it. That
    // drift is what offset paging is, and it is the reason this stays one page at a
    // time instead of pretending to hold the whole library.
    const params = toSearchParams(query, {
      limit: String(NOTE_PAGE_SIZE),
      offset: String(NOTE_PAGE_SIZE + more.length),
    });
    try {
      const page = await apiRequest<{ notes: Note[] }>(`/api/notes?${params}`);
      setMore((prev) => {
        // Offset paging drifts when a row above is removed, so a note can arrive twice.
        // `allNotes` de-dupes against the first page only; this keeps the appended tail
        // from rendering the same row twice.
        const seen = new Set(prev.map((note) => note.id));
        return [...prev, ...page.notes.filter((note) => !seen.has(note.id))];
      });
      // A short page is the only "到底" signal this page has: the provider keeps the
      // server's `total` to itself, so the count cannot be compared to what is loaded.
      setMoreState(page.notes.length < NOTE_PAGE_SIZE ? 'end' : 'idle');
    } catch {
      setMoreState('idle');
      showToast(t('notes.loadMoreError'), 'error');
    }
  }, [more.length, query, showToast, t]);

  /**
   * Whether another page can be offered.
   *
   * A first page shorter than the page size is the whole library; after a load, `end` is
   * the answer that request gave.
   */
  const canLoadMore = moreState !== 'end' && (more.length > 0 || allNotes.length >= NOTE_PAGE_SIZE);

  /**
   * Filters live in the store, not here: every one of them is a SQL predicate on
   * the server (a JSON scan over tags would disagree with the tag row rendered
   * beside it), so the page state and the query are the same object.
   *
   * `statusFilter` is seeded from the URL so the `?drafts=1` deep link is right on
   * the first paint — setting it in an effect afterwards lost the value, because
   * the same effect strips the param.
   */
  const statusFilter = query.status;
  const setStatusFilter = useCallback(
    (next: NoteStatus | ((current: NoteStatus) => NoteStatus)) => {
      const value = typeof next === 'function' ? next(statusFilter) : next;
      setQuery({ status: value });
    },
    [setQuery, statusFilter],
  );
  const searchText = query.q ?? '';
  /**
   * What the box shows, and what the list filters on — two values on purpose.
   *
   * Typing is local and filtering is a server request; wiring them together made one
   * keystroke one `/api/notes` call (four facet aggregations plus a hydrated page each),
   * and `NotesContext`'s sequence ticket only ordered the answers, it never stopped the
   * requests. Enter stays an immediate commit for the reader who does not want to wait.
   */
  const [searchInput, setSearchInput] = useState(searchText);
  const setSearchText = useCallback(
    (value: string) => {
      setSearchInput(value);
      // Clearing is a click, not typing: it should not wait out the delay.
      if (!value) setQuery({ q: '' });
    },
    [setQuery],
  );
  /** Trimmed before it becomes a query, so a trailing space is not a new search. */
  const commitSearch = useCallback(
    (value: string) => {
      const next = value.trim();
      if (next !== searchText) setQuery({ q: next });
    },
    [searchText, setQuery],
  );
  useEffect(() => {
    if (searchInput.trim() === searchText) return;
    const timer = window.setTimeout(() => setQuery({ q: searchInput.trim() }), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchInput, searchText, setQuery]);
  // A filter cleared elsewhere (清除筛选, a tag chip, the ?drafts=1 handover) empties the
  // box too, or the box would keep showing a query the list is not using.
  useEffect(() => {
    setSearchInput((current) => (current.trim() === searchText ? current : searchText));
  }, [searchText]);
  /**
   * Trigger text for a facet with something in it.
   *
   * One value is spelled out; several collapse to "first +n", because the trigger is
   * ~160px in the split view and a comma list would be a riddle at that width.
   */
  const summaryOf = useCallback(
    (facet: 'origin' | 'channel' | 'project' | 'tag', labels: string[]) => {
      const label = t(`notes.filter.prefix.${facet}`);
      return labels.length === 1
        ? t('notes.filter.summaryOne', { label, value: labels[0] })
        : t('notes.filter.summaryMore', { label, value: labels[0], count: labels.length - 1 });
    },
    [t],
  );
  /**
   * `/notes/new` is a note that does not exist yet.
   *
   * It used to POST an empty "未命名笔记" first and edit that, which left a row
   * behind whenever the user changed their mind — a library of blanks whose only
   * possible action is delete. A note is created when it has content, and the row
   * id in the URL is what says it exists.
   */
  const isNew = noteId === 'new';
  const blank = useMemo<Note>(
    () => ({
      id: 'new',
      title: '',
      summary: '',
      body: '',
      fields: [],
      tags: [],
      status: 'active',
      statusReason: null,
      origin: 'user',
      scope: 'user',
      scopeKey: '',
      sessionId: null,
      channel: 'webui',
      projectName: undefined,
      pinned: false,
      confidence: null,
      version: 0,
      captureId: null,
      viewCount: 0,
      lastViewedAt: null,
      reviewedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sources: [],
      related: [],
      sessionTitle: null,
    }),
    [],
  );
  /**
   * A note opened by id that the current filter does not contain.
   *
   * Drafts are the case that matters: the floating ball opens
   * `/notes/<draft>?edit=1` while the page may be filtered to active notes, so
   * without this fetch the editor would get a row the list does not have and the
   * link would look dead.
   */
  const [fetched, setFetched] = useState<Note | null>(null);
  useEffect(() => {
    if (!noteId || noteId === 'new') {
      setFetched(null);
      return;
    }
    if (rows.some((note) => note.id === noteId)) {
      // The list already has it, and a refetch would only risk showing a stale copy.
      setFetched(null);
      return;
    }
    let alive = true;
    void fetchNote(noteId).then((note) => {
      if (alive) setFetched(note);
    });
    return () => {
      alive = false;
    };
  }, [fetchNote, noteId, rows]);

  const selected = useMemo(
    () =>
      isNew
        ? blank
        : (rows.find((note) => note.id === noteId) ??
          (fetched?.id === noteId ? fetched : undefined)),
    [blank, fetched, isNew, rows, noteId],
  );

  /**
   * Which note is open in the editor, held by id rather than as a boolean: a
   * boolean has to be reset when the id changes, and that reset races the
   * `?edit=1` effect — under StrictMode both effects re-run, so the reset won the
   * second pass and arriving with the flag never opened the editor. Tying the
   * state to an id makes "editing note B" and "editing nothing" the same fact,
   * and navigation already answers it.
   */
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = isNew ? true : !!noteId && editingId === noteId;

  /**
   * The editor's live fields, held one level above the editor.
   *
   * They started inside `NoteDetail`, which was fine while the back arrow was the
   * only way out. Now clicking the *same row again* is also a way out (§7.3), and
   * two independent "is it dirty?" answers would eventually disagree about it —
   * so the dirty check, the prompt and the save all live here, where every exit
   * meets.
   */
  /**
   * The citation whose conversation is open in the bottom sheet (§4.7).
   *
   * Shaped as a `SearchResult` so the citation reuses the existing search
   * drawer: same sheet, same focus highlight, same "open full session" footer.
   */
  const [contextHit, setContextHit] = useState<SearchResult | null>(null);
  /**
   * The sheet's box on wide screens: the notes area — list plus detail — inset on
   * both sides. Only the app's navigation sidebar (对话 / 收件箱 / 技能 …) stays
   * uncovered.
   *
   * The width the sheet tracks is this page's own column, not the note panel: a
   * citation is context for the whole list you were scanning, and a sheet that
   * started mid-page would look like a second panel wedged under the first. Full
   * bleed stays the rule on phones.
   */
  const pageRef = useRef<HTMLDivElement>(null);
  const [drawerBox, setDrawerBox] = useState<{ left: number; width: number } | null>(null);
  useEffect(() => {
    if (!contextHit) {
      setDrawerBox(null);
      return;
    }
    const measure = () => {
      const element = pageRef.current;
      // Phones keep the full-bleed sheet; a measured box would fight the layout.
      if (!element || window.innerWidth < 640) {
        setDrawerBox(null);
        return;
      }
      const rect = element.getBoundingClientRect();
      setDrawerBox({
        left: Math.round(rect.left) + DRAWER_INSET_PX,
        width: Math.round(rect.width) - DRAWER_INSET_PX * 2,
      });
    };
    measure();
    window.addEventListener('resize', measure);
    const observer = new ResizeObserver(measure);
    if (pageRef.current) observer.observe(pageRef.current);
    return () => {
      window.removeEventListener('resize', measure);
      observer.disconnect();
    };
  }, [contextHit]);
  const [draftPatch, setDraftPatch] = useState<Partial<Note> | null>(null);
  const [askSave, setAskSave] = useState(false);
  const dirty = useMemo(
    () => (editing && draftPatch && selected ? differsFromNote(selected, draftPatch) : false),
    [draftPatch, editing, selected],
  );

  // Leaving edit mode drops the draft so a later exit cannot resurrect it.
  useEffect(() => {
    if (!editing) {
      setDraftPatch(null);
      setAskSave(false);
    }
  }, [editing]);

  /**
   * Save `patch`, optionally leaving the detail afterwards.
   *
   * One path for the editor's 保存 button and for the prompt's 保存并关闭: the
   * "new note" case differs between them only in where it goes next. `leaveTo` is the
   * exit the unsaved-changes prompt remembered (a row, 新笔记, the list), not always
   * `/notes` — otherwise "save and leave" quietly overrode the click that started it.
   */
  const persist = useCallback(
    (patch: Partial<Note>, leaveTo: string | null) => {
      const hasContent = !!(patch.title?.trim() || patch.body?.trim());
      if (isNew) {
        // Leaving a blank editor is not an error; it simply creates nothing.
        if (!hasContent) {
          navigate(leaveTo ?? '/notes', { replace: true });
          return;
        }
        void createNote(patch).then((note) => {
          if (!note) return;
          setDraftPatch(null);
          setEditingId(null);
          // Replace, so the browser's back button does not return to the empty
          // form the note was just created from.
          navigate(leaveTo ?? `/notes/${note.id}`, { replace: true });
        });
        return;
      }
      if (!selected) return;
      // One update path for both statuses: the server rewrites the text and leaves
      // the status alone, so editing a draft cannot approve it — approval is the
      // separate decision the draft row asks for.
      void updateNote(selected, patch).then((note) => {
        if (!note) return;
        setDraftPatch(null);
        setEditingId(null);
        if (leaveTo) navigate(leaveTo);
      });
    },
    [createNote, isNew, navigate, selected, updateNote],
  );

  /**
   * Save the editor's text, then approve the draft it belongs to.
   *
   * Two calls in order, not one: the version gate lives on `PUT`, so the sequence
   * has to be "write, then decide". Approving first would publish the text the
   * reviewer was looking at while their edits were still unsaved.
   */
  const persistAndApprove = useCallback(
    (patch: Partial<Note>) => {
      if (!selected) return;
      void updateNote(selected, patch).then((note) => {
        if (!note) return;
        setDraftPatch(null);
        setEditingId(null);
        // Same follow-through as the draft row's 批准: the note now lives in the
        // library, so that is the list the panel switches to. A refused approval
        // resolves `false` (title already taken) — switching anyway left the editor
        // closed on a draft that still is one, with the reason in a line of red text
        // at the top of a list the reader had not been sent to.
        void saveDraft(note.id).then((ok) => {
          if (!ok) return;
          setQuery({ status: 'active' });
        });
      });
    },
    [saveDraft, selected, setQuery, updateNote],
  );

  /**
   * How this page leaves the note that is open.
   *
   * Every exit runs through here — the header arrow, clicking the open row again,
   * clicking a *different* row, 新笔记, a related note — because "you have unsaved text"
   * is one question and two copies of it drift. The target is remembered while the
   * prompt is open, so "save and leave" lands where the click pointed instead of always
   * on the list. Clicking straight to another row used to `navigate` past this, and the
   * effect that clears `draftPatch` then dropped everything just typed.
   */
  const pendingNav = useRef<string | null>(null);
  const requestClose = useCallback(
    (target: string = '/notes') => {
      // Leaving with unsaved changes asks first; leaving a clean note does not.
      if (editing && dirty) {
        pendingNav.current = target;
        setAskSave(true);
        return;
      }
      pendingNav.current = null;
      navigate(target);
    },
    [dirty, editing, navigate],
  );

  /**
   * Remove one row, whatever "remove" means for its status, and offer the way back.
   *
   * One handler for the three verbs: the *action* differs (archive is a soft delete, a
   * draft's reject records a verdict, an archived row comes back) while the
   * follow-through does not — in a list built for clearing out a review queue, a mis-click
   * is the expected mistake, so archive and discard end in a three-second `撤销` instead
   * of a confirm dialog. `restoreNote` is the whole undo: the server never dropped the
   * text, so nothing has to be reconstructed.
   */
  const removeNote = useCallback(
    async (note: Note, reason: NoteRejectionCode = 'other'): Promise<boolean> => {
      // The three writes answer `false` for a refusal (404 from another tab, a title
      // conflict on restore) — they do not throw — so a refusal must not fall through
      // into the success toast, and it is what the caller waits for before leaving.
      let ok = false;
      try {
        ok =
          note.status === 'archived'
            ? await restoreNote(note.id)
            : note.status === 'draft'
              ? await discardDraft(note.id, reason)
              : await archiveNote(note.id);
      } catch {
        // Not the refusal path (that is the `false` above) — this only keeps an
        // unexpected throw from disappearing into a click that seemed to do nothing.
        showToast(t('notes.toast.failed'), 'error');
        return false;
      }
      if (!ok) return false;
      // Restoring is not the kind of delete that needs an undo — its inverse is the
      // row's own button, one click away in the list it just rejoined.
      if (note.status === 'archived') {
        showToast(t('notes.toast.restored'), 'success', 3000);
        return true;
      }
      showToast(
        t(note.status === 'draft' ? 'notes.toast.discarded' : 'notes.toast.archived'),
        'success',
        3000,
        [
          {
            label: t('notes.toast.undo'),
            onClick: () => {
              // Already gone from the screen: a refused undo has to say so, or the row
              // silently stays archived.
              void restoreNote(note.id).then((restored) => {
                if (!restored) showToast(t('notes.toast.undoFailed'), 'error');
              });
            },
          },
        ],
      );
      return true;
    },
    [archiveNote, discardDraft, restoreNote, showToast, t],
  );

  /**
   * The purge dialog, for the archived note in the detail pane.
   *
   * An archived note is the only row it can act on, and the header button of the detail
   * is the only way to open it: the list's archived rows keep the single 恢复 action they
   * have, because an irreversible verb in a list you are scanning is a verb you press by
   * accident. The state lives at page level so the follow-through — toast, navigation,
   * dropping the row from the loaded tail — sits beside every other way out of a note.
   */
  const [purgeOpen, setPurgeOpen] = useState(false);

  /**
   * Follow-through for a row that no longer exists: just purged, or already gone.
   *
   * `gone` is the `404` case (purged in another tab). It is not a failure — the note is
   * gone, which is what the user asked for — but it is not the success sentence either,
   * because `已彻底删除` would claim an action this page did not take.
   */
  const finishPurge = useCallback(
    (note: Note, outcome: 'purged' | 'gone') => {
      setPurgeOpen(false);
      // The tail pages are this component's own state and the provider cannot see them,
      // so its refetch would leave a purged row rendering from `加载更多` until the
      // filter changed.
      setMore((prev) => prev.filter((item) => item.id !== note.id));
      // Purging ends the detail view: there is nothing left in the pane to read.
      navigate('/notes');
      showToast(
        t(outcome === 'purged' ? 'notes.toast.purged' : 'notes.purgeGone'),
        outcome === 'purged' ? 'success' : 'info',
        3000,
      );
    },
    [navigate, showToast, t],
  );

  /**
   * Esc closes what is open, through the same guard as every other exit.
   *
   * Registered only while a note is on screen, and skipped while the unsaved-changes
   * prompt is up — `Modal` owns Escape there, and closing the note underneath an open
   * question would answer it backwards.
   */
  useEffect(() => {
    // `contextHit`: while the citation sheet is open, `SearchContextPanel` owns Escape.
    // Both listeners would otherwise fire on one press and close two things at once.
    if (!selected || askSave || contextHit || purgeOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // `defaultPrevented`: a dropdown that already consumed the key keeps it — Escape
      // there means "close me", not "close the note behind me".
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      requestClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [askSave, contextHit, purgeOpen, requestClose, selected]);

  /**
   * Up/Down move between rows.
   *
   * Two controls per row (open, and its status action) means Tab alone scans a page in
   * pairs; the arrow keys keep the list scan one-handed, and only while a row already has
   * focus, so they cannot hijack a key pressed in the filters above.
   */
  const onListKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-note-open]'));
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (index === -1) return;
    const next = items[index + (event.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  // `?drafts=1` is how the floating ball hands over the review queue: the page
  // opens already filtered to drafts, so the ball needs no drawer of its own.
  // The flag is consumed once so a later reload does not silently re-apply it.
  useEffect(() => {
    if (searchParams.get('drafts') !== '1') return;
    setQuery({ status: 'draft' });
    const next = new URLSearchParams(searchParams);
    next.delete('drafts');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, setQuery]);

  // Opening a note is the one reader of `view_count` (plan §8.3). It is a POST so
  // that a prefetch or a link check cannot inflate it.
  useEffect(() => {
    // A blank note has no row to count a visit on.
    if (noteId && noteId !== 'new') markViewed(noteId);
  }, [noteId, markViewed]);

  // The purge dialog is a question about one row, so it closes with that row. Left
  // open, `purgeOpen` would outlive a note the dialog stopped rendering for — the row
  // was restored in another tab, say — and re-mount the question on whatever archived
  // note is opened next.
  useEffect(() => {
    setPurgeOpen(false);
  }, [noteId]);

  // `?edit=1` is how "新笔记" and "手写笔记" land in the editor; consumed once.
  useEffect(() => {
    if (!noteId || searchParams.get('edit') !== '1') return;
    setEditingId(noteId);
    const next = new URLSearchParams(searchParams);
    next.delete('edit');
    setSearchParams(next, { replace: true });
  }, [noteId, searchParams, setSearchParams]);

  /**
   * Facet options come from the server with the list response — a `GROUP BY` over
   * the library, not a scan of whatever page happens to be loaded. Deriving them
   * from the loaded rows meant a filter could hide the very values needed to widen
   * it back: filter to one channel and the channel list held that one channel.
   */
  const channels = useMemo(
    () =>
      channelFacets.map((facet) => ({
        value: facet.channel,
        label: `${t(`notes.channel.${facet.channel}`)} · ${facet.count}`,
        shortLabel: t(`notes.channel.${facet.channel}`),
      })),
    [channelFacets, t],
  );
  /**
   * Projects as (id, name) pairs: the server filters on `scope_key` while the row
   * shows the resolved name, and a dropdown keyed by name would send a name the
   * query cannot match.
   */
  const projects = useMemo(
    () =>
      projectFacets.map((facet) => ({
        value: facet.id,
        label: `${facet.name} · ${facet.count}`,
        shortLabel: facet.name,
      })),
    [projectFacets],
  );
  const tags = useMemo(() => tagFacets.map((facet) => facet.tag), [tagFacets]);

  // 新笔记 from a dirty editor is the same lost-typing trap as clicking another row.
  const startNewNote = useCallback(() => requestClose('/notes/new'), [requestClose]);

  const hasFilters =
    !!query.origins?.length ||
    !!query.channels?.length ||
    !!query.projectIds?.length ||
    !!query.tags?.length ||
    !!searchText;

  const clearFilters = useCallback(() => {
    setQuery({
      origins: undefined,
      channels: undefined,
      projectIds: undefined,
      tags: undefined,
      q: '',
    });
  }, [setQuery]);
  return (
    <div ref={pageRef} className="flex h-full min-h-0 bg-white dark:bg-neutral-950">
      {/*
       * One prompt for every way out of the detail (header arrow, or clicking the
       * open row again). It lives at page level because "leave with unsaved text"
       * is one decision, and asking it in two places is how the two answers drift.
       */}
      <Modal
        open={askSave}
        onClose={() => {
          pendingNav.current = null;
          setAskSave(false);
        }}
        title={t('notes.unsaved.title')}
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                pendingNav.current = null;
                setAskSave(false);
              }}
            >
              {t('notes.unsaved.cancel')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                // The exit the reader actually clicked, not always the list.
                const target = pendingNav.current ?? '/notes';
                pendingNav.current = null;
                setAskSave(false);
                navigate(target);
              }}
            >
              {t('notes.unsaved.discard')}
            </Button>
            <Button
              onClick={() => {
                const target = pendingNav.current ?? '/notes';
                pendingNav.current = null;
                setAskSave(false);
                if (draftPatch) persist(draftPatch, target);
                else navigate(target);
              }}
            >
              {t('notes.unsaved.save')}
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
          {t('notes.unsaved.body')}
        </p>
      </Modal>

      {/*
       * Mounted only while open (`purgeOpen`), so the typed title and any refusal
       * reset when the dialog is reopened on another row — state kept across opens
       * would be a confirmation already half given for a different note.
       */}
      {purgeOpen && selected?.status === 'archived' && (
        <PurgeDialog
          note={selected}
          onPurge={purgeNote}
          onClose={() => setPurgeOpen(false)}
          onDone={(outcome) => finishPurge(selected, outcome)}
        />
      )}

      <SearchContextPanel
        hit={contextHit}
        onClose={() => setContextHit(null)}
        hint={t('notes.traceCited')}
        box={drawerBox}
      />

      {/*
       * List column. With no note open it takes the whole width and the detail
       * column is not rendered at all — closing a note is supposed to *end* the
       * detail view, not leave a placeholder next to a 364px strip of list.
       */}
      <div
        className={cn(
          // A tinted index, not a second page: the reading column keeps the white
          // (or #0d1117) surface, so switching notes moves one plane instead of
          // moving the whole screen. It also gives the open row something to lift
          // off, which a white-on-white list cannot do.
          // `@container` because these filters are sized by the *column*, not by the
          // viewport: the same window shows a 364px column beside an open note and a
          // full-width list when none is open, and a viewport breakpoint would call
          // both "large" and cram four selects into 364px.
          'w-full @container min-w-0 flex-col bg-neutral-50/70 md:flex dark:bg-neutral-900/40',
          selected
            ? 'hidden border-r border-neutral-200 md:w-[364px] md:shrink-0 dark:border-neutral-800'
            : 'flex',
        )}
      >
        <div className="shrink-0 px-4 pb-2 pt-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h1 className="flex items-baseline gap-1.5 text-[15px] font-semibold tracking-[-0.01em] text-neutral-900 dark:text-neutral-100">
                {t('notes.title')}
                <span className="rounded-full bg-neutral-200/70 px-1.5 text-[10.5px] font-medium tabular-nums text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                  {/* Server-side count for the status being shown: "笔记 7" over a
                      list of three drafts reads as a bug. */}
                  {counts[statusFilter] ?? allNotes.length}
                </span>
              </h1>
              {error && (
                <p
                  className="mt-0.5 truncate text-[11px] text-red-600 dark:text-red-400"
                  title={error}
                >
                  {error}
                  <button
                    type="button"
                    onClick={() => void refresh()}
                    className="ml-1 underline underline-offset-2"
                  >
                    {t('notes.retry')}
                  </button>
                </p>
              )}
            </div>
            {/* The actions breathe with the column: at 364px three controls plus the
                title need every pixel, full-width there is room to separate them. */}
            <div className="flex shrink-0 items-center gap-2 @2xl:gap-3">
              {/* No ball switch here: hiding is `notes.ball.show` in config.yaml and
                  the settings page is its one visible control. An in-page restore
                  button looked reasonable until it vanished with the list column on
                  narrow layouts — a way back that disappears with the layout it was
                  meant to survive. */}
              {/* Still a toggle, not a fourth select: "archived" is a *place* in the
                  library rather than a value of a field, and a select would offer
                  "Archived: all" next to "Archived: 3", which says nothing. It sits
                  beside 草稿箱 because both are places you go, not filters you narrow. */}
              {counts.archived > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setStatusFilter((current) => (current === 'archived' ? 'active' : 'archived'))
                  }
                  aria-pressed={statusFilter === 'archived'}
                  className={cn(
                    'inline-flex h-8 shrink-0 items-center rounded-md border px-2 text-[11px] font-medium tabular-nums transition-colors',
                    // The same active state as 草稿箱: both are places you go, so the
                    // pressed look is one vocabulary, not a slightly quieter second one.
                    statusFilter === 'archived'
                      ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-300'
                      : 'border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800',
                  )}
                >
                  {t('notes.archivedToggle', { count: counts.archived })}
                </button>
              )}
              <button
                type="button"
                onClick={() =>
                  setStatusFilter((current) => (current === 'draft' ? 'active' : 'draft'))
                }
                aria-pressed={statusFilter === 'draft'}
                title={t('notes.draftsToggleHint')}
                className={cn(
                  'relative inline-flex h-8 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors',
                  statusFilter === 'draft'
                    ? 'border-indigo-300 bg-indigo-50 text-indigo-700 dark:border-indigo-500/40 dark:bg-indigo-500/10 dark:text-indigo-300'
                    : 'border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800',
                )}
              >
                <Inbox className="h-3.5 w-3.5" strokeWidth={1.75} />
                {t('notes.draftsButton')}
                {counts.draft > 0 && (
                  <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-indigo-600 px-1 text-[10px] font-semibold text-white">
                    {counts.draft}
                  </span>
                )}
              </button>
              <Button size="sm" onClick={startNewNote} className="h-8">
                <Plus className="h-3.5 w-3.5" strokeWidth={2} />
                {t('notes.newNote')}
              </Button>
            </div>
          </div>
        </div>

        {/* filters */}
        <div className="shrink-0 space-y-2 px-3 pb-2">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" />
            <input
              value={searchInput}
              onChange={(event) => setSearchText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                commitSearch(event.currentTarget.value);
              }}
              placeholder={t('notes.searchPlaceholder')}
              className="h-9 w-full rounded-lg border border-neutral-200 bg-white pl-8 pr-7 text-[12px] text-neutral-800 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none dark:border-neutral-700/80 dark:bg-neutral-900 dark:text-neutral-200"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => setSearchText('')}
                aria-label={t('notes.clear')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </label>

          {/* Four facets, two by two: three selects in a 364px column were already at
              the edge of legible, and the tag filter used to live below them as a
              scrolling chip strip that silently stopped at the eighth tag. The same
              control for all four also means one interaction to learn, not two. */}
          {/* One row when the column can hold it, two when it cannot — the tag filter
              is the fourth facet, not a separate strip, so all four behave alike. */}
          <div
            className={cn(
              'grid gap-1.5',
              tags.length > 0 ? 'grid-cols-2 @2xl:grid-cols-4' : 'grid-cols-3',
            )}
          >
            <MultiSelect
              compact
              label={t('notes.filter.prefix.origin')}
              searchPlaceholder={t('notes.filter.searchOptions')}
              clearLabel={t('notes.filter.clearOne')}
              emptyLabel={t('notes.filter.noOption')}
              allLabel={t('notes.filter.originAll')}
              formatSummary={(labels) => summaryOf('origin', labels)}
              values={query.origins ?? []}
              onChange={(values) => setQuery({ origins: values.length ? values : undefined })}
              // Plain labels inside the panel: "作者：我" is a trigger, "我" is an option.
              options={[
                { value: 'user', label: t('notes.facet.origin.user') },
                { value: 'agent', label: t('notes.facet.origin.agent') },
              ]}
            />
            <MultiSelect
              compact
              label={t('notes.filter.prefix.channel')}
              searchPlaceholder={t('notes.filter.searchOptions')}
              clearLabel={t('notes.filter.clearOne')}
              emptyLabel={t('notes.filter.noOption')}
              allLabel={t('notes.filter.channelAll')}
              formatSummary={(labels) => summaryOf('channel', labels)}
              values={query.channels ?? []}
              onChange={(values) => setQuery({ channels: values.length ? values : undefined })}
              options={channels}
            />
            <MultiSelect
              compact
              label={t('notes.filter.prefix.project')}
              searchPlaceholder={t('notes.filter.searchOptions')}
              clearLabel={t('notes.filter.clearOne')}
              emptyLabel={t('notes.filter.noOption')}
              allLabel={t('notes.filter.projectAll')}
              formatSummary={(labels) => summaryOf('project', labels)}
              values={query.projectIds ?? []}
              onChange={(values) => setQuery({ projectIds: values.length ? values : undefined })}
              options={projects}
            />
            {tags.length > 0 && (
              <MultiSelect
                compact
                label={t('notes.filter.prefix.tag')}
                searchPlaceholder={t('notes.filter.searchOptions')}
                clearLabel={t('notes.filter.clearOne')}
                emptyLabel={t('notes.filter.noOption')}
                allLabel={t('notes.filter.tagAll')}
                formatSummary={(labels) => summaryOf('tag', labels)}
                values={query.tags ?? []}
                onChange={(values) => setQuery({ tags: values.length ? values : undefined })}
                // The count is the reason this is a dropdown: `#tag · 7` says how much
                // is behind the filter, which a chip never did, and it is the number
                // that tells you whether a tag is worth clicking.
                options={tagFacets.map((facet) => ({
                  value: facet.tag,
                  label: `#${facet.tag} · ${facet.count}`,
                  shortLabel: `#${facet.tag}`,
                }))}
              />
            )}
          </div>

          {hasFilters && (
            <div className="flex items-center gap-2 text-[11px]">
              <button
                type="button"
                onClick={clearFilters}
                className="ml-auto shrink-0 text-neutral-500 underline-offset-2 hover:underline dark:text-neutral-400"
              >
                {t('notes.clearFilters')}
              </button>
            </div>
          )}

          {/* The one reader of `stats()`: how urgent the queue is and whether the
              review gate is actually being used. Shown only in the drafts view —
              "3 due" over a list of approved notes would be nagging about nothing. */}
          {statusFilter === 'draft' && stats && (
            <p className="text-[11px] text-neutral-400 dark:text-neutral-500">
              {t('notes.draftsStats', {
                due: stats.draftsDue,
                rate: Math.round(stats.approvalRate * 100),
              })}
            </p>
          )}
        </div>

        {/* Cards, not hairlines: rows carry a title, a one-or-two-line summary and a
            meta strip, so their heights differ. A rule between two rows of different
            heights reads as a table with a broken grid, while a rounded card per row
            absorbs the difference — and the row you open is then a card *plus* an
            accent, instead of the only thing on the page with an outline. */}
        <ul
          onKeyDown={onListKeyDown}
          className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-28"
        >
          {loading && allNotes.length === 0 && <ListSkeleton label={t('notes.loading')} />}
          {!loading && allNotes.length === 0 && (
            <ListEmpty
              icon={
                searchText
                  ? Search
                  : statusFilter === 'draft'
                    ? Inbox
                    : statusFilter === 'archived'
                      ? Archive
                      : Inbox
              }
              text={
                searchText
                  ? t('notes.emptySearch')
                  : statusFilter === 'draft'
                    ? t('notes.emptyDrafts')
                    : statusFilter === 'archived'
                      ? t('notes.emptyArchived')
                      : t('notes.empty')
              }
            />
          )}
          {allNotes.map((note, index) => (
            <NoteRow
              key={note.id}
              note={note}
              language={i18n.language}
              active={note.id === noteId}
              // Banded like a spreadsheet: two rows of the same height, weight and
              // card outline read as one block otherwise, and the eye loses the row
              // it was on when it comes back from the detail pane.
              banded={index % 2 === 1}
              // Clicking the open row closes the detail, the same way its back
              // arrow does — and clicking *another* row asks the same unsaved-text
              // question before it switches, which is why both go through the guard.
              onSelect={() => requestClose(note.id === noteId ? '/notes' : `/notes/${note.id}`)}
              onRemove={() => void removeNote(note)}
            />
          ))}
          {/* "加载更多" rather than an invisible cap: without it the list simply ended,
              which reads as "the library holds 50 notes". */}
          {canLoadMore && (
            <li>
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={moreState === 'loading'}
                className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-neutral-300 bg-white/60 text-[12px] text-neutral-600 transition-colors hover:bg-white disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900/40 dark:text-neutral-300 dark:hover:bg-neutral-900"
              >
                {moreState === 'loading' ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
                    {t('notes.loading')}
                  </>
                ) : (
                  t('notes.loadMore')
                )}
              </button>
            </li>
          )}
          {moreState === 'end' && more.length > 0 && (
            <li className="py-2 text-center text-[11px] text-neutral-400 dark:text-neutral-500">
              {t('notes.endOfList')}
            </li>
          )}
        </ul>
      </div>

      {/* ── detail column ───────────────────────────────────────────── */}
      {selected && (
        <div className="flex min-w-0 flex-1">
          <NoteDetail
            note={selected}
            language={i18n.language}
            editing={editing}
            onEdit={() => setEditingId(selected.id)}
            onCancelEdit={() => setEditingId(null)}
            dirty={dirty}
            onDraftChange={setDraftPatch}
            onSave={(patch) => persist(patch, null)}
            onSaveAndApprove={selected.status === 'draft' ? persistAndApprove : undefined}
            onApprove={() => {
              // Approving leaves the note where it now lives: switch the view to the
              // library it just joined, or the panel would close under the cursor and
              // the note would look deleted. A refused approval (title already taken)
              // resolves `false` — switching then hid the note the message was about.
              void saveDraft(selected.id).then((ok) => {
                if (!ok) return;
                setEditingId(null);
                setQuery({ status: 'active' });
              });
            }}
            onDiscard={(reason) => {
              // Wait for the answer: a refused reject leaves the draft (and its text) where
              // the reviewer can still see it, so leaving first was the same "worked
              // anyway" mistake as the approval path.
              void removeNote(selected, reason).then((ok) => {
                if (!ok) return;
                setEditingId(null);
                navigate('/notes');
              });
            }}
            onPin={() => void togglePin(selected.id)}
            onArchive={() => void removeNote(selected)}
            onPurge={() => setPurgeOpen(true)}
            // Not `onBack={requestClose}`: this handler receives the click event, and an
            // optional `target` would take it for a route.
            onBack={() => requestClose()}
            onOpenSource={(source) => {
              const sessionId = source.sessionId ?? selected.sessionId ?? null;
              if (!sessionId) return;
              setContextHit({
                kind: 'message',
                // A session-level citation has no single message to focus: the
                // drawer then opens on the end of that conversation, which is
                // where the note was written.
                id: source.kind === 'message' ? source.id : '',
                session_id: sessionId,
                session_title: selected.sessionTitle ?? null,
                // Translated here: the panel prints the channel verbatim, and a
                // raw `qq` next to a Chinese subtitle reads like a debug string.
                channel: selected.channel ? t(CHANNEL_LABEL[selected.channel]) : null,
                title: selected.title,
                snippet: source.excerpt,
              } as SearchResult);
            }}
            onOpenNote={(id) => requestClose(`/notes/${id}`)}
            onOpenTag={(value) => setQuery({ tags: [value] })}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Does the editor's draft say anything the note does not?
 *
 * Field-by-field rather than a JSON diff: `undefined` means "this field was not
 * part of the patch", and tags in a different order are a real change while key
 * order in an object is not.
 */
function differsFromNote(note: Note, draft: Partial<Note>): boolean {
  if (draft.title !== undefined && draft.title !== note.title) return true;
  if (draft.summary !== undefined && draft.summary !== note.summary) return true;
  if (draft.body !== undefined && draft.body !== note.body) return true;
  if (draft.scope !== undefined && draft.scope !== note.scope) return true;
  if (draft.tags) {
    if (draft.tags.length !== note.tags.length) return true;
    if (draft.tags.some((tag, index) => tag !== note.tags[index])) return true;
  }
  // `fields` became editable, so an unsaved slot has to count as dirty — otherwise
  // the editor says "saved", the prompt never appears and the fix is silently lost.
  if (draft.fields) {
    if (draft.fields.length !== note.fields.length) return true;
    if (
      draft.fields.some((field, index) => {
        const current = note.fields[index];
        return (
          field.key !== current.key ||
          field.value !== current.value ||
          !!field.mono !== !!current.mono
        );
      })
    ) {
      return true;
    }
  }
  return false;
}

/**
 * A single-line row that scrolls instead of wrapping.
 *
 * Tags are open-ended (the corpus grows them), so the row cannot be sized ahead
 * of time; wrapping would push the list down by a variable amount on every
 * filter change. The fade is the affordance: a clipped chip with no hint reads
 * as a rendering bug.
 */
/**
 * Delete, with the rejection code it will be recorded under.
 *
 * A menu rather than a dialog: the codes are one glance each and the action is not
 * destructive enough to deserve a confirm step — the note is archived, never
 * dropped. The chosen code is the note's *verdict*; `note_events.detail` keeps it.
 */
function RejectMenu({
  reason,
  onReason,
  children,
}: {
  reason: NoteRejectionCode;
  onReason: (reason: NoteRejectionCode) => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-neutral-600 transition-colors hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        {children}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute bottom-full right-0 z-20 mb-1 w-[168px] rounded-lg border border-neutral-200 bg-white p-1 shadow-xl shadow-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-900"
        >
          <div className="px-2 py-1 text-[10px] text-neutral-400 dark:text-neutral-500">
            {t('notes.rejectHint')}
          </div>
          {NOTE_REJECTION_CODES.map((code) => (
            <button
              key={code}
              type="button"
              role="menuitemradio"
              aria-checked={code === reason}
              onClick={() => {
                onReason(code);
                setOpen(false);
              }}
              className={cn(
                'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800',
                code === reason
                  ? 'font-medium text-neutral-900 dark:text-neutral-100'
                  : 'text-neutral-600 dark:text-neutral-300',
              )}
            >
              <span className="w-3 shrink-0 text-indigo-600 dark:text-indigo-400">
                {code === reason ? '·' : ''}
              </span>
              {t(`notes.reject.${code}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The empty list, with the icon that says *why* it is empty.
 *
 * A bare sentence in a 364px column reads as a failed request; an icon plus one
 * line reads as an answer to the filter the user just set.
 */
function ListEmpty({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <li className="px-4 py-14 text-center">
      <span className="mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-neutral-200/60 text-neutral-400 dark:bg-neutral-800/70 dark:text-neutral-500">
        <Icon className="h-4 w-4" strokeWidth={1.75} />
      </span>
      <p className="mt-2.5 text-[12px] leading-relaxed text-neutral-400 dark:text-neutral-500">
        {text}
      </p>
    </li>
  );
}

/**
 * Placeholder rows instead of the word "loading": the list keeps its height, so the
 * column does not jump when the first page lands.
 */
function ListSkeleton({ label }: { label: string }) {
  return (
    <li role="status" aria-label={label} aria-busy="true" className="px-2">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="animate-pulse rounded-xl px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-300 dark:bg-neutral-700" />
            <span
              className="h-2.5 rounded bg-neutral-200 dark:bg-neutral-800"
              style={{ width: `${56 - index * 7}%` }}
            />
          </div>
          <div className="mt-2 h-2 w-4/5 rounded bg-neutral-100 dark:bg-neutral-800/60" />
        </div>
      ))}
    </li>
  );
}

/**
 * One row, as a card with two columns: the note itself, and a right rail holding the
 * time and the row's one action.
 *
 * Structure A from the review (§5 X1): the card's outline lives on the `<li>` and the two
 * buttons are siblings inside it. The old row was a single `<button>`, so a delete control
 * inside it would have been a `<button>` inside a `<button>` — illegal HTML that the
 * browser silently restructures, which is where "clicked delete, opened the note instead"
 * comes from. Siblings need no `stopPropagation`.
 *
 * The rail is why the alignment is not done with absolute offsets: a relative time is
 * `3 天前` in one language and `3 days ago` in the other, so pinning an x-coordinate can
 * only align the right *edge*. Two stacked children in one `flex-col` share a centre line
 * by construction.
 */
function NoteRow({
  note,
  language,
  active,
  banded,
  onSelect,
  onRemove,
}: {
  note: Note;
  language: string;
  active: boolean;
  /** Second row of a pair — see the banding comment at the call site. */
  banded: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('common');
  /**
   * One verb per status, and the icon says which one.
   *
   * `DELETE /api/notes/:id` archives — the text is kept and `restore` brings it back — so
   * an active row says 归档 and wears the archive box, not a bin. A draft's reject is the
   * only one that reads as "gone" (it will not come back as a draft), so it is the only
   * row that gets the bin.
   */
  const action =
    note.status === 'archived'
      ? { icon: RotateCcw, label: t('notes.restore') }
      : note.status === 'draft'
        ? { icon: Trash2, label: t('notes.discard') }
        : { icon: Archive, label: t('notes.archive') };
  const ActionIcon = action.icon;

  return (
    <li
      className={cn(
        // One card style for every row, open or not: the height of a row varies with
        // its summary, so an outline per row is what gives the column a grid. What
        // marks the open note is the rail below, not a recoloured edge — a card whose
        // border changes colour on click reads as a state of the *control*, while the
        // rail reads as "this is the note in the pane on the right".
        //
        // The hover tint moved here with the outline: it used to live on the row button,
        // which now covers only the left column — hovering the delete button would have
        // highlighted half a card.
        'group relative rounded-xl border border-neutral-200/80 transition-colors',
        // One band for the whole list: a draft and an approved note are the same
        // *row*, so they stripe the same — the badge and the hollow dot already say
        // which is which, and a second colour system would fight the first.
        banded
          ? 'bg-neutral-200/55 hover:bg-neutral-200/75 dark:bg-neutral-700/60 dark:hover:bg-neutral-700/80'
          : 'bg-white hover:bg-neutral-50 dark:bg-neutral-900/40 dark:hover:bg-neutral-800/60',
        // `dark:border-neutral-700` is this app's dark-mode *border* tone (the inputs
        // and cards use it); neutral-800 sat at the same value as the surface below,
        // which made the card edges almost invisible on #0d1117.
        'hover:border-neutral-300 dark:border-neutral-700/80 dark:hover:border-neutral-600',
      )}
    >
      {/* Inset far enough (3px) to clear the card's own border, so it is an accent
          inside the card rather than a second edge on top of the first. */}
      {active && (
        <span
          aria-hidden
          className="absolute inset-y-2.5 left-[3px] w-[2px] rounded-full bg-indigo-500 dark:bg-indigo-400"
        />
      )}
      <div className="flex items-stretch">
        <button
          type="button"
          data-note-open
          onClick={onSelect}
          // The open row is a toggle; the tooltip says so without adding a control
          // to the list.
          title={active ? t('notes.closeHint') : undefined}
          // `min-w-0 flex-1`: the title truncates against the rail instead of pushing
          // it out of the card on a 364px column.
          className="min-w-0 flex-1 rounded-xl px-3 py-2.5 text-left"
        >
          {/* `min-w-0` on the row and on the title: a flex item's automatic minimum
              size is its content, so a long title would widen the card rather than
              ellipsise. */}
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                'min-w-0 truncate text-[13px] font-medium leading-snug',
                active
                  ? 'text-neutral-900 dark:text-neutral-50'
                  : 'text-neutral-800 dark:text-neutral-100',
              )}
            >
              {note.title}
            </span>
            {note.pinned && (
              <Pin
                className="h-3 w-3 shrink-0 text-amber-500/75"
                strokeWidth={2}
                aria-label={t('notes.pinned')}
              />
            )}
            {note.status === 'archived' && (
              <Archive className="h-3 w-3 shrink-0 text-neutral-400" strokeWidth={2} />
            )}
            {note.status === 'draft' && <DraftBadge />}
          </div>
          {note.summary && (
            <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-neutral-500 dark:text-neutral-400">
              {note.summary}
            </p>
          )}
          <div className="mt-1 flex items-center gap-1 overflow-hidden">
            <span className="shrink-0 rounded bg-neutral-200/60 px-1 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800/70 dark:text-neutral-400">
              {t(`notes.facet.origin.${note.origin}`)}
            </span>
            {/* Only the scopes that are *not* the default: a 364px column where every
                row ends in 个人知识 says nothing, and the row that reads 本聊天 is the
                one that would otherwise be invisible in a personal library (X6). */}
            {note.scope !== 'user' && <ScopeChip scope={note.scope} className="text-[10px]" />}
            {note.channel && (
              <span className="shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500">
                · {t(CHANNEL_LABEL[note.channel])}
              </span>
            )}
            {note.projectName && (
              <span className="shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500">
                · {note.projectName}
              </span>
            )}
            {note.tags.slice(0, 2).map((item) => (
              <span
                key={item}
                className="shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500"
              >
                #{item}
              </span>
            ))}
          </div>
        </button>

        {/* The right rail: time at the top corner, action at the bottom corner, one
            centre line for both. `whitespace-nowrap` keeps a longer English label on
            one line — a wrapped label would widen the rail and push the action off its
            axis. */}
        <div className="flex shrink-0 flex-col items-center justify-between gap-1 py-2.5 pl-1 pr-3">
          <span className="whitespace-nowrap text-[10px] tabular-nums text-neutral-400 dark:text-neutral-500">
            {relativeTime(note.updatedAt, language)}
          </span>
          <button
            type="button"
            onClick={onRemove}
            aria-label={action.label}
            title={action.label}
            // 24px is the floor for a thumb (the detail's header icons are 28px; a row
            // is denser). Always visible, never `opacity-0` + `group-hover`: on a phone
            // there is no hover, so a hover-revealed delete simply does not exist. The
            // quiet grey ink is what keeps it out of the way while scanning.
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-200/70 hover:text-neutral-700 dark:text-neutral-500 dark:hover:bg-neutral-700/60 dark:hover:text-neutral-100"
          >
            <ActionIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </li>
  );
}

function NoteDetail({
  note,
  language,
  editing,
  dirty,
  onDraftChange,
  onEdit,
  onCancelEdit,
  onSave,
  onSaveAndApprove,
  onApprove,
  onDiscard,
  onBack,
  onPin,
  onArchive,
  onPurge,
  onOpenNote,
  onOpenSource,
  onOpenTag,
}: {
  note: Note;
  language: string;
  editing: boolean;
  /** Whether the editor's current text differs from the note; owned by the page. */
  dirty: boolean;
  onDraftChange: (patch: Partial<Note>) => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (patch: Partial<Note>) => void;
  /** Present only for a draft: "save this text and publish it in one step". */
  onSaveAndApprove?: (patch: Partial<Note>) => void;
  onApprove: () => void;
  /** `reason` is the reviewer's verdict; the floating card always sends `other`. */
  onDiscard: (reason: NoteRejectionCode) => void;
  /** Asks the page to leave, which is where the unsaved-changes prompt lives. */
  onBack: () => void;
  onPin: () => void;
  onArchive: () => void;
  /**
   * Opens the purge dialog; present only where the button belongs.
   *
   * Archived rows get it — the server refuses anything else, and a control that can
   * only answer "not archived" teaches the wrong thing about what it does.
   */
  onPurge: () => void;
  onOpenNote: (id: string) => void;
  /** Show a citation in its conversation (bottom sheet, §4.7). */
  onOpenSource: (source: NoteSource) => void;
  onOpenTag: (tag: string) => void;
}) {
  const { t } = useTranslation('common');
  // Which code the delete menu will record. One `other` by default, because most
  // deletions are "not worth keeping" and asking is a nudge, not a gate.
  const [rejectReason, setRejectReason] = useState<NoteRejectionCode>('other');

  const statusLabel =
    editing && dirty
      ? t('notes.status.unsaved')
      : note.status === 'draft'
        ? t('notes.status.draft')
        : note.status === 'archived'
          ? t('notes.status.archived')
          : t('notes.status.active');

  return (
    <div className="flex min-h-0 w-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-neutral-200/80 px-3 dark:border-neutral-800">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('notes.back')}
          title={t('notes.back')}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        {/* The status is a badge only where it is a state worth naming: a draft is
            unpublished and needs a decision, an unsaved edit is transient. Both keep
            amber out of the draft signal — it belongs to "you have unsaved text". */}
        {editing && dirty ? (
          <span className="inline-flex items-center gap-1 truncate text-[11px] font-medium text-amber-600 dark:text-amber-400/90">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500/80" />
            {statusLabel}
          </span>
        ) : note.status === 'draft' ? (
          <DraftBadge className="px-1.5 py-0.5 text-[10px]" />
        ) : (
          <span className="truncate text-[11px] text-neutral-400 dark:text-neutral-500">
            {statusLabel}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {note.status === 'draft' ? null : (
            <>
              <IconAction
                label={note.pinned ? t('notes.unpin') : t('notes.pin')}
                onClick={onPin}
                active={note.pinned}
              >
                {note.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
              </IconAction>
              <IconAction label={t('notes.edit')} onClick={onEdit} disabled={editing}>
                <Pencil className="h-3.5 w-3.5" />
              </IconAction>
              <IconAction
                label={note.status === 'archived' ? t('notes.restore') : t('notes.archive')}
                onClick={onArchive}
              >
                {/* Archive, not Trash2: the endpoint archives. A bin on a button that keeps
                    the note is the kind of icon that teaches the wrong thing. */}
                {note.status === 'archived' ? (
                  <RotateCcw className="h-3.5 w-3.5" />
                ) : (
                  <Archive className="h-3.5 w-3.5" />
                )}
              </IconAction>
              {/* Only on an archived note, and only here: the archived *rows* in the
                  list keep their single 恢复 button. Purging is the one verb in this page
                  that cannot be undone, so it is behind a visit to the detail and a
                  typed title rather than one click away from a list being scanned.
                  Disabled while editing: the text on screen would have nowhere to go,
                  and the deleted note is exactly the one holding the unsaved edit. */}
              {note.status === 'archived' && (
                <IconAction label={t('notes.purge')} onClick={onPurge} disabled={editing} danger>
                  <Trash2 className="h-3.5 w-3.5" />
                </IconAction>
              )}
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            'mx-auto w-full max-w-[46rem] px-5 pt-5 sm:px-7 sm:pt-7',
            // The editor ends on a sticky action bar, so it must not also reserve
            // the reading view's bottom breathing room: that would leave a dead gap
            // under the bar at the end of the scroll.
            editing ? 'pb-0' : 'pb-16',
          )}
        >
          {editing ? (
            <NoteEditor
              note={note}
              onSave={onSave}
              onSaveAndApprove={onSaveAndApprove}
              onCancel={onCancelEdit}
              onDraftChange={onDraftChange}
            />
          ) : (
            <>
              <h2 className="text-[19px] font-semibold leading-[1.35] tracking-[-0.01em] text-neutral-900 dark:text-neutral-50">
                {note.title}
              </h2>
              {/* Facets only: the aspect a note carries is a tag (`#pitfall`), not a
                  category chip — the tag row and search both consume it. */}
              <div className="mt-2.5 flex flex-wrap items-center gap-1">
                <FacetRow note={note} />
              </div>

              {/* A draft is a decision waiting to happen, so its three verbs are
                  spelled out instead of hidden behind icons: approve, edit,
                  delete. Only a draft has this row — an active note has already
                  been decided. */}
              {note.status === 'draft' && (
                // Stacked and centred on narrow screens: a sentence and three
                // buttons cannot share 320px, and `ml-auto` on a wrapped line
                // pushed the buttons to the right while the text stayed left —
                // which read as a broken layout rather than a wrapped one.
                //
                // A left rule on a barely-there surface, not a tinted box: a full
                // amber frame made the commonest thing in this panel (an unpublished
                // note) look like an error state, and in dark mode it was the
                // loudest object on the page.
                <div className="mt-3.5 flex flex-col items-center gap-2 rounded-r-lg border-l-2 border-neutral-300 bg-neutral-50/80 py-2 pl-3 pr-2.5 text-center sm:flex-row sm:text-left dark:border-neutral-600 dark:bg-neutral-900/60">
                  <span className="text-[11.5px] leading-relaxed text-neutral-500 dark:text-neutral-400">
                    {t('notes.draftHint')}
                  </span>
                  <div className="flex flex-wrap items-center justify-center gap-1.5 sm:ml-auto sm:justify-end">
                    {/* The one verb this panel exists for, so it is the one filled
                        control in the app's vocabulary (`bg-neutral-900` text-white,
                        inverting in dark) rather than another white outlined button
                        that reads as a peer of 编辑 and 删除. */}
                    <button
                      type="button"
                      onClick={onApprove}
                      className="inline-flex h-7 items-center gap-1 rounded-md bg-neutral-900 px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
                    >
                      <Check className="h-3.5 w-3.5" />
                      {t('notes.approve')}
                    </button>
                    <Button size="sm" variant="secondary" className="h-7" onClick={onEdit}>
                      <Pencil className="h-3.5 w-3.5" />
                      {t('notes.edit')}
                    </Button>
                    {/* Deleting asks why, and only here. The floating card's delete is
                        one click (`other`): mid-conversation the user's intent is to get
                        the card off the screen, and a dialog there would cost more than
                        the tally is worth. This row is a deliberate visit to review, so
                        the code recorded here is a verdict — which is what makes
                        "nine of fifty were duplicates" mean something. */}
                    <RejectMenu
                      reason={rejectReason}
                      onReason={(code) => {
                        setRejectReason(code);
                        onDiscard(code);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {t('notes.discard')}
                    </RejectMenu>
                  </div>
                </div>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-neutral-400 dark:text-neutral-500">
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" strokeWidth={1.75} />
                  {relativeTime(note.updatedAt, language)}
                </span>
                {/* `view_count` used to be printed here as "查看 N 次". It counts every
                    open, drafts included, on a library with one reader — a number that
                    answered no question anyone asks (X9). */}
                {note.sources.length > 0 && (
                  <span className="inline-flex items-center gap-1">
                    <Link2 className="h-3 w-3" strokeWidth={1.75} />
                    {t('notes.sourceCount', { count: note.sources.length })}
                  </span>
                )}
              </div>

              {note.summary && (
                <p className="mt-4 border-l-2 border-neutral-300 pl-3.5 text-[13px] leading-[1.75] text-neutral-600 dark:border-neutral-700 dark:text-neutral-300">
                  {note.summary}
                </p>
              )}

              {note.fields.length > 0 && (
                // Rows in one card, not a stack of separate boxes: these slots
                // belong to the same note, and a divider draws them as one block of
                // facts, which is what they are.
                <dl className="mt-4 divide-y divide-neutral-200/70 overflow-hidden rounded-xl border border-neutral-200/80 bg-neutral-50/50 dark:divide-neutral-800 dark:border-neutral-800 dark:bg-neutral-900/40">
                  {note.fields.map((field) => (
                    <div
                      key={field.key}
                      className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:gap-3"
                    >
                      <dt className="w-16 shrink-0 pt-0.5 text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
                        {t(`notes.field.${field.key}`, { defaultValue: field.key })}
                      </dt>
                      <dd className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-neutral-700 dark:text-neutral-200">
                        {field.mono ? (
                          <CopyableValue value={field.value} />
                        ) : (
                          <span className="whitespace-pre-line">{field.value}</span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}

              <div className="mt-5">
                <NoteBody body={note.body} />
              </div>

              {note.tags.length > 0 && (
                <div className="mt-5 flex flex-wrap items-center gap-1">
                  {note.tags.map((item) => (
                    <TagChip key={item} tag={item} onClick={() => onOpenTag(item)} />
                  ))}
                </div>
              )}

              {/* ── trace back to the conversation (plan §4.7) ── */}
              <section className="mt-7 border-t border-neutral-200/80 pt-4 dark:border-neutral-800">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-neutral-400 dark:text-neutral-500">
                  {t('notes.traceTitle')}
                </h3>
                <p className="mt-1.5 text-[12px] leading-relaxed text-neutral-600 dark:text-neutral-300">
                  {t('notes.traceFrom', {
                    where: sessionLabel(note, t) || t('notes.traceUnknown'),
                  })}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {note.sources.length === 0 ? (
                    <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
                      {t('notes.traceNone')}
                    </span>
                  ) : (
                    note.sources.map((source) => (
                      <SourceChip key={source.id} source={source} onOpen={onOpenSource} />
                    ))
                  )}
                </div>
              </section>

              {note.related.length > 0 && (
                <section className="mt-7">
                  <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-neutral-400 dark:text-neutral-500">
                    {t('notes.relatedTitle')}
                  </h3>
                  <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                    {note.related.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => onOpenNote(item.id)}
                        className="flex items-start gap-2 rounded-xl border border-neutral-200/80 px-3 py-2 text-left transition-colors hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:border-neutral-700 dark:hover:bg-neutral-900"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[12px] text-neutral-700 dark:text-neutral-200">
                            {item.title}
                          </span>
                          <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                            {/* Why, not just that: a bare 「相关」 list is the part
                                people stop trusting. One word is enough. */}
                            {t(`notes.related.${item.basis}`)}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function IconAction({
  children,
  label,
  onClick,
  active,
  disabled,
  danger,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  /** Red ink, for the one verb that does not come back. */
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-40',
        // `danger` first: a red action never borrows the amber "this is pinned" state,
        // and two tints on one button would say nothing about which it is.
        danger
          ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10'
          : active
            ? 'text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-500/10'
            : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Confirm-and-purge, the dialog behind the one irreversible verb in the notes page.
 *
 * The rest of the page deletes by archiving and offers a three-second 撤销; that undo is
 * genuinely absent here — the row, its citations, its relations and its review records are
 * erased together — so the friction takes its place: the title has to be typed back. The
 * client check is deliberately shallow (`title.trim()` against `note.title.trim()`): only
 * the obvious mismatch is caught, because the server compares normalised titles and is the
 * authority. Catching the obvious case is still this side's job — a disabled button with
 * 请重新输入这条笔记的标题 under it is an answer, while a 422 after a click that looked
 * like it worked is not.
 */
function PurgeDialog({
  note,
  onPurge,
  onClose,
  onDone,
}: {
  note: Note;
  onPurge: (id: string, title: string) => Promise<PurgeOutcome>;
  onClose: () => void;
  /** The row is gone for good (`purged`) or was already (`gone`). */
  onDone: (outcome: 'purged' | 'gone') => void;
}) {
  const { t } = useTranslation('common');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * What the server said about the last attempt.
   *
   * Kept apart from the live check below: that one is a fact about the text box, this
   * one is a fact about the row, and they need different sentences. `mismatch` appears
   * here only when the server's normalisation disagrees with this side's — the only
   * way a click with a "matching" title is refused.
   */
  const [refusal, setRefusal] = useState<'not_archived' | 'mismatch' | 'failed' | null>(null);

  // The server repeats this comparison through `normalizeTitle` (`src/notes/canonical.ts`),
  // and this side has to agree with it or the guard becomes stricter than the rule:
  // `termux换源` re-typed for a note titled `Termux 换源` is the same subject by the
  // library's only definition, and blocking it here would be testing memory for
  // punctuation. `titleKey` below is that function's browser twin.
  const matches = titleKey(typed) === titleKey(note.title);
  /**
   * A restored note cannot be purged, so retyping cannot fix a 409: the button stays
   * disabled until the dialog is reopened on the row's real status — which the refetch
   * `purgeNote` runs has already put on the list behind it.
   */
  const blocked = refusal === 'not_archived';

  const submit = async () => {
    if (busy || blocked || !matches) return;
    setBusy(true);
    setRefusal(null);
    const outcome = await onPurge(note.id, typed.trim());
    setBusy(false);
    if (outcome === 'ok') {
      onDone('purged');
      return;
    }
    if (outcome === 'not_found') {
      // Already erased elsewhere: 彻底删除失败 would invite a retry that cannot work,
      // and leaving the dialog open would ask for the title of a note that is not there.
      onDone('gone');
      return;
    }
    setRefusal(
      outcome === 'not_archived'
        ? 'not_archived'
        : outcome === 'title_mismatch'
          ? 'mismatch'
          : 'failed',
    );
  };

  /**
   * One line under the input. A fact about the row wins over a fact about the text box:
   * when the note is not archived any more, telling the user to retype its title would
   * point at the wrong fix — the box cannot make the 409 go away.
   */
  const hint =
    refusal === 'not_archived'
      ? t('notes.purgeNotArchived')
      : refusal === 'failed'
        ? t('notes.purgeFailed')
        : !matches || refusal === 'mismatch'
          ? t('notes.purgeMismatch')
          : null;

  return (
    <Modal
      open
      onClose={() => {
        // A request in flight owns the outcome: closing now would drop the toast and
        // the navigation while the row is already being erased.
        if (!busy) onClose();
      }}
      title={t('notes.purgeTitle')}
      size="sm"
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t('notes.cancel')}
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={!matches || blocked}
            onClick={() => void submit()}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('notes.purgeConfirm')}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-neutral-700 dark:text-neutral-300">
        {t('notes.purgeBody')}
      </p>
      <label
        htmlFor="notes-purge-title"
        className="mt-3 block text-[11.5px] font-medium text-neutral-500 dark:text-neutral-400"
      >
        {t('notes.purgePlaceholder')}
      </label>
      <input
        id="notes-purge-title"
        value={typed}
        onChange={(event) => {
          setTyped(event.target.value);
          // The sentence was about the text that was sent, and editing it is the fix,
          // so it goes. `not_archived` is the exception: no retyping makes an active
          // note archived again.
          setRefusal((current) => (current === 'not_archived' ? current : null));
        }}
        onKeyDown={(event) => {
          // Enter is the same request as the button, guards included: the keyboard must
          // not be able to do what the button refuses.
          if (event.key === 'Enter') void submit();
        }}
        // The note's own title, so the two can be read against each other instead of
        // recalled; the server compares the text, so nothing here fills it in.
        placeholder={note.title}
        aria-label={t('notes.purgePlaceholder')}
        autoFocus
        // 36px: the height of every other control a thumb aims at on this page, and
        // `text-[13px]` keeps the browser from zooming the page on focus on iOS.
        className="mt-1 h-9 w-full rounded-lg border border-neutral-300 bg-white px-2.5 text-[13px] text-neutral-800 placeholder:text-neutral-400 focus:border-red-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:placeholder:text-neutral-500"
      />
      {hint && (
        <p
          className={cn(
            'mt-1.5 text-[11.5px] leading-relaxed',
            // An untouched box is guidance, not an error: in red it would read as a
            // mistake the user has already made the moment the dialog opens. Anything
            // the server refused is red.
            refusal === null && !matches
              ? 'text-neutral-500 dark:text-neutral-400'
              : 'text-red-600 dark:text-red-400',
          )}
        >
          {hint}
        </p>
      )}
    </Modal>
  );
}

/**
 * Editor. Deliberately plain: title, summary, tags, scope, body. Facets
 * (author, channel) are absent because they are facts, not settings (§4.6).
 *
 * It has no back button of its own: leaving is the header's job (the arrow sits
 * left of the status, the same place it has on mobile), because leaving while
 * dirty has to ask about saving and that conversation belongs to the panel, not
 * to one of its children. What the editor owes the panel is its current fields —
 * reported through `onDraftChange` — so the header can tell "unsaved" from
 * "already saved" without reaching into this state.
 */
/** The first line with content, used as a title when none was typed. */
/**
 * The first line of a body, as a title someone would have written.
 *
 * The editor's own derived title: a note saved with an empty title field gets one
 * from its first meaningful line, so "save without naming it" produces a row with
 * a name instead of a blank. Its server-side twin is `firstMeaningfulLine` in
 * `src/notes/text.ts` — deliberately not imported, because the WebUI bundle does
 * not (and should not) pull the notes server into the browser. Two runtimes, one
 * rule: if the notion of "meaningful line" changes, change both (the capture path
 * and this one must agree, or a note's title depends on which client wrote it).
 */
function firstLineOf(text: string): string {
  const line = text
    .split('\n')
    .map((item) => item.replace(/^[#>\-*\s]+/, '').trim())
    .find((item) => item.length > 0);
  return (line ?? '').slice(0, 60);
}

/**
 * The comparison key a title is checked under, mirroring `normalizeTitle` in
 * `src/notes/canonical.ts`.
 *
 * Not imported for the same reason as `firstLineOf`: the WebUI bundle does not pull
 * the notes server into the browser. Kept deliberately small and identical in effect
 * (NFKC, lower case, whitespace/`-`/`_`/`·` folded, punctuation dropped) because a
 * client that is stricter than the server turns a correct answer into "does not
 * match".
 */
function titleKey(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_·・]+/g, '')
    .replace(/[!"#$%&'()*+,:;<=>?@[\\\]^`{|}~，。、；：？！“”‘’（）《》【】…—]/g, '');
}

function NoteEditor({
  note,
  onSave,
  onSaveAndApprove,
  onCancel,
  onDraftChange,
}: {
  note: Note;
  onSave: (patch: Partial<Note>) => void;
  /** A draft can be edited *and* published without leaving the editor. */
  onSaveAndApprove?: (patch: Partial<Note>) => void;
  onCancel: () => void;
  onDraftChange: (patch: Partial<Note>) => void;
}) {
  const { t } = useTranslation('common');
  const [title, setTitle] = useState(note.title);
  const [summary, setSummary] = useState(note.summary);
  const [body, setBody] = useState(note.body);
  const [tags, setTags] = useState(note.tags.join(', '));
  const [scope, setScope] = useState(note.scope);
  /**
   * The structured slots, editable here because they are the part that gets copied.
   *
   * `PUT /api/notes/:id` always accepted `fields`; without inputs, a wrong `command`
   * value meant rewriting the whole body or dropping the note (U2).
   */
  const [fields, setFields] = useState<NoteField[]>(note.fields);

  /**
   * One scope option, not four.
   *
   * `NOTE_SCOPES` offered 项目 / 本聊天 / 仅本会话, but this page has no project, chat or
   * session picker — nothing can supply the `scopeKey` those scopes need, so the server
   * stored `scope_key = ''` and the note became unreachable from every facet and filter
   * (P4). A menu whose three other items cannot work is a fake choice; when a selector
   * exists for them, it comes back with the key it needs.
   * A note that is already `project`/`channel`/`session` keeps its value on the trigger
   * and can be moved *into* the library, which is the one direction this page can
   * honestly offer.
   */
  const scopeOptions = useMemo(() => {
    const options = [{ value: 'user', label: t('notes.scope.user') }];
    if (scope !== 'user') options.unshift({ value: scope, label: t(`notes.scope.${scope}`) });
    return options;
  }, [scope, t]);

  /**
   * The normalised patch, shared by the save button and the header's prompt.
   *
   * No "untitled" fallback: a title derived from the body's first line reads like
   * something the user wrote, and inventing one is how a library fills with notes
   * called 未命名笔记 that nobody can tell apart.
   */
  const patch = useMemo<Partial<Note>>(
    () => ({
      title: title.trim() || firstLineOf(body),
      summary: summary.trim(),
      body,
      scope,
      // Sent together with the scope it belongs to: `scope` alone makes the server
      // write `scope_key = ''` and strand the note (P4), and sending a stale key for
      // `user` would do the same. Changing the scope is what clears the key.
      scopeKey: scope === note.scope ? note.scopeKey : '',
      // A row with no name is what "add field" leaves behind before it is filled in, so
      // it is dropped; a row *with* a name keeps its value even when empty, because the
      // server stores such a slot and dropping it here would make the editor report the
      // note as unsaved the moment it opened.
      fields: fields
        .map((field) => ({ key: field.key.trim(), value: field.value, mono: !!field.mono }))
        .filter((field) => field.key.length > 0),
      tags: tags
        .split(/[,，\s]+/)
        .map((item) => item.replace(/^#/, '').trim())
        .filter(Boolean)
        .slice(0, 6),
    }),
    [body, fields, note.scope, note.scopeKey, scope, summary, tags, title],
  );

  useEffect(() => {
    onDraftChange(patch);
  }, [onDraftChange, patch]);

  /**
   * Ctrl/Cmd+S saves.
   *
   * `MarkdownEditor` already owns Ctrl+Z/B/I/K inside the textarea, so the save
   * shortcut has to be caught at this level — otherwise the browser's own "save page"
   * dialog is the reward for pressing the key everyone presses.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      if (!patch.title && !body.trim()) return;
      onSave(patch);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [body, onSave, patch]);

  return (
    <div className="space-y-3">
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder={t('notes.editor.titlePlaceholder')}
        className="w-full border-0 border-b border-neutral-200 bg-transparent px-0 pb-2 text-[19px] font-semibold leading-snug tracking-[-0.01em] text-neutral-900 placeholder:font-normal placeholder:text-neutral-300 focus:border-neutral-400 focus:outline-none dark:border-neutral-800 dark:text-neutral-50 dark:placeholder:text-neutral-600"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select
          compact
          value={scope}
          onChange={(event) => setScope(event.target.value as Note['scope'])}
          options={scopeOptions}
        />
        <input
          value={tags}
          onChange={(event) => setTags(event.target.value)}
          placeholder={t('notes.editor.tagsPlaceholder')}
          className="h-8 min-w-[160px] flex-1 rounded-lg border border-neutral-300 bg-white px-2 text-[12px] text-neutral-800 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
        />
      </div>
      <input
        value={summary}
        onChange={(event) => setSummary(event.target.value)}
        placeholder={t('notes.editor.summaryPlaceholder')}
        className="w-full rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-[12.5px] text-neutral-800 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
      />
      {/* Structured slots, one row each: name, value, and whether it is meant to be
          copied. Rows are added and removed freely — a card full of empty inputs when
          the note has no slots would claim the structure is mandatory. */}
      <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
        <div className="flex items-center justify-between gap-2 border-b border-neutral-200/80 bg-neutral-50/60 px-2 py-1 dark:border-neutral-800 dark:bg-neutral-900/40">
          <span className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400">
            {t('notes.editor.fieldsTitle')}
          </span>
          <button
            type="button"
            onClick={() =>
              setFields((current) => [...current, { key: '', value: '', mono: false }])
            }
            className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-neutral-500 transition-colors hover:bg-neutral-200/70 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <Plus className="h-3 w-3" strokeWidth={2} />
            {t('notes.editor.addField')}
          </button>
        </div>
        {fields.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] text-neutral-400 dark:text-neutral-500">
            {t('notes.editor.fieldsEmpty')}
          </p>
        ) : (
          <ul className="divide-y divide-neutral-200/70 dark:divide-neutral-800">
            {fields.map((field, index) => (
              // Index as key: the rows are positional inputs with no identity of their
              // own, and a generated id would have to be stored to survive a reorder.
              <li key={index} className="flex items-center gap-1 px-1.5 py-1">
                <input
                  value={field.key}
                  onChange={(event) =>
                    setFields((current) =>
                      current.map((item, i) =>
                        i === index ? { ...item, key: event.target.value } : item,
                      ),
                    )
                  }
                  placeholder={t('notes.editor.fieldKey')}
                  aria-label={t('notes.editor.fieldKey')}
                  className="h-7 w-[76px] shrink-0 rounded border border-neutral-300 bg-white px-1.5 text-[11.5px] text-neutral-800 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
                />
                <input
                  value={field.value}
                  onChange={(event) =>
                    setFields((current) =>
                      current.map((item, i) =>
                        i === index ? { ...item, value: event.target.value } : item,
                      ),
                    )
                  }
                  placeholder={t('notes.editor.fieldValue')}
                  aria-label={t('notes.editor.fieldValue')}
                  className="h-7 min-w-0 flex-1 rounded border border-neutral-300 bg-white px-1.5 font-mono text-[11.5px] text-neutral-800 placeholder:font-sans placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
                />
                <label
                  className="inline-flex shrink-0 items-center gap-1 text-[10px] text-neutral-500 dark:text-neutral-400"
                  title={t('notes.editor.fieldMonoHint')}
                >
                  <input
                    type="checkbox"
                    checked={!!field.mono}
                    onChange={(event) =>
                      setFields((current) =>
                        current.map((item, i) =>
                          i === index ? { ...item, mono: event.target.checked } : item,
                        ),
                      )
                    }
                    className="h-3.5 w-3.5 rounded border-neutral-300 dark:border-neutral-600"
                  />
                  {t('notes.editor.fieldMono')}
                </label>
                <button
                  type="button"
                  onClick={() => setFields((current) => current.filter((_, i) => i !== index))}
                  aria-label={t('notes.editor.removeField')}
                  title={t('notes.editor.removeField')}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-200/70 hover:text-neutral-700 dark:hover:bg-neutral-700/60 dark:hover:text-neutral-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <MarkdownEditor
        value={body}
        onChange={setBody}
        placeholder={t('notes.editor.bodyPlaceholder')}
        ariaLabel={t('notes.editor.bodyPlaceholder')}
      />
      {/* Sticky, not trailing: a note body can be long, and 保存 scrolling out of
          reach is how an edit gets abandoned half-written. The bar borrows the
          content column's padding back with negative margins so it spans the full
          width while the fields above stay inset. */}
      <div className="sticky bottom-0 z-10 -mx-5 flex items-center gap-2 border-t border-neutral-200/80 bg-white/90 px-5 py-2.5 backdrop-blur sm:-mx-7 sm:px-7 dark:border-neutral-800 dark:bg-neutral-950/90">
        {/* Disabled rather than hidden: a grey button explains itself, a missing one
            makes the user wonder what they broke. */}
        <button
          type="button"
          onClick={() => onSave(patch)}
          disabled={!patch.title && !body.trim()}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-neutral-900 px-3 text-[12px] font-medium text-white transition-colors hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
        >
          {t('notes.save')}
        </button>
        {onSaveAndApprove && (
          // Saving alone leaves a draft; this is the verb that finishes the job,
          // so it sits next to 保存 rather than behind the panel's 批准.
          <button
            type="button"
            onClick={() => onSaveAndApprove(patch)}
            disabled={!patch.title && !body.trim()}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-neutral-300 bg-white px-3 text-[12px] font-medium text-neutral-700 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
          >
            {t('notes.editor.saveAndApprove')}
          </button>
        )}
        <Button size="sm" variant="ghost" className="h-8" onClick={onCancel}>
          {t('notes.cancel')}
        </Button>
      </div>
    </div>
  );
}
