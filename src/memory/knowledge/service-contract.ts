/**
 * The knowledge-service surface, split out from its implementation so the
 * consumers (tools, curation job, WebUI routes, context injection) can be
 * written and reviewed against a fixed shape instead of against whatever the
 * implementation happened to export.
 *
 * `service.ts` implements this; nothing here touches the database.
 *
 * Rules that the implementation owes its callers:
 *
 * - **`status === 'active'` is the default read filter.** `search`, `get`,
 *   `list`, `titlesForInjection` never return a `pending` or `archived` page
 *   unless the caller asks for that status explicitly (`listPending` is the
 *   one accessor for the review queue). A shadow-mode page leaking into an
 *   injected prompt would be indistinguishable from a confirmed fact.
 * - **Writes are one transaction.** Page row, FTS row, link rows and the log
 *   row land together or not at all. FTS maintenance is delete-then-insert per
 *   page (`knowledge_fts_jieba` is a standalone FTS5 table with no uniqueness
 *   constraint, so a bare INSERT on update leaves the old text searchable).
 * - **`version` is optimistic concurrency.** Every update carries
 *   `expectedVersion`; a mismatch is a refusal that hands back the current
 *   body so the writer can re-read instead of clobbering.
 * - **No path sandbox exists or is needed.** The pages live in SQLite. The
 *   boundary is the closed `PageType` set, the `sources` that must resolve to
 *   real rows, and the version check above.
 */

import type {
  CreateKnowledgePageInput,
  KnowledgeBacklink,
  KnowledgeLink,
  KnowledgePage,
  KnowledgePageStatus,
  KnowledgeSource,
  KnowledgeSourceInput,
  PageType,
  UpdateKnowledgePageInput,
} from './types.js';

/** One full-text hit, already trimmed to what a caller can act on. */
export interface KnowledgeSearchHit {
  id: string;
  slug: string;
  pageType: PageType;
  title: string;
  /** ±120 chars around the match, from `content_original` (not the segmented text). */
  snippet: string;
  /**
   * Rank-fused relevance (reciprocal-rank), higher is better, ordered best first.
   *
   * Only comparable within one result set: the two page lanes — BM25 over the
   * index and the name leg — are fused by rank, never by adding a BM25 magnitude
   * to a name match, so the number carries an order and nothing else.
   */
  score: number;
}

/** A page plus everything needed to render it and to explain where it came from. */
export interface KnowledgePageDetail {
  page: KnowledgePage;
  sources: KnowledgeSource[];
  /** Outgoing `[[wikilinks]]`; `missing` marks a link whose target page does not exist yet. */
  links: Array<{ slug: string; label: string | null; missing: boolean }>;
}

export type KnowledgeWriteRejection =
  /** `expectedVersion` did not match — caller must re-read `currentContent`. */
  | { code: 'version_conflict'; currentVersion: number; currentContent: string }
  /** `pageType` outside the closed set. */
  | { code: 'invalid_page_type'; allowed: readonly PageType[] }
  /** At least one `sources` entry does not resolve to a real row (anti-hallucination gate). */
  | { code: 'unknown_sources'; missing: KnowledgeSourceInput[] }
  /** Admission rules rejected the page (curation only; explicit user/agent writes pass through). */
  | {
      code: 'admission_rejected';
      reason: 'no_subject' | 'not_recurrent' | 'not_requested';
      detail: string;
    }
  /** Target page not found for an update. */
  | { code: 'not_found'; slug: string };

export type KnowledgeWriteResult =
  | {
      ok: true;
      id: string;
      slug: string;
      pageType: PageType;
      version: number;
      status: KnowledgePageStatus;
      /** True when this call created the page rather than updating it. */
      created: boolean;
      /** Slugs that could not be resolved while parsing `[[wikilinks]]` (logged, never fatal). */
      danglingLinks: string[];
    }
  | ({ ok: false } & KnowledgeWriteRejection);

export interface KnowledgeSearchOptions {
  pageType?: PageType;
  tag?: string;
  /** Default 6, clamped to 20. */
  limit?: number;
}

export interface KnowledgeListOptions {
  /** Default `'active'`. Pass `'pending'` only from the review-queue UI. */
  status?: KnowledgePageStatus;
  pageType?: PageType;
  limit?: number;
  offset?: number;
}

/** Who is writing — decides `updated_by`, the log actor, and whether admission applies. */
export type KnowledgeActor = 'agent' | 'user' | 'system';

export interface KnowledgeWriteOptions {
  actor: KnowledgeActor;
  /**
   * Curation passes `true` so the admission rules (nameable subject, ≥2
   * recurrences, or an explicit user request) run. A user editing a page in
   * the WebUI, or the model writing on an explicit instruction, passes `false`
   * — they are the authority the rules exist to approximate.
   */
  enforceAdmission?: boolean;
  /**
   * The user asked for this page in so many words — admission rule 3.
   *
   * Defaults to "the write is attributed to the user" (`actor === 'user'`),
   * which covers a WebUI edit. A *curation* write passes it explicitly: the
   * curator knows whether its trigger was a user request (`manual`, e.g.
   * `/knowledge curate` or a shared message) or the nightly batch, and the actor
   * stays `system` either way — the page body was machine-written, the request
   * was not. Without this, a user-triggered curation write of a single shared
   * message could not pass rule 3 at all.
   */
  explicitRequest?: boolean;
}

export interface KnowledgeService {
  /** Full-text search over active pages only. */
  search(query: string, options?: KnowledgeSearchOptions): KnowledgeSearchHit[];
  /** Fetch by slug (within an optional page type) or by id. */
  get(ref: { slug: string; pageType?: PageType } | { id: string }): KnowledgePageDetail | null;
  /** Browse, newest-updated first. */
  list(options?: KnowledgeListOptions): KnowledgePage[];
  /** The review queue for `curate.shadow`. */
  listPending(limit?: number): KnowledgePage[];
  create(input: CreateKnowledgePageInput, options: KnowledgeWriteOptions): KnowledgeWriteResult;
  /** Replaces `sources`/`aliases`/`tags` when provided; `content` only when provided. */
  update(
    ref: { slug: string; pageType?: PageType } | { id: string },
    input: UpdateKnowledgePageInput,
    options: KnowledgeWriteOptions,
  ): KnowledgeWriteResult;
  /** `approve <id>` / `archive` from the WebUI or `/knowledge`. */
  setStatus(id: string, status: KnowledgePageStatus, actor: KnowledgeActor): boolean;
  /**
   * Page titles worth injecting this turn, most relevant first.
   *
   * Titles only — the plan caps automatic injection at a couple of headings
   * (≤150 tokens) and leaves the body to an explicit tool call. Returns `[]`
   * when nothing clears the relevance floor; never invents a hit.
   *
   * `score` is relevance in (0,1] **relative to the best hit in this result set**
   * (top = 1), which is what makes it comparable with another lane's scores; the
   * raw fused rank value stays inside the service.
   */
  titlesForInjection(
    query: string,
    max: number,
  ): Array<{ slug: string; title: string; score?: number }>;
  /** Outgoing links of a page, for `knowledge_get` and the WebUI backlink panel. */
  linksOf(pageId: string): KnowledgeLink[];
  /**
   * Incoming links: the **active** pages whose body cites `ref`, newest first.
   *
   * Empty for a page that is not readable (`get` returns null for the same refs),
   * because a panel of pages pointing at a shadow page is a second way to read it.
   */
  backlinks(ref: { slug: string; pageType?: PageType } | { id: string }): KnowledgeBacklink[];
}

/** Tunables the service reads; a subset of the `knowledge:` config block. */
export interface KnowledgeRuntimeConfig {
  enabled: boolean;
  /** `require_sources` — admission rule 2 threshold (≥ N independent sources). */
  requireSources: number;
  /** `min_memory_confidence` — memories below this never seed a page. */
  minMemoryConfidence: number;
  /** `shadow` — new pages from curation land as `pending` instead of `active`. */
  shadow: boolean;
  /** `log_retention_days` — `knowledge_log` pruning horizon. */
  logRetentionDays: number;
}
