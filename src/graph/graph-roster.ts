/**
 * Rosters: the graph's two enumerable lists (plan §4.1).
 *
 * A drawing is a slice; a list can be complete. The WebUI's canvas answers "what
 * does this neighbourhood look like" and is capped at 40 rendered nodes, so it can
 * never answer "what is in my graph" — on the device 357 of 378 entities have no
 * relation at all and therefore have nothing to draw. These two endpoints are the
 * complete answer: every entity and every edge, paginated with a **keyset cursor**
 * (not `OFFSET`) so each row appears exactly once and paging stays stable while
 * the projector keeps writing behind it.
 *
 * Deliberately NOT `/api/search`: that is a *ranking* (RRF fusion, scores that move
 * with the query), and a keyset needs an order that does not depend on the query.
 * Enumeration and ranking are different jobs; merging them is how one gets two
 * rankers that disagree.
 *
 * Read-only. Nothing here writes, and nothing here re-derives a relation count: the
 * degree numbers come straight from `entity_edges` — the same predicate the canvas
 * radius and the overview ranking use, retracted edges included — so the two
 * surfaces cannot drift. (v27's materialised metrics replace this scan wholesale.)
 */

import type Database from 'better-sqlite3';
import { MENTION_RELATION_TYPE } from './entity-mining.js';
import { graphTablesPresent } from './graph-query.js';

/** Entity columns the roster can order by. */
export type EntityRosterSort = 'degree' | 'mentions' | 'name' | 'updated';
/** Edge columns the roster can order by. */
export type EdgeRosterSort = 'validFrom' | 'confidence' | 'relation';
/** `yes` = has a typed edge, `no` = isolated (mention-only included), `any` = all. */
export type RosterEdgePresence = 'any' | 'yes' | 'no';

export interface EntityRosterQuery {
  /** Substring over name / canonical name / aliases. */
  q?: string;
  entityType?: string;
  edges?: RosterEdgePresence;
  minDegree?: number;
  sort: EntityRosterSort;
  dir: 'asc' | 'desc';
  cursor?: RosterCursor;
  limit: number;
}

export interface EntityRosterRow {
  id: string;
  name: string;
  canonicalName: string;
  entityType: string;
  /**
   * Incident typed edges, retracted ones included (same predicate as `GraphNode.degree`).
   * The filters `edges` / `minDegree` instead use OPEN connectivity — see the note there.
   */
  degree: { out: number; in: number; total: number };
  /** `memory_links` rows naming this entity, exact name (same predicate as the ranking). */
  mentionCount: number;
  /** Up to `ALIAS_PREVIEW` aliases, alphabetical. */
  aliases: string[];
  /** How many aliases exist in total, so "6 of 9" is sayable. */
  aliasCount: number;
  updatedAt: number | null;
}

export interface EntityRosterPage {
  items: EntityRosterRow[];
  /** Rows matching the filters, ignoring the cursor and limit. */
  total: number;
  nextCursor: string | null;
}

export interface EdgeRosterQuery {
  /** Entity id: outgoing edges only. */
  source?: string;
  /** Entity id: incoming edges only. */
  target?: string;
  relation?: string;
  status: 'open' | 'retracted' | 'all';
  /** Epoch ms; the same temporal predicate the drawing uses. */
  asOf?: number;
  /** Epoch ms window over `valid_from`. */
  since?: number;
  until?: number;
  sort: EdgeRosterSort;
  dir: 'asc' | 'desc';
  cursor?: RosterCursor;
  limit: number;
}

export interface EdgeRosterRow {
  id: string;
  relationType: string;
  confidence: number;
  source: { id: string; name: string };
  target: { id: string; name: string };
  validFrom: number | null;
  /** Non-null = retracted: history, not connectivity. */
  validTo: number | null;
  sourceMemoryId: string | null;
}

export interface EdgeRosterPage {
  items: EdgeRosterRow[];
  total: number;
  nextCursor: string | null;
  /**
   * Open vs retracted under the same filters *except* `status` — so the list can
   * say "2 of 12 are history" without a second request.
   */
  counts: { open: number; retracted: number };
}

/** Aliases returned per row; the rest are counted, not sent (a phone renders a line). */
const ALIAS_PREVIEW = 6;

/** `(sortValue, id)` — the id tiebreak is what makes the order total. */
export interface RosterCursor {
  v: string | number;
  id: string;
}

export function encodeRosterCursor(cursor: RosterCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * `undefined` for anything that is not a cursor this module wrote.
 *
 * The route answers 400 on `undefined` rather than paging from the start: a
 * truncated or hand-edited cursor silently restarting the list is how a reader
 * concludes "the list lost rows".
 */
export function decodeRosterCursor(raw: string): RosterCursor | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const { v, id } = parsed as { v?: unknown; id?: unknown };
    if (typeof id !== 'string' || id.length === 0) return undefined;
    if (v !== null && typeof v !== 'string' && typeof v !== 'number') return undefined;
    if (typeof v === 'number' && !Number.isFinite(v)) return undefined;
    return { v: v as string | number, id };
  } catch {
    return undefined;
  }
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/**
 * The `base` CTE every entity-roster query stands on.
 *
 * Degrees come from two `GROUP BY`s over `entity_edges` rather than from a
 * correlated subquery per row (the shape 43 ms of a 55 ms request used to cost):
 * one indexed pass each, then a hash join. `mentions` is only built when a caller
 * needs the column, because it is the expensive one — a join that probes
 * `memory_links` per entity, which is exactly what `idx_memory_links_subject`
 * (migration-v26) makes cheap in both directions.
 */
function entityRosterBase(db: Database.Database, withMentions: boolean): string {
  const mentions = withMentions
    ? `, mentions AS (
         SELECT e2.id AS id, COUNT(*) AS n
           FROM entities e2
           JOIN memory_links ml
             ON ml.target_entity = e2.name OR ml.subject_entity = e2.name
          GROUP BY e2.id
       )`
    : '';
  const mentionColumns = withMentions
    ? ', COALESCE(m.n, 0) AS mention_count'
    : ', 0 AS mention_count';
  const mentionJoin = withMentions ? ' LEFT JOIN mentions m ON m.id = e.id' : '';
  return `WITH dout AS (
            SELECT source_entity_id AS id, COUNT(*) AS n FROM entity_edges GROUP BY 1
          ), din AS (
            SELECT target_entity_id AS id, COUNT(*) AS n FROM entity_edges GROUP BY 1
          ), dout_live AS (
            SELECT source_entity_id AS id, COUNT(*) AS n FROM entity_edges
             WHERE valid_to IS NULL GROUP BY 1
          ), din_live AS (
            SELECT target_entity_id AS id, COUNT(*) AS n FROM entity_edges
             WHERE valid_to IS NULL GROUP BY 1
          )${mentions}, base AS (
            SELECT e.id, e.name, e.canonical_name, e.entity_type, e.updated_at,
                   COALESCE(dout.n, 0) AS degree_out,
                   COALESCE(din.n, 0) AS degree_in,
                   COALESCE(dout.n, 0) + COALESCE(din.n, 0) AS degree_total,
                   COALESCE(dout_live.n, 0) + COALESCE(din_live.n, 0) AS degree_live${mentionColumns}
              FROM entities e
              LEFT JOIN dout ON dout.id = e.id
              LEFT JOIN din ON din.id = e.id
              LEFT JOIN dout_live ON dout_live.id = e.id
              LEFT JOIN din_live ON din_live.id = e.id${mentionJoin}
          )`;
}

/** The ORDER BY expression for a sort key, and whether its values are numbers. */
function entityOrderValue(sort: EntityRosterSort): string {
  switch (sort) {
    case 'degree':
      return 'b.degree_total';
    case 'mentions':
      return 'b.mention_count';
    case 'updated':
      // NULL sorts with 0 instead of last-forever, so "newest first" keeps working
      // on rows the projector never stamped.
      return 'COALESCE(b.updated_at, 0)';
    case 'name':
    default:
      return 'b.canonical_name';
  }
}

interface WhereClause {
  sql: string;
  params: Record<string, unknown>;
}

function entityRosterWhere(
  db: Database.Database,
  query: EntityRosterQuery,
  includeCursor: boolean,
): WhereClause {
  const parts: string[] = [];
  const params: Record<string, unknown> = {};

  if (query.q && query.q.trim().length > 0) {
    // `LIKE` on already-folded columns: `canonical_name` is stored folded, and the
    // alias leg probes the unique index instead of scanning the join.
    parts.push(
      `(b.canonical_name LIKE @q OR lower(b.name) LIKE @q
        OR EXISTS (SELECT 1 FROM entity_aliases a
                    WHERE a.entity_id = b.id AND lower(a.alias) LIKE @q))`,
    );
    params.q = `%${query.q.trim().toLowerCase()}%`;
  }
  if (query.entityType) {
    parts.push('b.entity_type = @entityType');
    params.entityType = query.entityType;
  }
  // `edges` / `minDegree` measure OPEN connectivity, which is exactly what
  // `/stats.isolated` counts: a node whose every fact was retracted has nothing the
  // canvas can draw, so it belongs with the isolated ones. The `degree` numbers in
  // the payload are a different question — what the record holds — and they count
  // history. Two questions, two names, both stated.
  if (query.edges === 'yes') parts.push('b.degree_live > 0');
  if (query.edges === 'no') parts.push('b.degree_live = 0');
  if (query.minDegree !== undefined) {
    parts.push('b.degree_live >= @minDegree');
    params.minDegree = query.minDegree;
  }

  if (includeCursor && query.cursor) {
    const orderValue = entityOrderValue(query.sort);
    const compare = query.dir === 'desc' ? '<' : '>';
    // Total order is `ORDER BY value <dir>, id ASC`; the id tiebreak is why a
    // cursor cannot land in a gap between two rows with the same value.
    parts.push(`(${orderValue} ${compare} @cursorValue
                 OR (${orderValue} = @cursorValue AND b.id > @cursorId))`);
    params.cursorValue = query.cursor.v;
    params.cursorId = query.cursor.id;
  }

  return { sql: parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '', params };
}

/**
 * One page of entities, with the numbers the roster columns show.
 *
 * `total` is computed under the same filters but without the cursor — a caller needs
 * to know how many rows the filter matched, and "of 378" is the denominator every
 * truncation in this plan must print.
 */
export function queryEntityRoster(
  db: Database.Database,
  query: EntityRosterQuery,
): EntityRosterPage {
  if (!graphTablesPresent(db)) return { items: [], total: 0, nextCursor: null };

  const limit = Math.max(1, Math.floor(query.limit));
  const withMentions = tableExists(db, 'memory_links');
  const base = entityRosterBase(db, withMentions);
  const paged = entityRosterWhere(db, query, true);
  const counted = entityRosterWhere(db, query, false);

  const rows = db
    .prepare(
      `${base}
       SELECT b.* FROM base b
       ${paged.sql}
       ORDER BY ${entityOrderValue(query.sort)} ${query.dir === 'desc' ? 'DESC' : 'ASC'},
                b.id ASC
       LIMIT @limit`,
    )
    .all({ ...paged.params, limit: limit + 1 }) as Array<{
    id: string;
    name: string;
    canonical_name: string;
    entity_type: string;
    updated_at: number | null;
    degree_out: number;
    degree_in: number;
    degree_total: number;
    degree_live: number;
    mention_count: number;
  }>;

  const { n: total } = db
    .prepare(`${base} SELECT COUNT(*) AS n FROM base b ${counted.sql}`)
    .get(counted.params) as { n: number };

  const page = rows.slice(0, limit);
  const ids = page.map((row) => row.id);
  const aliases = new Map<string, string[]>();
  if (ids.length > 0 && tableExists(db, 'entity_aliases')) {
    const placeholders = ids.map(() => '?').join(', ');
    const aliasRows = db
      .prepare(
        `SELECT entity_id AS id, alias FROM entity_aliases
          WHERE entity_id IN (${placeholders})
          ORDER BY entity_id, alias`,
      )
      .all(...ids) as Array<{ id: string; alias: string }>;
    for (const row of aliasRows) {
      const list = aliases.get(row.id);
      if (list) list.push(row.alias);
      else aliases.set(row.id, [row.alias]);
    }
  }

  const last = page[page.length - 1];
  const orderValueOf = (row: (typeof page)[number]): string | number => {
    switch (query.sort) {
      case 'degree':
        return row.degree_total;
      case 'mentions':
        return row.mention_count;
      case 'updated':
        return row.updated_at ?? 0;
      case 'name':
      default:
        return row.canonical_name;
    }
  };

  return {
    items: page.map((row) => {
      const list = aliases.get(row.id) ?? [];
      return {
        id: row.id,
        name: row.name,
        canonicalName: row.canonical_name,
        entityType: row.entity_type,
        degree: { out: row.degree_out, in: row.degree_in, total: row.degree_total },
        mentionCount: row.mention_count,
        aliases: list.slice(0, ALIAS_PREVIEW),
        aliasCount: list.length,
        updatedAt: row.updated_at,
      };
    }),
    total,
    nextCursor:
      rows.length > limit && last
        ? encodeRosterCursor({ v: orderValueOf(last), id: last.id })
        : null,
  };
}

/** The ORDER BY expression for an edge sort key. */
function edgeOrderValue(sort: EdgeRosterSort): string {
  switch (sort) {
    case 'confidence':
      return 'e.confidence';
    case 'relation':
      return 'e.relation_type';
    case 'validFrom':
    default:
      return 'COALESCE(e.valid_from, 0)';
  }
}

/**
 * Filters shared by the page query, the count and the counts breakdown.
 *
 * `status` is pulled out by the caller: the breakdown must measure both halves, so
 * it cannot be inside this clause.
 */
function edgeRosterWhere(query: EdgeRosterQuery, includeCursor: boolean): WhereClause {
  const parts: string[] = [`upper(trim(e.relation_type)) <> @mentionRelation`];
  const params: Record<string, unknown> = { mentionRelation: MENTION_RELATION_TYPE };

  if (query.source) {
    parts.push('e.source_entity_id = @source');
    params.source = query.source;
  }
  if (query.target) {
    parts.push('e.target_entity_id = @target');
    params.target = query.target;
  }
  if (query.relation) {
    parts.push('e.relation_type = @relation');
    params.relation = query.relation;
  }
  if (query.asOf !== undefined) {
    // The same predicate `parseGraphAsOf` feeds the drawing: "what was true then"
    // must mean one thing across the two surfaces.
    parts.push(
      `((e.valid_from IS NULL OR e.valid_from <= @asOf)
        AND (e.valid_to IS NULL OR e.valid_to > @asOf))`,
    );
    params.asOf = query.asOf;
  }
  if (query.since !== undefined) {
    parts.push('e.valid_from IS NOT NULL AND e.valid_from >= @since');
    params.since = query.since;
  }
  if (query.until !== undefined) {
    parts.push('e.valid_from IS NOT NULL AND e.valid_from <= @until');
    params.until = query.until;
  }
  if (includeCursor && query.cursor) {
    const orderValue = edgeOrderValue(query.sort);
    const compare = query.dir === 'desc' ? '<' : '>';
    parts.push(`(${orderValue} ${compare} @cursorValue
                 OR (${orderValue} = @cursorValue AND e.id > @cursorId))`);
    params.cursorValue = query.cursor.v;
    params.cursorId = query.cursor.id;
  }

  return { sql: `WHERE ${parts.join(' AND ')}`, params };
}

function statusClause(status: EdgeRosterQuery['status']): string {
  if (status === 'open') return 'AND e.valid_to IS NULL';
  if (status === 'retracted') return 'AND e.valid_to IS NOT NULL';
  return '';
}

/**
 * One page of typed edges, joined to both endpoints' names.
 *
 * The endpoint names travel in the row so the list renders without a second
 * request per line, and so `status=all` can show a retracted edge with the pair it
 * used to assert — which is the whole reason history is kept.
 */
export function queryEdgeRoster(db: Database.Database, query: EdgeRosterQuery): EdgeRosterPage {
  const empty = { items: [], total: 0, nextCursor: null, counts: { open: 0, retracted: 0 } };
  if (!graphTablesPresent(db)) return empty;

  const limit = Math.max(1, Math.floor(query.limit));
  const where = edgeRosterWhere(query, true);
  const counted = edgeRosterWhere(query, false);
  const status = statusClause(query.status);

  const rows = db
    .prepare(
      `SELECT e.id, e.relation_type, e.confidence, e.valid_from, e.valid_to,
              e.source_memory_id,
              s.id AS source_id, s.name AS source_name,
              t.id AS target_id, t.name AS target_name
         FROM entity_edges e
         JOIN entities s ON s.id = e.source_entity_id
         JOIN entities t ON t.id = e.target_entity_id
        ${where.sql} ${status}
        ORDER BY ${edgeOrderValue(query.sort)} ${query.dir === 'desc' ? 'DESC' : 'ASC'},
                 e.id ASC
        LIMIT @limit`,
    )
    .all({ ...where.params, limit: limit + 1 }) as Array<{
    id: string;
    relation_type: string;
    confidence: number;
    valid_from: number | null;
    valid_to: number | null;
    source_memory_id: string | null;
    source_id: string;
    source_name: string;
    target_id: string;
    target_name: string;
  }>;

  const { n: total } = db
    .prepare(`SELECT COUNT(*) AS n FROM entity_edges e ${counted.sql} ${status}`)
    .get(counted.params) as { n: number };

  const breakdown = db
    .prepare(
      `SELECT SUM(CASE WHEN e.valid_to IS NULL THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN e.valid_to IS NOT NULL THEN 1 ELSE 0 END) AS retracted
         FROM entity_edges e ${counted.sql}`,
    )
    .get(counted.params) as { open: number | null; retracted: number | null };

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const orderValueOf = (row: (typeof page)[number]): string | number => {
    switch (query.sort) {
      case 'confidence':
        return row.confidence;
      case 'relation':
        return row.relation_type;
      case 'validFrom':
      default:
        return row.valid_from ?? 0;
    }
  };

  return {
    items: page.map((row) => ({
      id: row.id,
      relationType: row.relation_type,
      confidence: row.confidence,
      source: { id: row.source_id, name: row.source_name },
      target: { id: row.target_id, name: row.target_name },
      validFrom: row.valid_from,
      validTo: row.valid_to,
      sourceMemoryId: row.source_memory_id,
    })),
    total,
    nextCursor:
      rows.length > limit && last
        ? encodeRosterCursor({ v: orderValueOf(last), id: last.id })
        : null,
    counts: { open: Number(breakdown.open ?? 0), retracted: Number(breakdown.retracted ?? 0) },
  };
}
