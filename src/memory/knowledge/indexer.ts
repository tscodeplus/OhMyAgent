/**
 * `knowledge_fts_jieba` maintenance and search.
 *
 * Two things live here, and only here, because both are consequences of the
 * table's shape (a *standalone* FTS5 table, not external-content — see
 * migration-v14 and migration-v20):
 *
 * 1. **Write = DELETE by `page_id`, then INSERT.** FTS5 has no uniqueness
 *    constraint, so an INSERT-only update path leaves the previous body in the
 *    index and `knowledge_search` starts returning superseded text. This is the
 *    same discipline `fts.ts` applies to `messages_fts_jieba`.
 * 2. **Read joins back to `knowledge_pages`.** The index carries the body and
 *    the id, but `status`, `tags` and the authoritative `title`/`slug` live on
 *    the page row. Filtering in SQL rather than after the fact is what keeps
 *    `status = 'pending'` pages out of search results *and* out of the
 *    `LIMIT` accounting.
 *
 * `content` and `title` are the indexed columns, and both are stored
 * jieba-segmented: the default `unicode61` tokenizer cannot split CJK, so a
 * title that tokenizes differently from the query can never match. `title`
 * became indexed in migration-v20 — in v14 it was `UNINDEXED`, which left a page
 * findable only through the exact-name leg whenever its body did not repeat the
 * words in its title.
 *
 * Segmentation reuses `fts-tokenizer.ts` (`tokenizeForIndex` / `buildFtsQuery`)
 * — there is deliberately no second jieba path in this file.
 */

import type Database from 'better-sqlite3';
import { buildFtsQuery, tokenizeForIndex } from '../fts-tokenizer.js';
import type { KnowledgePage, KnowledgePageStatus, PageType } from './types.js';
import { scopeSql } from './scope.js';

/** Columns written per page. `content` and `title` are indexed, both segmented. */
export interface KnowledgeIndexablePage {
  id: string;
  title: string;
  pageType: PageType;
  content: string;
}

/**
 * Replace a page's index row: delete every row for the page, then insert one.
 *
 * Per-page, not per-batch: the caller runs this inside the page write's
 * transaction so the index can never be ahead of or behind the page row.
 *
 * The title is written too, and segmented the same way as the body — a title
 * change is a search change (a page retitled `Pivot Tables` must stop matching
 * `Pivot Charts`, and the old title must stop matching at all), which is why
 * `repository.updatePage` re-indexes on `title` as well as on `content`.
 */
export function indexKnowledgePage(db: Database.Database, page: KnowledgeIndexablePage): void {
  db.prepare('DELETE FROM knowledge_fts_jieba WHERE page_id = ?').run(page.id);
  db.prepare(
    `INSERT INTO knowledge_fts_jieba (content, content_original, page_id, title, page_type)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    tokenizeForIndex(page.content),
    page.content,
    page.id,
    tokenizeForIndex(page.title),
    page.pageType,
  );
}

export interface KnowledgeIndexSearchOptions {
  /** Read filter. Search always passes `'active'`; the index holds every status. */
  status: KnowledgePageStatus;
  pageType?: PageType;
  /** Exact tag match against the page's JSON `tags` array. */
  tag?: string;
  /**
   * Asked scope: the page's own scope **or** `'global'` (migration-v22).
   *
   * Filtered in SQL rather than after the fact for the same reason as `status`:
   * a `LIMIT` applied before the filter would quietly shrink the result set
   * instead of returning the right number of in-scope hits.
   */
  scope?: string;
  limit: number;
}

export interface KnowledgeIndexHit {
  pageId: string;
  /** Raw markdown, used for the snippet — never the segmented column. */
  contentOriginal: string;
  /** Raw FTS5 BM25 rank: negative, and *more* negative means a better match. */
  bm25Score: number;
  /**
   * The page row the match joined back to, carried in the same SELECT so the
   * caller never has to re-read pages one `findById` per hit (the old N+1).
   * The JOIN already established the page exists and satisfies the filters, so
   * a stale index row cannot reach a caller as a hole to be plugged.
   */
  page: KnowledgePage;
}

/**
 * BM25 search over the page index, filtered to one status.
 *
 * `bm25()` takes one weight per column, in declaration order
 * (`content, content_original, page_id, title, page_type`): the body counts
 * normally, the title counts triple, and the three `UNINDEXED` columns' weights
 * are inert. A page's own name is the cheapest way to identify it, so the same
 * word in a title says more about the page than the same word in a paragraph.
 * This is a *weight*, not a second lane: the fused ordering across the name leg
 * lives in `service.ts`.
 *
 * A malformed query is an empty result, not an exception: FTS5 MATCH throws on
 * syntax it dislikes and a search box must not turn that into a failed turn.
 */
export function searchKnowledgeIndex(
  db: Database.Database,
  query: string,
  options: KnowledgeIndexSearchOptions,
): KnowledgeIndexHit[] {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  const params: unknown[] = [ftsQuery, options.status];
  let sql = `
    SELECT f.page_id AS page_id,
           f.content_original AS content_original,
           bm25(knowledge_fts_jieba, 1.0, 0, 0, 3.0, 0) AS rank,
           p.*
    FROM knowledge_fts_jieba f
    JOIN knowledge_pages p ON p.id = f.page_id
    WHERE knowledge_fts_jieba MATCH ?
      AND p.status = ?`;
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
  sql += ` ORDER BY rank LIMIT ?`;
  params.push(options.limit);

  try {
    const rows = db.prepare(sql).all(...params) as Array<
      {
        page_id: string;
        content_original: string;
        rank: number;
      } & KnowledgePage
    >;
    return rows.map((row) => {
      // `p.*` lands the page columns on the row; the join already established
      // the page exists and satisfies the filters, so the caller can use it
      // directly instead of one `findById` per hit.
      const { page_id, content_original, rank, ...page } = row;
      return {
        pageId: page_id,
        contentOriginal: content_original,
        bm25Score: rank,
        page: page as KnowledgePage,
      };
    });
  } catch {
    return [];
  }
}

/** Characters kept on each side of the match; ≈120 characters of body in total. */
const SNIPPET_RADIUS = 60;

/**
 * Plain query terms, obtained by taking the FTS5 MATCH expression apart.
 *
 * Reusing `buildFtsQuery` (rather than cutting the query a second way) keeps the
 * snippet anchored on exactly the tokens the index matched — otherwise a
 * snippet could be centred on a word FTS never looked at.
 */
function queryTerms(query: string): string[] {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];
  return ftsQuery
    .split(' OR ')
    .map((term) => term.replace(/^"|"$/g, ''))
    .filter((term) => term.length > 0);
}

/**
 * ~120 characters of `content_original` around the first matching term.
 *
 * Read from the raw column, not the segmented one: a snippet of jieba tokens
 * (`Excel 的 数据 清洗`) is unreadable in a card or a tool result. Whitespace is
 * collapsed and the clip is marked with `…` so a truncated snippet cannot be
 * mistaken for the whole note.
 */
export function buildSnippet(
  contentOriginal: string,
  query: string,
  radius: number = SNIPPET_RADIUS,
): string {
  const compact = (text: string) => text.replace(/\s+/g, ' ').trim();
  const haystack = contentOriginal.toLowerCase();

  let hit = -1;
  for (const term of queryTerms(query)) {
    const at = haystack.indexOf(term.toLowerCase());
    if (at >= 0 && (hit < 0 || at < hit)) hit = at;
  }

  if (hit < 0) {
    const head = contentOriginal.slice(0, radius * 2);
    return `${compact(head)}${contentOriginal.length > head.length ? '…' : ''}`;
  }

  const start = Math.max(0, hit - radius);
  const end = Math.min(contentOriginal.length, hit + radius);
  const body = compact(contentOriginal.slice(start, end));
  return `${start > 0 ? '…' : ''}${body}${end < contentOriginal.length ? '…' : ''}`;
}

export interface KnowledgeIndexConsistency {
  pageCount: number;
  /** FTS rows — one per page when the index is correct. */
  indexedRowCount: number;
  duplicatePageIds: string[];
  /** Pages with no index row: unsearchable. */
  missingPageIds: string[];
  /** Index rows whose page no longer exists: searchable ghosts. */
  orphanPageIds: string[];
  consistent: boolean;
}

/**
 * Compare `knowledge_pages` with its index.
 *
 * Row count alone is not enough — one page indexed twice and another not at all
 * keeps `COUNT(*)` equal — so duplicates, misses and orphans are reported
 * separately. `pnpm knowledge:reindex --check` reports this and changes nothing.
 */
export function checkConsistency(db: Database.Database): KnowledgeIndexConsistency {
  const pageCount = (
    db.prepare('SELECT COUNT(*) AS cnt FROM knowledge_pages').get() as {
      cnt: number;
    }
  ).cnt;
  const indexedRowCount = (
    db.prepare('SELECT COUNT(*) AS cnt FROM knowledge_fts_jieba').get() as {
      cnt: number;
    }
  ).cnt;

  const duplicatePageIds = (
    db
      .prepare(
        `SELECT page_id FROM knowledge_fts_jieba GROUP BY page_id HAVING COUNT(*) > 1 ORDER BY page_id`,
      )
      .all() as Array<{ page_id: string }>
  ).map((row) => row.page_id);

  const missingPageIds = (
    db
      .prepare(
        `SELECT p.id FROM knowledge_pages p
         WHERE NOT EXISTS (SELECT 1 FROM knowledge_fts_jieba f WHERE f.page_id = p.id)
         ORDER BY p.id`,
      )
      .all() as Array<{ id: string }>
  ).map((row) => row.id);

  const orphanPageIds = (
    db
      .prepare(
        `SELECT DISTINCT f.page_id FROM knowledge_fts_jieba f
         WHERE NOT EXISTS (SELECT 1 FROM knowledge_pages p WHERE p.id = f.page_id)
         ORDER BY f.page_id`,
      )
      .all() as Array<{ page_id: string }>
  ).map((row) => row.page_id);

  return {
    pageCount,
    indexedRowCount,
    duplicatePageIds,
    missingPageIds,
    orphanPageIds,
    consistent:
      pageCount === indexedRowCount &&
      duplicatePageIds.length === 0 &&
      missingPageIds.length === 0 &&
      orphanPageIds.length === 0,
  };
}

/**
 * Drop the index and rebuild it from `knowledge_pages`.
 *
 * Needed after a tokenizer or schema change (the segmented column is a cache of
 * a segmentation decision) and to repair drift found by {@link checkConsistency}.
 * One transaction: a half-rebuilt index would report every unvisited page as
 * missing.
 *
 * @returns the number of pages indexed.
 */
export function rebuild(db: Database.Database): { pages: number } {
  const pages = db
    .prepare('SELECT id, page_type, title, content FROM knowledge_pages')
    .all() as Array<{ id: string; page_type: string; title: string; content: string }>;

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM knowledge_fts_jieba').run();
    for (const page of pages) {
      indexKnowledgePage(db, {
        id: page.id,
        title: page.title,
        pageType: page.page_type as PageType,
        content: page.content,
      });
    }
  });
  tx();

  return { pages: pages.length };
}
