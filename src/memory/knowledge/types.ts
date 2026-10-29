/**
 * Shared contract for the knowledge layer (K2).
 *
 * Pure types and the closed sets they are built from — no database access, no
 * imports from other layers, so every consumer (repository, tools, WebUI routes,
 * curation) can depend on this file without pulling a dependency in.
 *
 * Two shapes per concept, deliberately:
 *   - the row interface mirrors the v14 tables (snake_case column names, JSON
 *     columns as the raw TEXT they are stored as)
 *   - the input types are what a caller passes (camelCase, JSON columns as
 *     arrays, which the repository serialises)
 *
 * `page_type` is a closed set, not a free string: inferring a type from a name's
 * shape is exactly how `Power Query` ended up typed as a person in the old
 * graph. Values written outside the set are a caller bug, so the type is a union
 * and callers validate untrusted input with `isPageType`.
 */

/** The page kinds a knowledge page can be. Closed set — see `isPageType`. */
export const PAGE_TYPES = ['entity', 'project', 'topic', 'decision', 'snippet'] as const;

export type PageType = (typeof PAGE_TYPES)[number];

export function isPageType(value: unknown): value is PageType {
  return typeof value === 'string' && (PAGE_TYPES as readonly string[]).includes(value);
}

/**
 * Page lifecycle. `active` is the only status every reader sees (search, get,
 * per-turn injection, link resolution, export); `pending` is curation written in
 * shadow mode and visible only from the WebUI pending list; `archived` is a page
 * kept for history but no longer offered.
 */
export const KNOWLEDGE_PAGE_STATUSES = ['active', 'pending', 'archived'] as const;

export type KnowledgePageStatus = (typeof KNOWLEDGE_PAGE_STATUSES)[number];

/** What a page can cite. Each id must resolve in its own table at write time. */
export const KNOWLEDGE_SOURCE_KINDS = ['memory', 'message', 'session'] as const;

export type KnowledgeSourceKind = (typeof KNOWLEDGE_SOURCE_KINDS)[number];

/** Append-only change-log actions. */
export const KNOWLEDGE_LOG_ACTIONS = ['create', 'update', 'link', 'pending', 'merge'] as const;

export type KnowledgeLogAction = (typeof KNOWLEDGE_LOG_ACTIONS)[number];

export const KNOWLEDGE_LOG_ACTORS = ['agent', 'user', 'system'] as const;

export type KnowledgeLogActor = (typeof KNOWLEDGE_LOG_ACTORS)[number];

/**
 * A `knowledge_pages` row as stored.
 *
 * `aliases` and `tags` are JSON array text (e.g. `'["PQ"]'`) or NULL — parse
 * them at the boundary; a malformed value is data corruption, not an empty list.
 * `version` is the optimistic-concurrency token: an update must supply the
 * version it read (`expectedVersion`).
 */
export interface KnowledgePage {
  id: string;
  page_type: PageType;
  slug: string;
  title: string;
  content: string;
  aliases: string | null;
  tags: string | null;
  confidence: number | null;
  version: number;
  status: KnowledgePageStatus;
  created_at: number | null;
  updated_at: number | null;
  updated_by: string | null;
}

/** A `knowledge_sources` row: one citation from a page to a memory/message/session. */
export interface KnowledgeSource {
  page_id: string;
  source_kind: KnowledgeSourceKind;
  source_id: string;
  created_at: number | null;
}

/** A `knowledge_links` row: one parsed `[[wikilink]]` from one page to another. */
export interface KnowledgeLink {
  from_page_id: string;
  to_page_id: string;
  label: string | null;
  created_at: number | null;
}

/**
 * One incoming `[[wikilink]]`, flattened for a reader.
 *
 * A read projection, not a table row: the linking page's address and name come
 * from `knowledge_pages`, the label from the link the author wrote. This is what
 * `KnowledgeRepository.linksTo()` joins, and it is the shape the page-detail API
 * and the WebUI render — a `KnowledgeLink` would force every caller to re-read
 * the page row to name the linker.
 */
export interface KnowledgeBacklink {
  slug: string;
  title: string;
  label: string | null;
}

/** A `knowledge_log` row. Append-only; `page_id` is NULL for global actions. */
export interface KnowledgeLogEntry {
  id: string;
  page_id: string | null;
  action: KnowledgeLogAction;
  actor: KnowledgeLogActor;
  version: number | null;
  reason: string | null;
  created_at: number;
}

/** One citation passed to a write. `id` must exist in the table its `kind` names. */
export interface KnowledgeSourceInput {
  kind: KnowledgeSourceKind;
  id: string;
}

/**
 * Create a page. `sources` is required and must hold at least one resolvable id:
 * a page nobody can trace back to a memory/message/session is how the knowledge
 * layer would start inventing facts.
 */
export interface CreateKnowledgePageInput {
  pageType: PageType;
  slug: string;
  title: string;
  content: string;
  aliases?: string[];
  tags?: string[];
  confidence?: number;
  /** Defaults to 'active'; curation in shadow mode writes 'pending'. */
  status?: KnowledgePageStatus;
  /** 'agent' | 'user' | 'import' — recorded on the row and in the log. */
  updatedBy?: string;
  sources: KnowledgeSourceInput[];
  reason?: string;
}

/**
 * Update a page. `expectedVersion` is the version the caller read; a mismatch is
 * refused rather than overwritten (the refusal returns the current body so the
 * writer can re-merge instead of clobbering a newer edit). Omitting it is the
 * "I did not read this page, create/append only" case and must not be used to
 * overwrite a body.
 *
 * `sources`, when given, replace the page's citation set (not append).
 */
export interface UpdateKnowledgePageInput {
  title?: string;
  content?: string;
  aliases?: string[];
  tags?: string[];
  confidence?: number;
  status?: KnowledgePageStatus;
  updatedBy?: string;
  expectedVersion?: number;
  sources?: KnowledgeSourceInput[];
  reason?: string;
}
