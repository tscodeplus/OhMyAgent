/**
 * Persistence for the knowledge layer: `knowledge_pages` and its three
 * companions (`knowledge_sources`, `knowledge_links`, `knowledge_log`) plus the
 * FTS index they feed.
 *
 * Boundaries this class owns, so callers never have to think about them:
 *
 * - **One write = one transaction.** Page row, FTS row, link rows and the log
 *   row land together. A page visible to `knowledge_get` but absent from
 *   `knowledge_search` is a bug of the "half a feature" kind.
 * - **A create never overwrites.** `insertPage` on a taken `(page_type, slug)`
 *   returns `version_conflict` with the current body — the caller re-reads and
 *   updates with `expectedVersion` instead of clobbering.
 * - **An update with new content must cite the version it read.** Without
 *   `expectedVersion` the update is refused (`version_conflict`); the
 *   append-only cases (status, tags) are allowed without it because they cannot
 *   destroy a body.
 * - **Citations must resolve.** `missingSources` is the anti-hallucination gate:
 *   a page may only cite rows that exist.
 *
 * Policy (admission, shadow status, page-type validation) lives in `service.ts`;
 * this file answers "what is stored" and "did the write succeed".
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  CreateKnowledgePageInput,
  KnowledgeLink,
  KnowledgeLogAction,
  KnowledgeLogActor,
  KnowledgePage,
  KnowledgePageStatus,
  KnowledgeSource,
  KnowledgeSourceInput,
  PageType,
  UpdateKnowledgePageInput,
} from './types.js';
import { slugify } from './slug.js';
import { resolveWikilinks } from './links.js';
import { indexKnowledgePage } from './indexer.js';

/** Address a page by slug (optionally within one page type) or by id. */
export type KnowledgePageRef = { slug: string; pageType?: PageType } | { id: string };

export interface KnowledgePageListQuery {
  status: KnowledgePageStatus;
  pageType?: PageType;
  limit?: number;
  offset?: number;
}

/**
 * Outcome of a page write. Deliberately not the service's `KnowledgeWriteResult`:
 * page-type validation and admission are policy, and only the service can decide
 * them — so this type only carries what the database decided.
 */
export type KnowledgePageWriteResult =
  | { ok: true; page: KnowledgePage; created: boolean; danglingLinks: string[] }
  | { ok: false; code: 'version_conflict'; currentVersion: number; currentContent: string }
  | { ok: false; code: 'not_found'; slug: string };

const DEFAULT_LIST_LIMIT = 50;

/** JSON array column → text, or NULL for "no list". */
function serializeArray(values: string[] | undefined): string | null {
  if (values === undefined) return null;
  const cleaned = values.map((value) => value.trim()).filter((value) => value.length > 0);
  return cleaned.length > 0 ? JSON.stringify(cleaned) : null;
}

export class KnowledgeRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  findById(id: string): KnowledgePage | undefined {
    return this.db.prepare('SELECT * FROM knowledge_pages WHERE id = ?').get(id) as
      KnowledgePage | undefined;
  }

  /**
   * Look up by slug, optionally constrained to one page type.
   *
   * Without a page type the same slug can exist as several pages (`topic/x` and
   * `project/x`), so an active page wins and the newest updated_at breaks the
   * remaining tie — a caller that needs determinism should pass the type.
   */
  findBySlug(slug: string, pageType?: PageType): KnowledgePage | undefined {
    const normalised = slugify(slug);
    if (!normalised) return undefined;
    if (pageType) {
      return this.db
        .prepare('SELECT * FROM knowledge_pages WHERE page_type = ? AND slug = ?')
        .get(pageType, normalised) as KnowledgePage | undefined;
    }
    return this.db
      .prepare(
        `SELECT * FROM knowledge_pages WHERE slug = ?
         ORDER BY (status = 'active') DESC, updated_at DESC, id ASC LIMIT 1`,
      )
      .get(normalised) as KnowledgePage | undefined;
  }

  /** Browse one status, newest-updated first. */
  list(query: KnowledgePageListQuery): KnowledgePage[] {
    const params: unknown[] = [query.status];
    let sql = 'SELECT * FROM knowledge_pages WHERE status = ?';
    if (query.pageType) {
      sql += ' AND page_type = ?';
      params.push(query.pageType);
    }
    sql += ' ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?';
    params.push(query.limit ?? DEFAULT_LIST_LIMIT, query.offset ?? 0);
    return this.db.prepare(sql).all(...params) as KnowledgePage[];
  }

  /**
   * Pages whose title, slug or one of whose aliases equals `text` (case-folded).
   *
   * The FTS index only holds bodies, so an acronym stored as an alias (`PQ` for
   * `Power Query`) is findable only through this leg of `knowledge_search`.
   * The `tag` / `pageType` filters live in SQL for the same reason as in
   * `searchKnowledgeIndex`: filtering in JS would make `limit` a lie.
   */
  findByTitleOrAlias(
    text: string,
    options: { status: KnowledgePageStatus; pageType?: PageType; tag?: string; limit: number },
  ): KnowledgePage[] {
    const trimmed = text.trim();
    if (!trimmed) return [];

    const params: unknown[] = [options.status, trimmed, slugify(trimmed), trimmed];
    let sql = `
      SELECT * FROM knowledge_pages p
      WHERE p.status = ?
        AND (
          lower(p.title) = lower(?)
          OR p.slug = ?
          OR EXISTS (SELECT 1 FROM json_each(p.aliases) WHERE lower(json_each.value) = lower(?))
        )`;
    if (options.pageType) {
      sql += ` AND p.page_type = ?`;
      params.push(options.pageType);
    }
    if (options.tag) {
      sql += ` AND EXISTS (SELECT 1 FROM json_each(p.tags) WHERE json_each.value = ?)`;
      params.push(options.tag);
    }
    sql += ` ORDER BY p.updated_at DESC, p.id ASC LIMIT ?`;
    params.push(options.limit);

    return this.db.prepare(sql).all(...params) as KnowledgePage[];
  }

  sourcesOf(pageId: string): KnowledgeSource[] {
    return this.db
      .prepare(
        `SELECT * FROM knowledge_sources WHERE page_id = ?
         ORDER BY source_kind, source_id`,
      )
      .all(pageId) as KnowledgeSource[];
  }

  linksOf(pageId: string): KnowledgeLink[] {
    return this.db
      .prepare('SELECT * FROM knowledge_links WHERE from_page_id = ? ORDER BY to_page_id')
      .all(pageId) as KnowledgeLink[];
  }

  /**
   * Citations that do not resolve to a real row.
   *
   * Each kind is checked against its own table — a memory id never satisfies a
   * message citation, which is the whole point: the gate exists so a model
   * cannot invent a source.
   */
  missingSources(sources: KnowledgeSourceInput[]): KnowledgeSourceInput[] {
    const prepared = {
      memory: this.db.prepare('SELECT 1 FROM memories WHERE id = ?'),
      message: this.db.prepare('SELECT 1 FROM messages WHERE id = ?'),
      session: this.db.prepare('SELECT 1 FROM sessions WHERE id = ?'),
    };
    return sources.filter((source) => {
      const statement = prepared[source.kind];
      if (!statement) return true; // a kind outside the closed set is not a source
      return statement.get(source.id) === undefined;
    });
  }

  // ── writes ───────────────────────────────────────────────────────────────

  /**
   * Insert a page.
   *
   * Refuses when `(page_type, slug)` is taken: silently upserting here is how an
   * automated writer would erase a human's edit, so the caller is handed the
   * current body and has to update deliberately.
   *
   * `input.status` drives the log action (`pending` when curation wrote it into
   * the review queue) and is otherwise the caller's decision.
   */
  insertPage(
    input: CreateKnowledgePageInput & { status: KnowledgePageStatus; updatedBy: string },
    actor: KnowledgeLogActor,
  ): KnowledgePageWriteResult {
    const run = this.db.transaction((): KnowledgePageWriteResult => {
      const existing = this.findBySlug(input.slug, input.pageType);
      if (existing) {
        return {
          ok: false,
          code: 'version_conflict',
          currentVersion: existing.version,
          currentContent: existing.content,
        };
      }

      const now = Date.now();
      const id = randomUUID();
      const slug = slugify(input.slug);
      this.db
        .prepare(
          `INSERT INTO knowledge_pages
             (id, page_type, slug, title, content, aliases, tags, confidence,
              version, status, created_at, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.pageType,
          slug,
          input.title,
          input.content,
          serializeArray(input.aliases),
          serializeArray(input.tags),
          input.confidence ?? null,
          input.status,
          now,
          now,
          input.updatedBy,
        );

      this.replaceSources(id, input.sources, now);
      indexKnowledgePage(this.db, {
        id,
        title: input.title,
        pageType: input.pageType,
        content: input.content,
      });
      const danglingLinks = this.writeLinks(id, input.content);

      const page = this.findById(id)!;
      this.appendLog({
        pageId: id,
        action: input.status === 'pending' ? 'pending' : 'create',
        actor,
        version: page.version,
        reason: input.reason ?? null,
      });
      if (danglingLinks.length > 0) {
        this.appendLog({
          pageId: id,
          action: 'link',
          actor,
          version: page.version,
          reason: `dangling: ${danglingLinks.join(', ')}`,
        });
      }

      return { ok: true, page, created: true, danglingLinks };
    });

    return run();
  }

  /**
   * Update a page.
   *
   * Two refusals, both returning the current body so the caller can re-merge:
   * `expectedVersion` that does not match, and a content-bearing update that
   * carries no `expectedVersion` at all ("I did not read this page, so I must
   * not overwrite its body").
   */
  updatePage(
    ref: KnowledgePageRef,
    input: UpdateKnowledgePageInput,
    actor: KnowledgeLogActor,
  ): KnowledgePageWriteResult {
    const run = this.db.transaction((): KnowledgePageWriteResult => {
      const current = this.resolveRef(ref);
      if (!current) return { ok: false, code: 'not_found', slug: refSlug(ref) };

      if (input.expectedVersion === undefined) {
        if (input.content !== undefined) {
          return {
            ok: false,
            code: 'version_conflict',
            currentVersion: current.version,
            currentContent: current.content,
          };
        }
      } else if (input.expectedVersion !== current.version) {
        return {
          ok: false,
          code: 'version_conflict',
          currentVersion: current.version,
          currentContent: current.content,
        };
      }

      const now = Date.now();
      const version = current.version + 1;
      const title = input.title ?? current.title;
      const content = input.content ?? current.content;
      const status = input.status ?? current.status;

      this.db
        .prepare(
          `UPDATE knowledge_pages
           SET title = ?, content = ?, aliases = ?, tags = ?, confidence = ?,
               version = ?, status = ?, updated_at = ?, updated_by = ?
           WHERE id = ?`,
        )
        .run(
          title,
          content,
          input.aliases !== undefined ? serializeArray(input.aliases) : current.aliases,
          input.tags !== undefined ? serializeArray(input.tags) : current.tags,
          input.confidence ?? current.confidence,
          version,
          status,
          now,
          input.updatedBy ?? current.updated_by,
          current.id,
        );

      if (input.sources !== undefined) this.replaceSources(current.id, input.sources, now);

      // The index carries the title and the body, so either one changing means a
      // re-index. Nothing else on the row is indexed.
      if (input.content !== undefined || input.title !== undefined) {
        indexKnowledgePage(this.db, {
          id: current.id,
          title,
          pageType: current.page_type,
          content,
        });
      }

      // Links are a parse of the body: only a body change can change them.
      const danglingLinks = input.content !== undefined ? this.writeLinks(current.id, content) : [];

      this.appendLog({
        pageId: current.id,
        action: status === 'pending' ? 'pending' : 'update',
        actor,
        version,
        reason: input.reason ?? null,
      });
      if (danglingLinks.length > 0) {
        this.appendLog({
          pageId: current.id,
          action: 'link',
          actor,
          version,
          reason: `dangling: ${danglingLinks.join(', ')}`,
        });
      }

      return { ok: true, page: this.findById(current.id)!, created: false, danglingLinks };
    });

    return run();
  }

  /** Flip a page's lifecycle status (approve / archive / re-queue). */
  setStatus(id: string, status: KnowledgePageStatus, actor: KnowledgeLogActor): boolean {
    const run = this.db.transaction((): boolean => {
      const current = this.findById(id);
      if (!current) return false;
      if (current.status === status) return false;

      const now = Date.now();
      const version = current.version + 1;
      this.db
        .prepare(
          `UPDATE knowledge_pages SET status = ?, version = ?, updated_at = ?, updated_by = ?
           WHERE id = ?`,
        )
        .run(status, version, now, actor, id);

      this.appendLog({
        pageId: id,
        action: status === 'pending' ? 'pending' : 'update',
        actor,
        version,
        reason: `status: ${current.status} -> ${status}`,
      });
      return true;
    });

    return run();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private resolveRef(ref: KnowledgePageRef): KnowledgePage | undefined {
    return 'id' in ref ? this.findById(ref.id) : this.findBySlug(ref.slug, ref.pageType);
  }

  private replaceSources(pageId: string, sources: KnowledgeSourceInput[], now: number): void {
    this.db.prepare('DELETE FROM knowledge_sources WHERE page_id = ?').run(pageId);
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO knowledge_sources (page_id, source_kind, source_id, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (const source of sources) insert.run(pageId, source.kind, source.id, now);
  }

  /**
   * Re-derive the page's outgoing links from its body.
   *
   * Deleting first is what makes a removed `[[wikilink]]` actually disappear —
   * `knowledge_links` is a projection of the body, never an independent fact.
   *
   * @returns the targets that resolved to nothing (dangling).
   */
  private writeLinks(pageId: string, content: string): string[] {
    const { links, dangling } = resolveWikilinks(
      content,
      (link) => this.resolveActivePageId(link.pageType, link.slug),
      { selfPageId: pageId },
    );

    this.db.prepare('DELETE FROM knowledge_links WHERE from_page_id = ?').run(pageId);
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO knowledge_links (from_page_id, to_page_id, label, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    const now = Date.now();
    for (const link of links) insert.run(pageId, link.toPageId, link.label, now);

    return dangling;
  }

  /**
   * Resolve a wikilink target to a page id — active pages only.
   *
   * A `pending` page must be invisible to link resolution: a shadow-mode page
   * silently satisfying another page's citation is exactly the leak the status
   * filter exists to prevent.
   */
  private resolveActivePageId(pageType: PageType | null, slug: string): string | null {
    const row = pageType
      ? (this.db
          .prepare(
            `SELECT id FROM knowledge_pages WHERE page_type = ? AND slug = ? AND status = 'active'`,
          )
          .get(pageType, slug) as { id: string } | undefined)
      : (this.db
          .prepare(
            `SELECT id FROM knowledge_pages WHERE slug = ? AND status = 'active'
             ORDER BY updated_at DESC, id ASC LIMIT 1`,
          )
          .get(slug) as { id: string } | undefined);
    return row?.id ?? null;
  }

  private appendLog(entry: {
    pageId: string | null;
    action: KnowledgeLogAction;
    actor: KnowledgeLogActor;
    version: number | null;
    reason: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO knowledge_log (id, page_id, action, actor, version, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        entry.pageId,
        entry.action,
        entry.actor,
        entry.version,
        entry.reason,
        Date.now(),
      );
  }
}

function refSlug(ref: KnowledgePageRef): string {
  return 'id' in ref ? ref.id : ref.slug;
}
