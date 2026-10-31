/**
 * Payloads of the search API (`src/app/webui/search-routes.ts`).
 *
 * Only what the conversation-context panel renders: the notes page's citation
 * drawer asks `/api/search/context` for the window around a message it cites.
 * Ranking happens server-side, so there is no client-side result list here.
 */

import type { Message } from './session';

export type SearchResultKind = 'memory' | 'message';

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
