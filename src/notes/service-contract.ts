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

/** Everything a capture can be asked for. `text`/`messageIds` per mode (§5.1). */
export interface CaptureRequest {
  sessionId: string;
  mode: CaptureMode;
  /** `selection` mode. */
  messageIds?: string[];
  /** `text` mode — verbatim user content; no message is read. */
  text?: string;
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
  'disabled' | 'no_session' | 'empty_window' | 'model_failed' | 'invalid' | 'no_notes';

export type CaptureResult =
  | {
      ok: true;
      captureId: string;
      /** Drafts, newest first. Empty only for `text` (which lands active). */
      notes: Note[];
      /** How many credential-shaped spans the redactor hid (§5.2). */
      redacted: number;
      /** Drafts dropped as recaps, for the diagnostic log. */
      droppedRecaps: number;
    }
  | {
      ok: false;
      code: CaptureFailureCode;
      captureId?: string;
      /** Operator-facing sentence; the route maps it to a status code. */
      message: string;
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
  byKind: Record<string, number>;
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
  /**
   * The session's last user message, so the "keep just this sentence" dialog opens
   * with something in it. `null` when the session has no user message yet.
   */
  prefill(sessionId: string): string | null;
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
