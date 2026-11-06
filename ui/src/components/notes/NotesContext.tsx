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
import { fetchConfig as readConfig, putConfig } from '../../utils/config-cache';
import { NOTES_PAGE_SIZE } from './types';
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
  /**
   * Aborts the request behind the capture.
   *
   * A distillation runs tens of seconds, and the one dialog that shows a progress
   * state (the brief dialog) is also the one that has to be able to say stop. The
   * server does not cancel its own work — a draft may still land later — but the
   * caller stops waiting for it, which is what the button promises.
   */
  signal?: AbortSignal;
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
  /**
   * The server's failure code (`no_notes`, `model_failed`, …).
   *
   * The UI owns the sentence, so this — not the wire's English `message` — is what
   * a notice is translated from. `message` stays as the operator-facing fallback
   * for a code this build does not know yet.
   */
  code?: string;
  /** Server sentence; only a fallback for a code the UI has no wording for. */
  message?: string;
  /** The user pressed cancel: an abort, not a failure, so nothing is reported. */
  canceled?: boolean;
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

/** The one number the review UI shows; `stats()` has no other reader. */
export interface NotesStatsView {
  approvalRate: number;
}

/**
 * What came of a purge request.
 *
 * A code, not a boolean: `purgeNote` is the one write whose refusals mean three
different things — the row was restored elsewhere (`not_archived`), the typed title
is not the note's title (`title_mismatch`), the row is gone already (`not_found`) —
and the dialog that asks for the title has a sentence for each. Collapsing them into
`false` is how "clicked 彻底删除 and nothing happened" reads.
 */
export type PurgeOutcome = 'ok' | 'not_archived' | 'title_mismatch' | 'not_found' | 'failed';

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
  /**
   * Whether this server runs the notes layer at all.
   *
   * `false` when the routes are not registered: `notes.enabled` was set to false, or
   * the service failed to construct. Everything else in this store then has nothing
   * to talk to, so the page shows that fact instead of the 404 it would otherwise
   * earn. Absent `notes:` config is *not* this state — the layer is on by default.
   */
  available: boolean;
  query: NotesQuery;
  setQuery: (next: Partial<NotesQuery>) => void;
  refresh: () => Promise<void>;
  /**
   * Where the reader is in the filtered list, and what that list holds in total.
   *
   * Paging lives here rather than in the page component because every write
   * (`approve`, `pin`, `archive`) refetches the list: with the page number held by the
   * component, that refetch dropped the reader back to row 1. Page numbers are offsets
   * in disguise — `offset = (page - 1) * NOTES_PAGE_SIZE` — so the REST contract is
   * unchanged; only who remembers the position moved.
   */
  page: number;
  /** `ceil(total / NOTES_PAGE_SIZE)`, floored at 1: an empty list is still page 1. */
  pageCount: number;
  /** Rows matching the current filters across every page — what the pager prints. */
  total: number;
  /** Clamped to `1..pageCount`; asking for the page already open is a no-op. */
  setPage: (next: number) => void;
  capturing: boolean;
  /**
   * The drafts one capture produced, in the order the server answered with them.
   *
   * A list, not a single id: a capture routinely distils two or three notes, and the
   * ball's review card shows them as tabs. The store owns the group because approving
   * or deleting a tab is a write — the id has to leave the group at the same moment
   * the server stops calling it a draft, or the card would keep a tab for a note that
   * no longer exists. Empty means no review card.
   */
  draftCardIds: string[];
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
  /**
   * The layer's only physical delete: archived rows, and the title typed back.
   *
   * Everything else here moves a row between statuses (`DELETE /api/notes/:id`
   * archives, `restore` brings it back); this one erases the row and the records
   * hanging off it. The title is the server's own guard, so the caller has to send
   * what the user typed rather than the note object's title — a client that filled
   * that in itself would turn the confirmation into a no-op click.
   */
  purgeNote: (id: string, title: string) => Promise<PurgeOutcome>;
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
 * `extra` is how paging reaches the server (`limit`/`offset`) without a second query
 * builder: a facet added here used to be missing from the hand-written copy that
 * "load more" used, which silently paged a list the filters did not describe. Two
 * spellings of one query language is the same defect as two rankers.
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
  /**
   * Whether the server has a notes API, and `unknown` until something proves it.
   *
   * Neither default is free: optimistic ("on") fires a request that is guaranteed to
   * 404 on an install with the layer off, and pessimistic ("off") blinks the page
   * into "未启用" for every working install while `/api/config` is in flight. So the
   * list simply waits for the answer, which costs one round trip either way and is
   * the same request the ball's visibility already needed.
   */
  const [layer, setLayer] = useState<'unknown' | 'on' | 'off'>('unknown');
  const available = layer !== 'off';
  const [stats, setStats] = useState<NotesStatsView | null>(null);
  const [ballHidden, setBallHiddenState] = useState(false);
  const [ballSize, setBallSizeState] = useState<BallSize>(readBallSize);
  const [query, setQueryState] = useState<NotesQuery>({ status: 'active' });
  /**
   * The page the list is showing, 1-based.
   *
   * Not in `NotesQuery`: the query is the *filter*, and every change to it restarts at
   * page 1, while paging is a position inside one filter's result. Keeping them apart
   * is also what stops a page number from riding along into a facet change.
   */
  const [page, setPageState] = useState(1);
  const [capturing, setCapturing] = useState(false);
  const [draftCardIds, setDraftCardIds] = useState<string[]>([]);
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
    // The routes do not exist when the layer is off: asking anyway is how the page
    // ended up showing "404: Not Found 重试" over an empty library.
    if (layer === 'off') {
      setError(null);
      setLoading(false);
      return;
    }
    // One round trip decides whether this request can succeed at all (see `layer`).
    if (layer === 'unknown') return;
    const ticket = (seq.current += 1);
    listRequest.current?.abort();
    const request = new AbortController();
    listRequest.current = request;
    try {
      const data = await apiRequest<NoteListResult>(
        `/api/notes?${toSearchParams(query, {
          limit: String(NOTES_PAGE_SIZE),
          offset: String((page - 1) * NOTES_PAGE_SIZE),
        })}`,
        { signal: request.signal },
      );
      // A slow first response must not overwrite a fast second one.
      if (ticket !== seq.current) return;
      setResult(data);
      setError(null);
      // The page a reader is on can stop existing under them: approving the last draft
      // of page 4 leaves `offset` past `total`, and the server answers that with an
      // empty page rather than an error. Step back to the last real page instead of
      // painting "还没有笔记" over a library that is not empty.
      if (data.total > 0 && (page - 1) * NOTES_PAGE_SIZE >= data.total) {
        setPageState(Math.max(1, Math.ceil(data.total / NOTES_PAGE_SIZE)));
      } else if (data.total === 0 && page !== 1) {
        setPageState(1);
      }
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
      // A 404 here is not "the list failed", it is "this server has no notes API".
      // Trust the endpoint over the config snapshot: `notes.enabled` reads true for a
      // service that failed to construct too, and the routes are what actually exist.
      if ((err as { status?: number }).status === 404) {
        setLayer('off');
        setError(null);
        return;
      }
      setError(describeError(err));
    } finally {
      if (ticket === seq.current) setLoading(false);
    }
    // Separate request, separate failure: the list is what the page is for, and a
    // stats endpoint that is down must not blank it.
    try {
      const data = await apiRequest<{ approvalRate: number }>('/api/notes/stats');
      setStats({ approvalRate: data.approvalRate });
    } catch {
      setStats(null);
    }
  }, [query, layer, page]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A provider that unmounts mid-flight leaves nothing to render an answer into.
  useEffect(() => () => listRequest.current?.abort(), []);

  /**
   * Read the two `notes:` keys this store needs, once per page load.
   *
   * One request, because both answers are about the same section: `notes.enabled`
   * decides whether there is a list to fetch at all, and `notes.ball.show` decides
   * whether the ball is drawn. A failed read settles both at their safe defaults —
   * "config unreachable" must not be read as "the operator hid the ball" (the only
   * way back from a hidden ball is a page the user may not think to visit), nor as
   * "the layer is off" when it is running; the list request then answers the second
   * question authoritatively, 404 ⇒ off.
   */
  useEffect(() => {
    let cancelled = false;
    // Shared read: the same document the settings panel and the language sync
    // need, so the page load costs one `GET /api/config` in total.
    void readConfig()
      .then((config) => {
        if (cancelled) return;
        const notes = (config as { notes?: { enabled?: boolean; ball?: { show?: boolean } } })
          .notes;
        if (notes?.ball?.show === false) setBallHiddenState(true);
        setLayer(notes?.enabled === false ? 'off' : 'on');
      })
      .catch(() => {
        if (!cancelled) setLayer('on');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The current page plus anything captured since the last fetch, de-duplicated by id.
   *
   * The overlay only applies to page 1: a just-captured note is the newest row, so on
   * page 3 it would push one of that page's own twenty rows over the edge and make the
   * pager's "第 3 / 12 页" describe a list nobody fetched.
   */
  const notes = useMemo(() => {
    if (page !== 1) return result.notes;
    const seen = new Set(result.notes.map((note) => note.id));
    const fresh = captured.filter((note) => !seen.has(note.id) && note.status === query.status);
    return [...fresh, ...result.notes];
  }, [captured, page, result.notes, query.status]);

  /**
   * Drafts the UI holds, for the ball's review-card lookup — page-independent.
   *
   * On the drafts view it is the list itself, plus any draft captured since the last
   * fetch (which the page-1 rule above would otherwise hide on page 3).
   */
  const drafts = useMemo(() => {
    const held = captured.filter((note) => note.status === 'draft');
    if (query.status !== 'draft') return held;
    const listed = new Set(notes.map((note) => note.id));
    return [...held.filter((note) => !listed.has(note.id)), ...notes];
  }, [captured, notes, query.status]);

  /**
   * Rows in the whole filtered list, and the page count the pager renders.
   *
   * `total` is the server's `COUNT(*)` over the same predicate — the number the old
   * "load more" never read, which is why it had to infer "this is everything" from a
   * short page.
   */
  const total = result.total;
  const pageCount = Math.max(1, Math.ceil(total / NOTES_PAGE_SIZE));

  const setPage = useCallback(
    (next: number) => {
      const bounded = Number.isFinite(next) ? Math.round(next) : 1;
      setPageState(Math.min(Math.max(1, bounded), pageCount));
    },
    [pageCount],
  );

  const setQuery = useCallback((next: Partial<NotesQuery>) => {
    // Page 4 of the old filter is a different list under the new one, so a filter
    // change restarts at row 1 — the same rule the server applies to `offset`.
    setPageState(1);
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
          code: 'no_session',
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
          // Composed with the timeout by `apiRequest`, so a cancel and a timeout
          // share one controller instead of overwriting each other.
          signal: intent.signal,
        });
        setCaptured((prev) => [...response.notes, ...prev]);
        // Every new row is the newest row, so it lives on page 1 — the overlay renders
        // there and nowhere else (see `notes`). A capture therefore puts the list back
        // at the top instead of leaving the reader on a page the draft is not on.
        setPageState(1);
        // Every capture ends in a review card rather than a jump to the page: the
        // card is where a draft is judged, and a verbatim drop needs the same
        // decision (approve it, edit it, or let the agent tidy it up). The whole
        // group goes to the card so multiple drafts are tabs of one review rather
        // than a count the reader has to go elsewhere to act on.
        if (response.notes.length > 0) {
          setDraftCardIds(response.notes.map((note) => note.id));
        }
        // The badge reads `counts.draft`, which is the server's tally as of the last
        // refetch — so without this the ball claimed "0 pending" for a draft that was
        // sitting right there, most visibly after the card was dismissed and the
        // queue was the only place left to find it. The overlay above holds the row
        // for rendering; it deliberately does not invent a count (see `drafts`).
        void refresh();
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
        // The user pressed cancel: the abort *is* the outcome, and a sentence about
        // it would be the app arguing with a decision the user just made.
        if (intent.signal?.aborted) {
          return { ok: false, canceled: true, notes: [], duplicates: [], redacted: 0 };
        }
        // "This already exists" is an answer with somewhere to go, so it is lifted out
        // of the error string: the caller links to the row that owns the title instead
        // of telling the user off for pressing a button twice.
        const body = (err as { body?: Record<string, unknown> }).body;
        const duplicates = Array.isArray(body?.duplicates)
          ? (body?.duplicates as DuplicateRef[])
          : [];
        return {
          ok: false,
          // The failure codes travel in the response body, and they are the key the
          // UI translates from — the raw `status: message` string is never shown.
          code: typeof body?.code === 'string' ? body.code : undefined,
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

  /**
   * Write a server answer into the overlay; a row the list owns is its business.
   *
   * Internal on purpose: it is in the value's dependency list (every write callback
   * uses it) but *not* in `NotesContextValue`, and it used to be both — an excess
   * property a consumer could neither see nor call, which is the same drift as a
   * documented function that does not exist.
   */
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
        // The tab leaves the card; the rest of the capture stays for review.
        setDraftCardIds((current) => current.filter((item) => item !== id));
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
        // A reject answers with `{ deleted }`, not a note: the draft's body, evidence,
        // relations and index row are gone and only its `reject` event survives (that
        // is what the approval rate counts). So the row is *dropped* from the overlay
        // instead of being rewritten with the server's copy — the mistake this overlay
        // made once already was holding an object for a row that no longer existed.
        const response = await apiRequest<{ deleted?: boolean; id?: string; note?: Note }>(
          `/api/notes/${id}/review`,
          { method: 'POST', body: JSON.stringify({ decision: 'reject', reason }) },
        );
        if (response.deleted) setCaptured((prev) => prev.filter((note) => note.id !== id));
        else if (response.note) applyNote(response.note);
        // Same rule as an approval: the deleted draft's tab goes, the group stays.
        setDraftCardIds((current) => current.filter((item) => item !== id));
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

  const dismissDraftCard = useCallback(() => setDraftCardIds([]), []);

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
      // Same rule as a capture: a row is created with `updated_at = now`, so it sorts
      // to the top of page 1 and a reader left on page 3 would see the editor open on
      // a note the list does not show.
      setPageState(1);
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
        const response = await apiRequest<{ note?: Note; deleted?: boolean; id?: string }>(
          `/api/notes/${id}`,
          { method: 'DELETE' },
        );
        // The row leaves the current filter; writing the server's `archived` copy into
        // the overlay is what makes it leave the screen too. `deleted` is the draft
        // branch of the same verb (a draft has no archive to wait in), and there the
        // row has to be dropped rather than rewritten.
        if (response.note) applyNote(response.note);
        else setCaptured((prev) => prev.filter((note) => note.id !== id));
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
   * Erase one archived note — body, sources, relations and review records included.
   *
   * `409`/`404` on a refusal are *answers*, so they come back as codes and the list is
   * refetched: a row restored in another tab has left the archived filter, and the
   * page behind the dialog must not keep rendering it. Only an unrecognized failure
   * (network, 500) lands in `error`, because that one has no sentence of its own and
   * must not be explained away as "it is not archived any more".
   */
  const purgeNote = useCallback(
    async (id: string, title: string): Promise<PurgeOutcome> => {
      try {
        await apiRequest<{ purged: true }>(`/api/notes/${id}/purge`, {
          method: 'DELETE',
          body: JSON.stringify({ title }),
        });
        // Nothing comes back to write into the overlay — the row does not exist. It has
        // to be dropped from it explicitly: `refresh()` clears only the ids the new list
        // returns, so a note the server has forgotten would keep rendering from here.
        setCaptured((prev) => prev.filter((note) => note.id !== id));
        await refresh();
        return 'ok';
      } catch (err) {
        const status = (err as { status?: number }).status;
        // The title was wrong while the row was still a candidate: the list did not
        // move, so there is nothing to refetch and the dialog keeps the typed text.
        if (status === 422) return 'title_mismatch';
        if (status === 404 || status === 409) {
          // The row moved under the open dialog: purged somewhere else (404) or
          // restored there (409). Either way the archived list is now a lie, so it is
          // refetched before the caller decides what to say.
          if (status === 404) setCaptured((prev) => prev.filter((note) => note.id !== id));
          await refresh();
          return status === 404 ? 'not_found' : 'not_archived';
        }
        setError(describeError(err));
        return 'failed';
      }
    },
    [refresh],
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
    void putConfig({ 'notes.ball.show': !hidden }).catch(() => {
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
      available,
      query,
      setQuery,
      refresh,
      page,
      pageCount,
      total,
      setPage,
      capturing,
      draftCardIds,
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
      purgeNote,
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
      available,
      query,
      setQuery,
      refresh,
      page,
      pageCount,
      total,
      setPage,
      capturing,
      draftCardIds,
      capture,
      fetchNote,
      approve,
      discardDraft,
      stats,
      dismissDraftCard,
      createNoteInternal,
      updateNote,
      togglePin,
      archiveNote,
      restoreNote,
      purgeNote,
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
