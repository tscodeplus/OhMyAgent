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
  KnowledgeBacklink,
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
import { relationForPageType } from './types.js';
import { normalizeScope, scopeSql } from './scope.js';
import { slugify } from './slug.js';
import { canonicalizeEntityName } from '../repositories/entity-repository.js';
import { resolveWikilinks } from './links.js';
import { indexKnowledgePage } from './indexer.js';
import { normalizeMergeName } from './merge.js';

/** Address a page by slug (optionally within one page type) or by id. */
export type KnowledgePageRef = { slug: string; pageType?: PageType } | { id: string };

export interface KnowledgePageListQuery {
  status: KnowledgePageStatus;
  pageType?: PageType;
  /** Asked scope; pages in this scope **or** `'global'` are returned. */
  scope?: string;
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
  /** Cached `entities`-table probe: absent on a knowledge-only database. */
  private entitiesTable: boolean | undefined;

  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /**
   * `scope` is optional only for internal reads that already filtered (the index
   * lane re-reads a row it just matched); every caller-facing lookup passes the
   * asked scope, so a page from another chat cannot be addressed by id.
   */
  findById(id: string, scope?: string): KnowledgePage | undefined {
    if (scope === undefined) {
      return this.db.prepare('SELECT * FROM knowledge_pages WHERE id = ?').get(id) as
        KnowledgePage | undefined;
    }
    const filter = scopeSql('scope', scope);
    return this.db
      .prepare(`SELECT * FROM knowledge_pages WHERE id = ? AND ${filter.sql}`)
      .get(id, ...filter.params) as KnowledgePage | undefined;
  }

  /**
   * Look up by slug, optionally constrained to one page type.
   *
   * Without a page type the same slug can exist as several pages (`topic/x` and
   * `project/x`), so an active page wins and the newest updated_at breaks the
   * remaining tie — a caller that needs determinism should pass the type.
   */
  findBySlug(slug: string, pageType?: PageType, scope?: string): KnowledgePage | undefined {
    const normalised = slugify(slug);
    if (!normalised) return undefined;
    // Rows local to the asked scope sort above global ones: a chat that wrote its
    // own `deploy-process` must read its own page, not the console's earlier one.
    const filter = scope === undefined ? null : scopeSql('scope', scope);
    const scopeClause = filter ? ` AND ${filter.sql}` : '';
    const scopeParams = filter ? filter.params : [];
    if (pageType) {
      return this.db
        .prepare(
          `SELECT * FROM knowledge_pages WHERE page_type = ? AND slug = ?${scopeClause}
           ORDER BY (scope != 'global') DESC, (status = 'active') DESC, updated_at DESC, id ASC
           LIMIT 1`,
        )
        .get(pageType, normalised, ...scopeParams) as KnowledgePage | undefined;
    }
    return this.db
      .prepare(
        `SELECT * FROM knowledge_pages WHERE slug = ?${scopeClause}
         ORDER BY (scope != 'global') DESC, (status = 'active') DESC, updated_at DESC, id ASC
         LIMIT 1`,
      )
      .get(normalised, ...scopeParams) as KnowledgePage | undefined;
  }

  /** Browse one status, newest-updated first. */
  list(query: KnowledgePageListQuery): KnowledgePage[] {
    const params: unknown[] = [query.status];
    let sql = 'SELECT * FROM knowledge_pages WHERE status = ?';
    if (query.scope !== undefined) {
      const filter = scopeSql('scope', query.scope);
      sql += ` AND ${filter.sql}`;
      params.push(...filter.params);
    }
    if (query.pageType) {
      sql += ' AND page_type = ?';
      params.push(query.pageType);
    }
    sql += ' ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?';
    params.push(query.limit ?? DEFAULT_LIST_LIMIT, query.offset ?? 0);
    return this.db.prepare(sql).all(...params) as KnowledgePage[];
  }

  /**
   * Pages whose title starts with `text`, or whose slug / one of whose aliases
   * equals it (case-folded).
   *
   * The title leg is a **prefix** match, not equality: a searcher who typed
   * `power que` or `Power` is naming the page, and the body leg cannot help when
   * the body never repeats the words in the title. Prefix is the widest leg that
   * is still deterministic — no stemming, no fuzzy distance, no model — and it is
   * anchored, so it cannot match a title's middle. The match runs over
   * `normalized_title` (migration-v24, the `normalizeMergeName` fold), so
   * `Power Query`, `power-query` and a full-width `ＰＯＷＥＲ　Ｑ` all name the
   * same page and the prefix is an indexed `LIKE 'x%'` instead of an expression
   * scan over `lower(trim(title))`.
   * Aliases stay exact because an alias *is* an address (`PQ` for `Power Query`),
   * and an exact title sorts above a prefix one, newest first after that, so the
   * leg's own order is total: two pages that both prefix-match `Power` do not
   * swap places between two identical searches.
   *
   * The FTS index holds the segmented body and title, so an acronym stored as an
   * alias is findable only through this leg of `knowledge_search`. The `tag` /
   * `pageType` filters live in SQL for the same reason as in
   * `searchKnowledgeIndex`: filtering in JS would make `limit` a lie.
   */
  findByTitleOrAlias(
    text: string,
    options: {
      status: KnowledgePageStatus;
      pageType?: PageType;
      tag?: string;
      scope?: string;
      limit: number;
    },
  ): KnowledgePage[] {
    const trimmed = text.trim();
    if (!trimmed) return [];

    // The prefix runs over the stored comparison key (migration-v24), so it is
    // an indexed `LIKE 'x%'` and folds case, width and punctuation. Normalizing
    // strips everything that is not a letter or digit, so no LIKE wildcard can
    // survive into the pattern and no `ESCAPE` clause is needed.
    // A query with no letter or digit left is not a name: the pre-v24 LIKE
    // answered it literally (nothing, ever), and an empty `%%` prefix would be
    // the opposite answer (everything), so the old semantics win.
    const normalizedTitle = normalizeMergeName(trimmed);
    if (!normalizedTitle) return [];
    const normalizedPrefix = `${normalizedTitle}%`;
    const params: unknown[] = [options.status, normalizedPrefix, slugify(trimmed), trimmed];
    let sql = `
      SELECT * FROM knowledge_pages p
      WHERE p.status = ?
        AND (
          p.normalized_title LIKE ?
          OR p.slug = ?
          OR EXISTS (SELECT 1 FROM json_each(p.aliases) WHERE lower(json_each.value) = lower(?))
        )`;
    if (options.scope !== undefined) {
      const filter = scopeSql('p.scope', options.scope);
      sql += ` AND ${filter.sql}`;
      params.push(...filter.params);
    }
    if (options.pageType) {
      sql += ` AND p.page_type = ?`;
      params.push(options.pageType);
    }
    if (options.tag) {
      sql += ` AND EXISTS (SELECT 1 FROM json_each(p.tags) WHERE json_each.value = ?)`;
      params.push(options.tag);
    }
    params.push(trimmed);
    sql += ` ORDER BY (lower(trim(p.title)) = lower(?)) DESC, p.updated_at DESC, p.id ASC LIMIT ?`;
    params.push(options.limit);

    return this.db.prepare(sql).all(...params) as KnowledgePage[];
  }

  /**
   * The ACTIVE page the caller's subject already names — the damping lookup
   * for a re-curated archived address (`curate.ts`). Exact legs only: the
   * stored normalized title equals the caller's folded title, the slug equals
   * the derived slug, or one absorbed alias equals the spelling. Not the
   * prefix of `findByTitleOrAlias` — a damping decision must only redirect
   * two spellings of one subject, and a prefix would fold "Power" into
   * "Power Query" and rewrite the wrong page.
   *
   * A chat's own page sorts above a global one (`scopeSql`), newest first
   * after that — the same total order `findBySlug` reads with.
   */
  findActiveSameSubject(
    title: string,
    slug: string,
    options?: { pageType?: PageType; scope?: string },
  ): KnowledgePage | undefined {
    const normalizedTitle = normalizeMergeName(title);
    const normalizedSlug = slugify(slug);
    if (!normalizedTitle && !normalizedSlug) return undefined;
    const params: unknown[] = [normalizedTitle, normalizedSlug, title];
    let sql = `
      SELECT * FROM knowledge_pages p
      WHERE p.status = 'active'
        AND (
          p.normalized_title = ?
          OR p.slug = ?
          OR EXISTS (SELECT 1 FROM json_each(p.aliases) WHERE lower(json_each.value) = lower(?))
        )`;
    if (options?.scope !== undefined) {
      const filter = scopeSql('p.scope', options.scope);
      sql += ` AND ${filter.sql}`;
      params.push(...filter.params);
    }
    if (options?.pageType) {
      sql += ` AND p.page_type = ?`;
      params.push(options.pageType);
    }
    sql += " ORDER BY (p.scope != 'global') DESC, p.updated_at DESC, p.id ASC LIMIT 1";
    return this.db.prepare(sql).get(...params) as KnowledgePage | undefined;
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
   * The active pages whose body cites `pageId` — the reverse of {@link linksOf}.
   *
   * `scope` filters the *linking* pages by the usual read rule (`scope = asked
   * OR 'global'`, {@link scopeSql}): a panel of who-cites-this is a list of
   * pages, and a page another chat cannot read must not be named by its panel.
   * Omitted, the console's every-scope view is kept.
   *
   * Joined to `knowledge_pages` rather than read straight from
   * `knowledge_links` because the caller wants to *name* the linking pages, and
   * `status = 'active'` is the read filter every other knowledge reader applies:
   * a shadow-mode page must not become visible as somebody's backlink. The join
   * also drops a link row whose source page no longer exists (only possible on a
   * connection with foreign keys off, since the FK cascades on delete).
   *
   * Reads `idx_knowledge_links_to` (migration-v20); before that index this was a
   * full scan of the link table. Newest-updated first, id as the tiebreak, so the
   * order is total.
   */
  linksTo(pageId: string, scope?: string): KnowledgeBacklink[] {
    const filter = scope === undefined ? null : scopeSql('p.scope', scope);
    const scopeClause = filter ? ` AND ${filter.sql}` : '';
    const scopeParams = filter ? filter.params : [];
    return this.db
      .prepare(
        `SELECT p.slug AS slug, p.title AS title, l.label AS label,
                l.relation_type AS relation_type
         FROM knowledge_links l
         JOIN knowledge_pages p ON p.id = l.from_page_id
         WHERE l.to_page_id = ? AND p.status = 'active'${scopeClause}
         ORDER BY p.updated_at DESC, p.id ASC`,
      )
      .all(pageId, ...scopeParams) as KnowledgeBacklink[];
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
    input: CreateKnowledgePageInput & {
      status: KnowledgePageStatus;
      updatedBy: string;
      scope?: string;
    },
    actor: KnowledgeLogActor,
  ): KnowledgePageWriteResult {
    const run = this.db.transaction((): KnowledgePageWriteResult => {
      // Same-scope only: a page with this slug in another chat is a different
      // page, not a conflict. Globals still collide here, because promoting to
      // global is how a chat's page becomes one page for everybody.
      const scope = normalizeScope(input.scope);
      const existing = this.findBySlug(input.slug, input.pageType, scope);
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
             (id, page_type, slug, title, normalized_title, content, aliases, tags, confidence,
              version, status, entity_id, scope, created_at, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.pageType,
          slug,
          input.title,
          // The name leg's comparison key (migration-v24); maintained on every
          // write so the stored fold can never drift from the title.
          normalizeMergeName(input.title),
          input.content,
          serializeArray(input.aliases),
          serializeArray(input.tags),
          input.confidence ?? null,
          input.status,
          this.resolveEntityId(input.title),
          scope,
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
      const danglingLinks = this.writeLinks(id, input.content, scope);

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
    scope?: string,
  ): KnowledgePageWriteResult {
    const run = this.db.transaction((): KnowledgePageWriteResult => {
      const current = this.resolveRef(ref, scope);
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
           SET title = ?, normalized_title = ?, content = ?, aliases = ?, tags = ?, confidence = ?,
               version = ?, status = ?, entity_id = ?, updated_at = ?, updated_by = ?
           WHERE id = ?`,
        )
        .run(
          title,
          normalizeMergeName(title),
          content,
          input.aliases !== undefined ? serializeArray(input.aliases) : current.aliases,
          input.tags !== undefined ? serializeArray(input.tags) : current.tags,
          input.confidence ?? current.confidence,
          version,
          status,
          // A retitled page is about a different subject iff its new title folds
          // to a different canonical name; keep the link when nothing moved, so
          // an unrelated body edit cannot unlink a page.
          canonicalizeEntityName(title) === canonicalizeEntityName(current.title)
            ? current.entity_id
            : this.resolveEntityId(title),
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

      // Links are a parse of the body: only a body change can change them. The
      // writer's scope decides what a `[[wikilink]]` may resolve to, exactly as
      // on insert — an update must not silently relink against another chat.
      const danglingLinks =
        input.content !== undefined
          ? this.writeLinks(current.id, content, normalizeScope(scope ?? current.scope))
          : [];

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

  private resolveRef(ref: KnowledgePageRef, scope?: string): KnowledgePage | undefined {
    return 'id' in ref
      ? this.findById(ref.id, scope)
      : this.findBySlug(ref.slug, ref.pageType, scope);
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
  private writeLinks(pageId: string, content: string, scope: string): string[] {
    const { links, dangling } = resolveWikilinks(
      content,
      (link) => this.resolveActivePageId(link.pageType, link.slug, scope)?.id ?? null,
      { selfPageId: pageId },
    );

    this.db.prepare('DELETE FROM knowledge_links WHERE from_page_id = ?').run(pageId);
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO knowledge_links
         (from_page_id, to_page_id, label, relation_type, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    for (const link of links) {
      // The predicate is the target's type, not the body's wording: a wikilink
      // says "these pages are connected" and the type says how. Read from the
      // row the resolver just matched, so a link and its predicate cannot come
      // from two different pages.
      const targetType = this.pageTypeById(link.toPageId);
      const relation = targetType ? relationForPageType(targetType) : null;
      insert.run(pageId, link.toPageId, link.label, relation, now);
    }

    return dangling;
  }

  /**
   * Resolve a wikilink target to a page id — active pages only.
   *
   * A `pending` page must be invisible to link resolution: a shadow-mode page
   * silently satisfying another page's citation is exactly the leak the status
   * filter exists to prevent.
   */
  /**
   * The page a wikilink points at, from the writer's own point of view.
   *
   * Scoped, because a link written in chat A that resolved to chat B's page would
   * publish B's existence as a backlink. The link stays in the body either way
   * (Obsidian resolves it); it is reported as dangling instead of stored.
   */
  private resolveActivePageId(
    pageType: PageType | null,
    slug: string,
    scope?: string,
  ): { id: string; pageType: PageType } | null {
    const filter = scope === undefined ? null : scopeSql('scope', scope);
    const scopeClause = filter ? ` AND ${filter.sql}` : '';
    const scopeParams = filter ? filter.params : [];
    if (pageType) {
      const row = this.db
        .prepare(
          `SELECT id, page_type FROM knowledge_pages
            WHERE page_type = ? AND slug = ? AND status = 'active'${scopeClause}
            ORDER BY (scope != 'global') DESC, updated_at DESC, id ASC LIMIT 1`,
        )
        .get(pageType, slug, ...scopeParams) as { id: string; page_type: PageType } | undefined;
      return row ? { id: row.id, pageType: row.page_type } : null;
    }
    const row = this.db
      .prepare(
        `SELECT id, page_type FROM knowledge_pages WHERE slug = ? AND status = 'active'${scopeClause}
         ORDER BY (scope != 'global') DESC, updated_at DESC, id ASC LIMIT 1`,
      )
      .get(slug, ...scopeParams) as { id: string; page_type: PageType } | undefined;
    return row ? { id: row.id, pageType: row.page_type } : null;
  }

  private pageTypeById(id: string): PageType | null {
    const row = this.db.prepare('SELECT page_type FROM knowledge_pages WHERE id = ?').get(id) as
      { page_type: PageType } | undefined;
    return row?.page_type ?? null;
  }

  /**
   * The entity node whose canonical name this title folds to, or NULL.
   *
   * A lookup, never an insert: the graph's nodes are attested by memories, and a
   * page creating one would put a subject in the graph that no producer vouched
   * for (see `KnowledgePage.entity_id`). The `entities` table is absent on a
   * knowledge-only database, which is not an error — it means nothing is linked.
   */
  private resolveEntityId(title: string): string | null {
    if (!this.hasEntitiesTable()) return null;
    const canonical = canonicalizeEntityName(title);
    if (!canonical) return null;
    const row = this.db
      .prepare(
        `SELECT id FROM entities WHERE canonical_name = ?
          ORDER BY updated_at DESC, id ASC LIMIT 1`,
      )
      .get(canonical) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private hasEntitiesTable(): boolean {
    if (this.entitiesTable !== undefined) return this.entitiesTable;
    const row = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entities'`)
      .get() as { name: string } | undefined;
    this.entitiesTable = row !== undefined;
    return this.entitiesTable;
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
