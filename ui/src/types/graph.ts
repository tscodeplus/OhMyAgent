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
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** A cap cut the payload — the graph then says how many nodes it draws. */
  truncated: boolean;
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
}
