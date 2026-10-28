/**
 * Conversation search — the only read path over raw messages.
 *
 * `messages_fts_jieba` was built (migration-v10) and kept in sync with every
 * message INSERT/UPDATE/DELETE (`fts.ts`), but until now its single reader was
 * the WebUI's `/api/search` leg. The agent had no way to reach original
 * conversation text at all, which is why "上次那个方案叫什么" could not be
 * answered from anything but a compressed preference.
 *
 * The FTS table is standalone and carries `session_id` / `role` / `created_at`
 * as UNINDEXED columns (migration-v10), so neither snippet construction nor
 * per-session filtering needs a join back to `messages`.
 *
 * Two contract details that are easy to get wrong:
 *
 * 1. `limit` is the **total** cap, neighbourhood expansion included. Hits are
 *    ranked by BM25, then each hit is followed by its ±1 neighbour in the same
 *    session, and the walk stops the moment `limit` entries exist — so
 *    `limit: 8` can be "4 hits + 4 neighbours" but never "8 hits × 3 = 24".
 *    A budget that only caps hits silently triples the prompt cost.
 * 2. Channel is read as `session.channel ?? inferChannel(...)`, never as a
 *    filter by default: a NULL/`unknown` channel must not make a session
 *    unsearchable (see `session-access.ts`).
 */

import type Database from 'better-sqlite3';
import { buildFtsQuery, cutCJK } from './fts-tokenizer.js';
import { resolveSessionChannel, sessionVisible } from './session-access.js';
import type { SessionAccessPolicy, SessionRow } from './session-access.js';
import { parseEpochMs } from '../shared/timestamp.js';

export const DEFAULT_CONVERSATION_SEARCH_LIMIT = 8;
export const MAX_CONVERSATION_SEARCH_LIMIT = 50;
/** Roughly one line of context per hit; the tool's budget is built on this. */
export const CONVERSATION_SNIPPET_MAX_CHARS = 120;

/**
 * Policy, channel and time filters run after the SQL (they need the session row,
 * or a numeric timestamp the TEXT column cannot be compared against), so the
 * query over-fetches to avoid returning a page far shorter than `limit` allows.
 */
const CANDIDATE_MULTIPLIER = 8;
const MAX_CANDIDATE_ROWS = 400;

export interface ConversationSearchOptions {
  db: Database.Database;
  /** Raw user text — segmented with the same jieba path the index was built with. */
  query: string;
  /** Restrict to one session. */
  sessionId?: string;
  /** Restrict to one channel (`feishu`, `webui`, `unknown`, …). */
  channel?: string;
  /** Only messages at/after this instant: epoch ms, digit string or ISO date. */
  since?: number | string;
  /** Only messages at/before this instant: epoch ms, digit string or ISO date. */
  until?: number | string;
  /** TOTAL number of entries returned, neighbourhood included. Default 8. */
  limit?: number;
  /** Session access policy. An unset field never filters. */
  policy?: SessionAccessPolicy;
}

export interface ConversationSearchHit {
  message_id: string;
  session_id: string;
  /** Owning session's title; falls back to the `metadata.title` mirror. */
  session_title: string | null;
  channel: string;
  role: string;
  /** Epoch milliseconds. */
  created_at: number;
  /** ~120 chars of `content_original`, windowed around the match. */
  snippet: string;
  /** Normalised BM25 in (0, 1); 0 for a neighbour added for context. */
  score: number;
  /** True when this row is a ±1 neighbour rather than an FTS hit. */
  expanded: boolean;
  /** `memory_sources` for this message; [] when nothing was recorded. */
  memory_ids: string[];
  /**
   * `knowledge_sources(source_kind = 'message')` → active `knowledge_pages.slug`.
   * Always present, empty until the knowledge layer cites messages.
   */
  knowledge_slugs: string[];
}

interface FtsRow {
  message_id: string;
  content_original: string | null;
  session_id: string;
  role: string | null;
  created_at: string | number | null;
  rank: number;
}

interface SessionMetaRow extends SessionRow {
  title?: string | null;
  metadata?: string | null;
}

interface TimelineEntry {
  message_id: string;
  created_at: number;
}

interface Selection {
  message_id: string;
  expanded: boolean;
  /** Present for FTS hits; neighbours are fetched in one batch afterwards. */
  row?: FtsRow;
}

/**
 * Search raw messages and return at most `limit` entries, chronologically
 * ordered, each with its provenance (memories / knowledge pages).
 *
 * Returns [] rather than throwing when the FTS table is missing or the MATCH
 * expression is rejected: conversation search is one retrieval leg, not a
 * reason to fail a tool call.
 */
export function searchMessages(options: ConversationSearchOptions): ConversationSearchHit[] {
  const { db, query } = options;
  const limit = clampLimit(options.limit);

  if (!tableExists(db, 'messages_fts_jieba')) return [];
  const ftsQuery = buildFtsQuery(query ?? '');
  if (!ftsQuery) return [];

  const since = toEpochMs(options.since);
  const until = toEpochMs(options.until);
  const policy = options.policy ?? {};
  const wantedChannel = options.channel?.trim() ?? '';

  const candidates = queryFts(db, ftsQuery, {
    sessionId: options.sessionId,
    limit: candidateLimit(limit),
  });
  if (candidates.length === 0) return [];

  const sessions = loadSessions(
    db,
    candidates.map((row) => row.session_id),
  );
  const sessionOf = (id: string): SessionMetaRow => sessions.get(id) ?? { id, project_id: null };

  // Timestamps up front: the time window has to be applied to the *repaired*
  // value, not to the `'0'` the index carries for post-backfill rows.
  const candidateTimes = new Map<string, number>();
  for (const row of candidates) {
    candidateTimes.set(row.message_id, toEpochMs(row.created_at) ?? 0);
  }
  repairTimestamps(db, candidateTimes);

  const hits = candidates.filter((row) => {
    const session = sessionOf(row.session_id);
    if (!sessionVisible(session, policy)) return false;
    if (wantedChannel !== '' && resolveSessionChannel(session) !== wantedChannel) return false;
    const createdAt = candidateTimes.get(row.message_id) ?? 0;
    if (since !== undefined && (createdAt === 0 || createdAt < since)) return false;
    if (until !== undefined && (createdAt === 0 || createdAt > until)) return false;
    return true;
  });

  // Hit → its ±1 neighbours, stopping at the total cap. The timeline is loaded
  // once per session and reused for every hit in it.
  const timelines = new Map<string, TimelineEntry[]>();
  const timelineOf = (sessionId: string): TimelineEntry[] => {
    const cached = timelines.get(sessionId);
    if (cached) return cached;
    const timeline = loadTimeline(db, sessionId);
    timelines.set(sessionId, timeline);
    return timeline;
  };

  const selections: Selection[] = [];
  const seen = new Set<string>();
  for (const row of hits) {
    if (selections.length >= limit) break;
    if (!seen.has(row.message_id)) {
      seen.add(row.message_id);
      selections.push({ message_id: row.message_id, expanded: false, row });
    }

    const timeline = timelineOf(row.session_id);
    const index = timeline.findIndex((entry) => entry.message_id === row.message_id);
    if (index < 0) continue;
    for (const neighbourIndex of [index - 1, index + 1]) {
      if (selections.length >= limit) break;
      const neighbour = timeline[neighbourIndex];
      if (!neighbour || seen.has(neighbour.message_id)) continue;
      seen.add(neighbour.message_id);
      selections.push({ message_id: neighbour.message_id, expanded: true });
    }
  }

  // Neighbour content in one query — never one per entry.
  const missing = selections
    .filter((selection) => selection.row === undefined)
    .map((selection) => selection.message_id);
  const neighbourRows = loadFtsRows(db, missing);
  const resolveRow = (selection: Selection): FtsRow | undefined =>
    selection.row ?? neighbourRows.get(selection.message_id);

  const rows: Array<{ selection: Selection; row: FtsRow }> = [];
  for (const selection of selections) {
    const row = resolveRow(selection);
    // A neighbour whose index row is gone (message deleted between the timeline
    // read and this batch) contributes nothing rather than a hole.
    if (row) rows.push({ selection, row });
  }

  const resultTimes = new Map<string, number>();
  for (const { row } of rows) {
    resultTimes.set(
      row.message_id,
      candidateTimes.get(row.message_id) ?? toEpochMs(row.created_at) ?? 0,
    );
  }
  repairTimestamps(db, resultTimes);

  const results: ConversationSearchHit[] = rows.map(({ selection, row }) => {
    const session = sessionOf(row.session_id);
    return {
      message_id: row.message_id,
      session_id: row.session_id,
      session_title: sessionTitle(session),
      channel: resolveSessionChannel(session),
      role: row.role ?? 'unknown',
      created_at: resultTimes.get(row.message_id) ?? 0,
      snippet: buildSnippet(row.content_original ?? '', query ?? ''),
      score: selection.expanded ? 0 : normalizeBm25(row.rank),
      expanded: selection.expanded,
      memory_ids: [],
      knowledge_slugs: [],
    };
  });

  // Chronological, not BM25 order: a hit plus its neighbours is meant to read
  // as the consecutive exchange it was, and the model needs the order to make
  // sense of it.
  results.sort((a, b) => a.created_at - b.created_at || a.message_id.localeCompare(b.message_id));

  attachProvenance(db, results);
  return results;
}

/** `limit` clamped into [1, MAX]; a missing/garbage value means the default. */
function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_CONVERSATION_SEARCH_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_CONVERSATION_SEARCH_LIMIT);
}

function candidateLimit(limit: number): number {
  return Math.min(MAX_CANDIDATE_ROWS, Math.max(limit * CANDIDATE_MULTIPLIER, limit));
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/**
 * Epoch milliseconds, or undefined when the value cannot be read as a time.
 *
 * The legacy TEXT columns store epoch millis as a bare digit string, but a
 * numeric bind into a TEXT column is written by SQLite as a *real*
 * (`"1789639714808.0"`), which `parseEpochMs` cannot parse — it returns 0 for
 * it. This keeps `parseEpochMs` as the single definition of "a timestamp
 * string" and only adds the real form, which `Number()` reads exactly.
 */
function toEpochMs(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = parseEpochMs(value);
  if (parsed > 0) return parsed;
  const asNumber = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(asNumber) && asNumber > 0 ? asNumber : undefined;
}

/** The BM25 query form `graph-routes.ts` already uses for message search. */
function queryFts(
  db: Database.Database,
  ftsQuery: string,
  options: { sessionId?: string; limit: number },
): FtsRow[] {
  const params: Record<string, unknown> = { query: ftsQuery, limit: options.limit };
  let sql = `SELECT message_id, content_original, session_id, role, created_at,
                    bm25(messages_fts_jieba) AS rank
             FROM messages_fts_jieba
             WHERE messages_fts_jieba MATCH @query`;
  if (options.sessionId) {
    sql += ' AND session_id = @sessionId';
    params.sessionId = options.sessionId;
  }
  sql += ' ORDER BY rank LIMIT @limit';

  try {
    return db.prepare(sql).all(params) as FtsRow[];
  } catch {
    // Unparsable MATCH (or an index left over from another tokenizer setup).
    return [];
  }
}

/**
 * Restore timestamps the FTS index lost.
 *
 * `syncMessageJiebaFts` stores `String(parseEpochMs(message.created_at))`, and
 * `parseEpochMs` cannot read the form a numeric bind leaves in a TEXT column
 * (`"1789639714808.0"`): it parses `^\d+$` or ISO only and returns 0 otherwise.
 * Every message written after the v10 backfill is therefore indexed with
 * `created_at = '0'` (6 of 68 rows in the live database), while the `messages`
 * row keeps the real time. This is the one case where the module needs the row
 * behind the index — without it both the ordering and the ±1 neighbourhood are
 * wrong, which is exactly what K1 exists to get right — and it is a repair of a
 * known upstream defect, not a second source of truth: once `parseEpochMs`
 * accepts the real form, this finds nothing to do.
 */
function repairTimestamps(db: Database.Database, timestamps: Map<string, number>): void {
  const unknown = [...timestamps].filter(([, value]) => value === 0).map(([id]) => id);
  if (unknown.length === 0 || !tableExists(db, 'messages')) return;

  const rows = db
    .prepare(`SELECT id, created_at FROM messages WHERE id IN (${idPlaceholders(unknown)})`)
    .all(...unknown) as Array<{ id: string; created_at: string | number | null }>;
  for (const row of rows) {
    const repaired = toEpochMs(row.created_at);
    if (repaired !== undefined) timestamps.set(row.id, repaired);
  }
}

/** `@p0, @p1, …` — one bound parameter per id, never interpolated. */
function idPlaceholders(ids: string[]): string {
  return ids.map(() => '?').join(', ');
}

function loadSessions(
  db: Database.Database,
  ids: Array<string | null>,
): Map<string, SessionMetaRow> {
  const out = new Map<string, SessionMetaRow>();
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return out;

  const rows = db
    .prepare(
      `SELECT id, chat_id, project_id, channel, title, metadata
       FROM sessions WHERE id IN (${idPlaceholders(unique)})`,
    )
    .all(...unique) as SessionMetaRow[];
  for (const row of rows) out.set(row.id, row);
  return out;
}

/** Every indexed message of one session, in chronological order. */
function loadTimeline(db: Database.Database, sessionId: string): TimelineEntry[] {
  const rows = db
    .prepare('SELECT message_id, created_at FROM messages_fts_jieba WHERE session_id = ?')
    .all(sessionId) as Array<{ message_id: string; created_at: string | number | null }>;

  const timestamps = new Map<string, number>();
  for (const row of rows) timestamps.set(row.message_id, toEpochMs(row.created_at) ?? 0);
  repairTimestamps(db, timestamps);

  return [...timestamps]
    .map(([message_id, created_at]) => ({ message_id, created_at }))
    .sort((a, b) => a.created_at - b.created_at || a.message_id.localeCompare(b.message_id));
}

function loadFtsRows(db: Database.Database, ids: string[]): Map<string, FtsRow> {
  const out = new Map<string, FtsRow>();
  if (ids.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT message_id, content_original, session_id, role, created_at, 0 AS rank
       FROM messages_fts_jieba WHERE message_id IN (${idPlaceholders(ids)})`,
    )
    .all(...ids) as FtsRow[];
  for (const row of rows) out.set(row.message_id, row);
  return out;
}

/**
 * Session title, with the same `metadata.title` fallback the inbox uses: a
 * session created before v9 has no `title` column value, and a hit that cannot
 * say *where* it came from is only half an answer.
 */
function sessionTitle(session: SessionMetaRow): string | null {
  if (session.title) return session.title;
  if (!session.metadata) return null;
  try {
    const parsed = JSON.parse(session.metadata) as { title?: unknown };
    return typeof parsed?.title === 'string' ? parsed.title : null;
  } catch {
    return null;
  }
}

/** BM25 rank is negative and unbounded; map it into (0, 1) like `fts.ts` does. */
function normalizeBm25(rank: number): number {
  const relevance = -rank;
  return relevance > 0 ? relevance / (1 + relevance) : 0;
}

/** Flatten to one line — snippets come from Markdown/HTML-heavy chat text. */
function flatten(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A ~120-character window of `content` positioned on the match.
 *
 * The head of a long CJK message usually contains no match at all, so a
 * first-120-chars snippet reads as if it answered a different question. The
 * whole query is tried first, then its words (jieba tokens for CJK), and the
 * earliest hit wins; no hit falls back to the head.
 */
function buildSnippet(content: string, query: string): string {
  const plain = flatten(content);
  if (plain.length <= CONVERSATION_SNIPPET_MAX_CHARS) return plain;

  const needles = [query.trim(), ...query.split(/[\s,，。、;；:：!?！？]+/), ...cutCJK(query)]
    .map((needle) => needle.trim())
    .filter((needle) => needle.length >= 2);

  let matchIndex = -1;
  for (const needle of needles) {
    const index = plain.toLowerCase().indexOf(needle.toLowerCase());
    if (index >= 0 && (matchIndex < 0 || index < matchIndex)) matchIndex = index;
  }

  if (matchIndex < 0) return `${plain.slice(0, CONVERSATION_SNIPPET_MAX_CHARS)}…`;

  // Centre the window on the match, clamped to the text bounds so a match near
  // either end still yields a full-width snippet.
  const half = Math.floor(CONVERSATION_SNIPPET_MAX_CHARS / 2);
  const start = Math.max(
    0,
    Math.min(matchIndex - half, plain.length - CONVERSATION_SNIPPET_MAX_CHARS),
  );
  const slice = plain.slice(start, start + CONVERSATION_SNIPPET_MAX_CHARS).trim();
  const suffix = start + CONVERSATION_SNIPPET_MAX_CHARS < plain.length ? '…' : '';
  return `${start > 0 ? '…' : ''}${slice}${suffix}`;
}

/**
 * Attach `memory_ids` / `knowledge_slugs` to every hit.
 *
 * Both are unconditional parts of the result shape — an empty array means
 * "nothing recorded", and a caller must never have to test for the field's
 * presence. `knowledge_slugs` is empty until the knowledge layer starts citing
 * messages; making it conditional now would mean the consumer side has to be
 * written twice.
 */
function attachProvenance(db: Database.Database, hits: ConversationSearchHit[]): void {
  if (hits.length === 0) return;
  const ids = [...new Set(hits.map((hit) => hit.message_id))];
  const placeholders = idPlaceholders(ids);

  const memoryIds = new Map<string, string[]>();
  if (tableExists(db, 'memory_sources')) {
    const rows = db
      .prepare(
        `SELECT message_id, memory_id FROM memory_sources
         WHERE message_id IN (${placeholders}) ORDER BY memory_id`,
      )
      .all(...ids) as Array<{ message_id: string; memory_id: string }>;
    for (const row of rows) pushInto(memoryIds, row.message_id, row.memory_id);
  }

  const slugs = new Map<string, string[]>();
  if (tableExists(db, 'knowledge_sources') && tableExists(db, 'knowledge_pages')) {
    const rows = db
      .prepare(
        `SELECT ks.source_id AS message_id, p.slug AS slug
         FROM knowledge_sources ks
         JOIN knowledge_pages p ON p.id = ks.page_id
         WHERE ks.source_kind = 'message'
           AND ks.source_id IN (${placeholders})
           AND p.status = 'active'
         ORDER BY p.slug`,
      )
      .all(...ids) as Array<{ message_id: string; slug: string }>;
    for (const row of rows) pushInto(slugs, row.message_id, row.slug);
  }

  for (const hit of hits) {
    hit.memory_ids = memoryIds.get(hit.message_id) ?? [];
    hit.knowledge_slugs = slugs.get(hit.message_id) ?? [];
  }
}

function pushInto(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
