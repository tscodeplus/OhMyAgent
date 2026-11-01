/**
 * The contract between the notes service and its callers (HTTP routes, and later
 * the `/note` command). Types only — no database access — so the route module and
 * the tests can depend on it without pulling the implementation in.
 */

import type {
  CaptureMode,
  Note,
  NoteEventActor,
  NoteField,
  NoteKind,
  NoteListQuery,
  NoteListResult,
  NoteRejectionCode,
  NoteScope,
  NoteSourceInput,
  NoteStatus,
  NoteStatusReason,
} from './types.js';
import type { NotesThinkingMode } from '../memory/aux-call-options.js';

/**
 * What to do with the material, which is a different question from where it came
 * from (`mode`).
 *
 *   - `distill` — the model reads it and proposes notes. The default for a
 *     conversation window, and what the ballistic-capture modes always do.
 *   - `verbatim` — store the text as the user handed it over. No model call, no
 *     recap gate: dropping a selection on the ball means "keep these words", and
 *     paraphrasing them is the one thing that would make it useless.
 *
 * Only `text` mode can be `verbatim`; every other mode reads stored rows the user
 * did not author.
 */
export type CaptureTreatment = 'distill' | 'verbatim';

/** Everything a capture can be asked for. `text`/`messageIds` per mode (§5.1). */
export interface CaptureRequest {
  sessionId: string;
  mode: CaptureMode;
  /**
   * `distill` | `verbatim`. Defaults to `verbatim` for `text` mode and `distill`
   * for every other mode, because `text` is the one mode where the material is
   * already the user's own words.
   */
  treatment?: CaptureTreatment;
  /** `selection` mode. */
  messageIds?: string[];
  /** `text` mode — the content itself; no message is read. */
  text?: string;
  /**
   * A free-form instruction from the user ("keep the command you shared", "turn
   * today's chat into notes, not the earlier stuff").
   *
   * It is passed to the distiller as the requirement it must satisfy, and it
   * also relaxes two defaults that exist to second-guess a free-running model:
   * the recap gate stops dropping notes, and the window opens wider than one
   * turn. Both are heuristics for "the model decided on its own"; an explicit
   * instruction is not.
   */
  instruction?: string;
  /** Overrides the inferred kind (a `--kind pitfall` style hint). */
  kind?: NoteKind;
  /** Overrides the inferred scope. `session` can only arrive this way (§5.7). */
  scope?: NoteScope;
  scopeKey?: string;
  /** Number of turns for `recent`. */
  turns?: number;
  /**
   * `p2p` | `group` when the channel knows it. A group chat's note defaults to
   * the `channel` scope so it cannot leak into the person's own library (§4.5).
   */
  chatType?: string;
  /** Who triggered it, for the log. */
  actor?: NoteEventActor;
}

export type CaptureFailureCode =
  | 'disabled'
  | 'no_session'
  | 'empty_window'
  | 'model_failed'
  | 'invalid'
  | 'no_notes'
  | 'duplicate';

/** A candidate the library already holds, so no second row was created (§5.5). */
export interface DuplicateNote {
  title: string;
  existingId: string;
  /** `active` means "already a note"; `draft` means "already waiting for review". */
  status: NoteStatus;
}

export type CaptureResult =
  | {
      ok: true;
      captureId: string;
      /** Drafts, newest first. Every one of them still needs approval. */
      notes: Note[];
      /** Candidates skipped because their title is already taken in this scope. */
      duplicates: DuplicateNote[];
      /** How many credential-shaped spans the redactor hid (§5.2). */
      redacted: number;
      /** Drafts dropped as recaps, for the diagnostic log. */
      droppedRecaps: number;
      /** Messages the window actually held, and the mode it was read in. */
      readMessages: number;
      /**
       * Messages the token/character budget removed from the **old** end. Non-zero
       * means the note was written from the tail of the conversation, and the reply
       * says so — a reviewer cannot judge a note whose material silently stopped
       * halfway.
       */
      droppedMessages: number;
      /**
       * The scope the model reported for a brief like "only the last 3 turns", after it
       * was enforced. Present only when the brief stated one — it is what makes the
       * note's material auditable instead of a matter of trust.
       */
      appliedScope?: { turns?: number; chars?: number };
    }
  | {
      ok: false;
      code: CaptureFailureCode;
      captureId?: string;
      /** Operator-facing sentence; the route maps it to a status code. */
      message: string;
      /** Present for `duplicate`: the rows that already own these titles. */
      duplicates?: DuplicateNote[];
    };

/** A user writing a note by hand (WebUI editor, `/note --text`). Lands `active`. */
export interface ManualNoteInput {
  title: string;
  summary?: string;
  body: string;
  kind?: NoteKind;
  fields?: NoteField[];
  tags?: string[];
  scope?: NoteScope;
  scopeKey?: string;
  sessionId?: string | null;
  channel?: Note['channel'];
  actor?: NoteEventActor;
}

export type ManualNoteResult =
  { ok: true; note: Note } | { ok: false; code: 'title_conflict'; existingId: string };

export interface UpdateResult {
  ok: boolean;
  note?: Note;
  code?: 'not_found' | 'version_mismatch' | 'version_required' | 'title_conflict';
  currentVersion?: number;
  currentBody?: string;
  existingId?: string;
}

export interface ReviewDecision {
  decision: 'approve' | 'reject';
  /** Only for `reject`: the closed-set code recorded in `note_events.detail`. */
  reason?: NoteRejectionCode;
  actor?: NoteEventActor;
}

export interface NotesStats {
  byStatus: Record<NoteStatus, number>;
  /** Drafts that will expire within a day — what the badge should nag about. */
  draftsDue: number;
  /** Approvals per active note, the crude "is review working" number. */
  approvalRate: number;
}

/**
 * The service's public surface. The WebUI routes are a thin HTTP wrapper around
 * exactly these methods, which is what keeps "the REST contract" and "the UI
 * contract" the same shape.
 */
export interface NotesService {
  capture(request: CaptureRequest): Promise<CaptureResult>;
  createManual(input: ManualNoteInput): ManualNoteResult;
  list(query: NoteListQuery): NoteListResult;
  get(id: string): Note | undefined;
  update(
    id: string,
    patch: {
      title?: string;
      kind?: NoteKind;
      summary?: string;
      body?: string;
      fields?: NoteField[];
      tags?: string[];
      scope?: NoteScope;
      scopeKey?: string;
      expectedVersion?: number;
    },
    actor?: NoteEventActor,
  ): UpdateResult;
  review(id: string, decision: ReviewDecision): UpdateResult;
  pin(id: string, pinned: boolean): UpdateResult;
  archive(id: string, reason?: NoteStatusReason): UpdateResult;
  restore(id: string): UpdateResult;
  recordView(id: string): void;
  stats(): NotesStats;
}

/** Runtime knobs the service reads per call (hot-reloadable, unlike construction). */
export interface NotesRuntimeConfig {
  maxNotesPerCapture: number;
  windowTurns: number;
  tokenBudget: number;
  includeTools: 'off' | 'args';
  redact: boolean;
  /** Body cap per note, in characters. */
  bodyMaxChars: number;
  /** Output budget; undefined = derive from bodyMaxChars x maxNotesPerCapture. */
  maxOutputTokens?: number;
  /**
   * Whether the distillation call may think. `inherit` = whatever
   * `memory_aux_models.thinking` says, since the notes chain is built on the aux
   * chain and the deployment already has an opinion.
   */
  thinking: NotesThinkingMode;
  /** Sampling temperature for the distillation call; the repair retry halves it. */
  temperature: number;
  ttlDays: number;
  logRetentionDays: number;
  /** Empty = reuse `memory_aux_models`. */
  modelRef: string;
}

/** Construction-time config: changing these needs a new service instance. */
export interface NotesServiceConfig {
  enabled: boolean;
}

export type { NoteSourceInput };
