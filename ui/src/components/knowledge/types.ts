/**
 * Payloads of the knowledge-page API (`src/app/webui/knowledge-routes.ts`).
 *
 * The route renders rows in camelCase, so these mirror the HTTP shapes rather
 * than the `knowledge_pages` columns. `pageType` and the statuses are closed
 * sets on the server (`knowledge/types.ts`); they are repeated here because the
 * filters, the badges and the PUT guard all need the same vocabulary, and a
 * free string would let the UI offer a type the server rejects with a 400.
 */

/** Page kinds — must stay in step with `PAGE_TYPES` in `memory/knowledge/types.ts`. */
export const PAGE_TYPES = ['entity', 'project', 'topic', 'decision', 'snippet'] as const;
export type PageType = (typeof PAGE_TYPES)[number];

/**
 * Lifecycle. `pending` is only ever listed by the review queue: `GET /pages`
 * answers 400 for it, and `GET /page/:id` is active-only, so a pending body
 * arrives from `GET /pending` and nowhere else.
 */
export const KNOWLEDGE_PAGE_STATUSES = ['active', 'pending', 'archived'] as const;
export type KnowledgePageStatus = (typeof KNOWLEDGE_PAGE_STATUSES)[number];

/** What a page can cite. `page` is not in the API's set — pages cite rows. */
export const KNOWLEDGE_SOURCE_KINDS = ['memory', 'message', 'session'] as const;
export type KnowledgeSourceKind = (typeof KNOWLEDGE_SOURCE_KINDS)[number];

/** A `knowledge_pages` row as the WebUI consumes it. */
export interface KnowledgePagePayload {
  id: string;
  pageType: PageType;
  slug: string;
  title: string;
  content: string;
  aliases: string[];
  tags: string[];
  confidence: number | null;
  /** Optimistic-concurrency token: every PUT must echo the version it read. */
  version: number;
  status: KnowledgePageStatus;
  /**
   * The conversation this page belongs to (`memory/knowledge/scope.ts`):
   * `'global'` for a page the console wrote or a human approved, otherwise the
   * `channel:<chatId>` / `session:<id>` that produced it. Render it with
   * `compactScopeLabel` — the raw value is an address, not a label.
   */
  scope: string;
  /** Epoch milliseconds, not an ISO string — format with `formatRelativeTime`. */
  createdAt: number | null;
  updatedAt: number | null;
  updatedBy: string | null;
}

/** One citation of a page. */
export interface KnowledgeSourceRef {
  kind: KnowledgeSourceKind;
  id: string;
  createdAt: number | null;
}

/** One outgoing `[[wikilink]]`; `missing` means the target page does not exist yet. */
export interface KnowledgePageLink {
  slug: string;
  label: string | null;
  missing: boolean;
}

/**
 * One incoming `[[wikilink]]`: a page whose body cites this one.
 *
 * Outgoing links can be dangling; backlinks cannot — the server reads them from
 * `knowledge_links` joined to `knowledge_pages`, active pages only.
 */
export interface KnowledgeBacklink {
  slug: string;
  title: string;
  label: string | null;
}

/** `GET /api/knowledge/page/:id` and `GET /api/knowledge/page/:pageType/:slug`. */
export interface KnowledgePageDetailPayload {
  page: KnowledgePagePayload;
  sources: KnowledgeSourceRef[];
  links: KnowledgePageLink[];
  backlinks: KnowledgeBacklink[];
}

/** `GET /api/knowledge/pages` — `count` is the rows on this page, not a total. */
export interface KnowledgePageListPayload {
  pages: KnowledgePagePayload[];
  count: number;
  limit: number;
  offset: number;
}

/** `GET /api/knowledge/pending` — the review queue. */
export interface KnowledgePendingPayload {
  pages: KnowledgePagePayload[];
  count: number;
}

/** One full-text hit (`GET /api/knowledge/search`), already trimmed by the server. */
export interface KnowledgeSearchHit {
  id: string;
  slug: string;
  pageType: PageType;
  title: string;
  snippet: string;
  score: number;
}

export interface KnowledgeSearchPayload {
  q: string;
  hits: KnowledgeSearchHit[];
  count: number;
  limit: number;
}

/** `PUT /api/knowledge/page/:id` and `POST /api/knowledge/page`. */
export interface KnowledgeWriteAccepted {
  ok: true;
  created: boolean;
  id: string;
  slug: string;
  pageType: PageType;
  version: number;
  status: KnowledgePageStatus;
  /** `[[wikilinks]]` whose target page is absent — logged, never fatal. */
  danglingLinks: string[];
}

/** `POST /api/knowledge/page/:id/approve` and `/archive`. */
export interface KnowledgeStatusChangePayload {
  ok: true;
  id: string;
  status: KnowledgePageStatus;
  /** `null` when the page vanished in between, or (for archive) is no longer readable. */
  page: KnowledgePageDetailPayload | null;
}

/** `indexer.checkConsistency` — `null` in the stats payload means "not checked". */
export interface KnowledgeFtsConsistency {
  pageCount: number;
  indexedRowCount: number;
  duplicatePageIds: string[];
  missingPageIds: string[];
  orphanPageIds: string[];
  consistent: boolean;
}

/** `GET /api/knowledge/stats`. Pending rows are counted here, never returned. */
export interface KnowledgeStatsPayload {
  total: number;
  byStatus: Record<KnowledgePageStatus, number>;
  byPageType: Record<PageType, number>;
  fts: KnowledgeFtsConsistency | null;
}

/**
 * `PUT` body accepted by the route. `status` is deliberately absent: approval
 * and archival have their own endpoints, and the route rejects the field.
 */
export interface KnowledgePagePatch {
  expectedVersion: number;
  title?: string;
  content?: string;
  aliases?: string[];
  tags?: string[];
  confidence?: number;
}
