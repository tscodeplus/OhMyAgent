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
import type { Note, NoteListResult, NoteStatus } from './types';

/**
 * What a caller can ask the ball for.
 *
 * The UI names the *intent*, not the wire fields: `turn` and `instruction` both
 * distil a window and differ in whether the user said what to keep, `drop` carries
 * text the user dragged in, and `manual` creates no row until the editor has
 * something to save. `NotesContext` maps each onto the REST request, so the
 * mapping lives in exactly one place.
 */
export type CaptureMode = 'turn' | 'instruction' | 'drop' | 'manual';

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
  origin?: 'all' | 'user' | 'agent';
  channel?: string;
  projectId?: string;
  tag?: string | null;
  q?: string;
}

export interface CaptureOutcome {
  ok: boolean;
  /** Server sentence, already localized server-side; shown as-is. */
  message?: string;
  /** Drafts produced (never active). */
  notes: Note[];
  /** Credential-shaped spans the redactor hid — the card warns when > 0. */
  redacted: number;
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
  tags: Array<{ tag: string; count: number }>;
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
  saveDraft: (id: string) => Promise<void>;
  discardDraft: (id: string) => Promise<void>;
  dismissDraftCard: () => void;
  /** User-authored note: lands `active` immediately (plan §4.2-2). */
  createNote: (seed?: Partial<Note>) => Promise<Note | null>;
  updateNote: (note: Note, patch: Partial<Note>) => Promise<Note | null>;
  togglePin: (id: string) => Promise<void>;
  archiveNote: (id: string) => Promise<void>;
  restoreNote: (id: string) => Promise<void>;
  /** Detail-page visit, counted server-side (`view_count`). */
  markViewed: (id: string) => void;
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
function toSearchParams(query: NotesQuery, extra: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  params.set('status', query.status);
  if (query.origin && query.origin !== 'all') params.set('origin', query.origin);
  if (query.channel) params.set('channel', query.channel);
  if (query.projectId) params.set('projectId', query.projectId);
  if (query.tag) params.set('tag', query.tag);
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
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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

  const refresh = useCallback(async () => {
    const ticket = (seq.current += 1);
    try {
      const data = await apiRequest<NoteListResult>(`/api/notes?${toSearchParams(query, {})}`);
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
      setError(describeError(err));
    } finally {
      if (ticket === seq.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
        return { ok: true, notes: [], redacted: 0 };
      }

      const sessionId = intent.sessionId ?? null;
      if (!sessionId) {
        return { ok: false, notes: [], redacted: 0, message: 'no session open' };
      }

      // `drop` is verbatim unless asked otherwise; everything else reads a window
      // and always distils. Only a run the model touches shows the spinner — a
      // verbatim save returns in milliseconds and a spinner would outlast it.
      const treatment = intent.mode === 'drop' ? (intent.treatment ?? 'verbatim') : 'distill';
      const body =
        intent.mode === 'drop'
          ? { sessionId, mode: 'text', treatment, text: intent.text ?? '' }
          : intent.mode === 'instruction'
            ? { sessionId, mode: 'recent', instruction: intent.instruction ?? '' }
            : { sessionId, mode: 'turn' };

      if (treatment === 'distill') setCapturing(true);
      try {
        const response = await apiRequest<{
          captureId: string;
          notes: Note[];
          redacted: number;
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
        return { ok: true, notes: response.notes, redacted: response.redacted };
      } catch (err) {
        // A client-side timeout does not cancel the server's capture: the draft may
        // land a moment later, so refetch before reporting the failure — otherwise
        // the badge stays at 0 while a review is waiting.
        void refresh();
        return { ok: false, notes: [], redacted: 0, message: describeError(err) };
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
    async (id: string) => {
      const response = await apiRequest<{ note: Note }>(`/api/notes/${id}/review`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'approve' }),
      });
      applyNote(response.note);
      setDraftCardId((current) => (current === id ? null : current));
      await refresh();
    },
    [applyNote, refresh],
  );

  const discardDraft = useCallback(
    async (id: string) => {
      const response = await apiRequest<{ note: Note }>(`/api/notes/${id}/review`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'reject', reason: 'other' }),
      });
      applyNote(response.note);
      setDraftCardId((current) => (current === id ? null : current));
      await refresh();
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
          kind: seed?.kind ?? 'other',
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
    async (id: string) => {
      const note = notes.find((item) => item.id === id);
      const response = await apiRequest<{ note: Note }>(`/api/notes/${id}/pin`, {
        method: 'POST',
        body: JSON.stringify({ pinned: !note?.pinned }),
      });
      applyNote(response.note);
      await refresh();
    },
    [applyNote, notes, refresh],
  );

  const archiveNote = useCallback(
    async (id: string) => {
      const response = await apiRequest<{ note: Note }>(`/api/notes/${id}`, { method: 'DELETE' });
      // The row leaves the current filter; writing the server's `archived` copy into
      // the overlay is what makes it leave the screen too.
      applyNote(response.note);
      await refresh();
    },
    [applyNote, refresh],
  );

  const restoreNote = useCallback(
    async (id: string) => {
      const response = await apiRequest<{ note: Note }>(`/api/notes/${id}/restore`, {
        method: 'POST',
      });
      applyNote(response.note);
      await refresh();
    },
    [applyNote, refresh],
  );

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
      dismissDraftCard,
      createNoteInternal,
      fetchNote,
      updateNote,
      togglePin,
      archiveNote,
      restoreNote,
      markViewed,
    ],
  );

  return <NotesContext.Provider value={value}>{children}</NotesContext.Provider>;
}

export function useNotes(): NotesContextValue {
  const value = useContext(NotesContext);
  if (!value) throw new Error('useNotes must be used inside <NotesProvider>');
  return value;
}
