/**
 * Unified search (K5) — the one fusion point for the three retrieval lanes.
 *
 * Before this file existed there were three answers to "what do we know about
 * X": the WebUI ranked messages its own way (`/api/search`), the agent's tool
 * ranked them again (`conversation-search.ts` called from `session_search`),
 * and per-turn injection ranked memories by nothing at all. K5 exists because
 * two rankers inevitably disagree, and the disagreement is invisible to the
 * user — the WebUI shows one hit order, the model cites another.
 *
 * The lanes, in the order they are fused:
 *
 * | lane | source | answers |
 * |---|---|---|
 * | `message` | `conversation-search.ts` over `messages_fts_jieba` | "when did we say that" |
 * | `memory` | the hybrid retriever (`MemoryRetriever.retrieve`) | "what do I know" |
 * | `knowledge` | `KnowledgeService.search` over `knowledge_fts_jieba` | "what is written down" |
 *
 * ## Score normalisation and fusion
 *
 * The lanes' numbers are not comparable. The message lane emits BM25 mapped
 * into (0,1) with `relevance / (1 + relevance)` and `0` for a neighbourhood
 * row; the memory lane emits the hybrid retriever's fused score (reciprocal-rank
 * scale — around 0.015 for a single source — then rescaled by rerank, temporal
 * decay and pool weighting); the knowledge lane emits page-level BM25. Adding or
 * averaging them would let whichever lane's arithmetic happens to be larger win
 * every query, which is the same defect as ranking twice, one level down.
 *
 * So the merge is rank-based, using the formula `memory/rrf-merge.ts` already
 * implements (`score = Σ 1 / (rank + k)`, `k = 60`). Because the fusion keys are
 * lane-prefixed and provenance dedupe has already run, no key exists in two
 * lanes, so RRF here reduces to **equal-weight rank interleaving**: the best
 * message, the best memory and the best page share the top of the list and the
 * result decays by depth. That is the intended pre-reranker ordering — K5-2's
 * source-type feature belongs in `retrieval/reranker.ts` on top of this output,
 * not inside this function.
 *
 * Two numbers survive on each hit:
 *   - `score` — the fused RRF value; comparable inside one result set only.
 *   - `laneScore` — the lane's own score, min-max normalised over that lane's
 *     returned rows into [0,1] (a lane whose rows all share one score reports
 *     1 for each: they are equally good, not equally bad).
 *
 * `rrfMerge()` itself is not called: its `SourceResult` is a memory row
 * (`scope`/`scopeKey`/`kind`/`createdAt` plus a `source` from the memory-retrieval
 * union). Filling those fields with placeholders for a message or a page would
 * make two lanes lie about being memories, and the lie would outlive this file.
 *
 * ## Provenance dedupe (plan §6 K2-3.1, same-source rule)
 *
 * A knowledge page is curated *from* memories, so the same fact is routinely in
 * both tables. Injecting both spends the budget twice and, worse, gives two
 * answers that can disagree once one of them is stale. The rule implemented
 * here is the plan's:
 *
 * - **page wins**: when a returned page cites a memory (`knowledge_sources`
 *   with `source_kind = 'memory'`, read through `KnowledgeService.get`), that
 *   memory is dropped from the memory lane and recorded in `deduped[]`;
 * - **the reverse does not hold**: a memory hit is never promoted to a page —
 *   pages exist because something has a subject and a topic, not because a
 *   memory matched;
 * - **staleness resolves to the page**: the page is the corrected copy, which
 *   is why it is the one that survives.
 *
 * ## Decision table (plan §6 K5 — what the evaluation numbers mean)
 *
 * | Result after `pnpm eval:knowledge` vs `baseline-<date>.json` | Action |
 * |---|---|
 * | G1–G3 all reach their thresholds | merge and release (§11) |
 * | G3 reaches, G2 does not | freeze curation (`knowledge.curate.mode: off`), keep the written pages and the read-only tools — never drop the tables, the pages are data the agent wrote and people may have cited |
 * | G2 reaches, G3 does not | keep the `session_search` tool, remove the auto-injected episodic leg (it is the one that spends tokens every turn) |
 * | none reach | roll back K2/K3/K4 (keep `knowledge_pages` as a read-only archive), keep `session_search` alone, set `memory.graph.enabled: false` |
 *
 * The table lives here because this file is the only place where all three
 * lanes are visible at once: whichever lane is switched off, this module keeps
 * working with the remaining ones, and a lane that throws degrades to an empty
 * lane with its error reported rather than failing the caller. Which lanes run
 * is the caller's choice (`lanes`), so "message only" and "message +
 * knowledge" are configurations of one implementation, not three of them.
 */

import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { searchMessages } from './conversation-search.js';
import type { ConversationSearchHit } from './conversation-search.js';
import type { SessionAccessPolicy } from './session-access.js';
import type { MemoryRetriever, RetrievedMemory } from './memory-retriever.js';
import type { KnowledgeSearchHit, KnowledgeService } from './knowledge/service-contract.js';
import type { PageType } from './knowledge/types.js';

export type UnifiedSearchLane = 'message' | 'memory' | 'knowledge';

/**
 * Tie-break order, not a relevance claim: two hits at the same lane rank fuse
 * to the same score, and something has to decide. Raw text first (it answers
 * the "when did we say it" question on its own), curated page titles last (a
 * title without its body is the least self-contained of the three). Weights
 * are the reranker's job, not this array's.
 */
const LANE_ORDER: readonly UnifiedSearchLane[] = ['message', 'memory', 'knowledge'];

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
  /** Lane-native id: message id, memory id, or knowledge page id. */
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
  /** Active knowledge pages citing this message. */
  knowledgeSlugs: string[];
}

export interface UnifiedMemoryHit extends UnifiedSearchHitBase {
  lane: 'memory';
  kind: string;
  scope: string;
  /** Epoch milliseconds. */
  createdAt: number;
}

export interface UnifiedKnowledgeHit extends UnifiedSearchHitBase {
  lane: 'knowledge';
  slug: string;
  pageType: PageType;
  title: string;
  /** Memory ids this page cites — why a memory hit may have been dropped. */
  memoryIds: string[];
}

export type UnifiedSearchHit = UnifiedMessageHit | UnifiedMemoryHit | UnifiedKnowledgeHit;

/** What one lane contributed, and what it cost. */
export interface UnifiedLaneReport {
  /** Rows the lane returned after its own filtering. */
  hits: number;
  /** Rows dropped because a returned page already covers their source. */
  dropped: number;
  /** Set when the lane failed; the other lanes still answer. */
  error?: string;
}

export interface UnifiedDedupeRecord {
  lane: 'memory';
  /** The dropped memory id. */
  ref: string;
  reason: 'cited_by_knowledge_page';
  /** The page that covers it, so the drop is explainable. */
  pageSlug: string;
}

export interface UnifiedSearchResult {
  query: string;
  /** Fused, deduped, ordered best-first. */
  hits: UnifiedSearchHit[];
  /** Per-lane attribution, present for every lane whether or not it ran. */
  lanes: Record<UnifiedSearchLane, UnifiedLaneReport>;
  deduped: UnifiedDedupeRecord[];
}

export interface UnifiedSearchMessageLaneOptions {
  db: Database.Database;
  /** Session access policy. An unset field never filters (`session-access.ts`). */
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

export interface UnifiedSearchKnowledgeLaneOptions {
  /** `KnowledgeService.search` reads; `get` supplies the cited memory ids. */
  service: Pick<KnowledgeService, 'search' | 'get'>;
  pageType?: PageType;
  tag?: string;
}

export interface UnifiedSearchOptions {
  query: string;
  /**
   * Which lanes fuse — the caller's answer to "which lanes answer this
   * question", independent of which lane options it happened to supply.
   *
   * Omitted means "every lane whose options are present", which is the
   * behaviour every existing caller (the WebUI's `/api/search`) already had.
   * Supplied, it is intersected with the lanes that have options: naming a
   * lane without options for it does not fabricate one (a lane cannot be run
   * without its database handle / service), and a lane with options but not in
   * the set is not run at all — no `error`, no `hits`, exactly as if its
   * options had not been passed.
   *
   * This exists because "message + knowledge" is a real request
   * (`session_search`: raw transcript plus the curated page that settles it)
   * and it must not become a second, hand-written implementation of the
   * fusion.
   */
  lanes?: readonly UnifiedSearchLane[];
  /** Lane options, as before. Omit a lane's options to leave it out. */
  messages?: UnifiedSearchMessageLaneOptions;
  memories?: UnifiedSearchMemoryLaneOptions;
  knowledge?: UnifiedSearchKnowledgeLaneOptions;
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
   * while a supplement lane spends only a couple of slots. Equal allowances
   * would give a supplement lane half the answer purely because it returned as
   * many rows as the primary lane.
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
 * A retrieval lane is one way of answering the question, not the reason a
 * search happens: a knowledge query against a half-migrated database must not
 * take the message results down with it.
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
 * A flat lane (every row the same score — common for a single-row result) maps
 * to 1: those rows are equally good, and reporting 0 would read as "no match".
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
 * Search all three lanes and return one fused list.
 *
 * Lane order inside each lane is the lane's own relevance order, with one
 * deliberate exception: `conversation-search` returns hits **chronologically**
 * so that a hit and its neighbour read as the exchange they were, which is the
 * right order for a tool result and the wrong one for fusion — the message lane
 * is re-sorted by score (neighbours, which carry score 0, drop to the end)
 * before ranks are assigned.
 */
export async function unifiedSearch(options: UnifiedSearchOptions): Promise<UnifiedSearchResult> {
  const query = options.query?.trim() ?? '';
  const limit = clamp(options.limit ?? DEFAULT_HIT_LIMIT, 1, MAX_HIT_LIMIT);
  const perLaneLimit = clamp(options.perLaneLimit ?? DEFAULT_PER_LANE_LIMIT, 1, MAX_PER_LANE_LIMIT);

  const lanes: Record<UnifiedSearchLane, UnifiedLaneReport> = {
    message: emptyLane(),
    memory: emptyLane(),
    knowledge: emptyLane(),
  };
  const deduped: UnifiedDedupeRecord[] = [];

  if (!query) return { query, hits: [], lanes, deduped };

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
  const knowledge = wants('knowledge', options.knowledge !== undefined)
    ? options.knowledge
    : undefined;

  const [messageHits, memoryHits, knowledgeHits] = await Promise.all([
    runLane(lanes, 'message', options.logger, () =>
      messages ? collectMessageHits(query, laneLimit('message'), messages) : [],
    ),
    runLane(lanes, 'memory', options.logger, () =>
      memories ? collectMemoryHits(query, laneLimit('memory'), memories) : [],
    ),
    runLane(lanes, 'knowledge', options.logger, () =>
      knowledge ? collectKnowledgeHits(query, laneLimit('knowledge'), knowledge) : [],
    ),
  ]);

  lanes.message.hits = messageHits.length;
  lanes.memory.hits = memoryHits.length;
  lanes.knowledge.hits = knowledgeHits.length;

  // ── Provenance dedupe: page wins over the memories it was curated from ──
  const citedByPage = new Map<string, UnifiedKnowledgeHit>();
  for (const page of knowledgeHits) {
    for (const memoryId of page.memoryIds) {
      if (!citedByPage.has(memoryId)) citedByPage.set(memoryId, page);
    }
  }
  const survivingMemories = memoryHits.filter((hit) => {
    const page = citedByPage.get(hit.ref);
    if (!page) return true;
    deduped.push({
      lane: 'memory',
      ref: hit.ref,
      reason: 'cited_by_knowledge_page',
      pageSlug: page.slug,
    });
    return false;
  });
  lanes.memory.dropped = memoryHits.length - survivingMemories.length;

  const withLaneScores = <T extends UnifiedSearchHit>(rows: T[]): T[] => {
    const scores = normaliseLaneScores(rows);
    return rows.map((row, index) => ({ ...row, laneScore: scores[index] }));
  };

  const hits = fuseLanes(
    [withLaneScores(messageHits), withLaneScores(survivingMemories), withLaneScores(knowledgeHits)],
    limit,
  );

  options.logger?.debug(
    {
      query,
      limit,
      hits: hits.length,
      ran: {
        message: messages !== undefined,
        memory: memories !== undefined,
        knowledge: knowledge !== undefined,
      },
      lanes: {
        message: lanes.message.hits,
        memory: lanes.memory.hits,
        knowledge: lanes.knowledge.hits,
      },
      deduped: deduped.length,
    },
    'unified search fused',
  );

  return { query, hits, lanes, deduped };
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
    knowledgeSlugs: hit.knowledge_slugs,
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
  }));
}

function collectKnowledgeHits(
  query: string,
  limit: number,
  options: UnifiedSearchKnowledgeLaneOptions,
): UnifiedKnowledgeHit[] {
  const found = options.service.search(query, {
    limit,
    pageType: options.pageType,
    tag: options.tag,
  });

  return found.map((hit: KnowledgeSearchHit) => ({
    lane: 'knowledge' as const,
    key: laneKey('knowledge', hit.id),
    ref: hit.id,
    score: hit.score,
    laneRank: 0,
    laneScore: 0,
    snippet: hit.snippet,
    slug: hit.slug,
    pageType: hit.pageType,
    title: hit.title,
    memoryIds: citedMemoryIds(options.service, hit.id),
  }));
}

/**
 * The memories a page cites, for the same-source rule.
 *
 * `get` is the contract's only source-reading accessor, and a page whose
 * detail cannot be read still belongs in the result — losing the citations
 * only means the dedupe cannot fire, which is strictly better than dropping
 * the page.
 */
function citedMemoryIds(service: Pick<KnowledgeService, 'get'>, pageId: string): string[] {
  try {
    const detail = service.get({ id: pageId });
    if (!detail) return [];
    return detail.sources
      .filter((source) => source.source_kind === 'memory')
      .map((s) => s.source_id);
  } catch {
    return [];
  }
}
