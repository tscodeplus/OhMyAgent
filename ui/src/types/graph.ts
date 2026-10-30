import type { Message } from './session';

/**
 * Payloads of the read-only knowledge-graph API (src/app/webui/graph-routes.ts).
 *
 * `valid_to` is what makes an edge "retracted" — the row is kept so history
 * stays answerable, so the UI shows such relations as expired instead of
 * hiding them.
 */

export interface GraphNode {
  id: string;
  name: string;
  canonical_name: string;
  entity_type: string;
  description?: string;
  /** Incident edges in the whole graph, retracted ones included. */
  degree: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation_type: string;
  confidence: number;
  valid_from?: number;
  valid_to?: number;
  /**
   * `confidence` decayed to the instant being asked about, present only while
   * `memory.graph.decay_half_life_days` is set. The stored number is never
   * overwritten, so `confidence` still says what the producer asserted.
   */
  effective_confidence?: number;
  /**
   * The memory that asserted the relation, so an edge can be opened back to the
   * sentence it came from. Absent for edges projected before provenance was
   * stored — the column is nullable by design — and such a row then offers no
   * evidence button at all rather than a dead one.
   */
  source_memory_id?: string;
}

/**
 * A name the corpus mentions in the same memories as the queried entity.
 *
 * Never an edge: co-occurrence is not a statement, so it travels in its own
 * array and is rendered in its own block.
 */
export interface GraphMentionNeighbour {
  name: string;
  /** Memories that name this entity and the queried one both. */
  memories: number;
  /**
   * The node this name already belongs to, so the UI can open it. Absent when no
   * memory ever vouched for a node of that name — a mention the projector refused
   * has nothing to open, and the UI must not mint an id for it.
   */
  entity_id?: string;
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** A cap cut the payload — the graph then says how many nodes it draws. */
  truncated: boolean;
  /**
   * `memory.graph.enabled`. An empty graph and a switched-off one are different
   * answers, and the payload carries the difference rather than making the UI
   * guess it from `nodes.length === 0`. Absent in payloads from older servers.
   */
  enabled?: boolean;
  /**
   * Co-mentioned names — NEIGHBOURHOOD payloads only: a per-origin mention list
   * has no meaning when there is no origin. Optional rather than a second payload
   * type because one endpoint answers all three modes (overview, neighbourhood and
   * component), and the UI reads whichever fields the mode it asked for carries.
   */
  mentions?: GraphMentionNeighbour[];
  /** The mention cap alone decided; `truncated` aggregates it with the node/edge caps. */
  mentions_truncated?: boolean;
}

/** One connected part of the graph, as `GET /api/memory/graph/stats` lists them. */
export interface GraphComponent {
  /** Representative node id: highest degree, then canonical name. */
  id: string;
  size: number;
  /** Live typed edges inside the component — retracted ones are not connectivity. */
  edgeCount: number;
  /** Up to 12 members for the panel, ordered by degree desc then name. */
  nodes: Array<{ id: string; name: string }>;
}

/**
 * `GET /api/memory/graph/stats` — the numbers that explain a sparse drawing.
 *
 * `edges` counts typed edges only, so `MENTIONED` never inflates it: counting
 * co-occurrence would turn "almost nothing is connected" into "everything is".
 */
export interface GraphStats {
  enabled: boolean;
  nodes: number;
  edges: number;
  /** How many of `edges` are closed by `valid_to`: history, not connectivity. */
  retractedEdges: number;
  /** Entities with no typed edge in either direction. */
  isolated: number;
  /** Entities with no typed edge but at least one `memory_links` row naming them. */
  mentionOnly: number;
  mentionLinks: number;
  /** Total disconnected parts, each isolated entity counting as one. */
  componentCount: number;
  /** Largest component as a share of `nodes`, 0..1. */
  largestComponentPct: number;
  /** Size ≥ 2 components, largest first, capped at 8. */
  components: GraphComponent[];
  /** Present only when the `knowledge_links` table exists. */
  danglingLinks?: number;
  /** Present only when the `knowledge_pages` table exists. */
  scopedPages?: number;
  /**
   * The relation vocabulary to filter by, most used first (`GET /api/memory/graph/stats`).
   * Optional only for payloads from an older server: a list rebuilt from the current
   * payload would shrink to the type a user just selected, which is the one control
   * that can unselect it.
   */
  relationTypes?: string[];
}

export interface EntityRecord {
  id: string;
  name: string;
  canonical_name: string;
  entity_type: string;
  description: string | null;
  created_at: number | null;
  updated_at: number | null;
}

export interface EntityDetailPayload {
  entity: EntityRecord;
  aliases: string[];
  /**
   * Active curated pages that point at this entity (`knowledge_pages.entity_id`).
   * Empty while the page layer is off — the server does not serve the section
   * then, so an empty list is safe to read as "no pages". Absent in payloads
   * from older servers.
   */
  pages?: EntityPageRef[];
}

/** One page row in an entity's detail panel; `id` opens it in the pages tab. */
export interface EntityPageRef {
  id: string;
  title: string;
  slug: string;
  pageType: string;
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
  /** Owning session's title, when the hit belongs to one. */
  session_title?: string;
  /** Owning session's channel ('feishu', 'webui', …) — decides where "open" goes. */
  channel?: string;
}

/**
 * `GET /api/search/context` — the conversation window around one message hit.
 * `messages` uses the transcript shape, so the panel renders it with the normal
 * message component instead of a second, search-specific renderer.
 */
export interface SearchContextResponse {
  session: {
    id: string;
    /** IM sessions have no project and route to /inbox/:id. */
    is_im: boolean;
    project_id: string | null;
    channel: string;
    title: string | null;
  };
  messages: Message[];
  /** The hit itself, or null when it no longer exists. */
  focus_id: string | null;
  truncated_start: boolean;
  truncated_end: boolean;
}

export interface SearchPayload {
  q: string;
  results: SearchResult[];
  /**
   * Knowledge-page hits. A separate array because `results` is rendered by a
   * closed kind list: a fourth kind there would fall out of every group, and a
   * page-only answer would render as "no results".
   *
   * These rows MUST be rendered, not ignored: the fusion drops a memory when a
   * returned page cites it (`deduped`), so hiding `pages` makes a hit vanish
   * with nothing in its place.
   */
  pages?: SearchPageRow[];
  /** Memories dropped because a returned page already covers them. */
  deduped?: SearchDedupeRecord[];
  /** What each fused lane contributed; `error` marks a lane that failed alone. */
  lanes?: Partial<Record<SearchLane, SearchLaneReport>>;
  /** Relations the graph already records about the returned memories. */
  hints?: SearchGraphHint[];
}

export type SearchPageRow = Omit<SearchResult, 'kind'> & { kind: 'knowledge' };

export type SearchLane = 'memory' | 'message' | 'knowledge';

export interface SearchLaneReport {
  hits: number;
  dropped: number;
  /** Set when the lane failed; the other lanes still answer. */
  error?: string;
}

export interface SearchDedupeRecord {
  lane: 'memory';
  id: string;
  reason: 'cited_by_knowledge_page';
  /** The page that covers the dropped memory, so the drop is explainable. */
  page_slug: string;
}

export interface SearchGraphHint {
  subject: string;
  relation: string;
  object: string;
  memoryId: string;
  memoryRef: string;
}

/**
 * Counts the graph tab reports to the merged page's header.
 *
 * `enabled` is `memory.graph.enabled`: an empty graph and a switched-off one are
 * different answers, and the header says which one it is looking at.
 */
export interface GraphSummary {
  nodes: number;
  edges: number;
  enabled: boolean;
}
