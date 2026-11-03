/**
 * Notes UI types — the front-end half of `MyDocs/NOTES_LAYER_PLAN.md`, and the
 * shape `GET /api/notes` answers with.
 *
 * Kept hand-written rather than generated: the server types
 * (`src/notes/types.ts`) and this file are two views of one contract, and the
 * moment they disagree the compiler cannot help (different `tsconfig` projects).
 * `tests/notes/routes.test.ts` pins the payload; this file mirrors it.
 */

/**
 * Where a note is visible (plan §4.2-5). Mirrors `memories.scope` plus `channel`.
 * There is no kind: the aspect dimension is one optional tag (`pitfall`, `command`,
 * …) — see the server's `src/notes/types.ts`.
 */
export const NOTE_SCOPES = ['user', 'project', 'channel', 'session'] as const;

export type NoteScope = (typeof NOTE_SCOPES)[number];

export type NoteOrigin = 'user' | 'agent';

export type NoteChannel = 'feishu' | 'telegram' | 'wechat' | 'qq' | 'webui' | 'cron';

export type NoteStatus = 'draft' | 'active' | 'archived';

/** Why a note left the library. The rejection *code* lives in the server's log. */
export type NoteStatusReason = 'rejected' | 'expired' | 'superseded' | 'user';

/**
 * Why a reviewer rejected a draft (plan §6) — mirrors `NOTE_REJECTION_CODES`.
 *
 * Asked for on the review row and not on the floating card: the card's delete is a
 * shortcut for "get this off my screen" mid-conversation, while the review row is a
 * deliberate visit where a verdict is worth recording. A tally built from the second
 * place means something; one built from both would be mostly `other`.
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

/** One citation. `available: false` is the soft-reference case (plan §4.7). */
export interface NoteSource {
  kind: 'message' | 'memory' | 'session';
  id: string;
  excerpt: string;
  at: number;
  available: boolean;
  /** The conversation a message lives in; null for session/memory sources. */
  sessionId?: string | null;
}

/**
 * Why two notes are related, mirroring `NOTE_RELATION_BASES` on the server
 * (`src/notes/types.ts`). Stored, not derived: the list has to be able to say *why*
 * without re-running the rules in the browser.
 */
export type NoteRelationBasis = 'session' | 'title' | 'tags';

export interface NoteRelated {
  id: string;
  title: string;
  basis: NoteRelationBasis;
}

/**
 * One optional structured slot; the body stays authoritative (plan §4.3).
 *
 * `key` is a free-form slot name (`command`, `symptom`, `fix`…), not a translated
 * label: the UI shows the key itself, with `notes.field.<key>` from this app's
 * dictionaries as a translation when one exists.
 */
export interface NoteField {
  key: string;
  value: string;
  /** `true` renders a copy button next to the value (commands, paths). */
  mono?: boolean;
}

export interface Note {
  id: string;
  title: string;
  summary: string;
  body: string;
  fields: NoteField[];
  tags: string[];
  status: NoteStatus;
  statusReason: NoteStatusReason | null;
  /** Who wrote it — decides whether it needed review (plan §4.2-2). */
  origin: NoteOrigin;
  scope: NoteScope;
  /** `''` for `user`, projectId / `<channel>:<chatId>` / sessionId otherwise. */
  scopeKey: string;
  sessionId: string | null;
  channel: NoteChannel | null;
  pinned: boolean;
  confidence: number | null;
  /** Optimistic-concurrency token: send it back with every content edit. */
  version: number;
  captureId: string | null;
  viewCount: number;
  lastViewedAt: number | null;
  reviewedAt: number | null;
  createdAt: number;
  updatedAt: number;
  sources: NoteSource[];
  related: NoteRelated[];
  /** Resolved server-side from `projects.name`; follows a rename. */
  projectName?: string;
  /** The origin conversation's title; the client composes `<channel> · <title>`. */
  sessionTitle?: string | null;
}

/**
 * Rows one page of the library holds.
 *
 * Matches the server's `DEFAULT_LIST_LIMIT`, because page 1 is whatever the provider
 * asks for and the pager derives every other offset (`(page - 1) * NOTES_PAGE_SIZE`)
 * from it. A different number on either side would make page 2 repeat or skip rows.
 */
export const NOTES_PAGE_SIZE = 20;

/** What `GET /api/notes` answers: rows plus the counters and facets the page needs. */
export interface NoteListResult {
  notes: Note[];
  total: number;
  counts: Record<NoteStatus, number>;
  /** Facets describe the library under the current status, not the filtered rows. */
  tags: Array<{ tag: string; count: number }>;
  channels: Array<{ channel: NoteChannel; count: number }>;
  projects: Array<{ id: string; name: string; count: number }>;
}
