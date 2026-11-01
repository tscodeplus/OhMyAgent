/**
 * The notes layer's shared contract: closed sets, the stored row shape, and the
 * shapes the repository/service/HTTP boundary speak.
 *
 * Two shapes per concept, the same split the memory layer uses:
 *
 *   - `NoteRow` / `NoteSourceRow` mirror the v31 tables — snake_case columns,
 *     JSON columns still as the TEXT they are stored as.
 *   - `Note` / `NoteSource` are the parsed form (camelCase, arrays, epoch-ms
 *     numbers). This is also the REST payload and the WebUI's `Note` type, so
 *     there is exactly one note shape above the database.
 *
 * Every closed set is a union plus an `is*` guard rather than a free string:
 * `kind` is a classification *suggestion* (it never rejects a note), but it
 * still has to be one of the eight so filtering and counts mean something.
 */

/** What a note is about. `other` is the deliberate catch-all (plan §4.3). */
export const NOTE_KINDS = [
  'command',
  'workflow',
  'pitfall',
  'insight',
  'opinion',
  'reference',
  'decision',
  'other',
] as const;

export type NoteKind = (typeof NOTE_KINDS)[number];

export function isNoteKind(value: unknown): value is NoteKind {
  return typeof value === 'string' && (NOTE_KINDS as readonly string[]).includes(value);
}

/**
 * Optional structured slots per kind (plan §4.3).
 *
 * These are *suggestions* — the distiller fills whichever it has something to
 * say about and the body stays authoritative. A key outside this table is
 * dropped at validation time, because a slot no renderer knows about would be
 * stored forever and never shown.
 */
export const NOTE_FIELDS: Record<NoteKind, readonly string[]> = {
  command: ['command', 'when', 'gotcha'],
  workflow: ['steps', 'checkpoint'],
  pitfall: ['symptom', 'cause', 'fix'],
  insight: ['claim', 'why'],
  opinion: ['stance', 'source'],
  reference: ['subject', 'usage', 'limits'],
  decision: ['decision', 'context', 'alternatives'],
  other: [],
};

/**
 * Outcome of a status change.
 *
 * `undefined` still means "no such row" (the convention `get()`/`update()` use);
 * a promotion that collides with an active note returns the conflict instead of
 * throwing, so the review route can answer 422 with the note that owns the title.
 */
export type SetStatusResult =
  { ok: true; note: Note } | { ok: false; code: 'title_conflict'; existingId: string };

/** Slot keys the HTTP layer accepts (`fields: [{ key, value, mono? }]`). */
export function isNoteFieldKey(kind: NoteKind, key: string): boolean {
  return (NOTE_FIELDS[kind] as readonly string[]).includes(key);
}

/**
 * Lifecycle (plan §6). `active` is the only status the default read filter
 * shows; `draft` is the review queue, `archived` is history that is never
 * physically deleted.
 */
export const NOTE_STATUSES = ['draft', 'active', 'archived'] as const;

export type NoteStatus = (typeof NOTE_STATUSES)[number];

export function isNoteStatus(value: unknown): value is NoteStatus {
  return typeof value === 'string' && (NOTE_STATUSES as readonly string[]).includes(value);
}

/** Why a note left `active`/`draft`. Closed set: the tally is the useful part. */
export const NOTE_STATUS_REASONS = ['rejected', 'expired', 'superseded', 'user'] as const;

/**
 * Why a reviewer rejected a draft (plan §6).
 *
 * A closed set, not free text: the value of asking is the tally — "nine of fifty
 * drafts were called duplicates" is a statement about the distillation prompt,
 * while nine sentences saying roughly that are not. The `note_events.detail`
 * column carries the code; `notes.status_reason` stays `rejected`.
 */
export const NOTE_REJECTION_CODES = [
  'recap',
  'thin',
  'inaccurate',
  'not_reusable',
  'duplicate',
  'private',
  'other',
] as const;

export type NoteRejectionCode = (typeof NOTE_REJECTION_CODES)[number];

export function isNoteRejectionCode(value: unknown): value is NoteRejectionCode {
  return typeof value === 'string' && (NOTE_REJECTION_CODES as readonly string[]).includes(value);
}

export type NoteStatusReason = (typeof NOTE_STATUS_REASONS)[number];

export function isNoteStatusReason(value: unknown): value is NoteStatusReason {
  return typeof value === 'string' && (NOTE_STATUS_REASONS as readonly string[]).includes(value);
}

/** Where a note is visible. Same first three levels as `memories.scope`. */
export const NOTE_SCOPES = ['user', 'project', 'channel', 'session'] as const;

export type NoteScope = (typeof NOTE_SCOPES)[number];

export function isNoteScope(value: unknown): value is NoteScope {
  return typeof value === 'string' && (NOTE_SCOPES as readonly string[]).includes(value);
}

/**
 * Authorship, which decides whether review is required (plan §4.2-2).
 * Deliberately not "who triggered it": a user asking the agent to draft a note
 * still gets a draft.
 */
export const NOTE_ORIGINS = ['user', 'agent'] as const;

export type NoteOrigin = (typeof NOTE_ORIGINS)[number];

export function isNoteOrigin(value: unknown): value is NoteOrigin {
  return typeof value === 'string' && (NOTE_ORIGINS as readonly string[]).includes(value);
}

/** The platform a note came from. A fact, shown as a facet — never a permission. */
export const NOTE_CHANNELS = ['feishu', 'telegram', 'wechat', 'qq', 'webui', 'cron'] as const;

export type NoteChannel = (typeof NOTE_CHANNELS)[number];

export function isNoteChannel(value: unknown): value is NoteChannel {
  return typeof value === 'string' && (NOTE_CHANNELS as readonly string[]).includes(value);
}

/** What a note can cite (plan §4.7). Soft references: no foreign keys. */
export const NOTE_SOURCE_KINDS = ['message', 'memory', 'session'] as const;

export type NoteSourceKind = (typeof NOTE_SOURCE_KINDS)[number];

export function isNoteSourceKind(value: unknown): value is NoteSourceKind {
  return typeof value === 'string' && (NOTE_SOURCE_KINDS as readonly string[]).includes(value);
}

/** Append-only log actions. */
export const NOTE_EVENT_ACTIONS = [
  'create',
  'draft',
  'approve',
  'reject',
  'edit',
  'pin',
  'unpin',
  'archive',
  'restore',
  'view',
] as const;

export type NoteEventAction = (typeof NOTE_EVENT_ACTIONS)[number];

export const NOTE_EVENT_ACTORS = ['agent', 'user', 'system'] as const;

export type NoteEventActor = (typeof NOTE_EVENT_ACTORS)[number];

/** Capture outcomes. `invalid` is "the model produced nothing usable". */
export const CAPTURE_STATUSES = ['ok', 'empty', 'invalid', 'failed'] as const;

export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

/**
 * How the capture window was chosen (plan §5.1).
 *
 * `turn` is one exchange, `recent` is the last `windowTurns` exchanges, `session` is
 * everything the token budget allows — the difference matters because "summarise this
 * conversation" cannot be served by a suffix and then described as the whole.
 */
export const CAPTURE_MODES = ['turn', 'recent', 'session', 'selection', 'text'] as const;

export type CaptureMode = (typeof CAPTURE_MODES)[number];

export function isCaptureMode(value: unknown): value is CaptureMode {
  return typeof value === 'string' && (CAPTURE_MODES as readonly string[]).includes(value);
}

/** One structured slot, already parsed and typed for rendering. */
export interface NoteField {
  /** Slot name from `NOTE_FIELDS[kind]`. The label is the client's i18n key. */
  key: string;
  value: string;
  /** `true` renders a copy button (commands, paths, config keys). */
  mono?: boolean;
}

export interface NoteSource {
  kind: NoteSourceKind;
  id: string;
  excerpt: string;
  at: number;
  /** Resolved at read time; `false` is a citation whose row no longer exists. */
  available: boolean;
  /**
   * The conversation a message source lives in, so the UI can show it in place
   * (plan §4.7). Only message sources have one — a session source *is* one, and a
   * memory source belongs to no conversation at all. Resolved at read time, so a
   * message whose row is gone carries no session either.
   */
  sessionId?: string | null;
}

/**
 * A neighbour in the 「相关」 list.
 *
 * `basis` is *why*, and it is stored rather than recomputed at read time so that
 * "why is this related?" has one answer shared by the API, the UI and any script
 * inspecting the table. See `relations.ts` for the three rules.
 */
export interface NoteRelated {
  id: string;
  title: string;
  kind: NoteKind;
  basis: NoteRelationBasis;
}

/** The signal that made a pair related. Strongest first (see `relations.ts`). */
export const NOTE_RELATION_BASES = ['session', 'title', 'tags'] as const;
export type NoteRelationBasis = (typeof NOTE_RELATION_BASES)[number];

export function isRelationBasis(value: unknown): value is NoteRelationBasis {
  return typeof value === 'string' && (NOTE_RELATION_BASES as readonly string[]).includes(value);
}

/** A note as stored (`notes` row). JSON columns are TEXT or NULL. */
export interface NoteRow {
  id: string;
  kind: string;
  title: string;
  normalized_title: string;
  summary: string;
  body: string;
  fields: string | null;
  tags: string | null;
  status: string;
  status_reason: string | null;
  origin: string;
  scope: string;
  scope_key: string;
  session_id: string | null;
  channel: string | null;
  pinned: number;
  confidence: number | null;
  version: number;
  capture_id: string | null;
  superseded_by: string | null;
  view_count: number;
  last_viewed_at: number | null;
  reviewed_by: string | null;
  reviewed_at: number | null;
  created_at: number;
  updated_at: number;
}

/** A note as every layer above the repository sees it. */
export interface Note {
  id: string;
  kind: NoteKind;
  title: string;
  summary: string;
  body: string;
  fields: NoteField[];
  tags: string[];
  status: NoteStatus;
  statusReason: NoteStatusReason | null;
  origin: NoteOrigin;
  scope: NoteScope;
  scopeKey: string;
  sessionId: string | null;
  channel: NoteChannel | null;
  pinned: boolean;
  confidence: number | null;
  version: number;
  captureId: string | null;
  viewCount: number;
  lastViewedAt: number | null;
  reviewedAt: number | null;
  createdAt: number;
  updatedAt: number;
  sources: NoteSource[];
  related: NoteRelated[];
  /**
   * Display name of the note's project, resolved at read time from `projects`.
   *
   * Resolved, not stored: the facet must follow a rename (plan §4.6), while the
   * FTS index keeps whatever name it was indexed under.
   */
  projectName?: string;
  /**
   * The origin conversation's title, if it has one.
   *
   * A title, not a label: the client composes `<channel> · <title>` so the
   * channel name arrives in the user's language. Formatting it here would put a
   * translated word in the payload and make the same row read differently
   * depending on which language rendered it.
   */
  sessionTitle?: string | null;
}

export interface NoteSourceInput {
  kind: NoteSourceKind;
  id: string;
  excerpt?: string;
}

export interface CreateNoteInput {
  kind: NoteKind;
  title: string;
  summary: string;
  body: string;
  fields?: NoteField[];
  tags?: string[];
  status: NoteStatus;
  statusReason?: NoteStatusReason | null;
  origin: NoteOrigin;
  scope: NoteScope;
  scopeKey: string;
  sessionId?: string | null;
  channel?: NoteChannel | null;
  confidence?: number | null;
  captureId?: string | null;
  sources?: NoteSourceInput[];
  /** Actor recorded in `note_events` for the create. */
  actor?: NoteEventActor;
  now?: number;
}

export interface UpdateNoteInput {
  title?: string;
  kind?: NoteKind;
  summary?: string;
  body?: string;
  fields?: NoteField[];
  tags?: string[];
  scope?: NoteScope;
  scopeKey?: string;
  /**
   * Optimistic concurrency: the version the caller read. Omitted is allowed only
   * for changes that cannot destroy a body (pin, status) — a body edit without
   * it is refused (plan §4.2-4).
   */
  expectedVersion?: number;
  actor?: NoteEventActor;
  now?: number;
}

export interface CaptureRunInput {
  sessionId: string;
  scope: NoteScope;
  mode: CaptureMode;
  messageIds: string[];
  tokenEst: number;
  modelRef?: string | null;
  status: CaptureStatus;
  error?: string | null;
  noteCount?: number;
  /**
   * Messages the window's budget removed from the old end (v34). Stored, not just
   * reported: "how much of the conversation did this note see" is the first question
   * asked of a note that turned out thin, and a toast cannot answer it a day later.
   */
  droppedMessages?: number;
}

export interface NoteListQuery {
  status: NoteStatus;
  kind?: NoteKind;
  /**
   * Facet filters, each a set: **OR inside a field, AND across fields** — "any of
   * these authors, in any of these channels, carrying any of these tags". That is
   * what a filter row of checkboxes means, and it is why these are arrays: a
   * singular field would have forced the UI to offer one value per facet while
   * looking like it offered many.
   *
   * Empty/absent = that facet is not filtered at all.
   */
  origins?: NoteOrigin[];
  channels?: NoteChannel[];
  /** Project ids, matched against `scope='project'` notes; the name is resolved. */
  projectIds?: string[];
  tags?: string[];
  /** FTS query. Empty = browse, ordered by pin then `updated_at`. */
  q?: string;
  /** Read rule context (plan §4.2-5). Omitted = unscoped (console browse). */
  context?: NoteScopeContext | null;
  limit?: number;
  offset?: number;
}

export interface NoteScopeContext {
  /** The project the caller is in, when it is in one. */
  projectId?: string | null;
  /** `<channel>:<chatId>` for the conversation being served. */
  channelKey?: string | null;
  sessionId?: string | null;
}

export interface NoteListResult {
  notes: Note[];
  total: number;
  counts: Record<NoteStatus, number>;
  /**
   * The filter row's options, computed from `status` + scope only — never from the
   * current filters, or narrowing one facet would empty the control meant to widen it.
   */
  tags: Array<{ tag: string; count: number }>;
  channels: Array<{ channel: NoteChannel; count: number }>;
  projects: Array<{ id: string; name: string; count: number }>;
}
