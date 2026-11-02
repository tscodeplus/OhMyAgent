/**
 * The notes store: one API client, one React context.
 *
 * It replaced an in-memory demo corpus, and the swap was deliberately narrow: every
 * component already talked to this interface rather than to a fixture file, so the
 * change was the bodies and the loading states, not the screens. The interface
 * *is* the REST contract (`MyDocs/NOTES_LAYER_PLAN.md` §10.2), which is why the
 * request shapes here line up with `src/app/webui/notes-routes.ts` one for one.
 *
 * Three rules this store keeps, because they are the ones a component would get
 * wrong on its own:
 *
 * - **Approval is never a side effect.** `update` rewrites a draft's text and
 *   leaves its status alone; only `approve` moves a draft into the library.
 * - **A capture returns drafts, not notes.** The ball shows them as a card; nothing
 *   here can make one active.
 * - **A failed write is surfaced, not swallowed.** The list refetches only after a
 *   write the server accepted, so a 409 shows up as an error instead of a list that
 *   quietly lost an edit.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { apiRequest } from '../../utils/api';
import type { Note, NoteChannel, NoteListResult, NoteRejectionCode, NoteStatus } from './types';

/**
 * What a caller can ask the ball for.
 *
 * The UI names the *intent*, not the wire fields: `turn` and `instruction` both
 * distil a window and differ in whether the user said what to keep, `drop` carries
 * text the user dragged in, and `manual` creates no row until the editor has
 * something to save. `NotesContext` maps each onto the REST request, so the
 * mapping lives in exactly one place.
 */
/**
 * What the *user* asked for, which is not the same axis as the server's `mode`.
 *
 * `conversation` is the plain entry: the whole conversation, as far as the token
 * budget reaches. It sends `mode: 'session'` — the server used to receive `'turn'`
 * here, so a menu item that said "based on this conversation" read one exchange.
 */
export type CaptureMode = 'conversation' | 'instruction' | 'drop' | 'manual';

/** What to do with dropped text: keep the words, or let the agent tidy them. */
export type CaptureTreatment = 'verbatim' | 'distill';

export interface CaptureIntent {
  mode: CaptureMode;
  /** Absent only for `manual`. */
  sessionId?: string | null;
  /** `instruction` mode: the user's own requirement. */
  instruction?: string;
  /** `drop` mode: the selected text. */
  text?: string;
  /** `drop` mode. Defaults to `verbatim` — the user dragged words, not a request. */
  treatment?: CaptureTreatment;
}

/** Filters the page sends; the server owns the actual query. */
export interface NotesQuery {
  status: NoteStatus;
  /** Each facet is a set: OR inside it, AND across facets (see `NoteListQuery`). */
  origins?: string[];
  channels?: string[];
  projectIds?: string[];
  tags?: string[];
  q?: string;
}

export interface DuplicateRef {
  title: string;
  existingId: string;
  status: NoteStatus;
}

export interface CaptureOutcome {
  ok: boolean;
  /** Server sentence, already localized server-side; shown as-is. */
  message?: string;
  /** Drafts produced (never active). */
  notes: Note[];
  /** Candidates skipped because the library already holds that title (§5.5). */
  duplicates: DuplicateRef[];
  /** Where to send the reader when the answer was "already have it". */
  existingId?: string;
  /** Credential-shaped spans the redactor hid — the card warns when > 0. */
  redacted: number;
  /** Messages the window held, and how many the budget dropped from the old end. */
  readMessages?: number;
  droppedMessages?: number;
  /** Present when the session exceeded the read cap: head messages kept by sampling. */
  sampledHead?: number;
}

/** Ball size: the full 56px target, or a dot that does not cover the transcript. */
export type BallSize = 'normal' | 'compact';

/**
 * Ball visibility is NOT here: it is `notes.ball.show` in `config.yaml`, because
 * "hide the ball" has to be undoable from the settings page rather than from whichever
 * browser happened to hide it. Size stays local — it answers "how much room does this
 * screen have", which is the one question the server cannot answer.
 */
const BALL_SIZE_KEY = 'oma-notes-ball-size';

function readBallSize(): BallSize {
  try {
    return window.localStorage.getItem(BALL_SIZE_KEY) === 'compact' ? 'compact' : 'normal';
  } catch {
    return 'normal';
  }
}

/** The two numbers the review UI shows; `stats()` has no other reader. */
export interface NotesStatsView {
  draftsDue: number;
  approvalRate: number;
}

interface NotesContextValue {
  /** Rows for the current query (whatever `query.status` is). */
  notes: Note[];
  /**
   * Drafts the UI currently holds, for the ball's review card lookup.
   *
   * Not a count: the badge reads `counts.draft`, because a page load that has
   * only ever seen the active list would show 0 pending reviews while three are
   * waiting. This array exists so a *just captured* draft can be rendered before
   * the list refetches.
   */
  drafts: Note[];
  counts: Record<NoteStatus, number>;
  /** Facet options for the filter row: the library under the current status. */
  tags: Array<{ tag: string; count: number }>;
  channels: Array<{ channel: NoteChannel; count: number }>;
  projects: Array<{ id: string; name: string; count: number }>;
  loading: boolean;
  error: string | null;
  query: NotesQuery;
  setQuery: (next: Partial<NotesQuery>) => void;
  refresh: () => Promise<void>;
  capturing: boolean;
  /** The draft whose review card is on screen; `null` when nothing is pending. */
  draftCardId: string | null;
  capture: (intent: CaptureIntent) => Promise<CaptureOutcome>;
  /**
   * One note by id, for a permalink the current filter does not contain.
   *
   * A draft opened from the floating ball arrives as `/notes/<id>?edit=1` while the
   * page may be filtered to active notes — without this the editor would open on a
   * row the list does not have, which renders as "the link did nothing".
   */
  fetchNote: (id: string) => Promise<Note | null>;
  /** Approve a draft. Resolves `false` when the title is already taken (422). */
  saveDraft: (id: string) => Promise<boolean>;
  /** Resolves `false` when the server refused; the caller then keeps the draft on screen. */
  discardDraft: (id: string, reason?: NoteRejectionCode) => Promise<boolean>;
  /** Drafts near expiry and the approval rate, for the drafts header. */
  stats: NotesStatsView | null;
  dismissDraftCard: () => void;
  /** User-authored note: lands `active` immediately (plan §4.2-2). */
  createNote: (seed?: Partial<Note>) => Promise<Note | null>;
  updateNote: (note: Note, patch: Partial<Note>) => Promise<Note | null>;
  /**
   * The three list-level writes resolve `false` when the server refused.
   *
   * A refusal is not an exception: the note may have been archived in another tab
   * (404), and throwing that at a `void` call site left the row on screen with
   * nothing said. The sentence lands in `error`; the boolean is what a caller needs
   * to decide whether to close or navigate.
   */
  togglePin: (id: string) => Promise<boolean>;
  archiveNote: (id: string) => Promise<boolean>;
  restoreNote: (id: string) => Promise<boolean>;
  /** Detail-page visit, counted server-side (`view_count`). */
  markViewed: (id: string) => void;
  /**
   * Ball preferences, persisted per browser.
   *
   * They live here and not in the ball because hiding the ball removes the only
   * place that could unhide it: the notes page carries the switch that brings it
   * back, so both need to read the same state.
   */
  ballHidden: boolean;
  setBallHidden: (hidden: boolean) => void;
  ballSize: BallSize;
  setBallSize: (size: BallSize) => void;
}

const NotesContext = createContext<NotesContextValue | null>(null);

/** Turn an API failure into one sentence the UI can show without translating. */
function describeError(err: unknown): string {
  if (err && typeof err === 'object' && 'status' in err && 'message' in err) {
    const { status, message } = err as { status: number; message: string };
    return `${status}: ${message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Build a query string, skipping empty values so the URL stays readable. */
/**
 * The list query as a URL query string — the *only* spelling of it.
 *
 * Exported because the list's "load more" needs the same predicates with a different
 * `offset`. It used to rebuild the keys by hand, so a facet added here would have
 * silently paged an unfiltered list: a second spelling of the query language is the
 * same defect as a second ranker.
 */
export function toSearchParams(
  query: NotesQuery,
  extra: Record<string, string | undefined>,
): string {
  const params = new URLSearchParams();
  params.set('status', query.status);
  // One param per facet, comma-joined: the server accepts that or the repeated
  // form, so a filter stays one readable key in the URL instead of four.
  if (query.origins?.length) params.set('origin', query.origins.join(','));
  if (query.channels?.length) params.set('channel', query.channels.join(','));
  if (query.projectIds?.length) params.set('projectId', query.projectIds.join(','));
  if (query.tags?.length) params.set('tag', query.tags.join(','));
  if (query.q && query.q.trim()) params.set('q', query.q.trim());
  for (const [key, value] of Object.entries(extra)) {
    if (value) params.set(key, value);
  }
  return params.toString();
}

export function NotesProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [result, setResult] = useState<NoteListResult>({
    notes: [],
    total: 0,
    counts: { active: 0, draft: 0, archived: 0 },
    tags: [],
    channels: [],
    projects: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<NotesStatsView | null>(null);
  const [ballHidden, setBallHiddenState] = useState(false);
  const [ballSize, setBallSizeState] = useState<BallSize>(readBallSize);
  const [query, setQueryState] = useState<NotesQuery>({ status: 'active' });
  const [capturing, setCapturing] = useState(false);
  const [draftCardId, setDraftCardId] = useState<string | null>(null);
  /**
   * Rows that arrived from a capture or an edit after the last refetch.
   *
   * An overlay, not a cache: every mutation writes the server's answer back into
   * it, and `refresh()` drops the ids the refreshed list now owns. Without those
   * two rules a deleted note kept rendering from here — the server had archived it
   * and the list agreed, but the overlay was still holding the old object, so the
   * row survived its own delete.
   */
  const [captured, setCaptured] = useState<Note[]>([]);
  const seq = useRef(0);
  /**
   * The list request currently in flight.
   *
   * `seq` only decides which answer may render; it cannot stop a request, so typing
   * ten characters in the search box still left ten `/api/notes` calls running on the
   * server. Aborting the previous one is the other half of that guard.
   */
  const listRequest = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    const ticket = (seq.current += 1);
    listRequest.current?.abort();
    const request = new AbortController();
    listRequest.current = request;
    try {
      const data = await apiRequest<NoteListResult>(`/api/notes?${toSearchParams(query, {})}`, {
        signal: request.signal,
      });
      // A slow first response must not overwrite a fast second one.
      if (ticket !== seq.current) return;
      setResult(data);
      setError(null);
      // The list is now authoritative for every id it returns: the overlay only
      // carries what a refetch has not seen yet.
      const listed = new Set(data.notes.map((note) => note.id));
      setCaptured((prev) =>
        prev.some((note) => listed.has(note.id))
          ? prev.filter((note) => !listed.has(note.id))
          : prev,
      );
    } catch (err) {
      if (ticket !== seq.current) return;
      // We cancelled this one on purpose. Its rejection is the cancellation, not a
      // failure, so it must not paint an error line over a search in progress.
      if (request.signal.aborted) return;
      setError(describeError(err));
    } finally {
      if (ticket === seq.current) setLoading(false);
    }
    // Separate request, separate failure: the list is what the page is for, and a
    // stats endpoint that is down must not blank it.
    try {
      const data = await apiRequest<{ draftsDue: number; approvalRate: number }>(
        '/api/notes/stats',
      );
      setStats({ draftsDue: data.draftsDue, approvalRate: data.approvalRate });
    } catch {
      setStats(null);
    }
  }, [query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A provider that unmounts mid-flight leaves nothing to render an answer into.
  useEffect(() => () => listRequest.current?.abort(), []);

  /**
   * Read the ball's visibility from `config.yaml` once per page load.
   *
   * A failed read leaves the ball visible: "config unreachable" must not be read as
   * "the operator hid it", because the only way back from a hidden ball is a page the
   * user may not think to visit.
   */
  useEffect(() => {
    let cancelled = false;
    void apiRequest<{ notes?: { ball?: { show?: boolean } } }>('/api/config')
      .then((config) => {
        if (cancelled) return;
        if (config?.notes?.ball?.show === false) setBallHiddenState(true);
      })
      .catch(() => {
        /* see above */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** The list plus anything captured since the last fetch, de-duplicated by id. */
  const notes = useMemo(() => {
    const seen = new Set(result.notes.map((note) => note.id));
    const fresh = captured.filter((note) => !seen.has(note.id) && note.status === query.status);
    return [...fresh, ...result.notes];
  }, [captured, result.notes, query.status]);

  const drafts = useMemo(
    () => (query.status === 'draft' ? notes : captured.filter((note) => note.status === 'draft')),
    [captured, notes, query.status],
  );

  const setQuery = useCallback((next: Partial<NotesQuery>) => {
    setQueryState((current) => ({ ...current, ...next }));
  }, []);

  const capture = useCallback(
    async (intent: CaptureIntent): Promise<CaptureOutcome> => {
      if (intent.mode === 'manual') {
        // No row is created until the editor has something to save: a blank note
        // that the user closes would otherwise sit in the library forever asking
        // to be deleted (§7.3).
        navigate('/notes/new');
        return { ok: true, notes: [], duplicates: [], redacted: 0 };
      }

      const sessionId = intent.sessionId ?? null;
      if (!sessionId) {
        return {
          ok: false,
          notes: [],
          duplicates: [],
          redacted: 0,
          message: 'no session open',
        };
      }

      // `drop` is verbatim unless asked otherwise; everything else reads a window
      // and always distils. Only a run the model touches shows the spinner — a
      // verbatim save returns in milliseconds and a spinner would outlast it.
      const treatment = intent.mode === 'drop' ? (intent.treatment ?? 'verbatim') : 'distill';
      const body =
        intent.mode === 'drop'
          ? { sessionId, mode: 'text', treatment, text: intent.text ?? '' }
          : intent.mode === 'instruction'
            ? { sessionId, mode: 'session', instruction: intent.instruction ?? '' }
            : { sessionId, mode: 'session' };

      if (treatment === 'distill') setCapturing(true);
      try {
        const response = await apiRequest<{
          captureId: string;
          notes: Note[];
          duplicates: DuplicateRef[];
          redacted: number;
          readMessages?: number;
          droppedMessages?: number;
          sampledHead?: number;
        }>('/api/notes/capture', {
          method: 'POST',
          body: JSON.stringify(body),
          // One model call, but measured at 30–90s against a remote provider; the
          // 10s default would abandon a capture that is still running server-side.
          timeoutMs: treatment === 'distill' ? 150_000 : 30_000,
        });
        setCaptured((prev) => [...response.notes, ...prev]);
        // Every capture ends in a review card rather than a jump to the page: the
        // card is where a draft is judged, and a verbatim drop needs the same
        // decision (approve it, edit it, or let the agent tidy it up).
        if (response.notes[0]) setDraftCardId(response.notes[0].id);
        return {
          ok: true,
          notes: response.notes,
          duplicates: response.duplicates ?? [],
          redacted: response.redacted,
          readMessages: response.readMessages,
          droppedMessages: response.droppedMessages,
          sampledHead: response.sampledHead,
        };
      } catch (err) {
        // A client-side timeout does not cancel the server's capture: the draft may
        // land a moment later, so refetch before reporting the failure — otherwise
        // the badge stays at 0 while a review is waiting.
        void refresh();
        // "This already exists" is an answer with somewhere to go, so it is lifted out
        // of the error string: the caller links to the row that owns the title instead
        // of telling the user off for pressing a button twice.
        const body = (err as { body?: Record<string, unknown> }).body;
        const duplicates = Array.isArray(body?.duplicates)
          ? (body?.duplicates as DuplicateRef[])
          : [];
        return {
          ok: false,
          notes: [],
          duplicates,
          existingId: duplicates[0]?.existingId,
          redacted: 0,
          message: describeError(err),
        };
      } finally {
        if (treatment === 'distill') setCapturing(false);
      }
    },
    [navigate, refresh],
  );

  /** Write a server answer into the overlay; a row the list owns is its business. */
  const applyNote = useCallback((note: Note) => {
    setCaptured((prev) =>
      prev.some((item) => item.id === note.id)
        ? prev.map((item) => (item.id === note.id ? note : item))
        : prev,
    );
  }, []);

  const fetchNote = useCallback(async (id: string): Promise<Note | null> => {
    try {
      const response = await apiRequest<{ note: Note }>(`/api/notes/${id}`);
      return response.note;
    } catch {
      // A missing note is not an error worth a toast: the page shows the list.
      return null;
    }
  }, []);

  const approve = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const response = await apiRequest<{ note: Note }>(`/api/notes/${id}/review`, {
          method: 'POST',
          body: JSON.stringify({ decision: 'approve' }),
        });
        applyNote(response.note);
        setDraftCardId((current) => (current === id ? null : current));
        await refresh();
        return true;
      } catch (err) {
        // Refused, not lost: the draft stays a draft and the sentence says which note
        // holds the title. Throwing here would leave the caller's `.then()` unhandled
        // and the card frozen on a draft that can never be approved.
        setError(describeError(err));
        return false;
      }
    },
    [applyNote, refresh],
  );

  const discardDraft = useCallback(
    async (id: string, reason: NoteRejectionCode = 'other'): Promise<boolean> => {
      try {
        const response = await apiRequest<{ note: Note }>(`/api/notes/${id}/review`, {
          method: 'POST',
          body: JSON.stringify({ decision: 'reject', reason }),
        });
        applyNote(response.note);
        setDraftCardId((current) => (current === id ? null : current));
        await refresh();
        return true;
      } catch (err) {
        // The card stays on screen: the draft is still a draft, and saying so beats a
        // discard button that appears to have worked.
        setError(describeError(err));
        return false;
      }
    },
    [applyNote, refresh],
  );

  const dismissDraftCard = useCallback(() => setDraftCardId(null), []);

  const createNoteInternal = useCallback(async (seed?: Partial<Note>): Promise<Note | null> => {
    try {
      const response = await apiRequest<{ note: Note }>('/api/notes', {
        method: 'POST',
        body: JSON.stringify({
          // The caller supplies the title (the editor derives one from the body when
          // the user typed none). A fallback here would store a note called
          // 未命名笔记 that the user never chose.
          title: seed?.title?.trim() ?? '',
          summary: seed?.summary ?? '',
          body: seed?.body ?? '',
          fields: seed?.fields ?? [],
          tags: seed?.tags ?? [],
          scope: seed?.scope ?? 'user',
          channel: 'webui',
        }),
      });
      setCaptured((prev) => [response.note, ...prev]);
      return response.note;
    } catch (err) {
      setError(describeError(err));
      return null;
    }
  }, []);

  const updateNote = useCallback(
    async (note: Note, patch: Partial<Note>): Promise<Note | null> => {
      try {
        const response = await apiRequest<{ note: Note }>(`/api/notes/${note.id}`, {
          method: 'PUT',
          // The version the editor read: the server refuses a stale write and
          // hands back the current body instead of silently clobbering it.
          body: JSON.stringify({ ...patch, expectedVersion: note.version }),
        });
        setCaptured((prev) =>
          prev.map((item) => (item.id === response.note.id ? response.note : item)),
        );
        await refresh();
        return response.note;
      } catch (err) {
        setError(describeError(err));
        return null;
      }
    },
    [refresh],
  );

  const togglePin = useCallback(
    async (id: string): Promise<boolean> => {
      const note = notes.find((item) => item.id === id);
      try {
        const response = await apiRequest<{ note: Note }>(`/api/notes/${id}/pin`, {
          method: 'POST',
          body: JSON.stringify({ pinned: !note?.pinned }),
        });
        applyNote(response.note);
        await refresh();
        return true;
      } catch (err) {
        // A note archived in another tab answers 404 here. Left uncaught, that
        // rejection escaped into `void togglePin(id)` and the click did nothing.
        setError(describeError(err));
        return false;
      }
    },
    [applyNote, notes, refresh],
  );

  const archiveNote = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const response = await apiRequest<{ note: Note }>(`/api/notes/${id}`, {
          method: 'DELETE',
        });
        // The row leaves the current filter; writing the server's `archived` copy into
        // the overlay is what makes it leave the screen too.
        applyNote(response.note);
        await refresh();
        return true;
      } catch (err) {
        setError(describeError(err));
        return false;
      }
    },
    [applyNote, refresh],
  );

  const restoreNote = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const response = await apiRequest<{ note: Note }>(`/api/notes/${id}/restore`, {
          method: 'POST',
        });
        applyNote(response.note);
        await refresh();
        return true;
      } catch (err) {
        setError(describeError(err));
        return false;
      }
    },
    [applyNote, refresh],
  );

  /**
   * Persisted to `config.yaml` through the same `PUT /api/config` dot-notation the
   * settings page uses, so the ball's own menu and the settings toggle are two
   * entrances to one value instead of two values that disagree.
   *
   * Optimistic: the ball disappears on the click, and a failed write puts it back
   * rather than leaving a hidden ball and a config file that says visible.
   */
  const setBallHidden = useCallback((hidden: boolean) => {
    setBallHiddenState(hidden);
    void apiRequest('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ 'notes.ball.show': !hidden }),
    }).catch(() => {
      setBallHiddenState(!hidden);
    });
  }, []);

  const setBallSize = useCallback((size: BallSize) => {
    setBallSizeState(size);
    try {
      window.localStorage.setItem(BALL_SIZE_KEY, size);
    } catch {
      /* see above */
    }
  }, []);

  const markViewed = useCallback((id: string) => {
    // Fire-and-forget: a view counter must never delay or fail opening a note.
    void apiRequest(`/api/notes/${id}/view`, { method: 'POST' }).catch(() => undefined);
  }, []);

  const value = useMemo<NotesContextValue>(
    () => ({
      notes,
      drafts,
      counts: result.counts,
      tags: result.tags,
      channels: result.channels,
      projects: result.projects,
      loading,
      error,
      query,
      setQuery,
      refresh,
      capturing,
      draftCardId,
      capture,
      fetchNote,
      saveDraft: approve,
      discardDraft,
      stats,
      ballHidden,
      setBallHidden,
      ballSize,
      setBallSize,
      dismissDraftCard,
      createNote: createNoteInternal,
      updateNote,
      togglePin,
      archiveNote,
      restoreNote,
      applyNote,
      markViewed,
    }),
    [
      notes,
      drafts,
      result.counts,
      result.tags,
      result.channels,
      result.projects,
      loading,
      error,
      query,
      setQuery,
      refresh,
      capturing,
      draftCardId,
      capture,
      fetchNote,
      approve,
      discardDraft,
      stats,
      dismissDraftCard,
      createNoteInternal,
      fetchNote,
      updateNote,
      togglePin,
      archiveNote,
      restoreNote,
      applyNote,
      markViewed,
      ballHidden,
      setBallHidden,
      ballSize,
      setBallSize,
    ],
  );

  return <NotesContext.Provider value={value}>{children}</NotesContext.Provider>;
}

export function useNotes(): NotesContextValue {
  const value = useContext(NotesContext);
  if (!value) throw new Error('useNotes must be used inside <NotesProvider>');
  return value;
}
