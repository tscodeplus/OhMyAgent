/**
 * Knowledge-graph read API + unified search.
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
 *
 * `/api/search` ranks through `unifiedSearch()` (`src/memory/unified-search.ts`)
 * — the K5 fusion point — rather than ranking the same three sources here as
 * well. See the handler for the response contract.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { EntityRepository } from '../../memory/repositories/entity-repository.js';
import { MENTION_RELATION_TYPE } from '../../graph/entity-mining.js';
import type { MemoryRetriever } from '../../memory/memory-retriever.js';
import type { KnowledgeService } from '../../memory/knowledge/service-contract.js';
import { unifiedSearch } from '../../memory/unified-search.js';
import type {
  UnifiedKnowledgeHit,
  UnifiedLaneReport,
  UnifiedMemoryHit,
  UnifiedMessageHit,
  UnifiedSearchLane,
} from '../../memory/unified-search.js';
import { inferChannel } from '../../memory/session-channel.js';
import { readHintsForMemories, type GraphHint } from '../../graph/neighborhood.js';
import {
  DEFAULT_GRAPH_QUERY_LIMIT,
  MAX_QUERY_DEPTH,
  loadEdgesBetween,
  loadGraphNodes,
  parseGraphAsOf,
  parseGraphRelationTypes,
  queryEntityComponent,
  queryEntityGraph,
  readGraphStats,
  type GraphEdgeFilter,
  type GraphMentionNeighbour,
  type GraphQueryEdge,
  type GraphQueryNode,
  type GraphStats,
} from '../../graph/graph-query.js';
import { loadMessageContext, titleFromMetadata } from './session-message-view.js';
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

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;
/** The three legs `/api/search` unions; `kinds` selects a subset of them. */
const SEARCH_KINDS: SearchResultKind[] = ['entity', 'memory', 'message'];
/** Lanes `unifiedSearch()` fuses; `limit` is a per-lane allowance on each. */
const SEARCH_LANES = 3;
/** Search rows are rendered as one-line list entries — long text is noise. */
const TITLE_MAX_CHARS = 80;
const SNIPPET_MAX_CHARS = 200;

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

export type SearchResultKind = 'entity' | 'memory' | 'message';

export interface SearchResult {
  kind: SearchResultKind;
  id: string;
  title: string;
  snippet: string;
  score: number;
  session_id?: string;
  created_at?: number;
  /**
   * Owning session's title and channel, so a result row can say where it came
   * from ("飞书 · 目录检查") and the UI can decide whether "open session" means
   * the IM inbox or a project chat.
   */
  session_title?: string;
  channel?: string;
}

/**
 * A knowledge page hit: the consumer-facing row shape, its own `kind` and its
 * own array.
 *
 * Pages are not in `results` because the WebUI renders `results` by a closed
 * kind list (`entity`/`memory`/`message`): a fourth kind there would be dropped
 * from every group, and a page-only answer would render as "no results". They
 * share the row fields so a kind-aware group can render them as they are.
 */
export interface SearchPageRow extends Omit<SearchResult, 'kind'> {
  kind: 'knowledge';
}

/** A memory dropped because a returned page already covers it (same-source rule). */
export interface SearchDedupeRecord {
  /** `memory` — a page covered it; `knowledge` — the page was older than its source. */
  lane: 'memory' | 'knowledge';
  /** The dropped row's id (a memory id, or a page id for the `knowledge` lane). */
  id: string;
  reason: 'cited_by_knowledge_page' | 'superseded_by_cited_memory';
  /** The page involved, so the drop is explainable from the payload. */
  page_slug: string;
}

/**
 * `GET /api/search` payload.
 *
 * `q` and `results` are the original contract and are unchanged — same keys,
 * same kinds, one row per hit. `pages`, `lanes` and `deduped` are additive: a
 * client that ignores them sees the previous payload.
 */
export interface SearchResponse {
  q: string;
  results: SearchResult[];
  pages: SearchPageRow[];
  /** What each fused lane contributed. Entities are not a lane (see the handler). */
  lanes: Record<UnifiedSearchLane, UnifiedLaneReport>;
  deduped: SearchDedupeRecord[];
  /**
   * Relations the graph already records about the returned memories.
   *
   * Additive by design: a client that ignores the field behaves exactly as before,
   * and nothing here influences `results` order or `score`.
   */
  hints: GraphHint[];
}

export interface GraphRouteConfig {
  db: Database.Database;
  /**
   * Days in which an edge's confidence halves (`memory.graph.decay_half_life_days`),
   * 0/absent = no decay. Same value the tool gets, so the drawing and the
   * model's answer rank identically.
   */
  decayHalfLifeDays?: number;
  /**
   * The same retriever chat recall uses. `retrieve({ textOnly: true })` runs
   * its existing FTS → LIKE ladder, so memory hits here are ranked exactly like
   * the memory tab instead of by a second, divergent ranker. Optional so the
   * endpoints still answer (entities + messages only) when memory services are
   * not wired up.
   */
  memoryRetriever?: Pick<MemoryRetriever, 'retrieve'>;
  /**
   * The knowledge lane — the same service the knowledge routes and tools read.
   * Optional, and absent is the normal state: while `knowledge.enabled` is
   * false no service is built at all. Absent means the page lane does not run,
   * so pages are never returned and the page-wins dedupe cannot fire; the
   * memory/message lanes answer exactly as they did before.
   */
  knowledge?: Pick<KnowledgeService, 'search' | 'get'>;
  /** Footer defaults for messages saved before the footer snapshot existed. */
  getFooterConfig?: () => FooterConfig;
  /**
   * `memory.graph.enabled`, read per request. Optional so the tests (and any
   * caller that does not care) can omit it — absent means "on".
   */
  graphEnabled?: () => boolean;
}

/**
 * Second line of a search row: the part of the text that answers the query.
 *
 * Two failure modes this avoids, both visible in a list where every row should
 * read as one continuous thought:
 *   - repeating the title (`title` is the head of the same string), and
 *   - showing the head when the match sits past it — for a long CJK message the
 *     first 200 characters often contain no match at all, so the snippet looked
 *     unrelated to what the user searched.
 *
 * When the match is inside the title the snippet simply continues the text;
 * otherwise it is a window centred on the match.
 */
function buildSnippet(text: string, term: string, titleLength: number): string {
  const plain = plainText(text, text.length);
  const matchIndex = plain.toLowerCase().indexOf(term.toLowerCase());

  if (matchIndex < 0 || matchIndex < titleLength) {
    const rest = plain.slice(titleLength).trim();
    return rest.length > SNIPPET_MAX_CHARS ? `${rest.slice(0, SNIPPET_MAX_CHARS)}…` : rest;
  }

  // Centre the window on the match, clamped to the text bounds so a match near
  // either end still yields a full-width snippet.
  const half = Math.floor(SNIPPET_MAX_CHARS / 2);
  const start = Math.max(0, Math.min(matchIndex - half, plain.length - SNIPPET_MAX_CHARS));
  const slice = plain.slice(start, start + SNIPPET_MAX_CHARS).trim();
  return `${start > 0 ? '…' : ''}${slice}${start + SNIPPET_MAX_CHARS < plain.length ? '…' : ''}`;
}

/** Clamp a query-string integer to [min, max], falling back on garbage. */
function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(min, parsed), max);
}

/**
 * SQLite databases created before v10 have no graph tables at all. Checked once
 * per request rather than cached: the tables appear the first time the graph
 * migration/backfill writes, and a cached "missing" would lie afterwards.
 */
function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/**
 * Flatten to a single line and strip tags — snippets come from user-authored
 * chat text and memory content, which routinely contains Markdown/HTML.
 */
function plainText(value: string, maxChars: number): string {
  const flattened = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flattened.length > maxChars ? `${flattened.slice(0, maxChars)}…` : flattened;
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
  const ranked = db
    .prepare(
      `SELECT e.id
       FROM entities e
       ORDER BY (SELECT COUNT(*) FROM entity_edges x
                  WHERE x.source_entity_id = e.id OR x.target_entity_id = e.id) DESC,
                (SELECT COUNT(*) FROM memory_links ml
                  WHERE ml.target_entity = e.name OR ml.subject_entity = e.name) DESC,
                e.canonical_name ASC`,
    )
    .all() as Array<{ id: string }>;
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

/**
 * Row mappers — one per lane, so the response keeps the shape the WebUI already
 * renders while the *ranking* comes from `unifiedSearch()`.
 *
 * The message lane hands back a match window (±120 chars around the hit) rather
 * than the stored body, so its head becomes the title: for a long CJK message
 * the first 80 characters frequently contain no match at all, which is exactly
 * the row that used to read as unrelated to the query.
 */
function toMessageRow(hit: UnifiedMessageHit, term: string): SearchResult {
  const title = plainText(hit.snippet, TITLE_MAX_CHARS);
  return {
    kind: 'message',
    id: hit.ref,
    title,
    snippet: buildSnippet(hit.snippet, term, title.length),
    score: hit.score,
    session_id: hit.sessionId,
    created_at: hit.createdAt,
    ...(hit.sessionTitle ? { session_title: hit.sessionTitle } : {}),
    ...(hit.channel ? { channel: hit.channel } : {}),
  };
}

/** A memory row: the lane's excerpt is the memory content, so title + snippet split it. */
function toMemoryRow(hit: UnifiedMemoryHit, term: string): SearchResult {
  const title = plainText(hit.snippet, TITLE_MAX_CHARS);
  return {
    kind: 'memory',
    id: hit.ref,
    title,
    snippet: buildSnippet(hit.snippet, term, title.length),
    score: hit.score,
    ...(hit.createdAt ? { created_at: hit.createdAt } : {}),
  };
}

/**
 * A page row. `id` is the page id (what `knowledge_get` takes) and the title is
 * the page's own title: a page is a document with a name, not an excerpt whose
 * head happens to be where the match is.
 */
function toPageRow(hit: UnifiedKnowledgeHit): SearchPageRow {
  return {
    kind: 'knowledge',
    id: hit.ref,
    title: plainText(hit.title, TITLE_MAX_CHARS),
    snippet: plainText(hit.snippet, SNIPPET_MAX_CHARS),
    score: hit.score,
  };
}

/**
 * The memory lane as `unifiedSearch()` will call it, with `memory_kinds` applied
 * inside the lane.
 *
 * `unifiedSearch` hands a retriever only the query and the page size, so the
 * narrowing lives in the retriever it is given. Over-fetch while filtering: the
 * kind filter runs after retrieval, so asking for `limit` rows and dropping most
 * of them would return a page far shorter than the caller allowed.
 */
function memoryLaneRetriever(
  retriever: Pick<MemoryRetriever, 'retrieve'>,
  kinds: Set<string> | null,
): Pick<MemoryRetriever, 'retrieve'> {
  if (!kinds) return retriever;
  return {
    retrieve: async (options) => {
      const overFetch = Math.min((options.topK ?? DEFAULT_SEARCH_LIMIT) * 4, MAX_SEARCH_LIMIT * 2);
      const found = await retriever.retrieve({ ...options, topK: overFetch });
      return found.filter((memory) => kinds.has(memory.kind));
    },
  };
}

export function registerGraphRoutes(app: FastifyInstance, cfg: GraphRouteConfig): void {
  const repo = new EntityRepository(cfg.db);

  /**
   * Graph payload.
   *   `?entity=<id|name|alias>`    — that entity's neighbourhood (default: overview)
   *   `?component=<id|name|alias>` — that entity's whole connected component
   *   `?depth=1..3`                — hop count, neighbourhood only
   *   `?limit=1..200`              — node/edge cap
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
        const component = queryEntityComponent(cfg.db, componentRef, {
          asOf: filter.asOf,
          relationTypes: filter.relationTypes,
          limit,
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
   * One entity with its aliases — the detail header the graph payload does not
   * carry (nodes describe the drawing, not the record) — plus the curated pages
   * that point at it.
   *
   * `knowledge_pages.entity_id` (migration-v21) is a lookup, never an insert: a
   * page records the node its canonicalised title folds to, and the graph is
   * what makes those pages reachable from an entity. The console could not see
   * that relation at all before this field existed. Gated on `cfg.knowledge`,
   * so a console running without the page layer reports no pages instead of
   * half-rendering a section whose routes 404.
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
      const pages =
        cfg.knowledge && tableExists(cfg.db, 'knowledge_pages')
          ? (cfg.db
              .prepare(
                `SELECT id, title, slug, page_type AS pageType
                   FROM knowledge_pages
                  WHERE entity_id = ? AND status = 'active'
                  ORDER BY updated_at DESC
                  LIMIT 20`,
              )
              .all(entity.id) as Array<{
              id: string;
              title: string;
              slug: string;
              pageType: string;
            }>)
          : [];
      return reply.send({ entity, aliases, pages });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  /**
   * Unified search: one fused ranking over the retrieval lanes, plus the graph's
   * entity index.
   *
   * The message / memory / knowledge lanes are merged by `unifiedSearch()`
   * (`src/memory/unified-search.ts`): one ranker, one provenance-dedupe rule
   * (a returned page drops the memories it cites), one place to change. The
   * handler no longer ranks any of the three itself — before this it held a
   * second, divergent ordering of the same sources, which is what K5 exists to
   * remove.
   *
   * Entities are NOT fused: an entity is a graph node, not a retrieval lane — it
   * has no lane score and no provenance row — so it keeps
   * `EntityRepository.searchEntities`'s exact-then-shortest order and is reported
   * outside `lanes`.
   *
   * Response contract (see `SearchResponse`): `q` and `results` are unchanged —
   * `limit` is still a per-kind page size, still capped, still grouped by kind —
   * and `pages` / `lanes` / `deduped` are additive.
   */
  app.get('/api/search', async (request, reply) => {
    const {
      q,
      limit: limitParam,
      kinds: kindsParam,
      memory_kinds: memoryKindsParam,
    } = request.query as {
      q?: string;
      limit?: string;
      kinds?: string;
      memory_kinds?: string;
    };
    const term = (q ?? '').trim();
    if (!term) return reply.status(400).send({ error: 'q is required' });

    const limit = clampInt(limitParam, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);

    // Filtering server-side, not in the UI: each leg is capped at `limit`, so a
    // client that hid a kind after the fact would show fewer rows than the cap
    // allows. Unknown names are a 400 rather than silently ignored — a typo in a
    // filter should be visible, not quietly produce a short page.
    let kinds = SEARCH_KINDS;
    if (kindsParam !== undefined) {
      const requested = kindsParam
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const unknown = requested.filter(
        (value) => !SEARCH_KINDS.includes(value as SearchResultKind),
      );
      if (unknown.length > 0) {
        return reply.status(400).send({ error: `unknown kind: ${unknown.join(', ')}` });
      }
      if (requested.length === 0) {
        return reply.status(400).send({ error: 'kinds is empty' });
      }
      kinds = SEARCH_KINDS.filter((kind) => requested.includes(kind));
    }
    const wants = (kind: SearchResultKind): boolean => kinds.includes(kind);

    // Optional narrowing of the memory leg to specific memory kinds (preference,
    // fact, summary, …) — the same vocabulary the memory page filters by. Absent
    // means "every kind", which is why it is a separate parameter rather than
    // reusing `kinds` (that one selects which *legs* run).
    let memoryKinds: Set<string> | null = null;
    if (memoryKindsParam !== undefined) {
      const requested = memoryKindsParam
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      if (requested.length === 0) {
        return reply.status(400).send({ error: 'memory_kinds is empty' });
      }
      memoryKinds = new Set(requested);
    }

    try {
      const entityRows: SearchResult[] = [];

      if (wants('entity') && tableExists(cfg.db, 'entities')) {
        const entities = repo.searchEntities(term, limit);
        entities.forEach((entity, index) => {
          entityRows.push({
            kind: 'entity',
            id: entity.id,
            title: plainText(entity.name, TITLE_MAX_CHARS),
            snippet: plainText(
              entity.description ?? `${entity.entity_type} · ${entity.canonical_name}`,
              SNIPPET_MAX_CHARS,
            ),
            // Positional score: EntityRepository.searchEntities already orders
            // exact canonical hits first, then shortest name — the ordering IS
            // the ranking, so mirror it into a monotonic score.
            score: (entities.length - index) / entities.length,
          });
        });
      }

      // The knowledge lane is not gated by `kinds`: `kinds` selects which legs
      // the *client* renders, and knowledge is not one of them (its rows ride in
      // `pages`, which the current WebUI ignores). Running the lane regardless
      // is what lets the page-wins dedupe below remove a memory a page already
      // answers — the one visible K5 change on today's client.
      const fused = await unifiedSearch({
        query: term,
        // `limit` stays a per-lane page size, as it was per leg; the fused list is
        // sized to hold one lane's full allowance from each of the three, so the
        // fusion trims by rank only past that (per-lane allowances of 17+ share
        // `MAX_SEARCH_LIMIT` and the weakest rows lose).
        limit: Math.min(limit * SEARCH_LANES, MAX_SEARCH_LIMIT),
        perLaneLimit: limit,
        // The memory lane is the only one that can touch the provider, so
        // skipping it when the user filtered it out is a real latency win.
        // `textOnly` keeps a search-box keystroke from waiting on it at all.
        ...(wants('message') ? { messages: { db: cfg.db } } : {}),
        ...(wants('memory') && cfg.memoryRetriever
          ? {
              memories: {
                retriever: memoryLaneRetriever(cfg.memoryRetriever, memoryKinds),
                textOnly: true,
              },
            }
          : {}),
        ...(cfg.knowledge ? { knowledge: { service: cfg.knowledge } } : {}),
        logger: app.log,
      });

      const results: SearchResult[] = [...entityRows];
      const pages: SearchPageRow[] = [];
      for (const hit of fused.hits) {
        if (hit.lane === 'knowledge') {
          pages.push(toPageRow(hit));
          continue;
        }
        // The message lane spends its budget on ±1 context rows so a quoted hit
        // is not quoted alone. That is right for a tool result and wrong for a
        // list: a neighbour has no match (score 0) and would read as a hit.
        if (hit.lane === 'message') {
          if (!hit.expanded) results.push(toMessageRow(hit, term));
          continue;
        }
        results.push(toMemoryRow(hit, term));
      }

      // Two score scales remain — the entity leg's positional score and the
      // RRF-fused lanes — and they are only comparable *within* a kind, which is
      // how the UI renders them. Within a kind this sort is an identity: the
      // fused score is monotonic in lane rank.
      results.sort((a, b) => b.score - a.score);

      // Structural hints for the memories this query actually returned. Derived,
      // never ranked: they are attached beside the results so the client can show
      // them, and a wrong edge costs a wrong hint instead of a wrong hit order.
      const memoryIds = results
        .filter((row) => row.kind === 'memory')
        .map((row) => row.id)
        .slice(0, SEARCH_LANES * MAX_SEARCH_LIMIT);
      const hints = readHintsForMemories(cfg.db, memoryIds);

      const payload: SearchResponse = {
        q: term,
        results,
        pages,
        hints,
        lanes: fused.lanes,
        deduped: fused.deduped.map((record) => ({
          lane: record.lane,
          id: record.ref,
          reason: record.reason,
          page_slug: record.pageSlug,
        })),
      };
      return reply.send(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  // Conversation context for one search hit. The search list shows a snippet;
  // a snippet alone rarely explains what was asked, so the WebUI opens this
  // window beside it instead of making the user leave the page to find out.
  app.get('/api/search/context', async (request, reply) => {
    const {
      session_id: sessionId,
      message_id: messageId,
      radius: radiusParam,
    } = request.query as {
      session_id?: string;
      message_id?: string;
      radius?: string;
    };
    if (!sessionId) {
      return reply.status(400).send({ error: 'Bad Request', message: 'session_id is required' });
    }

    try {
      const session = cfg.db
        .prepare('SELECT id, project_id, channel, title, metadata FROM sessions WHERE id = ?')
        .get(sessionId) as
        | {
            id: string;
            project_id: string | null;
            channel: string | null;
            title: string | null;
            metadata: string | null;
          }
        | undefined;
      if (!session) {
        return reply.status(404).send({ error: 'Not Found', message: 'Session not found' });
      }

      const { messages, focusId, truncatedStart, truncatedEnd } = loadMessageContext(
        cfg.db,
        sessionId,
        messageId ?? '',
        {
          radius: radiusParam === undefined ? undefined : clampInt(radiusParam, 6, 1, 50),
          getFooterConfig: cfg.getFooterConfig,
        },
      );

      return reply.send({
        session: {
          id: session.id,
          // IM sessions have no project, which is exactly what the UI needs to
          // route "open full session" to /inbox/:id instead of /p/:project/s/:id.
          is_im: session.project_id === null,
          project_id: session.project_id,
          channel: session.channel ?? inferChannel(session.id, session.id),
          title: session.title ?? titleFromMetadata(session.metadata),
        },
        messages,
        focus_id: focusId,
        truncated_start: truncatedStart,
        truncated_end: truncatedEnd,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });
}
