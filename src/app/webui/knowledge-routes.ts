/**
 * Knowledge-page API — plan §6 K2 and §12 item 4.
 *
 * A knowledge page lives in SQLite (`knowledge_pages` + sources/links/log, v14),
 * so "editing a page by hand" cannot mean pointing an editor at a Markdown file
 * — there is no file. These routes are that editor's backend: browse, read,
 * full-text search, create, update with optimistic concurrency, and the
 * shadow-mode review queue (approve / archive).
 *
 * Everything delegates to `KnowledgeService` (`memory/knowledge/service-contract.ts`),
 * which owns the transaction, the FTS maintenance and the version check. This
 * module is the HTTP boundary and nothing else: it validates untrusted input,
 * translates the service's rejection codes into distinguishable status codes,
 * and renders rows as camelCase JSON.
 *
 * Two rules from the plan are enforced HERE as well as in the service, because a
 * leak would make a shadow page indistinguishable from a confirmed fact:
 *
 *   - `GET /pages` never asks the service for `pending` pages. `?status=pending`
 *     is a 400 that points at `GET /pending` — the single review-queue accessor.
 *   - `GET /stats` is the only place that counts pending rows, and it counts
 *     them; it does not return them.
 *
 * Status codes (also recorded in the module's report):
 *   400 — caller error: unknown pageType/status, missing `q`, missing or stale
 *         `expectedVersion`, field of the wrong type, unknown source kind,
 *         un-slugifiable title.
 *   404 — the page does not exist, or `service.get` refused it. `get` is
 *         active-only by contract, so a `pending` body is served by
 *         `GET /pending` and an `archived` page is not readable by id at all
 *         (see the module report).
 *   409 — `expectedVersion` did not match, or a create hit a taken
 *         `(pageType, slug)`. The body carries `currentVersion` and
 *         `currentContent` so the editor can show a diff instead of discarding
 *         the user's edit.
 *   500 — unexpected failure (corrupt JSON array column, database error).
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  KNOWLEDGE_PAGE_STATUSES,
  KNOWLEDGE_SOURCE_KINDS,
  PAGE_TYPES,
  isPageType,
  type KnowledgePage,
  type KnowledgePageStatus,
  type KnowledgeSourceKind,
  type PageType,
  type CreateKnowledgePageInput,
  type KnowledgeSourceInput,
  type UpdateKnowledgePageInput,
} from '../../memory/knowledge/types.js';
import type {
  KnowledgePageDetail,
  KnowledgeService,
  KnowledgeWriteResult,
} from '../../memory/knowledge/service-contract.js';
import { checkConsistency } from '../../memory/knowledge/indexer.js';
import { slugify } from '../../memory/knowledge/slug.js';

/** Same page size the memory list uses; the WebUI pages through it. */
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const DEFAULT_PENDING_LIMIT = 50;
const MAX_PENDING_LIMIT = 200;
/** Mirrors the contract's own search default (and clamp). */
const DEFAULT_SEARCH_LIMIT = 6;
const MAX_SEARCH_LIMIT = 20;

/**
 * Route dependencies. `db` is here for the two places that read storage
 * directly — the `/stats` counts and the FTS parity probe
 * (`indexer.checkConsistency(db)`) — because the service contract exposes no
 * aggregate accessor.
 *
 * `fts: null` in the stats payload means "not checked" (a database created
 * before v14 has no knowledge tables); it never means "checked and fine".
 */
export interface KnowledgeRouteConfig {
  db: Database.Database;
  /** Built from `createKnowledgeService` (memory/knowledge/service.ts). */
  service: KnowledgeService;
}

/** A `knowledge_pages` row as the WebUI consumes it. */
interface KnowledgePagePayload {
  id: string;
  pageType: PageType;
  slug: string;
  title: string;
  content: string;
  aliases: string[];
  tags: string[];
  confidence: number | null;
  version: number;
  status: KnowledgePageStatus;
  createdAt: number | null;
  updatedAt: number | null;
  updatedBy: string | null;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(min, parsed), max);
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/**
 * `aliases` / `tags` are JSON array text. `types.ts` is explicit that a
 * malformed value is data corruption rather than an empty list, so it surfaces
 * as a 500 naming the page instead of silently rendering as "no tags".
 */
function parseStringArray(
  pageId: string,
  column: 'aliases' | 'tags',
  raw: string | null,
): string[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`knowledge page ${pageId} has a malformed ${column} value`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`knowledge page ${pageId} has a malformed ${column} value`);
  }
  return parsed.map((value) => String(value));
}

function toPagePayload(page: KnowledgePage): KnowledgePagePayload {
  return {
    id: page.id,
    pageType: page.page_type,
    slug: page.slug,
    title: page.title,
    content: page.content,
    aliases: parseStringArray(page.id, 'aliases', page.aliases),
    tags: parseStringArray(page.id, 'tags', page.tags),
    confidence: page.confidence,
    version: page.version,
    status: page.status,
    createdAt: page.created_at,
    updatedAt: page.updated_at,
    updatedBy: page.updated_by,
  };
}

function toDetailPayload(detail: KnowledgePageDetail): {
  page: KnowledgePagePayload;
  sources: Array<{ kind: KnowledgeSourceKind; id: string; createdAt: number | null }>;
  links: Array<{ slug: string; label: string | null; missing: boolean }>;
} {
  return {
    page: toPagePayload(detail.page),
    // `source_kind`/`source_id` are the storage spelling; the UI thinks in
    // "this page cites that memory", so the pair is rendered as kind + id.
    sources: detail.sources.map((source) => ({
      kind: source.source_kind,
      id: source.source_id,
      createdAt: source.created_at,
    })),
    links: detail.links,
  };
}

function acceptedWrite(result: Extract<KnowledgeWriteResult, { ok: true }>): {
  ok: true;
  created: boolean;
  id: string;
  slug: string;
  pageType: PageType;
  version: number;
  status: KnowledgePageStatus;
  danglingLinks: string[];
} {
  return {
    ok: true,
    created: result.created,
    id: result.id,
    slug: result.slug,
    pageType: result.pageType,
    version: result.version,
    status: result.status,
    danglingLinks: result.danglingLinks,
  };
}

/** Query-string `pageType` — an unknown name is a 400, never "no filter". */
function readPageTypeParam(
  raw: unknown,
): { ok: true; pageType?: PageType } | { ok: false; error: string } {
  if (raw === undefined || raw === '') return { ok: true };
  if (typeof raw !== 'string' || !isPageType(raw)) {
    return { ok: false, error: `pageType must be one of: ${PAGE_TYPES.join(', ')}` };
  }
  return { ok: true, pageType: raw };
}

/**
 * `GET /pages` filter. `pending` is rejected rather than forwarded: the review
 * queue has its own endpoint, and a shadow page must never appear in a browse
 * list where it reads as a confirmed fact.
 */
function readListStatusParam(
  raw: unknown,
): { ok: true; status: KnowledgePageStatus } | { ok: false; error: string } {
  if (raw === undefined || raw === '') return { ok: true, status: 'active' };
  if (raw === 'pending') {
    return {
      ok: false,
      error: 'pending pages are only available from GET /api/knowledge/pending',
    };
  }
  if (raw !== 'active' && raw !== 'archived') {
    return { ok: false, error: 'status must be one of: active, archived' };
  }
  return { ok: true, status: raw };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * A slug is *derived, never typed freely* (`memory/knowledge/slug.ts`), so
 * whatever arrives is normalised through the same function the service and
 * `[[wikilink]]` resolution use: `Power Query`, `power  query` and
 * `ＰＯＷＥＲ QUERY` all land on `power-query`. Returning the normalised slug to
 * the client is the point — it is the page's address.
 */
function readSlug(raw: unknown, title: string): Parsed<string> {
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    return { ok: false, error: 'slug must be a string' };
  }
  const slug = slugify((raw ?? title).trim());
  if (!slug) {
    return {
      ok: false,
      error: 'a slug cannot be derived from this title — send an explicit slug',
    };
  }
  return { ok: true, value: slug };
}

function readStringArray(raw: unknown, field: string): Parsed<string[]> {
  if (!Array.isArray(raw)) return { ok: false, error: `${field} must be an array of strings` };
  const values: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string')
      return { ok: false, error: `${field} must be an array of strings` };
    const trimmed = entry.trim();
    if (trimmed) values.push(trimmed);
  }
  return { ok: true, value: values };
}

function readConfidence(raw: unknown): Parsed<number> {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    return { ok: false, error: 'confidence must be a number between 0 and 1' };
  }
  return { ok: true, value: raw };
}

function readSources(raw: unknown, required: boolean): Parsed<KnowledgeSourceInput[]> {
  if (raw === undefined && !required) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'sources must be an array of { kind, id }' };
  }
  if (required && raw.length === 0) {
    return {
      ok: false,
      error: `sources must cite at least one ${KNOWLEDGE_SOURCE_KINDS.join(' / ')} row`,
    };
  }
  const sources: KnowledgeSourceInput[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, error: 'sources must be an array of { kind, id }' };
    }
    const { kind, id } = entry as { kind?: unknown; id?: unknown };
    if (typeof kind !== 'string' || !(KNOWLEDGE_SOURCE_KINDS as readonly string[]).includes(kind)) {
      return {
        ok: false,
        error: `source kind must be one of: ${KNOWLEDGE_SOURCE_KINDS.join(', ')}`,
      };
    }
    if (typeof id !== 'string' || !id.trim()) {
      return { ok: false, error: 'each source needs a non-empty id' };
    }
    sources.push({ kind: kind as KnowledgeSourceKind, id: id.trim() });
  }
  return { ok: true, value: sources };
}

function asBody(raw: unknown): Parsed<Record<string, unknown>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  return { ok: true, value: raw as Record<string, unknown> };
}

/**
 * PUT body → `UpdateKnowledgePageInput`.
 *
 * `expectedVersion` is required, not optional: the contract allows omitting it
 * for the "append only, I never read the page" case, but a human editor always
 * has read the page — and an edit that silently overwrites a newer version is
 * exactly the failure this endpoint exists to prevent.
 *
 * `status` is rejected here: approval and archival are workflow decisions with
 * their own endpoints, and letting an editor PUT `status: 'active'` would make
 * the shadow review gate bypassable with one form field.
 */
function readUpdateInput(body: Record<string, unknown>): Parsed<UpdateKnowledgePageInput> {
  if (body.status !== undefined) {
    return {
      ok: false,
      error:
        'status cannot be changed through PUT — use POST /api/knowledge/page/:id/approve or /archive',
    };
  }

  const expectedVersion = body.expectedVersion;
  if (
    typeof expectedVersion !== 'number' ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    return {
      ok: false,
      error: 'expectedVersion is required (the version returned by GET /api/knowledge/page/:id)',
    };
  }

  const input: UpdateKnowledgePageInput = { expectedVersion };
  let hasChange = false;

  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || !body.title.trim()) {
      return { ok: false, error: 'title must be a non-empty string' };
    }
    input.title = body.title.trim();
    hasChange = true;
  }
  if (body.content !== undefined) {
    if (typeof body.content !== 'string') {
      return { ok: false, error: 'content must be a string' };
    }
    input.content = body.content;
    hasChange = true;
  }
  if (body.aliases !== undefined) {
    const aliases = readStringArray(body.aliases, 'aliases');
    if (!aliases.ok) return aliases;
    input.aliases = aliases.value;
    hasChange = true;
  }
  if (body.tags !== undefined) {
    const tags = readStringArray(body.tags, 'tags');
    if (!tags.ok) return tags;
    input.tags = tags.value;
    hasChange = true;
  }
  if (body.confidence !== undefined) {
    const confidence = readConfidence(body.confidence);
    if (!confidence.ok) return confidence;
    input.confidence = confidence.value;
    hasChange = true;
  }
  if (body.sources !== undefined) {
    const sources = readSources(body.sources, false);
    if (!sources.ok) return sources;
    input.sources = sources.value;
    hasChange = true;
  }
  if (body.reason !== undefined) {
    if (typeof body.reason !== 'string') {
      return { ok: false, error: 'reason must be a string' };
    }
    input.reason = body.reason;
  }

  if (!hasChange) {
    return {
      ok: false,
      error: 'nothing to update: send title, content, aliases, tags, confidence or sources',
    };
  }
  return { ok: true, value: input };
}

/** POST body → `CreateKnowledgePageInput`. `actor` is always the user. */
function readCreateInput(body: Record<string, unknown>): Parsed<CreateKnowledgePageInput> {
  const { pageType } = body;
  if (typeof pageType !== 'string' || !isPageType(pageType)) {
    return { ok: false, error: `pageType must be one of: ${PAGE_TYPES.join(', ')}` };
  }
  if (typeof body.title !== 'string' || !body.title.trim()) {
    return { ok: false, error: 'title must be a non-empty string' };
  }
  const title = body.title.trim();
  if (typeof body.content !== 'string') {
    return { ok: false, error: 'content must be a string' };
  }

  const slug = readSlug(body.slug, title);
  if (!slug.ok) return slug;

  // A page nobody can trace back to a memory/message/session is how the layer
  // would start inventing facts, so the editor must cite at least one row.
  const sources = readSources(body.sources, true);
  if (!sources.ok) return sources;

  const input: CreateKnowledgePageInput = {
    pageType,
    slug: slug.value,
    title,
    content: body.content,
    sources: sources.value,
    updatedBy: 'user',
  };

  if (body.aliases !== undefined) {
    const aliases = readStringArray(body.aliases, 'aliases');
    if (!aliases.ok) return aliases;
    input.aliases = aliases.value;
  }
  if (body.tags !== undefined) {
    const tags = readStringArray(body.tags, 'tags');
    if (!tags.ok) return tags;
    input.tags = tags.value;
  }
  if (body.confidence !== undefined) {
    const confidence = readConfidence(body.confidence);
    if (!confidence.ok) return confidence;
    input.confidence = confidence.value;
  }
  if (body.reason !== undefined) {
    if (typeof body.reason !== 'string') {
      return { ok: false, error: 'reason must be a string' };
    }
    input.reason = body.reason;
  }

  return { ok: true, value: input };
}

interface KnowledgeCounts {
  total: number;
  byStatus: Record<KnowledgePageStatus, number>;
  byPageType: Record<PageType, number>;
}

/**
 * Row counts straight from `knowledge_pages`. The service contract has no
 * aggregate accessor (see the module report), so this is the one place the
 * route reads tables itself — read-only, and `pending` is only ever *counted*.
 */
function readKnowledgeCounts(db: Database.Database): KnowledgeCounts {
  const byStatus = Object.fromEntries(
    KNOWLEDGE_PAGE_STATUSES.map((status) => [status, 0]),
  ) as Record<KnowledgePageStatus, number>;
  const byPageType = Object.fromEntries(PAGE_TYPES.map((pageType) => [pageType, 0])) as Record<
    PageType,
    number
  >;

  if (!tableExists(db, 'knowledge_pages')) {
    return { total: 0, byStatus, byPageType };
  }

  const statusRows = db
    .prepare('SELECT status, COUNT(*) AS n FROM knowledge_pages GROUP BY status')
    .all() as Array<{ status: string; n: number | string }>;
  for (const row of statusRows) {
    if ((KNOWLEDGE_PAGE_STATUSES as readonly string[]).includes(row.status)) {
      byStatus[row.status as KnowledgePageStatus] = Number(row.n);
    }
  }

  const typeRows = db
    .prepare('SELECT page_type, COUNT(*) AS n FROM knowledge_pages GROUP BY page_type')
    .all() as Array<{ page_type: string; n: number | string }>;
  for (const row of typeRows) {
    if (isPageType(row.page_type)) byPageType[row.page_type] = Number(row.n);
  }

  const totalRow = db.prepare('SELECT COUNT(*) AS n FROM knowledge_pages').get() as {
    n: number | string;
  };

  return { total: Number(totalRow.n), byStatus, byPageType };
}

export function registerKnowledgeRoutes(app: FastifyInstance, cfg: KnowledgeRouteConfig): void {
  const { service } = cfg;

  /**
   * Browse pages, newest-updated first.
   *   `?status=active|archived`  — default active; `pending` is a 400
   *   `?pageType=<closed set>`   — one page kind
   *   `?limit=1..100` `?offset=0..`
   */
  app.get('/api/knowledge/pages', async (request, reply) => {
    try {
      const query = request.query as {
        status?: string;
        pageType?: string;
        limit?: string;
        offset?: string;
      };

      const status = readListStatusParam(query.status);
      if (!status.ok) return reply.status(400).send({ error: status.error });
      const pageType = readPageTypeParam(query.pageType);
      if (!pageType.ok) return reply.status(400).send({ error: pageType.error });

      const limit = clampInt(query.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
      const offset = clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

      const pages = service.list({
        status: status.status,
        pageType: pageType.pageType,
        limit,
        offset,
      });

      return reply.send({
        pages: pages.map(toPagePayload),
        count: pages.length,
        limit,
        offset,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /** The `curate.shadow` review queue — the only endpoint that returns pending pages. */
  app.get('/api/knowledge/pending', async (request, reply) => {
    try {
      const { limit: limitParam } = request.query as { limit?: string };
      const limit = clampInt(limitParam, DEFAULT_PENDING_LIMIT, 1, MAX_PENDING_LIMIT);
      const pages = service.listPending(limit);
      return reply.send({ pages: pages.map(toPagePayload), count: pages.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /**
   * Full-text search over active pages.
   *   `?q=<text>` (required) `?pageType=` `?tag=` `?limit=1..20`
   */
  app.get('/api/knowledge/search', async (request, reply) => {
    try {
      const query = request.query as {
        q?: string;
        pageType?: string;
        tag?: string;
        limit?: string;
      };

      const term = (query.q ?? '').trim();
      if (!term) return reply.status(400).send({ error: 'q is required' });
      const pageType = readPageTypeParam(query.pageType);
      if (!pageType.ok) return reply.status(400).send({ error: pageType.error });

      const limit = clampInt(query.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
      const tag = (query.tag ?? '').trim();
      const hits = service.search(term, {
        pageType: pageType.pageType,
        tag: tag || undefined,
        limit,
      });

      return reply.send({
        q: term,
        hits: hits.map((hit) => ({
          id: hit.id,
          slug: hit.slug,
          pageType: hit.pageType,
          title: hit.title,
          snippet: hit.snippet,
          score: hit.score,
        })),
        count: hits.length,
        limit,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /** One page by id, with its sources and (possibly dangling) outgoing links. */
  app.get<{ Params: { id: string } }>('/api/knowledge/page/:id', async (request, reply) => {
    try {
      // `service.get` is active-only, so a pending page answers 404 here: its body
      // is served by `GET /api/knowledge/pending`, the one review-queue accessor.
      const detail = service.get({ id: request.params.id });
      if (!detail) {
        return reply
          .status(404)
          .send({ error: 'Not Found', message: `No knowledge page with id ${request.params.id}` });
      }
      return reply.send(toDetailPayload(detail));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /** One page by type + slug — the address `[[page_type/slug]]` resolves to. */
  app.get<{ Params: { pageType: string; slug: string } }>(
    '/api/knowledge/page/:pageType/:slug',
    async (request, reply) => {
      try {
        const { pageType, slug } = request.params;
        if (!isPageType(pageType)) {
          return reply
            .status(400)
            .send({ error: `pageType must be one of: ${PAGE_TYPES.join(', ')}` });
        }
        const detail = service.get({ pageType, slug });
        if (!detail) {
          return reply.status(404).send({
            error: 'Not Found',
            message: `No knowledge page ${pageType}/${slug}`,
          });
        }
        return reply.send(toDetailPayload(detail));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  /**
   * Update a page from the editor.
   *
   * 409 carries the current version and body: the user's text is still in the
   * browser, so the editor diffs it against what is stored instead of losing
   * one of the two edits.
   */
  app.put<{ Params: { id: string } }>('/api/knowledge/page/:id', async (request, reply) => {
    try {
      const body = asBody(request.body);
      if (!body.ok) return reply.status(400).send({ error: body.error });
      const input = readUpdateInput(body.value);
      if (!input.ok) return reply.status(400).send({ error: input.error });

      const result = service.update({ id: request.params.id }, input.value, {
        actor: 'user',
        // A human editing the page IS the authority the admission rules
        // approximate, so they never gate a manual edit.
        enforceAdmission: false,
      });

      if (result.ok) return reply.send(acceptedWrite(result));

      switch (result.code) {
        case 'version_conflict':
          return reply.status(409).send({
            error: 'Version Conflict',
            code: result.code,
            message: 'The page changed since it was loaded — re-merge against currentContent',
            currentVersion: result.currentVersion,
            currentContent: result.currentContent,
          });
        case 'not_found':
          return reply.status(404).send({
            error: 'Not Found',
            message: `No knowledge page with id ${request.params.id}`,
          });
        case 'unknown_sources':
          return reply.status(400).send({
            error: 'Unknown sources',
            code: result.code,
            message: 'Every source must cite an existing memory, message or session',
            missing: result.missing,
          });
        case 'invalid_page_type':
          return reply.status(400).send({
            error: 'Invalid page type',
            code: result.code,
            allowed: result.allowed,
          });
        case 'admission_rejected':
          // Unreachable while enforceAdmission is false; kept exhaustive so a
          // future caller cannot fall through to a success response.
          return reply.status(400).send({
            error: 'Admission rejected',
            code: result.code,
            reason: result.reason,
            detail: result.detail,
          });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /**
   * Create a page from the editor.
   *
   * A taken `(pageType, slug)` is a 409 carrying the current body rather than an
   * upsert: silently rewriting the page a colleague (or a previous edit) wrote is
   * the failure this keeps out of the create path. The editor turns that 409 into
   * "this page already exists — open it".
   */
  app.post('/api/knowledge/page', async (request, reply) => {
    try {
      const body = asBody(request.body);
      if (!body.ok) return reply.status(400).send({ error: body.error });
      const input = readCreateInput(body.value);
      if (!input.ok) return reply.status(400).send({ error: input.error });

      const result = service.create(input.value, { actor: 'user', enforceAdmission: false });

      if (result.ok) return reply.status(201).send(acceptedWrite(result));

      switch (result.code) {
        case 'not_found':
          // Unreachable on create — insertPage has no `not_found` outcome — but
          // the union is shared with update, so keep the case explicit.
          return reply.status(404).send({
            error: 'Not Found',
            code: result.code,
            message: `No knowledge page ${result.slug}`,
          });
        case 'version_conflict':
          return reply.status(409).send({
            error: 'Version Conflict',
            code: result.code,
            message:
              'A page with this pageType/slug already exists — update it with expectedVersion instead',
            currentVersion: result.currentVersion,
            currentContent: result.currentContent,
          });
        case 'unknown_sources':
          return reply.status(400).send({
            error: 'Unknown sources',
            code: result.code,
            message: 'Every source must cite an existing memory, message or session',
            missing: result.missing,
          });
        case 'invalid_page_type':
          return reply.status(400).send({
            error: 'Invalid page type',
            code: result.code,
            allowed: result.allowed,
          });
        case 'admission_rejected':
          return reply.status(400).send({
            error: 'Admission rejected',
            code: result.code,
            reason: result.reason,
            detail: result.detail,
          });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /**
   * Approve a shadow page: `pending` → `active`, so it becomes visible to search
   * and injection. `page` is the refreshed detail (the same shape as
   * `GET /api/knowledge/page/:id`) so the queue can drop the row without a
   * second round-trip; it is `null` only if the page vanished in between.
   */
  app.post<{ Params: { id: string } }>(
    '/api/knowledge/page/:id/approve',
    async (request, reply) => {
      try {
        const { id } = request.params;
        if (!service.setStatus(id, 'active', 'user')) {
          return reply
            .status(404)
            .send({ error: 'Not Found', message: `No knowledge page with id ${id}` });
        }
        const detail = service.get({ id });
        return reply.send({
          ok: true,
          id,
          status: 'active',
          page: detail ? toDetailPayload(detail) : null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  /**
   * Archive a page: kept for history, no longer offered by search or injection.
   * The row and its sources/links stay, so "what did we use to think" remains
   * answerable.
   *
   * `page` is always `null` here: `service.get` is active-only by contract, and
   * the page is no longer active once this returns. `status` is the new state the
   * UI needs; the archived body is still served by the list endpoint
   * (`?status=archived`).
   */
  app.post<{ Params: { id: string } }>(
    '/api/knowledge/page/:id/archive',
    async (request, reply) => {
      try {
        const { id } = request.params;
        if (!service.setStatus(id, 'archived', 'user')) {
          return reply
            .status(404)
            .send({ error: 'Not Found', message: `No knowledge page with id ${id}` });
        }
        const detail = service.get({ id });
        return reply.send({
          ok: true,
          id,
          status: 'archived',
          page: detail ? toDetailPayload(detail) : null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: message });
      }
    },
  );

  /**
   * Counts for the workbench header plus the FTS parity report from
   * `indexer.checkConsistency`. Counting `pending` is fine; returning pending
   * bodies is not.
   */
  app.get('/api/knowledge/stats', async (_request, reply) => {
    try {
      const counts = readKnowledgeCounts(cfg.db);
      // A database created before v14 has no knowledge tables, and a parity check
      // over missing tables is a 500, not an answer: report `null` — "not
      // checked" — so the UI never shows a fabricated "ok".
      const indexable =
        tableExists(cfg.db, 'knowledge_pages') && tableExists(cfg.db, 'knowledge_fts_jieba');
      return reply.send({
        ...counts,
        fts: indexable ? checkConsistency(cfg.db) : null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });
}
