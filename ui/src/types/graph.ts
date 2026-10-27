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
}

export interface SearchPayload {
  q: string;
  results: SearchResult[];
}
