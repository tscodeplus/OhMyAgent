/**
 * Knowledge-graph read query — the one implementation behind both the WebUI
 * graph endpoint (`src/app/webui/graph-routes.ts`) and the `entity_query` tool.
 *
 * Both surfaces need the same three things: resolve a typed reference to one
 * entity, walk its neighbourhood through `EntityRepository.neighbors` (the
 * recursive-CTE walk and the temporal predicate live there, not here), and read
 * the edges among the result so the answer names both endpoints. Duplicating
 * that per surface is how the two answers would drift — one honouring `asOf`,
 * the other forgetting it.
 *
 * READ-ONLY: nothing here writes to the graph. Edge retraction/history belongs
 * to EntityRepository, not to a read surface.
 *
 * Two invariants this module is the last line of defence for:
 *
 *   - **`MENTIONED` is never an edge.** The projector refuses it, but a database
 *     a pre-K3 build projected still carries those rows until
 *     `legacy-cleanup` runs, and a read surface that showed one would hand the
 *     model co-occurrence labelled as a statement. The edge query filters it
 *     unconditionally; mentions get their own array
 *     (`readMentionNeighbours`) and nothing else.
 *   - **A cap that cuts the payload says so.** Every list reads one row past its
 *     limit so `truncated` is a measurement, not a guess from
 *     `rows.length === limit`.
 */

import type Database from 'better-sqlite3';
import { EntityRepository, type Entity } from '../memory/repositories/entity-repository.js';
import { MENTION_RELATION_TYPE } from './entity-mining.js';
import { decayedConfidence } from './decay.js';
import { parseEpochMs } from '../shared/timestamp.js';

/**
 * Deepest walk any read surface may ask for. The WebUI's depth selector is the
 * binding case; `entity_query` narrows it further to 1–2, because a 3-hop answer
 * is mostly nodes the question never asked about.
 */
export const MAX_QUERY_DEPTH = 3;

/** Default node/edge cap when the caller does not name one. */
export const DEFAULT_GRAPH_QUERY_LIMIT = 50;

export interface GraphQueryNode {
  id: string;
  name: string;
  canonical_name: string;
  entity_type: string;
  description?: string;
  /**
   * Incident edges in the whole graph, retracted ones included: a node whose
   * facts were all retracted must not look isolated — that is the point of
   * keeping history.
   */
  degree: number;
}

export interface GraphQueryEdge {
  id: string;
  /** Source/target are entity ids, matching `GraphQueryNode.id`. */
  source: string;
  target: string;
  relation_type: string;
  confidence: number;
  valid_from?: number;
  valid_to?: number;
  /**
   * `confidence` decayed to the instant being asked about, present only when
   * `decayHalfLifeDays` is configured. The stored number is never overwritten —
   * a reader can still see what the producer asserted.
   */
  effective_confidence?: number;
}

/**
 * A name the corpus mentions in the same memory as the queried entity.
 *
 * Never an edge: co-occurrence is not a statement (see `docs/KNOWLEDGE_GRAPH.md`
 * §3). It is reported in its own array, and only when the caller asked for it.
 */
export interface GraphMentionNeighbour {
  name: string;
  /** Memories that mention this name and the queried entity both. */
  memories: number;
}

export interface GraphEdgeFilter {
  /** Epoch ms; edges not valid at that instant are skipped. */
  asOf?: number;
  relationTypes?: string[];
  limit: number;
}

export interface EntityGraphQueryOptions {
  /** Hop count, 1..`MAX_QUERY_DEPTH`. Default 1. */
  depth?: number;
  /** Epoch ms, already parsed (`parseGraphAsOf`). */
  asOf?: number;
  relationTypes?: string[];
  /** Cap on nodes, edges and mentions. Default `DEFAULT_GRAPH_QUERY_LIMIT`. */
  limit?: number;
  /** Add co-mentioned names to `mentions`; they never enter `edges`. */
  includeMentions?: boolean;
  /**
   * Days in which an edge's confidence halves, measured from its own
   * `valid_from` to the instant being asked about. `0`/absent disables decay,
   * and `effective_confidence` is then omitted rather than echoing `confidence`.
   */
  decayHalfLifeDays?: number;
}

export interface EntityGraphQuery {
  /** The resolved origin entity (so a caller need not guess `nodes[0]`). */
  origin: GraphQueryNode;
  /** Neighbours, nearest hop first; the origin is not repeated here. */
  nodes: GraphQueryNode[];
  /** Edges with both endpoints inside `origin` ∪ `nodes`. */
  edges: GraphQueryEdge[];
  /** Empty unless `includeMentions` was requested. */
  mentions: GraphMentionNeighbour[];
  /** True when any cap (nodes, edges or mentions) cut the payload. */
  truncated: boolean;
}

/** `@p0, @p1, …` — one bound parameter per id, never interpolated. */
function idPlaceholders(ids: string[], prefix: string, params: Record<string, unknown>): string {
  return ids
    .map((id, index) => {
      params[`${prefix}${index}`] = id;
      return `@${prefix}${index}`;
    })
    .join(', ');
}

/** SQLite databases created before v10 have no graph tables at all. */
export function graphTablesPresent(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master
       WHERE type = 'table' AND name IN ('entities', 'entity_aliases', 'entity_edges')`,
    )
    .get() as { n: number };
  return row.n === 3;
}

/**
 * Epoch-ms point in time from a query string or a tool argument.
 *
 * Accepts the three shapes a caller can hand over — epoch ms as a number, the
 * digit-string form, or ISO-8601 — through `parseEpochMs`, which exists because
 * `new Date("1788237296000")` is Invalid Date. Unparsable means "no temporal
 * filter" rather than "the epoch": `asOf=0` would silently hide every edge.
 */
export function parseGraphAsOf(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = parseEpochMs(value);
  return parsed > 0 ? parsed : undefined;
}

/** Relation-type filter from a comma-separated query param or an argument array. */
export function parseGraphRelationTypes(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const types = raw
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [...new Set(types)];
}

/**
 * Edges whose BOTH endpoints are inside `ids`. Direction is preserved
 * (`source`/`target`), because the UI groups relations by direction and draws
 * arrowheads — a bidirectional view would lose that.
 *
 * Reads one row past the cap so the caller can report truncation truthfully
 * instead of guessing from `edges.length === limit`.
 */
export function loadEdgesBetween(
  db: Database.Database,
  ids: string[],
  filter: GraphEdgeFilter,
): { edges: GraphQueryEdge[]; truncated: boolean } {
  if (ids.length === 0) return { edges: [], truncated: false };
  const params: Record<string, unknown> = {
    limit: filter.limit + 1,
    asOf: filter.asOf ?? null,
    mentionRelation: MENTION_RELATION_TYPE,
  };
  const sourceIn = idPlaceholders(ids, 'src', params);
  const targetIn = idPlaceholders(ids, 'tgt', params);

  // Same temporal predicate as EntityRepository.neighbors: an edge that started
  // after asOf was not true yet, a retracted one only up to valid_to.
  //
  // The mention filter is not a tuning knob: `MENTIONED` rows are co-occurrence,
  // so a read that returned one would be the "promote mentions to edges" design
  // arriving through the back door (docs/KNOWLEDGE_GRAPH.md §3).
  let sql = `
    SELECT e.id, e.source_entity_id, e.target_entity_id, e.relation_type,
           e.confidence, e.valid_from, e.valid_to
    FROM entity_edges e
    WHERE e.source_entity_id IN (${sourceIn})
      AND e.target_entity_id IN (${targetIn})
      AND upper(trim(e.relation_type)) <> @mentionRelation
      AND (@asOf IS NULL OR ((e.valid_from IS NULL OR e.valid_from <= @asOf)
           AND (e.valid_to IS NULL OR e.valid_to > @asOf)))`;

  const relationTypes = filter.relationTypes ?? [];
  if (relationTypes.length > 0) {
    sql += ` AND e.relation_type IN (${idPlaceholders(relationTypes, 'rel', params)})`;
  }

  sql += ' ORDER BY e.confidence DESC, e.created_at DESC LIMIT @limit';

  const rows = db.prepare(sql).all(params) as Array<{
    id: string;
    source_entity_id: string;
    target_entity_id: string;
    relation_type: string;
    confidence: number;
    valid_from: number | null;
    valid_to: number | null;
  }>;

  return {
    edges: rows.slice(0, filter.limit).map((row) => ({
      id: row.id,
      source: row.source_entity_id,
      target: row.target_entity_id,
      relation_type: row.relation_type,
      confidence: row.confidence,
      ...(row.valid_from !== null ? { valid_from: row.valid_from } : {}),
      ...(row.valid_to !== null ? { valid_to: row.valid_to } : {}),
    })),
    truncated: rows.length > filter.limit,
  };
}

/** Node rows (with degree) for `ids`, ordered by the caller's id order. */
export function loadGraphNodes(db: Database.Database, ids: string[]): GraphQueryNode[] {
  if (ids.length === 0) return [];
  const params: Record<string, unknown> = {};
  const placeholders = idPlaceholders(ids, 'id', params);
  const rows = db
    .prepare(
      `SELECT e.id, e.name, e.canonical_name, e.entity_type, e.description,
              (SELECT COUNT(*) FROM entity_edges x
                WHERE x.source_entity_id = e.id OR x.target_entity_id = e.id) AS degree
       FROM entities e
       WHERE e.id IN (${placeholders})`,
    )
    .all(params) as Array<Entity & { degree: number }>;

  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids
    .map((id) => byId.get(id))
    .filter((row): row is Entity & { degree: number } => row !== undefined)
    .map((row) => ({
      id: row.id,
      name: row.name,
      canonical_name: row.canonical_name,
      entity_type: row.entity_type,
      ...(row.description ? { description: row.description } : {}),
      degree: Number(row.degree),
    }));
}

/**
 * Names co-mentioned with `entity` in the same memories, most shared memories
 * first.
 *
 * `memory_links` carries no entity id — it names the entity as text — so this
 * joins on the origin's stored name. That is the same comparison the docs'
 * re-check query uses (`target_entity = e.name OR subject_entity = e.name`).
 * Superseded memories are not filtered out: the count is evidence of what the
 * corpus talks about, not a claim about the entity.
 */
function readMentionNeighbours(
  db: Database.Database,
  entity: Entity,
  limit: number,
): { mentions: GraphMentionNeighbour[]; truncated: boolean } {
  const hasLinks =
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_links'")
      .get() !== undefined;
  if (!hasLinks) return { mentions: [], truncated: false };

  const rows = db
    .prepare(
      `WITH anchor(memory_id) AS (
         SELECT DISTINCT ml.source_memory_id
         FROM memory_links ml
         WHERE trim(ml.target_entity) = @name OR trim(ml.subject_entity) = @name
       )
       SELECT name, COUNT(DISTINCT memory_id) AS memories
       FROM (
         SELECT ml.source_memory_id AS memory_id, trim(ml.target_entity) AS name
         FROM memory_links ml JOIN anchor a ON a.memory_id = ml.source_memory_id
         UNION ALL
         SELECT ml.source_memory_id AS memory_id, trim(ml.subject_entity) AS name
         FROM memory_links ml JOIN anchor a ON a.memory_id = ml.source_memory_id
       ) AS co_mentioned
       WHERE name <> '' AND lower(name) <> lower(@name)
       GROUP BY name
       ORDER BY memories DESC, name ASC
       LIMIT @limit`,
    )
    .all({ name: entity.name, limit: limit + 1 }) as Array<{ name: string; memories: number }>;

  return {
    mentions: rows
      .slice(0, limit)
      .map((row) => ({ name: row.name, memories: Number(row.memories) })),
    truncated: rows.length > limit,
  };
}

/**
 * Resolve the reference a caller typed — an id, a canonical name or an alias —
 * to one entity. Same resolution order `upsertEntity` uses.
 */
function resolveEntity(repo: EntityRepository, ref: string): Entity | undefined {
  const trimmed = ref.trim();
  if (!trimmed) return undefined;
  return repo.findById(trimmed) ?? repo.findByName(trimmed) ?? repo.findByAlias(trimmed);
}

/**
 * The neighbourhood of one entity, honouring depth / asOf / relation types.
 *
 * Returns `undefined` when the reference names no entity, or when the database
 * has no graph tables at all — both mean "there is nothing to answer", and both
 * callers have their own wording for it (a 404, a tool error), so this function
 * does not invent one.
 */
export function queryEntityGraph(
  db: Database.Database,
  ref: string,
  options: EntityGraphQueryOptions = {},
): EntityGraphQuery | undefined {
  if (!graphTablesPresent(db)) return undefined;

  const repo = new EntityRepository(db);
  const entity = resolveEntity(repo, ref);
  if (!entity) return undefined;

  const depth = Math.min(Math.max(1, Math.floor(options.depth ?? 1)), MAX_QUERY_DEPTH);
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_GRAPH_QUERY_LIMIT));
  const halfLifeDays = options.decayHalfLifeDays ?? 0;
  const decaying = Number.isFinite(halfLifeDays) && halfLifeDays > 0;
  // Decay changes which edges deserve the cap, and the cap is applied by SQL on
  // the stored confidence, so a decaying query reads a wider window and ranks it
  // here. Four times the limit is a bound on that work, and `truncated` still
  // reports the cut because `candidates` is measured, not inferred.
  const filter: GraphEdgeFilter = {
    asOf: options.asOf,
    relationTypes: options.relationTypes ?? [],
    limit: decaying ? Math.min(limit * 4, 400) : limit,
  };

  const origin = loadGraphNodes(db, [entity.id])[0];
  if (!origin) return undefined;

  const walked = repo.neighbors(entity.id, {
    depth,
    asOf: filter.asOf,
    relationTypes: filter.relationTypes,
    limit,
  });
  // A database a pre-K3 build projected still holds `MENTIONED` rows in
  // `entity_edges` until `legacy-cleanup` runs, and `neighbors` traverses them.
  // Co-occurrence must not read as connectivity here — the mention tier is
  // `mentions` below, and it is off by default.
  const neighbors = walked.filter(
    (neighbor) => neighbor.relationType.trim().toUpperCase() !== MENTION_RELATION_TYPE,
  );
  const nodes = loadGraphNodes(
    db,
    neighbors.map((neighbor) => neighbor.entity.id),
  );
  const { edges: loadedEdges, truncated: edgesTruncated } = loadEdgesBetween(
    db,
    [origin.id, ...nodes.map((node) => node.id)],
    filter,
  );
  // Decay is applied to what the caller asked *about*: an `asOf` in the past
  // measures age from each edge's own `valid_from` to that instant, so "what did
  // this look like in June" answers June rather than today.
  const decayNow = filter.asOf ?? Date.now();
  const rankedEdges = decaying
    ? loadedEdges
        .map((edge) => ({
          ...edge,
          effective_confidence: decayedConfidence(
            edge.confidence,
            edge.valid_from ?? null,
            decayNow,
            halfLifeDays,
          ),
        }))
        .sort(
          (a, b) =>
            (b.effective_confidence ?? 0) - (a.effective_confidence ?? 0) ||
            (b.valid_from ?? 0) - (a.valid_from ?? 0),
        )
    : loadedEdges;
  const edges = decaying ? rankedEdges.slice(0, limit) : rankedEdges;
  const { mentions, truncated: mentionsTruncated } = options.includeMentions
    ? readMentionNeighbours(db, entity, limit)
    : { mentions: [], truncated: false };

  return {
    origin,
    nodes,
    edges,
    mentions,
    // `neighbors` caps its own SQL at `limit`; hitting the cap means the walk
    // may have more, so say so rather than silently dropping nodes.
    truncated:
      walked.length >= limit ||
      edgesTruncated ||
      mentionsTruncated ||
      (decaying && rankedEdges.length > limit),
  };
}
