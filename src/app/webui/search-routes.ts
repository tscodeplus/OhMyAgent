/**
 * Unified search API: `/api/search` and its conversation-context companion.
 *
 * Ranking lives in `src/memory/unified-search.ts`; this module only parses the
 * query string and turns the fused hits into the row shape the WebUI renders.
 *
 * READ-ONLY: nothing here writes.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { MemoryRetriever } from '../../memory/memory-retriever.js';
import { unifiedSearch } from '../../memory/unified-search.js';
import type {
  UnifiedLaneReport,
  UnifiedMemoryHit,
  UnifiedMessageHit,
  UnifiedSearchLane,
} from '../../memory/unified-search.js';
import { inferChannel } from '../../memory/session-channel.js';
import { loadMessageContext, titleFromMetadata } from './session-message-view.js';
import type { FooterConfig } from '../types.js';

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;
/** The legs `/api/search` unions; `kinds` selects a subset of them. */
const SEARCH_KINDS: SearchResultKind[] = ['memory', 'message'];
/** Lanes `unifiedSearch()` fuses; `limit` is a per-lane allowance on each. */
const SEARCH_LANES = 2;
/** Search rows are rendered as one-line list entries — long text is noise. */
const TITLE_MAX_CHARS = 80;
const SNIPPET_MAX_CHARS = 200;

export type SearchResultKind = 'memory' | 'message';

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
   * from ("飞书 · 目录检查") and the UI can decide whether "open session" means the
   * IM inbox or a project chat.
   */
  session_title?: string;
  channel?: string;
}

/**
 * `GET /api/search` payload.
 *
 * `q` and `results` are the original contract — same keys, same kinds, one row
 * per hit. `lanes` is additive: a client that ignores it sees the previous
 * payload.
 */
export interface SearchResponse {
  q: string;
  results: SearchResult[];
  /** What each fused lane contributed. */
  lanes: Record<UnifiedSearchLane, UnifiedLaneReport>;
}

export interface SearchRouteConfig {
  db: Database.Database;
  /**
   * The same retriever chat recall uses. `retrieve({ textOnly: true })` runs its
   * existing FTS → LIKE ladder, so memory hits here are ranked exactly like the
   * memory tab instead of by a second, divergent ranker. Optional so the endpoint
   * still answers (messages only) when memory services are not wired up.
   */
  memoryRetriever?: Pick<MemoryRetriever, 'retrieve'>;
  /** Footer defaults for messages saved before the footer snapshot existed. */
  getFooterConfig?: () => FooterConfig;
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
 * A message row. The lane hands back a match window (±120 chars around the hit)
 * rather than the stored body, so its head becomes the title: for a long CJK
 * message the first 80 characters frequently contain no match at all, which is
 * exactly the row that used to read as unrelated to the query.
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

export function registerSearchRoutes(app: FastifyInstance, cfg: SearchRouteConfig): void {
  /**
   * Unified search: one fused ranking over the retrieval lanes.
   *
   * The message / memory lanes are merged by `unifiedSearch()`
   * (`src/memory/unified-search.ts`): one ranker, one place to change. The handler
   * does not rank either of them itself.
   *
   * Response contract (see `SearchResponse`): `q` and `results` are unchanged —
   * `limit` is still a per-kind page size, still capped, still grouped by kind.
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
      const fused = await unifiedSearch({
        query: term,
        // `limit` stays a per-lane page size; the fused list is sized to hold one
        // lane's full allowance from each leg, so the fusion trims by rank only
        // past that.
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
        logger: app.log,
      });

      const results: SearchResult[] = [];
      for (const hit of fused.hits) {
        // The message lane spends its budget on ±1 context rows so a quoted hit
        // is not quoted alone. That is right for a tool result and wrong for a
        // list: a neighbour has no match (score 0) and would read as a hit.
        if (hit.lane === 'message') {
          if (!hit.expanded) results.push(toMessageRow(hit, term));
          continue;
        }
        results.push(toMemoryRow(hit, term));
      }

      // The fused score is monotonic in lane rank, so this sort is what groups
      // the list by kind the way the UI renders it.
      results.sort((a, b) => b.score - a.score);

      const payload: SearchResponse = {
        q: term,
        results,
        lanes: fused.lanes,
      };
      return reply.send(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: message });
    }
  });

  // Conversation context for one search hit. The search list shows a snippet; a
  // snippet alone rarely explains what was asked, so the WebUI opens this window
  // beside it instead of making the user leave the page to find out.
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
