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
import {
  EntityRepository,
  canonicalizeEntityName,
  type Entity,
} from '../memory/repositories/entity-repository.js';
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
  /**
   * The memory that asserted the relation, so an edge can be opened back to the
   * sentence it came from. The column is nullable by design (migration-v10): a
   * pre-v10 build projected edges without provenance, and absence must stay
   * truthful — the key is omitted rather than filled with a guess, so the UI
   * offers no evidence link instead of a dead one.
   */
  source_memory_id?: string;
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
  /**
   * The entity node this name already resolves to, when there is one, so the UI
   * can open the node instead of re-typing the name.
   *
   * Absent for a name the corpus mentions but no memory ever vouched for: node
   * admission is the projector's job (`projectMentionNodes`), and a read surface
   * that minted an id here would be inventing a node nobody can open.
   */
  entity_id?: string;
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
   * Resolve each mention name to the node it already belongs to
   * (`GraphMentionNeighbour.entity_id`).
   *
   * Opt-in because the model-facing `entity_query` payload names things by name
   * and never by id (`entity-query-definition.ts`) — an opaque id there is
   * tokens the model cannot use.
   */
  mentionEntityIds?: boolean;
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
  /**
   * The mention cap alone. `truncated` aggregates nodes, edges and mentions, so a
   * caller that renders the mention block on its own cannot tell from it whether
   * the list it shows is the whole list.
   */
  mentionsTruncated: boolean;
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

/** One table's presence, for the read paths that must degrade instead of throwing. */
function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
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
           e.confidence, e.valid_from, e.valid_to, e.source_memory_id
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
    source_memory_id: string | null;
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
      ...(row.source_memory_id !== null ? { source_memory_id: row.source_memory_id } : {}),
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
 * `memory_links` carries no entity id — it names the entity as text in whatever
 * spelling the corpus used — so the anchor matches the entity's RESOLVED name
 * set: the stored name, the canonical key and every alias (the same order
 * `resolveEntity` used to find the entity), folded case-sensitively downward
 * with `lower()`. Matching only the literal `entity.name` missed every memory
 * that wrote an alias (`PQ` for `power query`) — and with it, the co-mention
 * of every other name in that memory.
 *
 * Superseded memories are not filtered out: the count is evidence of what the
 * corpus talks about, not a claim about the entity.
 */
function readMentionNeighbours(
  db: Database.Database,
  entity: Entity,
  limit: number,
  withEntityIds: boolean,
): { mentions: GraphMentionNeighbour[]; truncated: boolean } {
  if (!tableExists(db, 'memory_links')) return { mentions: [], truncated: false };

  const spellings = (
    db
      .prepare(
        `SELECT a.alias AS spelling FROM entity_aliases a WHERE a.entity_id = ?
         UNION SELECT e.name FROM entities e WHERE e.id = ?
         UNION SELECT e.canonical_name FROM entities e WHERE e.id = ?`,
      )
      .all(entity.id, entity.id, entity.id) as Array<{ spelling: string }>
  )
    .map((row) => row.spelling.trim().toLowerCase())
    .filter((spelling) => spelling !== '');
  const resolved = [...new Set(spellings)];

  // One bound parameter per resolved spelling, interpolated into the CTE's
  // VALUES list as placeholders only — the spellings themselves are bound.
  const params: Record<string, unknown> = { limit: limit + 1 };
  const nameRows = resolved
    .map((name, index) => {
      params[`name${index}`] = name;
      return `(@name${index})`;
    })
    .join(', ');

  const rows = db
    .prepare(
      `WITH resolved_names(n) AS (VALUES ${nameRows})
       , anchor(memory_id) AS (
         SELECT DISTINCT ml.source_memory_id
         FROM memory_links ml
         WHERE lower(trim(ml.target_entity)) IN (SELECT n FROM resolved_names)
            OR lower(trim(ml.subject_entity)) IN (SELECT n FROM resolved_names)
       )
       SELECT name, COUNT(DISTINCT memory_id) AS memories
       FROM (
         SELECT ml.source_memory_id AS memory_id, trim(ml.target_entity) AS name
         FROM memory_links ml JOIN anchor a ON a.memory_id = ml.source_memory_id
         UNION ALL
         SELECT ml.source_memory_id AS memory_id, trim(ml.subject_entity) AS name
         FROM memory_links ml JOIN anchor a ON a.memory_id = ml.source_memory_id
       ) AS co_mentioned
       WHERE name <> '' AND lower(name) NOT IN (SELECT n FROM resolved_names)
       GROUP BY name
       ORDER BY memories DESC, name ASC
       LIMIT @limit`,
    )
    .all(params) as Array<{ name: string; memories: number }>;

  const kept = rows.slice(0, limit);
  const entityIds = withEntityIds
    ? readMentionEntityIds(
        db,
        kept.map((row) => row.name),
      )
    : new Map<string, string>();

  return {
    mentions: kept.map((row) => {
      const entityId = entityIds.get(row.name);
      return {
        name: row.name,
        memories: Number(row.memories),
        ...(entityId !== undefined ? { entity_id: entityId } : {}),
      };
    }),
    truncated: rows.length > limit,
  };
}

/**
 * The node each mention name already belongs to, in one query.
 *
 * A mention is text: `memory_links` names the entity in whatever spelling the
 * corpus used, and most names never became nodes (`projectMentionNodes` admits
 * one only when a memory attests it). So this is a lookup and nothing else — a
 * name with no node simply comes back missing, and the caller omits `entity_id`.
 *
 * Two keys, because one node has two stored spellings in practice: the canonical
 * form (`powerquery`) and the literal name (`Power Query`). Aliases are not
 * consulted — a name only an alias spells is a different name in the corpus, and
 * matching it here would hand the UI a node whose mention count is zero.
 */
function readMentionEntityIds(db: Database.Database, names: string[]): Map<string, string> {
  if (names.length === 0 || !tableExists(db, 'entities')) return new Map();
  const params: Record<string, unknown> = {};
  const canonicalIn = idPlaceholders(
    names.map((name) => canonicalizeEntityName(name)),
    'canon',
    params,
  );
  const literalIn = idPlaceholders(
    names.map((name) => name.trim().toLowerCase()),
    'lit',
    params,
  );
  const rows = db
    .prepare(
      `SELECT id, name, canonical_name FROM entities
        WHERE canonical_name IN (${canonicalIn}) OR lower(trim(name)) IN (${literalIn})
        ORDER BY canonical_name ASC, name ASC, id ASC`,
    )
    .all(params) as Array<{ id: string; name: string; canonical_name: string }>;

  // First row wins per key (`ORDER BY` above makes "first" deterministic): two
  // entity types may share a canonical name, and a mention can only open one.
  const byCanonical = new Map<string, string>();
  const byLiteral = new Map<string, string>();
  for (const row of rows) {
    for (const key of [
      canonicalizeEntityName(row.canonical_name),
      canonicalizeEntityName(row.name),
    ]) {
      if (!byCanonical.has(key)) byCanonical.set(key, row.id);
    }
    const literal = row.name.trim().toLowerCase();
    if (!byLiteral.has(literal)) byLiteral.set(literal, row.id);
  }

  const resolved = new Map<string, string>();
  for (const name of names) {
    const id =
      byCanonical.get(canonicalizeEntityName(name)) ?? byLiteral.get(name.trim().toLowerCase());
    if (id !== undefined) resolved.set(name, id);
  }
  return resolved;
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
    ? rankByDecayedConfidence(loadedEdges, decayNow, halfLifeDays)
    : loadedEdges;
  const edges = decaying ? rankedEdges.slice(0, limit) : rankedEdges;
  const { mentions: rawMentions, truncated: mentionsTruncated } = options.includeMentions
    ? readMentionNeighbours(db, entity, limit, options.mentionEntityIds === true)
    : { mentions: [], truncated: false };
  // A name the walk already reached through a STATEMENT is not also a mere
  // co-mention. Listing it there contradicts the block's own caption ("mentioned
  // together, but not related") for the one name the reader can see is related, so
  // the payload's node set is the boundary: the reader sees one cluster, and the
  // mention tier explains only what that cluster does not.
  const statementIds = new Set<string>([origin.id, ...nodes.map((node) => node.id)]);
  const mentions = rawMentions.filter(
    (mention) => mention.entity_id === undefined || !statementIds.has(mention.entity_id),
  );

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
    mentionsTruncated,
  };
}

/**
 * `confidence` decayed to `now`, most durable first.
 *
 * Shared by the neighbourhood walk and the component drill-down: both answer
 * "what is most true/least stale here", and two orderings over the same edges
 * would make the panel and the drawing disagree about which ones survived the
 * cap.
 */
function rankByDecayedConfidence(
  edges: GraphQueryEdge[],
  now: number,
  halfLifeDays: number,
): GraphQueryEdge[] {
  return edges
    .map((edge) => ({
      ...edge,
      effective_confidence: decayedConfidence(
        edge.confidence,
        edge.valid_from ?? null,
        now,
        halfLifeDays,
      ),
    }))
    .sort(
      (a, b) =>
        (b.effective_confidence ?? 0) - (a.effective_confidence ?? 0) ||
        (b.valid_from ?? 0) - (a.valid_from ?? 0),
    );
}

// ---------------------------------------------------------------------------
// Diagnostics and component drill-down (WebUI stage S4)
//
// Both answer "why does this graph look so sparse" from the same structure, so
// they are computed here rather than in the route: the statistics panel and the
// drill-down it sends the user into must agree, and two implementations of
// "connected" would eventually disagree about a component's size.
// ---------------------------------------------------------------------------

/** Members a component reports for its panel; the drill-down fetches the rest. */
const COMPONENT_MEMBER_PREVIEW = 12;
/** Components listed by the statistics panel, largest first. */
const COMPONENT_LIST_CAP = 8;

/**
 * A connected part of the graph, as the diagnostics panel lists it.
 *
 * `id` is the node a click drills down into, so it must be a real entity id and
 * it must be stable: the busiest member (ties by canonical name) is the one a
 * reader recognises as the centre of the cluster.
 */
export interface GraphComponent {
  id: string;
  size: number;
  /** Live typed edges inside the component — history is not connectivity. */
  edgeCount: number;
  /** Up to 12 members, highest degree first. */
  nodes: Array<{ id: string; name: string }>;
}

/**
 * `GET /api/memory/graph/stats`.
 *
 * `enabled` is the one field that is not a count: an empty graph and a switched-off
 * projection look identical in the numbers, and they are different answers.
 */
export interface GraphStats {
  enabled: boolean;
  nodes: number;
  /** Typed edges that are still true — `MENTIONED` never counts. */
  edges: number;
  /** How many of `edges` are closed by `valid_to`: history, not connectivity. */
  retractedEdges: number;
  /** Entities with no typed edge in either direction. */
  isolated: number;
  /** Entities with no typed edge but at least one `memory_links` row naming them. */
  mentionOnly: number;
  /** Rows in `memory_links` — the raw co-occurrence evidence behind the graph. */
  mentionLinks: number;
  /** Total disconnected parts, each isolated entity counting as one. */
  componentCount: number;
  /** Largest component as a share of `nodes`, 0..1, rounded to 3 decimals. */
  largestComponentPct: number;
  /** Size ≥ 2 components, largest first, capped at 8. */
  components: GraphComponent[];
  /**
   * The relation vocabulary present in the graph, most used first.
   *
   * Served rather than derived on the client: the `?types=` filter needs the whole
   * vocabulary, and a list rebuilt from the current payload would shrink to the one
   * type a user just selected — removing the control that unselects it.
   */
  relationTypes: string[];
  /** Present only when the knowledge layer's tables exist. */
  danglingLinks?: number;
  /** Pages bound to one conversation rather than `global`. */
  scopedPages?: number;
}

/** One entity, as connectivity needs it: identity, a stable ordering key, degree. */
interface GraphStructureNode {
  id: string;
  name: string;
  canonicalName: string;
  /** Incident live typed edges, either direction. */
  degree: number;
}

interface GraphStructure {
  /** Every entity row — an isolated one is a component of size 1, not an absence. */
  nodes: Map<string, GraphStructureNode>;
  /** Union-find root per entity id. */
  rootOf: Map<string, string>;
  /** Root → member ids. */
  membersOf: Map<string, string[]>;
  /** Root → live typed edges whose endpoints are both in that component. */
  edgeCountOf: Map<string, number>;
  /** Typed edges in the whole graph, retracted ones included. */
  edgeCount: number;
  /** How many of `edgeCount` are closed by `valid_to`. */
  retractedEdges: number;
}

/**
 * The graph as connectivity sees it: every entity, plus the typed edges that are
 * still true.
 *
 * `edgeCount` counts every typed row so the panel's number equals a direct
 * `SELECT COUNT(*)`, with `retractedEdges` saying how many of them are closed.
 * Only the open ones join the walk: a retracted edge stays answerable — `asOf`
 * is how a caller asks about June — but it is not connectivity today, and
 * joining one would report a component that no longer exists (and make
 * `isolated` fall when a fact is retracted).
 *
 * `MENTIONED` is filtered for the reason it is filtered everywhere else:
 * co-occurrence is not a statement, and "isolated" is a claim about statements
 * (`docs/KNOWLEDGE_GRAPH.md` §3).
 *
 * Both scans are whole-table rather than per-neighbourhood: a component is a
 * global property, so its boundary cannot be found from a local walk. Both are
 * linear in tables that hold hundreds of rows on a real install.
 */
function readGraphStructure(db: Database.Database): GraphStructure {
  const structure: GraphStructure = {
    nodes: new Map(),
    rootOf: new Map(),
    membersOf: new Map(),
    edgeCountOf: new Map(),
    edgeCount: 0,
    retractedEdges: 0,
  };
  if (!tableExists(db, 'entities')) return structure;

  const entityRows = db.prepare('SELECT id, name, canonical_name FROM entities').all() as Array<{
    id: string;
    name: string;
    canonical_name: string;
  }>;
  for (const row of entityRows) {
    structure.nodes.set(row.id, {
      id: row.id,
      name: row.name,
      canonicalName: row.canonical_name,
      degree: 0,
    });
  }

  const parent = new Map<string, string>();
  for (const id of structure.nodes.keys()) parent.set(id, id);
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    // Path compression: "statistics, then drill into a component it listed" is
    // the ordinary sequence, and the second pass walks the same structure.
    let cursor = id;
    while (cursor !== root) {
      const next = parent.get(cursor) as string;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };

  const liveEdges: Array<[string, string]> = [];
  if (tableExists(db, 'entity_edges')) {
    const edgeRows = db
      .prepare(
        `SELECT source_entity_id, target_entity_id, valid_to
           FROM entity_edges
          WHERE upper(trim(relation_type)) <> @mentionRelation`,
      )
      .all({ mentionRelation: MENTION_RELATION_TYPE }) as Array<{
      source_entity_id: string;
      target_entity_id: string;
      valid_to: number | null;
    }>;

    for (const edge of edgeRows) {
      structure.edgeCount += 1;
      if (edge.valid_to !== null) {
        structure.retractedEdges += 1;
        continue;
      }
      const source = structure.nodes.get(edge.source_entity_id);
      const target = structure.nodes.get(edge.target_entity_id);
      // The foreign keys make a dangling endpoint impossible; skipping one is
      // still better than inventing a component for an entity that has no row.
      if (!source || !target) continue;
      source.degree += 1;
      target.degree += 1;
      const sourceRoot = find(source.id);
      const targetRoot = find(target.id);
      if (sourceRoot !== targetRoot) parent.set(targetRoot, sourceRoot);
      liveEdges.push([source.id, target.id]);
    }
  }

  for (const node of structure.nodes.values()) {
    const root = find(node.id);
    structure.rootOf.set(node.id, root);
    const members = structure.membersOf.get(root);
    if (members) members.push(node.id);
    else structure.membersOf.set(root, [node.id]);
  }

  for (const [sourceId] of liveEdges) {
    const root = structure.rootOf.get(sourceId) as string;
    structure.edgeCountOf.set(root, (structure.edgeCountOf.get(root) ?? 0) + 1);
  }

  return structure;
}

/**
 * Highest degree first, then canonical name — the order the overview uses, so a
 * component's representative is the node the overview put on top of that cluster.
 */
function compareByDegreeThenName(a: GraphStructureNode, b: GraphStructureNode): number {
  if (a.degree !== b.degree) return b.degree - a.degree;
  if (a.canonicalName !== b.canonicalName) return a.canonicalName < b.canonicalName ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/** A component's members in panel order. */
function orderedMembers(structure: GraphStructure, memberIds: string[]): GraphStructureNode[] {
  return memberIds
    .map((id) => structure.nodes.get(id))
    .filter((node): node is GraphStructureNode => node !== undefined)
    .sort(compareByDegreeThenName);
}

/** `name` in the form `readMentionEvidence` stores, so the two are comparable. */
function foldMentionName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The names `memory_links` mentions, folded to the form the entity table is
 * compared against, plus the row count behind them.
 *
 * `memory_links` stores the corpus spelling, so the comparison is case-insensitive
 * `trim`-equality against `entities.name` — the same rule the overview's mention
 * tiebreaker uses. An alias-only spelling is not matched here either: counting it
 * would make `mentionOnly` credit a memory that never named the node, and this is
 * the number the panel offers as an explanation.
 */
function readMentionEvidence(db: Database.Database): { names: Set<string>; links: number } {
  if (!tableExists(db, 'memory_links')) return { names: new Set(), links: 0 };
  const links = db.prepare('SELECT COUNT(*) AS n FROM memory_links').get() as { n: number };
  const rows = db
    .prepare(
      `SELECT lower(trim(target_entity)) AS name FROM memory_links
        UNION
       SELECT lower(trim(subject_entity)) AS name FROM memory_links`,
    )
    .all() as Array<{ name: string | null }>;
  const names = new Set<string>();
  for (const row of rows) {
    if (row.name) names.add(row.name);
  }
  return { names, links: Number(links.n) };
}

/**
 * The relation vocabulary the graph actually uses, most frequent first.
 *
 * `MENTIONED` is excluded for the reason it is not an edge: offering it as a filter
 * would let a reader ask for the one "relation" that is deliberately not one. Ties
 * fall back to the type name so the option list does not reshuffle between two
 * requests that measured the same counts.
 */
function readRelationVocabulary(db: Database.Database): string[] {
  if (!tableExists(db, 'entity_edges')) return [];
  const rows = db
    .prepare(
      `SELECT relation_type AS type, COUNT(*) AS n
         FROM entity_edges
        WHERE upper(trim(relation_type)) <> @mentionRelation
        GROUP BY relation_type
        ORDER BY n DESC, type ASC`,
    )
    .all({ mentionRelation: MENTION_RELATION_TYPE }) as Array<{ type: string; n: number }>;
  return rows.map((row) => row.type);
}

/**
 * The statistics panel's numbers. `enabled` is the caller's flag, so this reports
 * only what the database says and the route composes the two.
 *
 * Everything here is exact — no sampling, no `LIMIT`. A diagnostics panel of
 * approximations is worse than no panel: "12 entities are mention-only" is the
 * sentence that explains a sparse graph, and it has to be true.
 */
export function readGraphStats(db: Database.Database): Omit<GraphStats, 'enabled'> {
  const structure = readGraphStructure(db);
  const { names: mentionedNames, links: mentionLinks } = readMentionEvidence(db);

  const parts: Array<{ members: GraphStructureNode[]; edgeCount: number }> = [];
  let isolated = 0;
  let mentionOnly = 0;
  let largest = 0;

  for (const [root, memberIds] of structure.membersOf) {
    const members = orderedMembers(structure, memberIds);
    const edgeCount = structure.edgeCountOf.get(root) ?? 0;
    if (members.length > largest) largest = members.length;
    if (members.length === 1 && edgeCount === 0) {
      isolated += 1;
      // Mention-only is a subset of isolated by construction, so the two numbers
      // can never contradict each other in the panel.
      if (mentionedNames.has(foldMentionName(members[0].name))) mentionOnly += 1;
    }
    if (members.length >= 2) parts.push({ members, edgeCount });
  }

  parts.sort(
    (a, b) =>
      b.members.length - a.members.length || compareByDegreeThenName(a.members[0], b.members[0]),
  );

  const nodes = structure.nodes.size;
  const stats: Omit<GraphStats, 'enabled'> = {
    nodes,
    edges: structure.edgeCount,
    retractedEdges: structure.retractedEdges,
    isolated,
    mentionOnly,
    mentionLinks,
    componentCount: structure.membersOf.size,
    // Rounded here, not in the UI: two clients must not round 0.125 differently.
    largestComponentPct: nodes === 0 ? 0 : Number((largest / nodes).toFixed(3)),
    components: parts.slice(0, COMPONENT_LIST_CAP).map((part) => ({
      id: part.members[0].id,
      size: part.members.length,
      edgeCount: part.edgeCount,
      nodes: part.members
        .slice(0, COMPONENT_MEMBER_PREVIEW)
        .map((member) => ({ id: member.id, name: member.name })),
    })),
    relationTypes: readRelationVocabulary(db),
  };

  // The knowledge layer's own health belongs in the same panel — a dangling link
  // and an isolated entity are two halves of "why is nothing connected" — but only
  // where those tables exist. An install without the knowledge layer omits the
  // keys rather than reporting zeroes for a feature it does not have.
  if (tableExists(db, 'knowledge_links') && tableExists(db, 'knowledge_pages')) {
    // Dangling is the definition `resolveWikilinks` already uses: a link whose
    // target is not an active page resolves to nothing, which is what a reader
    // experiences (`src/memory/knowledge/links.ts`).
    const dangling = db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM knowledge_links l
           LEFT JOIN knowledge_pages p ON p.id = l.to_page_id
          WHERE p.id IS NULL OR p.status <> 'active'`,
      )
      .get() as { n: number };
    stats.danglingLinks = Number(dangling.n);
  }
  if (tableExists(db, 'knowledge_pages')) {
    // Pages bound to one conversation (migration-v22): the ones another chat
    // cannot see, so the count measures the scoping the reader is under.
    const scoped = db
      .prepare("SELECT COUNT(*) AS n FROM knowledge_pages WHERE scope <> 'global'")
      .get() as { n: number };
    stats.scopedPages = Number(scoped.n);
  }

  return stats;
}

export interface EntityComponentQuery {
  /** The resolved entity the drill-down was opened on, first in the payload. */
  origin: GraphQueryNode;
  /** The rest of the component. */
  nodes: GraphQueryNode[];
  /** Typed edges among the returned nodes, honouring `asOf` / `types` / `limit`. */
  edges: GraphQueryEdge[];
  /** True when the cap cut the component, or cut its edges. */
  truncated: boolean;
}

/**
 * One connected component, entered from one of its members.
 *
 * Membership is structural — everything reachable over the typed edges that are
 * still open — while `asOf` / `relationTypes` / `limit` narrow only the edges the
 * caller gets back. That split is deliberate: the statistics panel said "these
 * twelve belong together", and a drill-down that also filtered the walk would
 * quietly draw a different, smaller cluster than the one that was clicked.
 *
 * Returns `undefined` when the reference names no entity, matching
 * `queryEntityGraph` — both callers have their own wording for that (a 404), so
 * this function does not invent one.
 */
export function queryEntityComponent(
  db: Database.Database,
  ref: string,
  options: {
    asOf?: number;
    relationTypes?: string[];
    limit?: number;
    decayHalfLifeDays?: number;
  } = {},
): EntityComponentQuery | undefined {
  if (!graphTablesPresent(db)) return undefined;

  const repo = new EntityRepository(db);
  const entity = resolveEntity(repo, ref);
  if (!entity) return undefined;

  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_GRAPH_QUERY_LIMIT));
  const halfLifeDays = options.decayHalfLifeDays ?? 0;
  const decaying = Number.isFinite(halfLifeDays) && halfLifeDays > 0;
  const filter: GraphEdgeFilter = {
    asOf: options.asOf,
    relationTypes: options.relationTypes ?? [],
    limit: decaying ? Math.min(limit * 4, 400) : limit,
  };

  const structure = readGraphStructure(db);
  const root = structure.rootOf.get(entity.id);
  const members =
    root === undefined ? [] : orderedMembers(structure, structure.membersOf.get(root) ?? []);
  // The clicked entity leads the payload: it is where the UI centres the drawing
  // and the node that must survive the cap when the component is too big to send.
  const sequence = [
    ...members.filter((member) => member.id === entity.id),
    ...members.filter((member) => member.id !== entity.id),
  ];

  const [origin, ...nodes] = loadGraphNodes(
    db,
    sequence.slice(0, limit).map((member) => member.id),
  );
  // The entity has a row (`resolveEntity` read it), so this is only reachable on
  // a database whose graph tables were emptied between the two reads.
  if (!origin) return undefined;

  const { edges: loadedEdges, truncated: edgesTruncated } = loadEdgesBetween(
    db,
    [origin.id, ...nodes.map((node) => node.id)],
    filter,
  );
  const ranked = decaying
    ? rankByDecayedConfidence(loadedEdges, filter.asOf ?? Date.now(), halfLifeDays)
    : loadedEdges;

  return {
    origin,
    nodes,
    edges: decaying ? ranked.slice(0, limit) : ranked,
    // Two different cuts: the component did not fit, or its edge list did not.
    truncated: sequence.length > limit || edgesTruncated || (decaying && ranked.length > limit),
  };
}
