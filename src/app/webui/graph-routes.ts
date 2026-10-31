/**
 * Knowledge-graph read API.
 *
 * The v10 tables (`entities` / `entity_aliases` / `entity_edges`) are populated
 * in the background by the graph-sync pipeline, so on a fresh install — and in
 * any worktree where that writer has not run yet — every table here is EMPTY.
 * Empty is not an error: the endpoints return well-formed empty payloads so the
 * WebUI can show a real empty state instead of a crash, and a missing table
 * (database created before v10) degrades to the same empty payload.
 *
 * READ-ONLY: nothing here writes to the graph. Edge retraction/history belongs
 * to EntityRepository, not to a read surface.
 *
 * Traversal is NOT reimplemented: the walk itself — `EntityRepository`'s
 * recursive-CTE query, the temporal predicate (`valid_from <= asOf < valid_to`),
 * the depth clamp and the mention-vs-edge split — lives in
 * `src/graph/graph-query.ts`, which `entity_query` answers from as well. This
 * module only parses the query string and turns the result into the node/edge
 * payload the WebUI draws.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { EntityRepository } from '../../memory/repositories/entity-repository.js';
import { MENTION_RELATION_TYPE } from '../../graph/entity-mining.js';
import {
  COMPONENT_LIST_MIN_SIZE,
  DEFAULT_GRAPH_QUERY_LIMIT,
  MAX_QUERY_DEPTH,
  decodeComponentCursor,
  loadEdgesBetween,
  loadGraphNodes,
  parseGraphAsOf,
  parseGraphRelationTypes,
  queryEntityComponent,
  queryEntityGraph,
  readComponentPage,
  readGraphStats,
  readSeedRanking,
  tableExists,
  type GraphEdgeFilter,
  type GraphMentionNeighbour,
  type GraphQueryEdge,
  type GraphQueryNode,
  type GraphStats,
} from '../../graph/graph-query.js';
import {
  cursorMatchesSort,
  decodeRosterCursor,
  queryEdgeRoster,
  queryEntityRoster,
  type EdgeRosterQuery,
  type EdgeRosterSort,
  type EntityRosterQuery,
  type EntityRosterSort,
  type RosterEdgePresence,
} from '../../graph/graph-roster.js';
import type { FooterConfig } from '../types.js';

const MAX_GRAPH_LIMIT = 200;
/**
 * Share of the overview's node budget spent on seeds.
 *
 * Seeds cost budget and leaves cost budget, and the defect the overview had was a
 * hub whose spokes all fell outside a top-N list — numbing every edge it owned.
 * `seedCount === limit` reproduces exactly that: the budget is spent on names
 * before any neighbour of theirs is drawn. A fifth leaves four fifths for the
 * leaves, which is what a hub's spokes cost.
 */
const OVERVIEW_SEED_SHARE = 0.2;
/** Nearest whole number of seeds a node budget affords, never below one. */
function overviewSeedCount(nodeBudget: number): number {
  return Math.max(1, Math.ceil(nodeBudget * OVERVIEW_SEED_SHARE));
}

/**
 * The roster endpoints' sort keys, as closed sets.
 *
 * Closed because those values reach `ORDER BY`: a whitelist is what keeps a query
 * string out of the SQL, and an unknown key is reported as a 400 rather than
 * silently replaced by a default — a list that quietly re-sorts looks like a bug
 * in the data.
 */
const ENTITY_ROSTER_SORTS: EntityRosterSort[] = ['degree', 'mentions', 'name', 'updated'];
const EDGE_ROSTER_SORTS: EdgeRosterSort[] = ['validFrom', 'confidence', 'relation'];
const ROSTER_EDGE_PRESENCE: RosterEdgePresence[] = ['any', 'yes', 'no'];
const EDGE_STATUSES: Array<EdgeRosterQuery['status']> = ['open', 'retracted', 'all'];
const DEFAULT_ENTITY_ROSTER_LIMIT = 50;
const DEFAULT_EDGE_ROSTER_LIMIT = 100;
const DEFAULT_COMPONENT_PAGE_LIMIT = 20;
const MAX_COMPONENT_PAGE_LIMIT = 100;

/** A payload node/edge, as the WebUI draws it; the query shapes live in graph-query.ts. */
export type GraphNode = GraphQueryNode;
export type GraphEdge = GraphQueryEdge;

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** True when a cap (limit) cut the payload — the UI says "showing first N". */
  truncated: boolean;
  /**
   * `memory.graph.enabled`. Empty and switched-off look identical in `nodes`, and
   * they are different answers for a reader ("nothing has accumulated yet" vs
   * "this install does not project a graph"), so the switch travels with the
   * payload instead of being guessed from an empty array.
   */
  enabled: boolean;
}

/**
 * The neighbourhood payload: `GraphPayload` plus the co-occurrence tier.
 *
 * `mentions` has its own array because a mention is not an edge — co-occurrence is
 * not a statement (`docs/KNOWLEDGE_GRAPH.md` §3) — and the overview payload does
 * not carry it: a per-origin mention list has no meaning when there is no origin.
 */
export interface NeighbourhoodGraphPayload extends GraphPayload {
  mentions: GraphMentionNeighbour[];
  /** The mention cap alone; `truncated` aggregates it with the node and edge caps. */
  mentions_truncated: boolean;
}

export interface GraphRouteConfig {
  db: Database.Database;
  /**
   * Days in which an edge's confidence halves (`memory.graph.decay_half_life_days`),
   * 0/absent = no decay. Same value the tool gets, so the drawing and the
   * model's answer rank identically.
   */
  decayHalfLifeDays?: number;
  /** Footer defaults for messages saved before the footer snapshot existed. */
  getFooterConfig?: () => FooterConfig;
  /**
   * `memory.graph.enabled`, read per request. Optional so the tests (and any
   * caller that does not care) can omit it — absent means "on".
   */
  graphEnabled?: () => boolean;
}

/** Clamp a query-string integer to [min, max], falling back on garbage. */
function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(min, parsed), max);
}

/**
 * Overview payload: the busiest entities, then their one-hop neighbours.
 *
 * The old rule was a top-N induced subgraph — take the N busiest names and draw
 * whatever edges happen to join them — and its failure mode is why this is now a
 * BFS. A hub with thirty spokes ranked first and drew as a bare name, because the
 * spokes (degree 1) sat below N and were never selected; every edge the hub owned
 * pointed outside the picture. Selection therefore asks a different question:
 * which nodes does the budget buy, starting from the busiest ones and following
 * their edges.
 *
 * `limit` is still a NODE budget (plan §4.2.1 decision A), so `limit=2` yields two
 * nodes, not a seed plus an unbounded frontier. `whole` is the explicit escape
 * hatch for "the entire graph": the node budget is a phone-shaped default, not a
 * claim about the data.
 *
 * Seed order — degree desc, mention count desc, canonical name asc — is the order
 * the overview has always used, and it still matters: most nodes carry no edge at
 * all, so an alphabetical tiebreaker would show an arbitrary slice of the alphabet
 * and hide the names the corpus actually talks about.
 */
function loadOverview(
  db: Database.Database,
  nodeBudget: number,
  filter: GraphEdgeFilter,
  enabled: boolean,
  whole: boolean,
): GraphPayload {
  // The ranking is the expensive half of this request (43 ms of 55 on the device, and
  // quadratic in the corpus), so it comes from `readSeedRanking`, which reads the
  // materialised table when `graph_sync` has written one and falls back to the live
  // correlated-subquery form otherwise.
  const ranked = readSeedRanking(db).map((id) => ({ id }));
  const rankOf = new Map(ranked.map((row, index) => [row.id, index]));

  // `whole` spends the budget on seeds instead of leaves — every node is a seed,
  // so there is nothing left for a frontier to discover.
  const seedCount = whole ? nodeBudget : overviewSeedCount(nodeBudget);
  const seedIds = ranked.slice(0, seedCount).map((row) => row.id);
  const adjacency = readOverviewAdjacency(db, seedIds, filter, rankOf);

  const selected: string[] = [];
  const visited = new Set<string>();
  // Measured, not guessed: the flag is set only when an unvisited candidate really
  // was turned away, so a graph that simply fits reports `truncated: false`.
  let nodeBudgetCut = false;
  const consider = (id: string): void => {
    if (visited.has(id)) return;
    if (selected.length >= nodeBudget) {
      nodeBudgetCut = true;
      return;
    }
    visited.add(id);
    selected.push(id);
  };

  for (const seedId of seedIds) consider(seedId);
  for (const seedId of seedIds) {
    for (const neighbourId of adjacency.get(seedId) ?? []) consider(neighbourId);
  }

  const nodes = loadGraphNodes(db, selected);
  // The edge cap gets its own budget: edges are O(n·d) where nodes are O(n), so a
  // hub of twenty spokes loses most of them to a cap set at the node budget — the
  // second half of the same defect, arriving through the edge list.
  const { edges, truncated: edgesTruncated } = loadEdgesBetween(
    db,
    nodes.map((node) => node.id),
    { ...filter, limit: Math.max(nodeBudget, nodes.length * 4) },
  );
  // Three separate cuts, one flag. `nodeBudgetCut` and `edgesTruncated` are caps
  // that bit; `ranked.length > selected.length` is the overview's own design — it
  // draws the busiest part, so on any corpus with entities outside that part the
  // drawing is incomplete, and `graph.truncated`'s sentence ("only the first N
  // entities came back, there is more") is exactly the true statement. Without the
  // third term a 13-entity graph answered `truncated: false` while drawing two of
  // them, which reads as a lie to whoever opened the payload.
  const omitted = ranked.length > selected.length;
  return { nodes, edges, truncated: nodeBudgetCut || edgesTruncated || omitted, enabled };
}
/**
 * One-hop adjacency of the seeds, over the edges the caller will actually be shown.
 *
 * Read in a single query for all seeds (a per-seed lookup is N+1, and the overview
 * is the WebUI's landing request), and filtered by the same temporal and
 * relation-type predicate `loadEdgesBetween` uses: a neighbour reachable only
 * through an edge the caller filtered out would be drawn as an unrelated name —
 * the very symptom this selection rule exists to remove.
 *
 * `MENTIONED` rows are not adjacency. Co-occurrence is not a statement, so a
 * neighbour reached only that way has no drawn edge to its seed
 * (`docs/KNOWLEDGE_GRAPH.md` §3); mentions have their own tier on the
 * neighbourhood payload.
 *
 * Neighbours come back in the seeds' own ranking order, so which spokes survive a
 * tight budget is deterministic rather than rowid luck.
 */
function readOverviewAdjacency(
  db: Database.Database,
  seedIds: string[],
  filter: GraphEdgeFilter,
  rankOf: Map<string, number>,
): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  if (seedIds.length === 0 || !tableExists(db, 'entity_edges')) return adjacency;

  const params: Record<string, unknown> = {
    mentionRelation: MENTION_RELATION_TYPE,
    asOf: filter.asOf ?? null,
  };
  const seedPlaceholders = seedIds
    .map((id, index) => {
      params[`seed${index}`] = id;
      return `@seed${index}`;
    })
    .join(', ');

  let sql = `
    SELECT x.source_entity_id AS source, x.target_entity_id AS target
    FROM entity_edges x
    WHERE (x.source_entity_id IN (${seedPlaceholders})
        OR x.target_entity_id IN (${seedPlaceholders}))
      AND upper(trim(x.relation_type)) <> @mentionRelation
      AND (@asOf IS NULL OR ((x.valid_from IS NULL OR x.valid_from <= @asOf)
           AND (x.valid_to IS NULL OR x.valid_to > @asOf)))`;
  const relationTypes = filter.relationTypes ?? [];
  if (relationTypes.length > 0) {
    const typePlaceholders = relationTypes
      .map((type, index) => {
        params[`type${index}`] = type;
        return `@type${index}`;
      })
      .join(', ');
    sql += ` AND x.relation_type IN (${typePlaceholders})`;
  }

  const rows = db.prepare(sql).all(params) as Array<{ source: string; target: string }>;
  const seedSet = new Set(seedIds);
  for (const row of rows) {
    // An edge is filed under whichever endpoint is a seed; a seed-to-seed edge is
    // filed under both, each naming the other.
    if (seedSet.has(row.source)) pushAdjacent(adjacency, row.source, row.target);
    if (seedSet.has(row.target)) pushAdjacent(adjacency, row.target, row.source);
  }

  for (const neighbours of adjacency.values()) {
    neighbours.sort((a, b) => (rankOf.get(a) ?? Infinity) - (rankOf.get(b) ?? Infinity));
  }
  return adjacency;
}

function pushAdjacent(adjacency: Map<string, string[]>, from: string, to: string): void {
  const neighbours = adjacency.get(from);
  if (!neighbours) {
    adjacency.set(from, [to]);
  } else if (!neighbours.includes(to)) {
    neighbours.push(to);
  }
}

export function registerGraphRoutes(app: FastifyInstance, cfg: GraphRouteConfig): void {
  const repo = new EntityRepository(cfg.db);

  /**
   * Graph payload.
   *   `?entity=<id|name|alias>`    — that entity's neighbourhood (default: overview)
   *   `?component=<id|name|alias>` — that entity's whole connected component
   *   `?depth=1..3`                — hop count, neighbourhood only
   *   `?limit=1..200`              — node/edge cap
   *   `?cursor=`                   — page boundary inside one component (BFS order)
   *   `?asOf=<epoch ms>`           — "what was true then"
   *   `?types=a,b`                 — relation types to traverse
   *   `?whole=1`                   — the whole graph instead of a budgeted overview
   *
   * `component` wins when both it and `entity` are given: the drill-down is the
   * more specific request, and silently ignoring it would answer a different
   * question than the one the panel asked.
   */
  app.get('/api/memory/graph', async (request, reply) => {
    const query = request.query as {
      entity?: string;
      component?: string;
      depth?: string;
      limit?: string;
      cursor?: string;
      asOf?: string;
      types?: string;
      whole?: string;
    };

    const limit = clampInt(query.limit, DEFAULT_GRAPH_QUERY_LIMIT, 1, MAX_GRAPH_LIMIT);
    const depth = clampInt(query.depth, 1, 1, MAX_QUERY_DEPTH);
    // `whole=1` spends the hard cap rather than the caller's budget: the budget is
    // a phone-shaped default, and honouring both would make the escape hatch mean
    // "whatever limit says", which is the thing it exists to override.
    const whole = query.whole === '1';
    const enabled = cfg.graphEnabled ? cfg.graphEnabled() : true;
    const filter: GraphEdgeFilter = {
      asOf: parseGraphAsOf(query.asOf),
      relationTypes: parseGraphRelationTypes(query.types),
      limit,
    };

    try {
      if (!tableExists(cfg.db, 'entities')) {
        // Pre-v10 database: nothing has ever been written, so the honest answer
        // is an empty graph — not a 500 the UI has to special-case.
        if (query.entity || query.component) {
          return reply.status(404).send({ error: 'Entity not found' });
        }
        return reply.send({
          nodes: [],
          edges: [],
          truncated: false,
          enabled,
        } satisfies GraphPayload);
      }

      // Component drill-down: the payload the statistics panel links into. Nodes
      // are the whole component (structural, so it matches the size the panel
      // printed) while `limit` / `asOf` / `types` narrow only the edges drawn.
      const componentRef = query.component?.trim();
      if (componentRef) {
        const offset = query.cursor ? decodeComponentCursor(query.cursor) : undefined;
        if (query.cursor && offset === undefined) {
          return reply.status(400).send({ error: 'Invalid cursor' });
        }
        const component = queryEntityComponent(cfg.db, componentRef, {
          asOf: filter.asOf,
          relationTypes: filter.relationTypes,
          limit,
          offset,
          decayHalfLifeDays: cfg.decayHalfLifeDays,
        });
        if (!component) return reply.status(404).send({ error: 'Entity not found' });
        return reply.send({
          nodes: [component.origin, ...component.nodes],
          edges: component.edges,
          truncated: component.truncated,
          enabled,
        } satisfies GraphPayload);
      }

      const entityRef = query.entity?.trim();
      if (!entityRef) {
        return reply.send(
          loadOverview(cfg.db, whole ? MAX_GRAPH_LIMIT : limit, filter, enabled, whole),
        );
      }

      // `entity` is whatever the user clicked or typed: an id, a canonical name
      // or an alias. The walk itself is `queryEntityGraph` — the same function
      // `entity_query` answers from, so the tool and the drawing cannot drift.
      const neighbourhood = queryEntityGraph(cfg.db, entityRef, {
        depth,
        asOf: filter.asOf,
        relationTypes: filter.relationTypes,
        limit,
        includeMentions: true,
        mentionEntityIds: true,
        decayHalfLifeDays: cfg.decayHalfLifeDays,
      });
      if (!neighbourhood) return reply.status(404).send({ error: 'Entity not found' });

      return reply.send({
        // Origin first: the UI centres the layout on nodes[0].
        nodes: [neighbourhood.origin, ...neighbourhood.nodes],
        edges: neighbourhood.edges,
        truncated: neighbourhood.truncated,
        enabled,
        // Co-mentioned names, with the node each one already belongs to. For a
        // sparsely-connected entity this is the only informative part of the
        // payload, and it can never be mistaken for a statement: it never enters
        // `edges` (graph-query.ts owns that split).
        mentions: neighbourhood.mentions,
        mentions_truncated: neighbourhood.mentionsTruncated,
      } satisfies NeighbourhoodGraphPayload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /**
   * Graph diagnostics: the numbers that explain a sparse drawing.
   *
   * 378 entities and 12 edges is not a rendering problem, it is a corpus fact —
   * almost every node is a name a memory mentioned and no memory made a statement
   * about. That is what this panel is for, so `MENTIONED` is excluded from `edges`
   * by the query itself: counting it would turn "almost nothing is connected"
   * into "everything is connected", which is the exact reading the mention tier
   * exists to prevent (docs/KNOWLEDGE_GRAPH.md §3).
   *
   * A static path beside `/api/memory/graph`, not a `?stats=1` flag on it: the two
   * answer different questions with different costs (200 nodes vs the whole
   * graph), and Fastify prefers a static segment over a parameter, so neither the
   * parameterised `/api/memory/:id` nor `/api/memory/graph` is shadowed — both
   * cases are tested.
   */
  app.get('/api/memory/graph/stats', async (_request, reply) => {
    const enabled = cfg.graphEnabled ? cfg.graphEnabled() : true;
    try {
      // Zeroes with a real `enabled` flag on a pre-v10 database: there is no graph
      // to measure, and that is an answer, not a failure.
      return reply.send({ enabled, ...readGraphStats(cfg.db) } satisfies GraphStats);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /**
   * The entity roster (plan §4.1.1): every entity, keyset-paginated.
   *
   * The canvas cannot answer "what is in my graph". On the device 357 of 378
   * entities have no typed edge at all, so there is nothing to draw for them and the
   * 40-node budget is spent on the 21 that do. This is the complete answer, and it is
   * a LIST on purpose: enumeration has a total order, a drawing does not.
   *
   *   `?q=`                     substring over name / canonical name / alias
   *   `?type=`                  entity_type (the vocabulary is `/stats.entityTypes`)
   *   `?edges=any|yes|no`       has a typed edge / is isolated
   *   `?minDegree=`             incident-edge floor
   *   `?sort=degree|mentions|name|updated` + `?dir=asc|desc`
   *   `?cursor=`                opaque keyset cursor from the previous page
   *   `?limit=1..200`           page size (default 50)
   */
  app.get('/api/memory/entities', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    if (query.sort !== undefined && !ENTITY_ROSTER_SORTS.includes(query.sort as EntityRosterSort)) {
      return reply.status(400).send({ error: 'Unknown sort', allowed: ENTITY_ROSTER_SORTS });
    }
    if (
      query.edges !== undefined &&
      !ROSTER_EDGE_PRESENCE.includes(query.edges as RosterEdgePresence)
    ) {
      return reply
        .status(400)
        .send({ error: 'Unknown edges filter', allowed: ROSTER_EDGE_PRESENCE });
    }
    const cursor = query.cursor ? decodeRosterCursor(query.cursor) : undefined;
    // A cursor nobody can decode restarts nothing: silently paging from the top is
    // how a reader concludes the list lost rows.
    if (query.cursor && !cursor) return reply.status(400).send({ error: 'Invalid cursor' });
    // A cursor is only meaningful under the ordering it was issued for. Replaying it
    // against another `sort`/`dir` produces a page that neither continues nor repeats the
    // previous one, which a reader can only read as "the list lost rows".
    if (
      cursor &&
      !cursorMatchesSort(
        cursor,
        (query.sort as EntityRosterSort | undefined) ?? 'degree',
        query.dir === 'asc' ? 'asc' : 'desc',
      )
    ) {
      return reply.status(400).send({ error: 'Cursor was taken under a different sort' });
    }

    const roster: EntityRosterQuery = {
      q: query.q,
      entityType: query.type,
      edges: query.edges as RosterEdgePresence | undefined,
      minDegree:
        query.minDegree === undefined
          ? undefined
          : clampInt(query.minDegree, 0, 0, Number.MAX_SAFE_INTEGER),
      sort: (query.sort as EntityRosterSort | undefined) ?? 'degree',
      dir: query.dir === 'asc' ? 'asc' : 'desc',
      cursor,
      limit: clampInt(query.limit, DEFAULT_ENTITY_ROSTER_LIMIT, 1, MAX_GRAPH_LIMIT),
    };

    try {
      return reply.send(queryEntityRoster(cfg.db, roster));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /**
   * The edge roster (plan §4.1.2): every typed edge, keyset-paginated.
   *
   * `status=retracted` is the half the drawing cannot show. `/stats` has always
   * reported "2 retracted", and until now there was no way to learn which two — a
   * count with no drill-down is a dead end, and history nobody can open is
   * indistinguishable from history that was deleted.
   *
   *   `?source=` / `?target=`  entity id, one direction
   *   `?relation=`             predicate (vocabulary is `/stats.relationTypes`)
   *   `?status=open|retracted|all`  (default `open`)
   *   `?asOf=`                 the same temporal predicate the drawing uses
   *   `?since=` / `?until=`    window over `valid_from`
   *   `?sort=validFrom|confidence|relation` + `?dir=asc|desc`
   *   `?cursor=` / `?limit=`   page size default 100
   */
  app.get('/api/memory/edges', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    if (query.sort !== undefined && !EDGE_ROSTER_SORTS.includes(query.sort as EdgeRosterSort)) {
      return reply.status(400).send({ error: 'Unknown sort', allowed: EDGE_ROSTER_SORTS });
    }
    if (query.status !== undefined && !EDGE_STATUSES.includes(query.status as never)) {
      return reply.status(400).send({ error: 'Unknown status', allowed: EDGE_STATUSES });
    }
    const cursor = query.cursor ? decodeRosterCursor(query.cursor) : undefined;
    if (query.cursor && !cursor) return reply.status(400).send({ error: 'Invalid cursor' });
    if (
      cursor &&
      !cursorMatchesSort(
        cursor,
        (query.sort as EdgeRosterSort | undefined) ?? 'validFrom',
        query.dir === 'asc' ? 'asc' : 'desc',
      )
    ) {
      return reply.status(400).send({ error: 'Cursor was taken under a different sort' });
    }

    const roster: EdgeRosterQuery = {
      source: query.source,
      target: query.target,
      relation: query.relation,
      status: (query.status as EdgeRosterQuery['status'] | undefined) ?? 'open',
      asOf: parseGraphAsOf(query.asOf),
      since: parseGraphAsOf(query.since),
      until: parseGraphAsOf(query.until),
      sort: (query.sort as EdgeRosterSort | undefined) ?? 'validFrom',
      dir: query.dir === 'asc' ? 'asc' : 'desc',
      cursor,
      limit: clampInt(query.limit, DEFAULT_EDGE_ROSTER_LIMIT, 1, MAX_GRAPH_LIMIT),
    };

    try {
      return reply.send(queryEdgeRoster(cfg.db, roster));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /**
   * The full component list (plan §4.2).
   *
   * `/stats.components` is capped at eight and the cap is invisible in the payload, so a
   * reader sees "连通分量 368" above eight rows and cannot tell a full list from a
   * truncated one. `multiNodeComponents` gives the honest denominator and this endpoint
   * gives the rows behind it.
   *
   * `minSize` defaults to 2: one disconnected name is not a gap between clusters, it is
   * the normal state of a corpus that mentions more things than it makes statements about
   * (357 of 378 on the device).
   *
   *   `?minSize=2..`           member floor
   *   `?cursor=`               page boundary (an offset into a deterministic order)
   *   `?limit=1..100`          page size, default 20
   */
  app.get('/api/memory/components', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const offset = query.cursor ? decodeComponentCursor(query.cursor) : undefined;
    // A cursor nobody can decode must not turn into "page one": that is how a reader
    // concludes the list lost the rows they were part-way through.
    if (query.cursor && offset === undefined) {
      return reply.status(400).send({ error: 'Invalid cursor' });
    }

    try {
      return reply.send(
        readComponentPage(cfg.db, {
          minSize:
            query.minSize === undefined
              ? undefined
              : clampInt(
                  query.minSize,
                  COMPONENT_LIST_MIN_SIZE,
                  COMPONENT_LIST_MIN_SIZE,
                  1_000_000,
                ),
          offset,
          limit: clampInt(query.limit, DEFAULT_COMPONENT_PAGE_LIMIT, 1, MAX_COMPONENT_PAGE_LIMIT),
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /**
   * One entity with its aliases — the detail header the graph payload does not
   * carry (nodes describe the drawing, not the record).
   */
  app.get<{ Params: { id: string } }>('/api/memory/entity/:id', async (request, reply) => {
    try {
      if (!tableExists(cfg.db, 'entities')) {
        return reply.status(404).send({ error: 'Entity not found' });
      }
      const entity = repo.findById(request.params.id);
      if (!entity) return reply.status(404).send({ error: 'Entity not found' });
      const aliases = (
        cfg.db
          .prepare('SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY alias')
          .all(entity.id) as Array<{ alias: string }>
      ).map((row) => row.alias);
      return reply.send({ entity, aliases });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });
}
