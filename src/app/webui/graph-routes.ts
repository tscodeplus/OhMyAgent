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
 * Traversal is NOT reimplemented: `EntityRepository.neighbors` owns the
 * recursive-CTE walk, the temporal predicate (`valid_from <= asOf < valid_to`)
 * and the depth clamp. This module only turns its result into the node/edge
 * payload the WebUI draws.
 */

import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import {
  EntityRepository,
  type Entity,
  type EntityEdge,
} from '../../memory/repositories/entity-repository.js';
import type { MemoryRetriever } from '../../memory/memory-retriever.js';
import { buildFtsQuery } from '../../memory/fts-tokenizer.js';
import { inferChannel } from '../../memory/session-channel.js';
import { loadMessageContext, titleFromMetadata } from './session-message-view.js';
import type { FooterConfig } from '../types.js';

const DEFAULT_GRAPH_LIMIT = 50;
const MAX_GRAPH_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;
/** Mirrors the WebUI's depth selector; deeper walks read the whole graph. */
const MAX_GRAPH_DEPTH = 3;
/** Search rows are rendered as one-line list entries — long text is noise. */
const TITLE_MAX_CHARS = 80;
const SNIPPET_MAX_CHARS = 200;

export interface GraphNode {
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

export interface GraphEdge {
  id: string;
  /** Source/target are entity ids, matching `GraphNode.id`. */
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
  /** True when a cap (limit) cut the payload — the UI says "showing first N". */
  truncated: boolean;
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
   * the IM inbox or a project chat. Resolved in one IN-query per page, never
   * per row.
   */
  session_title?: string;
  channel?: string;
}

export interface GraphRouteConfig {
  db: Database.Database;
  /**
   * The same retriever chat recall uses. `retrieve({ textOnly: true })` runs
   * its existing FTS → LIKE ladder, so memory hits here are ranked exactly like
   * the memory tab instead of by a second, divergent ranker. Optional so the
   * endpoints still answer (entities + messages only) when memory services are
   * not wired up.
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

/** Epoch-ms point in time; unparsable means "no temporal filter". */
function parseAsOf(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseRelationTypes(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((type) => type.trim())
    .filter((type) => type.length > 0);
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

/** `@p0, @p1, …` — one bound parameter per id, never interpolated. */
function idPlaceholders(ids: string[], prefix: string, params: Record<string, unknown>): string {
  return ids
    .map((id, index) => {
      params[`${prefix}${index}`] = id;
      return `@${prefix}${index}`;
    })
    .join(', ');
}

interface EdgeFilter {
  asOf?: number;
  relationTypes?: string[];
  limit: number;
}

/**
 * Edges whose BOTH endpoints are inside `ids`. Direction is preserved
 * (`source`/`target`), because the UI groups relations by direction and draws
 * arrowheads — a bidirectional view would lose that.
 *
 * Reads one row past the cap so the caller can report truncation truthfully
 * instead of guessing from `edges.length === limit`.
 */
function loadEdgesBetween(
  db: Database.Database,
  ids: string[],
  filter: EdgeFilter,
): { edges: GraphEdge[]; truncated: boolean } {
  if (ids.length === 0) return { edges: [], truncated: false };
  const params: Record<string, unknown> = { limit: filter.limit + 1 };
  const sourceIn = idPlaceholders(ids, 'src', params);
  const targetIn = idPlaceholders(ids, 'tgt', params);

  // Same temporal predicate as EntityRepository.neighbors: an edge that started
  // after asOf was not true yet, a retracted one only up to valid_to.
  let sql = `
    SELECT id, source_entity_id, target_entity_id, relation_type, confidence, valid_from, valid_to
    FROM entity_edges
    WHERE source_entity_id IN (${sourceIn})
      AND target_entity_id IN (${targetIn})
      AND (@asOf IS NULL OR ((valid_from IS NULL OR valid_from <= @asOf)
           AND (valid_to IS NULL OR valid_to > @asOf)))`;

  if (filter.asOf !== undefined) params.asOf = filter.asOf;
  else params.asOf = null;

  const relationTypes = filter.relationTypes ?? [];
  if (relationTypes.length > 0) {
    sql += ` AND relation_type IN (${idPlaceholders(relationTypes, 'rel', params)})`;
  }

  sql += ' ORDER BY confidence DESC, created_at DESC LIMIT @limit';

  const rows = db.prepare(sql).all(params) as Array<
    Pick<
      EntityEdge,
      | 'id'
      | 'source_entity_id'
      | 'target_entity_id'
      | 'relation_type'
      | 'confidence'
      | 'valid_from'
      | 'valid_to'
    >
  >;

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
function loadNodes(db: Database.Database, ids: string[]): GraphNode[] {
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
 * Overview payload: the busiest entities first, then the edges among them.
 * Degree ordering is what makes an overview legible — the densest cluster is
 * what a user opening "knowledge graph" is looking for.
 */
function loadOverview(db: Database.Database, limit: number, filter: EdgeFilter): GraphPayload {
  const rows = db
    .prepare(
      `SELECT e.id
       FROM entities e
       ORDER BY (SELECT COUNT(*) FROM entity_edges x
                  WHERE x.source_entity_id = e.id OR x.target_entity_id = e.id) DESC,
                e.canonical_name ASC
       LIMIT @limit`,
    )
    .all({ limit: limit + 1 }) as Array<{ id: string }>;

  const truncated = rows.length > limit;
  const nodes = loadNodes(
    db,
    rows.slice(0, limit).map((row) => row.id),
  );
  const { edges, truncated: edgesTruncated } = loadEdgesBetween(
    db,
    nodes.map((node) => node.id),
    filter,
  );
  return { nodes, edges, truncated: truncated || edgesTruncated };
}

/** Neighbourhood payload for one entity, honouring depth / asOf / relation types. */
function loadNeighbourhood(
  db: Database.Database,
  repo: EntityRepository,
  origin: Entity,
  filter: EdgeFilter,
  depth: number,
): GraphPayload {
  const neighbors = repo.neighbors(origin.id, {
    depth,
    asOf: filter.asOf,
    relationTypes: filter.relationTypes,
    limit: filter.limit,
  });
  // Origin first: the UI centres the layout on nodes[0].
  const ids = [origin.id, ...neighbors.map((neighbor) => neighbor.entity.id)];
  const nodes = loadNodes(db, ids);
  const { edges, truncated: edgesTruncated } = loadEdgesBetween(
    db,
    nodes.map((node) => node.id),
    filter,
  );
  return {
    nodes,
    edges,
    // `neighbors` caps its own SQL at `limit`; hitting the cap means the walk
    // may have more, so say so rather than silently dropping nodes.
    truncated: neighbors.length >= filter.limit || edgesTruncated,
  };
}

interface MessageHit {
  message_id: string;
  content_original: string;
  session_id: string | null;
  role: string | null;
  created_at: string | number | null;
  rank: number;
}

/**
 * Message hits from `messages_fts_jieba`. The index stores jieba-segmented text
 * in an unicode61 FTS5 table, so the query must be segmented the same way —
 * `buildFtsQuery` is the same helper the memory FTS path uses, including its
 * unicode-regex fallback when jieba is unavailable.
 *
 * Returns [] (never throws) when the table is missing or the MATCH expression
 * is rejected: message search is one leg of a unified search, not a reason to
 * fail the request.
 */
function searchMessages(db: Database.Database, query: string, limit: number): MessageHit[] {
  if (!tableExists(db, 'messages_fts_jieba')) return [];
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];
  try {
    return db
      .prepare(
        `SELECT message_id, content_original, session_id, role, created_at,
                bm25(messages_fts_jieba) AS rank
         FROM messages_fts_jieba
         WHERE messages_fts_jieba MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, limit) as MessageHit[];
  } catch {
    // Unparsable MATCH (or an index left over from another tokenizer setup).
    return [];
  }
}

/** BM25 rank is negative and unbounded; map it into (0, 1) like fts.ts does. */
function normalizeBm25(rank: number): number {
  const relevance = -rank;
  return relevance > 0 ? relevance / (1 + relevance) : 0;
}

function toEpochMs(value: string | number | null): number | undefined {
  if (value === null) return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function registerGraphRoutes(app: FastifyInstance, cfg: GraphRouteConfig): void {
  const repo = new EntityRepository(cfg.db);

  /**
   * Graph payload.
   *   `?entity=<id|name|alias>` — that entity's neighbourhood (default: overview)
   *   `?depth=1..3`             — hop count, neighbourhood only
   *   `?limit=1..200`           — node/edge cap
   *   `?asOf=<epoch ms>`        — "what was true then"
   *   `?types=a,b`              — relation types to traverse
   */
  app.get('/api/memory/graph', async (request, reply) => {
    const query = request.query as {
      entity?: string;
      depth?: string;
      limit?: string;
      asOf?: string;
      types?: string;
    };

    const limit = clampInt(query.limit, DEFAULT_GRAPH_LIMIT, 1, MAX_GRAPH_LIMIT);
    const depth = clampInt(query.depth, 1, 1, MAX_GRAPH_DEPTH);
    const filter: EdgeFilter = {
      asOf: parseAsOf(query.asOf),
      relationTypes: parseRelationTypes(query.types),
      limit,
    };

    try {
      if (!tableExists(cfg.db, 'entities')) {
        // Pre-v10 database: nothing has ever been written, so the honest answer
        // is an empty graph — not a 500 the UI has to special-case.
        if (query.entity) return reply.status(404).send({ error: 'Entity not found' });
        return reply.send({ nodes: [], edges: [], truncated: false } satisfies GraphPayload);
      }

      const entityRef = query.entity?.trim();
      if (!entityRef) {
        return reply.send(loadOverview(cfg.db, limit, filter));
      }

      // `entity` is whatever the user clicked or typed: an id, a canonical name
      // or an alias. Same resolution order EntityRepository.upsertEntity uses.
      const origin =
        repo.findById(entityRef) ?? repo.findByName(entityRef) ?? repo.findByAlias(entityRef);
      if (!origin) return reply.status(404).send({ error: 'Entity not found' });

      return reply.send(loadNeighbourhood(cfg.db, repo, origin, filter, depth));
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

  /**
   * Unified search across the three things a user opens the graph for:
   * entities, memories and chat messages. Each leg is capped at `limit`, so the
   * response holds at most 3 × limit rows — the UI groups them by kind anyway.
   */
  app.get('/api/search', async (request, reply) => {
    const { q, limit: limitParam } = request.query as { q?: string; limit?: string };
    const term = (q ?? '').trim();
    if (!term) return reply.status(400).send({ error: 'q is required' });

    const limit = clampInt(limitParam, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);

    try {
      const results: SearchResult[] = [];

      if (tableExists(cfg.db, 'entities')) {
        const entities = repo.searchEntities(term, limit);
        entities.forEach((entity, index) => {
          results.push({
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

      if (cfg.memoryRetriever) {
        // Reuses the chat-recalled ranking path; textOnly skips the embedding
        // call so a search box keystroke never waits on the provider.
        const memories = await cfg.memoryRetriever.retrieve({
          query: term,
          topK: limit,
          textOnly: true,
        });
        for (const memory of memories) {
          // title + snippet must read as ONE continuous text, not the same
          // sentence twice: the head goes in the title, the snippet is the part
          // that answers the query (see buildSnippet).
          const title = plainText(memory.content, TITLE_MAX_CHARS);
          results.push({
            kind: 'memory',
            id: memory.id,
            title,
            snippet: buildSnippet(memory.content, term, title.length),
            score: memory.score,
            ...(memory.createdAt ? { created_at: memory.createdAt } : {}),
          });
        }
      }

      const messageHits = searchMessages(cfg.db, term, limit);
      // Session titles/channels for the whole page in one query — the row label
      // needs them and N round-trips for N hits would be a latency trap.
      const sessionMeta = lookupSessionMeta(
        cfg.db,
        messageHits.map((hit) => hit.session_id).filter((id): id is string => Boolean(id)),
      );
      for (const hit of messageHits) {
        const createdAt = toEpochMs(hit.created_at);
        const meta = hit.session_id ? sessionMeta.get(hit.session_id) : undefined;
        results.push({
          kind: 'message',
          id: hit.message_id,
          title: plainText(hit.content_original, TITLE_MAX_CHARS),
          snippet: buildSnippet(hit.content_original, term, TITLE_MAX_CHARS),
          score: normalizeBm25(hit.rank),
          ...(hit.session_id ? { session_id: hit.session_id } : {}),
          ...(createdAt !== undefined ? { created_at: createdAt } : {}),
          ...(meta?.title ? { session_title: meta.title } : {}),
          ...(meta?.channel ? { channel: meta.channel } : {}),
        });
      }

      // Scores come from three different scales; ordering only has to be stable
      // and meaningful *within* a kind, which is how the UI renders them.
      results.sort((a, b) => b.score - a.score);
      return reply.send({ q: term, results });
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

/**
 * Title/channel for a handful of sessions, keyed by id.
 *
 * Title falls back to the same metadata mirror the inbox uses, so a session
 * created before v9 (no `title` column value) still labels its search hits.
 */
function lookupSessionMeta(
  db: Database.Database,
  ids: string[],
): Map<string, { title?: string; channel?: string }> {
  const out = new Map<string, { title?: string; channel?: string }>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;

  const placeholders = unique.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT id, channel, title, metadata FROM sessions WHERE id IN (${placeholders})`)
    .all(...unique) as Array<{
    id: string;
    channel: string | null;
    title: string | null;
    metadata: string | null;
  }>;

  for (const row of rows) {
    const title = row.title ?? titleFromMetadata(row.metadata);
    out.set(row.id, {
      ...(title ? { title } : {}),
      ...(row.channel ? { channel: row.channel } : {}),
    });
  }
  return out;
}
