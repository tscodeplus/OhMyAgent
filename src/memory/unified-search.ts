/**
 * Unified search — the one fusion point for the retrieval lanes.
 *
 * Before this file existed there were two answers to "what do we know about X":
 * the WebUI ranked messages its own way (`/api/search`), and the agent's tool
 * ranked them again (`session_search` called `conversation-search.ts`). One
 * fusion point exists because two rankers inevitably disagree, and the
 * disagreement is invisible to the user — the WebUI shows one hit order and the
 * model cites another.
 *
 * The lanes, in the order they are fused:
 *
 * | lane | source | answers |
 * |---|---|---|
 * | `message` | `conversation-search.ts` over `messages_fts_jieba` | "when did we say that" |
 * | `memory` | the hybrid retriever (`MemoryRetriever.retrieve`) | "what do I know" |
 *
 * ## Score normalisation and fusion
 *
 * The lanes' numbers are not comparable. The message lane emits BM25 mapped into
 * (0,1) with `relevance / (1 + relevance)` and `0` for a neighbourhood row; the
 * memory lane emits the hybrid retriever's fused score (reciprocal-rank scale —
 * around 0.015 for a single source — then rescaled by rerank, temporal decay and
 * pool weighting). Adding or averaging them would let whichever lane's arithmetic
 * happens to be larger win every query, which is the same defect as ranking
 * twice, one level down.
 *
 * So the merge is rank-based, using the formula `memory/rrf-merge.ts` already
 * implements (`score = Σ 1 / (rank + k)`, `k = 60`). Because the fusion keys are
 * lane-prefixed and no key exists in two lanes, RRF here reduces to **equal-weight
 * rank interleaving**: the best message and the best memory share the top of the
 * list and the result decays by depth. That is the intended pre-reranker
 * ordering — a source-type feature belongs in `retrieval/reranker.ts` on top of
 * this output, not inside this function.
 *
 * Two numbers survive on each hit:
 *   - `score` — the fused RRF value; comparable inside one result set only.
 *   - `laneScore` — the lane's own score, min-max normalised over that lane's
 *     returned rows into [0,1] (a lane whose rows all share one score reports 1
 *     for each: they are equally good, not equally bad).
 *
 * `rrfMerge()` itself is not called: its `SourceResult` is a memory row
 * (`scope`/`scopeKey`/`kind`/`createdAt` plus a `source` from the memory-retrieval
 * union). Filling those fields with placeholders for a message would make a lane
 * lie about being a memory, and the lie would outlive this file.
 *
 * A lane that throws degrades to an empty lane with its error reported rather
 * than failing the caller, and which lanes run is the caller's choice (`lanes`),
 * so "message only" and "message + memory" are configurations of one
 * implementation, not two of them.
 */

import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { searchMessages } from './conversation-search.js';
import type { ConversationSearchHit } from './conversation-search.js';
import type { SessionAccessPolicy } from './session-access.js';
import type { MemoryRetriever, RetrievedMemory } from './memory-retriever.js';

export type UnifiedSearchLane = 'message' | 'memory';

/**
 * Tie-break order, not a relevance claim: two hits at the same lane rank fuse to
 * the same score, and something has to decide. Raw text first — it answers the
 * "when did we say it" question on its own.
 */
const LANE_ORDER: readonly UnifiedSearchLane[] = ['message', 'memory'];

const DEFAULT_HIT_LIMIT = 10;
const MAX_HIT_LIMIT = 50;
const DEFAULT_PER_LANE_LIMIT = 8;
const MAX_PER_LANE_LIMIT = 50;
/** RRF smoothing — the same `k` `rrfMerge()` defaults to. */
const RRF_K = 60;

interface UnifiedSearchHitBase {
  lane: UnifiedSearchLane;
  /** `<lane>:<native id>` — unique across lanes, and the fusion key. */
  key: string;
  /** Lane-native id: message id or memory id. */
  ref: string;
  /** Fused RRF score. Comparable within one result set, nowhere else. */
  score: number;
  /** Position within its own lane; 1 = the lane's best. */
  laneRank: number;
  /** The lane's own score, min-max normalised over the lane into [0,1]. */
  laneScore: number;
  /** One-line excerpt, safe to render. */
  snippet: string;
}

export interface UnifiedMessageHit extends UnifiedSearchHitBase {
  lane: 'message';
  sessionId: string;
  /** Session title, else the `metadata.title` mirror, else null. */
  sessionTitle: string | null;
  channel: string;
  role: string;
  /** Epoch milliseconds. */
  createdAt: number;
  /** True for a ±1 neighbour added so a hit is not quoted alone. */
  expanded: boolean;
  /** `memory_sources` for this message. */
  memoryIds: string[];
}

export interface UnifiedMemoryHit extends UnifiedSearchHitBase {
  lane: 'memory';
  kind: string;
  scope: string;
  /** Epoch milliseconds. */
  createdAt: number;
  /**
   * Epoch milliseconds of the last write. Optional because a lane that cannot
   * measure it (a test double) must not be forced to lie.
   */
  updatedAt?: number;
}

export type UnifiedSearchHit = UnifiedMessageHit | UnifiedMemoryHit;

/** What one lane contributed, and what it cost. */
export interface UnifiedLaneReport {
  /** Rows the lane returned after its own filtering. */
  hits: number;
  /** Rows the lane dropped for its own reasons (kept for payload stability). */
  dropped: number;
  /** Set when the lane failed; the other lanes still answer. */
  error?: string;
}

export interface UnifiedSearchResult {
  query: string;
  /** Fused and ordered best-first. */
  hits: UnifiedSearchHit[];
  /** Per-lane attribution, present for every lane whether or not it ran. */
  lanes: Record<UnifiedSearchLane, UnifiedLaneReport>;
}

export interface UnifiedSearchMessageLaneOptions {
  db: Database.Database;
  /** Session access policy. An unset field never filters (`session-access.js`). */
  policy?: SessionAccessPolicy;
  sessionId?: string;
  channel?: string;
  since?: number | string;
  until?: number | string;
}

export interface UnifiedSearchMemoryLaneOptions {
  retriever: Pick<MemoryRetriever, 'retrieve'>;
  agentId?: string;
  scope?: string;
  scopeKey?: string;
  /** Keep the lane off the embedding API (no key configured, or a hot path). */
  textOnly?: boolean;
}

export interface UnifiedSearchOptions {
  query: string;
  /**
   * Which lanes fuse — the caller's answer to "which lanes answer this
   * question", independent of which lane options it happened to supply.
   *
   * Omitted means "every lane whose options are present". Supplied, it is
   * intersected with the lanes that have options: naming a lane without options
   * for it does not fabricate one (a lane cannot be run without its database
   * handle / retriever), and a lane with options but not in the set is not run
   * at all — no `error`, no `hits`, exactly as if its options had not been
   * passed. This exists because "messages only" is a real request and it must not
   * become a second, hand-written implementation of the fusion.
   */
  lanes?: readonly UnifiedSearchLane[];
  /** Lane options, as before. Omit a lane's options to leave it out. */
  messages?: UnifiedSearchMessageLaneOptions;
  memories?: UnifiedSearchMemoryLaneOptions;
  /** Final number of hits (default 10, clamped to [1, 50]). */
  limit?: number;
  /** Rows fetched per lane before fusion (default 8, clamped to [1, 50]). */
  perLaneLimit?: number;
  /**
   * Per-lane allowance, overriding `perLaneLimit` for the lanes it names and
   * clamped the same way (default: `perLaneLimit`).
   *
   * Needed because the lanes are not equal partners everywhere: `limit` is one
   * budget, and a caller may want the message lane to keep its full allowance
   * while a supplement lane spends only a couple of slots.
   */
  perLaneLimits?: Partial<Record<UnifiedSearchLane, number>>;
  logger?: Pick<Logger, 'debug' | 'warn'>;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function emptyLane(): UnifiedLaneReport {
  return { hits: 0, dropped: 0 };
}

function laneKey(lane: UnifiedSearchLane, ref: string): string {
  return `${lane}:${ref}`;
}

/**
 * Run one lane, converting a failure into an empty lane plus a recorded error.
 *
 * A retrieval lane is one way of answering the question, not the reason a search
 * happens: a memory query against a half-migrated database must not take the
 * message results down with it.
 */
async function runLane<T>(
  reports: Record<UnifiedSearchLane, UnifiedLaneReport>,
  lane: UnifiedSearchLane,
  logger: Pick<Logger, 'debug' | 'warn'> | undefined,
  collect: () => T[] | Promise<T[]>,
): Promise<T[]> {
  try {
    return await collect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reports[lane].error = message;
    logger?.warn({ lane, err: message }, 'unified search lane failed — continuing without it');
    return [];
  }
}

/**
 * Normalise a lane's scores into [0,1] with min-max, keeping input order.
 *
 * A flat lane (every row the same score — common for a single-row result) maps to
 * 1: those rows are equally good, and reporting 0 would read as "no match".
 */
function normaliseLaneScores<T extends { score: number }>(rows: T[]): number[] {
  if (rows.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    if (row.score < min) min = row.score;
    if (row.score > max) max = row.score;
  }
  const span = max - min;
  return rows.map((row) => (span === 0 ? 1 : (row.score - min) / span));
}

/** Fuse the per-lane lists into one ordered list. */
function fuseLanes(lists: UnifiedSearchHit[][], limit: number): UnifiedSearchHit[] {
  const fused: UnifiedSearchHit[] = [];
  for (const list of lists) {
    for (let index = 0; index < list.length; index++) {
      fused.push({ ...list[index], laneRank: index + 1, score: 1 / (index + 1 + RRF_K) });
    }
  }

  fused.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.laneRank !== b.laneRank) return a.laneRank - b.laneRank;
    const laneDelta = LANE_ORDER.indexOf(a.lane) - LANE_ORDER.indexOf(b.lane);
    if (laneDelta !== 0) return laneDelta;
    return a.key.localeCompare(b.key);
  });

  return fused.slice(0, limit);
}

/**
 * Search every requested lane and return one fused list.
 *
 * Lane order inside each lane is the lane's own relevance order, with one
 * deliberate exception: `conversation-search` returns hits **chronologically** so
 * that a hit and its neighbour read as the exchange they were, which is the right
 * order for a tool result and the wrong one for fusion — the message lane is
 * re-sorted by score (neighbours, which carry score 0, drop to the end) before
 * ranks are assigned.
 */
export async function unifiedSearch(options: UnifiedSearchOptions): Promise<UnifiedSearchResult> {
  const query = options.query?.trim() ?? '';
  const limit = clamp(options.limit ?? DEFAULT_HIT_LIMIT, 1, MAX_HIT_LIMIT);
  const perLaneLimit = clamp(options.perLaneLimit ?? DEFAULT_PER_LANE_LIMIT, 1, MAX_PER_LANE_LIMIT);

  const lanes: Record<UnifiedSearchLane, UnifiedLaneReport> = {
    message: emptyLane(),
    memory: emptyLane(),
  };

  if (!query) return { query, hits: [], lanes };

  const laneLimit = (lane: UnifiedSearchLane): number =>
    clamp(options.perLaneLimits?.[lane] ?? perLaneLimit, 1, MAX_PER_LANE_LIMIT);

  // A lane runs only when it has both an entry in the requested set (when there
  // is one) and the options to run it. A lane left out this way reports
  // `{ hits: 0, dropped: 0 }` like every other lane — not an error, because it
  // did not fail.
  const requested = options.lanes ? new Set(options.lanes) : null;
  const wants = (lane: UnifiedSearchLane, configured: boolean): boolean =>
    configured && (requested === null || requested.has(lane));

  const messages = wants('message', options.messages !== undefined) ? options.messages : undefined;
  const memories = wants('memory', options.memories !== undefined) ? options.memories : undefined;

  const [messageHits, memoryHits] = await Promise.all([
    runLane(lanes, 'message', options.logger, () =>
      messages ? collectMessageHits(query, laneLimit('message'), messages) : [],
    ),
    runLane(lanes, 'memory', options.logger, () =>
      memories ? collectMemoryHits(query, laneLimit('memory'), memories) : [],
    ),
  ]);

  lanes.message.hits = messageHits.length;
  lanes.memory.hits = memoryHits.length;

  const withLaneScores = <T extends UnifiedSearchHit>(rows: T[]): T[] => {
    const scores = normaliseLaneScores(rows);
    return rows.map((row, index) => ({ ...row, laneScore: scores[index] }));
  };

  const hits = fuseLanes([withLaneScores(messageHits), withLaneScores(memoryHits)], limit);

  options.logger?.debug(
    {
      query,
      limit,
      hits: hits.length,
      ran: { message: messages !== undefined, memory: memories !== undefined },
      lanes: { message: lanes.message.hits, memory: lanes.memory.hits },
    },
    'unified search fused',
  );

  return { query, hits, lanes };
}

function collectMessageHits(
  query: string,
  limit: number,
  options: UnifiedSearchMessageLaneOptions,
): UnifiedMessageHit[] {
  const found = searchMessages({
    db: options.db,
    query,
    sessionId: options.sessionId,
    channel: options.channel,
    since: options.since,
    until: options.until,
    limit,
    policy: options.policy,
  });

  const ranked = [...found].sort(
    (a, b) =>
      b.score - a.score || b.created_at - a.created_at || a.message_id.localeCompare(b.message_id),
  );

  return ranked.map((hit: ConversationSearchHit) => ({
    lane: 'message' as const,
    key: laneKey('message', hit.message_id),
    ref: hit.message_id,
    score: hit.score,
    laneRank: 0,
    laneScore: 0,
    snippet: hit.snippet,
    sessionId: hit.session_id,
    sessionTitle: hit.session_title,
    channel: hit.channel,
    role: hit.role,
    createdAt: hit.created_at,
    expanded: hit.expanded,
    memoryIds: hit.memory_ids,
  }));
}

async function collectMemoryHits(
  query: string,
  limit: number,
  options: UnifiedSearchMemoryLaneOptions,
): Promise<UnifiedMemoryHit[]> {
  const found = await options.retriever.retrieve({
    query,
    topK: limit,
    agentId: options.agentId,
    scope: options.scope,
    scopeKey: options.scopeKey,
    textOnly: options.textOnly,
  });

  const ranked = [...found].sort((a, b) => b.score - a.score);

  return ranked.map((memory: RetrievedMemory) => ({
    lane: 'memory' as const,
    key: laneKey('memory', memory.id),
    ref: memory.id,
    score: memory.score,
    laneRank: 0,
    laneScore: 0,
    // Memory content is already the excerpt; the block consumers truncate.
    snippet: memory.content,
    kind: memory.kind,
    scope: memory.scope,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  }));
}
