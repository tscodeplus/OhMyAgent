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
  Inbox,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import Button from '../ui/Button';
import Modal from '../ui/Modal';
import Select from '../ui/Select';
import { useNotes } from './NotesContext';
import {
  CHANNEL_LABEL,
  CopyableValue,
  FacetRow,
  KIND_META,
  NoteBody,
  relativeTime,
  SourceChip,
  TagChip,
  sessionLabel,
} from './NoteBits';
import MarkdownEditor from './MarkdownEditor';
import SearchContextPanel from '../search/SearchContextPanel';
import type { SearchResult } from '../../types/search';
import {
  NOTE_KINDS,
  NOTE_SCOPES,
  type Note,
  type NoteKind,
  type NoteSource,
  type NoteStatus,
} from './types';

/** Breathing room between the citation sheet and the column it belongs to. */
const DRAWER_INSET_PX = 6;

export default function NotesView() {
  const { t, i18n } = useTranslation('common');
  const navigate = useNavigate();
  const { noteId } = useParams<{ noteId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    notes: rows,
    drafts,
    counts,
    tags: tagFacets,
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
    markViewed,
    fetchNote,
  } = useNotes();

  /**
   * Drafts are notes that have not been approved yet, so they live in the same
   * list and the same detail view — the server returns whichever status the query
   * asks for, and `rows` is already that list. Keeping drafts in a separate drawer
   * was the reason approving one happened on a different screen from editing it.
   */
  const allNotes = rows;

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
  const setSearchText = (value: string) => setQuery({ q: value });
  const origin = query.origin ?? 'all';
  const setOrigin = (value: 'all' | 'user' | 'agent') => setQuery({ origin: value });
  const channel = query.channel ?? 'all';
  const setChannel = (value: string) => setQuery({ channel: value === 'all' ? undefined : value });
  const project = query.projectId ?? 'all';
  const setProject = (value: string) =>
    setQuery({ projectId: value === 'all' ? undefined : value });
  const tag = query.tag ?? null;
  const setTag = (value: string | null) => setQuery({ tag: value });
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
      kind: 'other',
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
   * Shaped as a `SearchResult` because the drawer already existed for knowledge
   * search and a second transcript viewer would have drifted from it: same sheet,
   * same focus highlight, same "open full session" footer.
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
   * "new note" case differs between them only in where it goes next.
   */
  const persist = useCallback(
    (patch: Partial<Note>, leave: boolean) => {
      const hasContent = !!(patch.title?.trim() || patch.body?.trim());
      if (isNew) {
        // Leaving a blank editor is not an error; it simply creates nothing.
        if (!hasContent) {
          navigate('/notes', { replace: true });
          return;
        }
        void createNote(patch).then((note) => {
          if (!note) return;
          setDraftPatch(null);
          setEditingId(null);
          // Replace, so the browser's back button does not return to the empty
          // form the note was just created from.
          navigate(leave ? '/notes' : `/notes/${note.id}`, { replace: true });
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
        if (leave) navigate('/notes');
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
        // library, so that is the list the panel switches to.
        void saveDraft(note.id).then(() => setQuery({ status: 'active' }));
      });
    },
    [saveDraft, selected, setQuery, updateNote],
  );

  /** The one way out: header arrow, or clicking the row that is already open. */
  const requestClose = useCallback(() => {
    // Leaving with unsaved changes asks first; leaving a clean note does not.
    if (editing && dirty) {
      setAskSave(true);
      return;
    }
    navigate('/notes');
  }, [dirty, editing, navigate]);

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

  // `?edit=1` is how "新笔记" and "手写笔记" land in the editor; consumed once.
  useEffect(() => {
    if (!noteId || searchParams.get('edit') !== '1') return;
    setEditingId(noteId);
    const next = new URLSearchParams(searchParams);
    next.delete('edit');
    setSearchParams(next, { replace: true });
  }, [noteId, searchParams, setSearchParams]);

  const channels = useMemo(
    () => Array.from(new Set(rows.map((note) => note.channel).filter(Boolean))) as string[],
    [rows],
  );
  /**
   * Project filter options, as (id, name) pairs: the server filters on
   * `scope_key` (the project id) while the row shows the resolved name, and a
   * dropdown keyed by name would send a name the query cannot match.
   */
  const projects = useMemo(() => {
    const byId = new Map<string, string>();
    for (const note of rows) {
      if (note.scope === 'project' && note.scopeKey && note.projectName) {
        byId.set(note.scopeKey, note.projectName);
      }
    }
    return [...byId.entries()].map(([value, label]) => ({ value, label }));
  }, [rows]);
  /**
   * Tag counts come from the server with the list response: the row must show the
   * tags the *filter* can act on, which is a SQL `GROUP BY`, not a scan of whatever
   * page happens to be loaded.
   */
  const tags = useMemo(() => tagFacets.map((facet) => facet.tag), [tagFacets]);

  const startNewNote = useCallback(() => navigate('/notes/new'), [navigate]);

  const hasFilters =
    origin !== 'all' || channel !== 'all' || project !== 'all' || !!tag || !!searchText;

  const clearFilters = useCallback(() => {
    setQuery({ origin: 'all', channel: undefined, projectId: undefined, tag: null, q: '' });
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
        onClose={() => setAskSave(false)}
        title={t('notes.unsaved.title')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAskSave(false)}>
              {t('notes.unsaved.cancel')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setAskSave(false);
                navigate('/notes');
              }}
            >
              {t('notes.unsaved.discard')}
            </Button>
            <Button
              onClick={() => {
                setAskSave(false);
                if (draftPatch) persist(draftPatch, true);
                else navigate('/notes');
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
          'w-full min-w-0 flex-col md:flex',
          selected
            ? 'hidden border-r border-neutral-200 dark:border-neutral-800 md:w-[364px] md:shrink-0'
            : 'flex',
        )}
      >
        <div className="shrink-0 px-4 pb-2 pt-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h1 className="flex items-baseline gap-1.5 text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">
                {t('notes.title')}
                <span className="text-[11px] font-normal text-neutral-400">
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
            <div className="flex shrink-0 items-center gap-1">
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
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
              placeholder={t('notes.searchPlaceholder')}
              className="h-8 w-full rounded-md border border-neutral-300 bg-white pl-8 pr-7 text-[12px] text-neutral-800 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
            />
            {searchText && (
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

          <div className="flex gap-1.5">
            <Select
              compact
              className="flex-1"
              value={origin}
              onChange={(event) => setOrigin(event.target.value as typeof origin)}
              options={[
                { value: 'all', label: t('notes.filter.originAll') },
                { value: 'user', label: t('notes.filter.originUser') },
                { value: 'agent', label: t('notes.filter.originAgent') },
              ]}
            />
            <Select
              compact
              className="flex-1"
              value={channel}
              onChange={(event) => setChannel(event.target.value)}
              options={[
                { value: 'all', label: t('notes.filter.channelAll') },
                ...channels.map((value) => ({ value, label: t(`notes.channel.${value}`) })),
              ]}
            />
            <Select
              compact
              className="flex-1"
              value={project}
              onChange={(event) => setProject(event.target.value)}
              options={[
                { value: 'all', label: t('notes.filter.projectAll') },
                ...projects.map((item) => ({ value: item.value, label: item.label })),
              ]}
            />
          </div>

          {(tags.length > 0 || counts.archived > 0) && (
            <FilterRow>
              {tags.slice(0, 8).map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setTag(tag === item ? null : item)}
                  className={cn(
                    'shrink-0 rounded-md px-1.5 py-0.5 text-[11px] transition-colors',
                    tag === item
                      ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                      : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700',
                  )}
                >
                  <span className="opacity-50">#</span>
                  {item}
                </button>
              ))}
              {counts.archived > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setStatusFilter((current) => (current === 'archived' ? 'active' : 'archived'))
                  }
                  className={cn(
                    'ml-auto shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors',
                    statusFilter === 'archived'
                      ? 'border-neutral-300 bg-neutral-100 text-neutral-700 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200'
                      : 'border-transparent text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300',
                  )}
                >
                  {t('notes.archivedToggle', { count: counts.archived })}
                </button>
              )}
            </FilterRow>
          )}

          {hasFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="text-[11px] text-neutral-500 underline-offset-2 hover:underline dark:text-neutral-400"
            >
              {t('notes.clearFilters')}
            </button>
          )}
        </div>

        <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-28">
          {loading && allNotes.length === 0 && (
            <li className="px-3 py-8 text-center text-[12px] text-neutral-400 dark:text-neutral-500">
              {t('notes.loading')}
            </li>
          )}
          {!loading && allNotes.length === 0 && (
            <li className="px-3 py-8 text-center text-[12px] text-neutral-400 dark:text-neutral-500">
              {searchText
                ? t('notes.emptySearch')
                : statusFilter === 'draft'
                  ? t('notes.emptyDrafts')
                  : statusFilter === 'archived'
                    ? t('notes.emptyArchived')
                    : t('notes.empty')}
            </li>
          )}
          {allNotes.map((note) => (
            <li key={note.id}>
              <NoteRow
                note={note}
                language={i18n.language}
                active={note.id === noteId}
                // Clicking the open row closes the detail, the same way its back
                // arrow does — including the unsaved-changes question, which is why
                // this calls `requestClose` and not `navigate`.
                onSelect={() =>
                  note.id === noteId ? requestClose() : navigate(`/notes/${note.id}`)
                }
              />
            </li>
          ))}
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
            onSave={(patch) => persist(patch, false)}
            onSaveAndApprove={selected.status === 'draft' ? persistAndApprove : undefined}
            onApprove={() => {
              // Approving leaves the note where it now lives: switch the view to the
              // library it just joined, or the panel would close under the cursor and
              // the note would look deleted.
              void saveDraft(selected.id).then(() => {
                setEditingId(null);
                setQuery({ status: 'active' });
              });
            }}
            onDiscard={() => {
              void discardDraft(selected.id).then(() => {
                setEditingId(null);
                navigate('/notes');
              });
            }}
            onPin={() => void togglePin(selected.id)}
            onArchive={() =>
              void (selected.status === 'archived'
                ? restoreNote(selected.id)
                : archiveNote(selected.id))
            }
            onBack={requestClose}
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
            onOpenNote={(id) => navigate(`/notes/${id}`)}
            onOpenTag={(value) => setTag(value)}
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
  if (draft.kind !== undefined && draft.kind !== note.kind) return true;
  if (draft.scope !== undefined && draft.scope !== note.scope) return true;
  if (draft.tags) {
    if (draft.tags.length !== note.tags.length) return true;
    if (draft.tags.some((tag, index) => tag !== note.tags[index])) return true;
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
function FilterRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative -mx-1">
      <div className="flex items-center gap-1 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {children}
      </div>
      <div className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-white to-transparent dark:from-neutral-950" />
    </div>
  );
}

function NoteRow({
  note,
  language,
  active,
  onSelect,
}: {
  note: Note;
  language: string;
  active: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation('common');
  const meta = KIND_META[note.kind];
  return (
    <button
      type="button"
      onClick={onSelect}
      // The open row is a toggle; the tooltip says so without adding a control
      // to the list.
      title={active ? t('notes.closeHint') : undefined}
      className={cn(
        'w-full rounded-xl px-2.5 py-2 text-left transition-colors',
        active
          ? 'bg-neutral-100 dark:bg-neutral-800/70'
          : 'hover:bg-neutral-50 dark:hover:bg-neutral-900',
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', meta.dot)} />
        <span className="truncate text-[13px] font-medium text-neutral-800 dark:text-neutral-100">
          {note.title}
        </span>
        {note.pinned && (
          <Pin
            className="h-3 w-3 shrink-0 text-amber-500"
            strokeWidth={2}
            aria-label={t('notes.pinned')}
          />
        )}
        {note.status === 'archived' && (
          <Archive className="h-3 w-3 shrink-0 text-neutral-400" strokeWidth={2} />
        )}
        {note.status === 'draft' && (
          <span className="shrink-0 rounded border border-amber-300/70 bg-amber-50 px-1 text-[9.5px] font-medium text-amber-700 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-300">
            {t('notes.status.draft')}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-neutral-400">
          {relativeTime(note.updatedAt, language)}
        </span>
      </div>
      {note.summary && (
        <p className="mt-0.5 truncate text-[11.5px] leading-relaxed text-neutral-500 dark:text-neutral-400">
          {note.summary}
        </p>
      )}
      <div className="mt-1 flex items-center gap-1 overflow-hidden">
        <span className="shrink-0 rounded bg-neutral-100 px-1 py-0.5 text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
          {t(`notes.facet.origin.${note.origin}`)}
        </span>
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
          <span key={item} className="shrink-0 text-[10px] text-neutral-400 dark:text-neutral-500">
            #{item}
          </span>
        ))}
      </div>
    </button>
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
  onDiscard: () => void;
  /** Asks the page to leave, which is where the unsaved-changes prompt lives. */
  onBack: () => void;
  onPin: () => void;
  onArchive: () => void;
  onOpenNote: (id: string) => void;
  /** Show a citation in its conversation (bottom sheet, §4.7). */
  onOpenSource: (source: NoteSource) => void;
  onOpenTag: (tag: string) => void;
}) {
  const { t } = useTranslation('common');

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
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-200 px-3 dark:border-neutral-800">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('notes.back')}
          title={t('notes.back')}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span
          className={cn(
            'truncate text-[11px]',
            editing && dirty
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-neutral-400 dark:text-neutral-500',
          )}
        >
          {statusLabel}
        </span>
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
                {note.status === 'archived' ? (
                  <RotateCcw className="h-3.5 w-3.5" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
              </IconAction>
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-5 pb-28 pt-4">
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
              <h2 className="text-[17px] font-semibold leading-snug text-neutral-900 dark:text-neutral-100">
                {note.title}
              </h2>
              <FacetRow note={note} className="mt-2" />

              {/* A draft is a decision waiting to happen, so its three verbs are
                  spelled out instead of hidden behind icons: approve, edit,
                  delete. Only a draft has this row — an active note has already
                  been decided. */}
              {note.status === 'draft' && (
                // Stacked and centred on narrow screens: a sentence and three
                // buttons cannot share 320px, and `ml-auto` on a wrapped line
                // pushed the buttons to the right while the text stayed left —
                // which read as a broken layout rather than a wrapped one.
                <div className="mt-3 flex flex-col items-center gap-2 rounded-lg border border-amber-200/80 bg-amber-50/50 px-2.5 py-2 text-center sm:flex-row sm:text-left dark:border-amber-400/20 dark:bg-amber-500/5">
                  <span className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                    {t('notes.draftHint')}
                  </span>
                  <div className="flex flex-wrap items-center justify-center gap-1.5 sm:ml-auto sm:justify-end">
                    <Button size="sm" className="h-7" onClick={onApprove}>
                      <Check className="h-3.5 w-3.5" />
                      {t('notes.approve')}
                    </Button>
                    <Button size="sm" variant="secondary" className="h-7" onClick={onEdit}>
                      <Pencil className="h-3.5 w-3.5" />
                      {t('notes.edit')}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7" onClick={onDiscard}>
                      <Trash2 className="h-3.5 w-3.5" />
                      {t('notes.discard')}
                    </Button>
                  </div>
                </div>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-neutral-400 dark:text-neutral-500">
                <span>{relativeTime(note.updatedAt, language)}</span>
                <span>·</span>
                <span>{t('notes.viewCount', { count: note.viewCount })}</span>
                {note.sources.length > 0 && (
                  <>
                    <span>·</span>
                    <span>{t('notes.sourceCount', { count: note.sources.length })}</span>
                  </>
                )}
              </div>

              {note.summary && (
                <p className="mt-3 border-l-2 border-neutral-200 pl-3 text-[13px] leading-relaxed text-neutral-600 dark:border-neutral-700 dark:text-neutral-300">
                  {note.summary}
                </p>
              )}

              {note.fields.length > 0 && (
                <dl className="mt-4 space-y-2 rounded-xl border border-neutral-200/80 bg-neutral-50/60 p-3 dark:border-neutral-800 dark:bg-neutral-900/40">
                  {note.fields.map((field) => (
                    <div key={field.key} className="flex flex-col gap-1 sm:flex-row sm:gap-3">
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

              <div className="mt-4">
                <NoteBody body={note.body} />
              </div>

              {note.tags.length > 0 && (
                <div className="mt-4 flex flex-wrap items-center gap-1">
                  {note.tags.map((item) => (
                    <TagChip key={item} tag={item} onClick={() => onOpenTag(item)} />
                  ))}
                </div>
              )}

              {/* ── trace back to the conversation (plan §4.7) ── */}
              <section className="mt-6 border-t border-neutral-200 pt-3 dark:border-neutral-800">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                  {t('notes.traceTitle')}
                </h3>
                <p className="mt-1 text-[12px] text-neutral-600 dark:text-neutral-300">
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
                <section className="mt-5">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                    {t('notes.relatedTitle')}
                  </h3>
                  <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                    {note.related.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => onOpenNote(item.id)}
                        className="flex items-start gap-2 rounded-lg border border-neutral-200 px-2.5 py-2 text-left transition-colors hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
                      >
                        <span
                          className={cn(
                            'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                            KIND_META[item.kind].dot,
                          )}
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-[12px] text-neutral-700 dark:text-neutral-200">
                            {item.title}
                          </span>
                          <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
                            {t(`notes.kind.${item.kind}`)}
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
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
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
        active
          ? 'text-amber-600 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-500/10'
          : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Editor. Deliberately plain: title, kind, summary, tags, scope, body. Facets
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
function firstLineOf(text: string): string {
  const line = text
    .split('\n')
    .map((item) => item.replace(/^[#>\-*\s]+/, '').trim())
    .find((item) => item.length > 0);
  return (line ?? '').slice(0, 60);
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
  const [kind, setKind] = useState<NoteKind>(note.kind);
  const [summary, setSummary] = useState(note.summary);
  const [body, setBody] = useState(note.body);
  const [tags, setTags] = useState(note.tags.join(', '));
  const [scope, setScope] = useState(note.scope);

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
      tags: tags
        .split(/[,，\s]+/)
        .map((item) => item.replace(/^#/, '').trim())
        .filter(Boolean)
        .slice(0, 6),
    }),
    [body, kind, scope, summary, t, tags, title],
  );

  useEffect(() => {
    onDraftChange(patch);
  }, [onDraftChange, patch]);

  return (
    <div className="space-y-3">
      <input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder={t('notes.editor.titlePlaceholder')}
        className="w-full border-0 border-b border-neutral-200 bg-transparent px-0 pb-1.5 text-[17px] font-semibold text-neutral-900 placeholder:text-neutral-300 focus:border-neutral-400 focus:outline-none dark:border-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-600"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select
          compact
          value={kind}
          onChange={(event) => setKind(event.target.value as NoteKind)}
          options={NOTE_KINDS.map((value) => ({ value, label: t(`notes.kind.${value}`) }))}
        />
        <Select
          compact
          value={scope}
          onChange={(event) => setScope(event.target.value as Note['scope'])}
          options={NOTE_SCOPES.map((value) => ({ value, label: t(`notes.scope.${value}`) }))}
        />
        <input
          value={tags}
          onChange={(event) => setTags(event.target.value)}
          placeholder={t('notes.editor.tagsPlaceholder')}
          className="h-8 min-w-[160px] flex-1 rounded-md border border-neutral-300 bg-white px-2 text-[12px] text-neutral-800 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
        />
      </div>
      <input
        value={summary}
        onChange={(event) => setSummary(event.target.value)}
        placeholder={t('notes.editor.summaryPlaceholder')}
        className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-[12px] text-neutral-800 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
      />
      <MarkdownEditor
        value={body}
        onChange={setBody}
        placeholder={t('notes.editor.bodyPlaceholder')}
        ariaLabel={t('notes.editor.bodyPlaceholder')}
      />
      <div className="flex items-center gap-2">
        {/* Disabled rather than hidden: a grey button explains itself, a missing one
            makes the user wonder what they broke. */}
        <Button size="sm" onClick={() => onSave(patch)} disabled={!patch.title && !body.trim()}>
          {t('notes.save')}
        </Button>
        {onSaveAndApprove && (
          // Saving alone leaves a draft; this is the verb that finishes the job,
          // so it sits next to 保存 rather than behind the panel's 批准.
          <Button
            size="sm"
            variant="secondary"
            onClick={() => onSaveAndApprove(patch)}
            disabled={!patch.title && !body.trim()}
          >
            {t('notes.editor.saveAndApprove')}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('notes.cancel')}
        </Button>
      </div>
    </div>
  );
}
