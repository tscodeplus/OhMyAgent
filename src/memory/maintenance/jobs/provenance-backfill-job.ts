/**
 * `provenance_backfill` — gives a historical memory a source message when its
 * own text proves one, and never guesses.
 *
 * ## The hole this fills
 *
 * `memory_sources.source` has three documented values (`migration-v13.ts`):
 * `pipeline` (pass-through at write time, `memory-writer.ts`), `backfill`
 * (matched by content) and `manual` (an operator/tool). The `backfill` value
 * had no producer: on the real device database `memories.source_message_id` is
 * 0/712 and no `metadata` field carries a message id, so the provenance chain
 * covers only memories written after K1 shipped. "命中记忆 → 回到原话" is the
 * point of the layer, and for all existing data it was not true. This job is
 * the `backfill` producer.
 *
 * ## Precision over coverage
 *
 * A wrong provenance edge is worse than a missing one — the whole point is
 * answering "where did this come from", so a plausible-looking but false
 * source makes the answer wrong instead of absent. The evidence rule is
 * therefore narrow:
 *
 * 1. Probes come from the memory's own text, strongest tier first
 *    ({@link deriveProbes}): verbatim spans (quotes, URLs, paths), then
 *    code-shaped identifiers (`excel-mcp`, `Node22`, `v2.1.3`, long digit
 *    runs), then capitalised Latin names (`Termux`, `Sheet`). Generic CJK and
 *    English function words are not probes: they match everything.
 * 2. The strongest probe that matches anything decides. A match is a message
 *    whose raw text still contains the probe **literally** — `messages_fts_jieba`
 *    is only the candidate index, and its `unicode61` tokenisation happily
 *    returns `ABC`/`123` hits for `ABC-123`, so the literal check on the stored
 *    `content_original` is what makes the edge true.
 * 3. The match must be unique — one message — or all matches must sit in one
 *    session and be consecutive (a summary is compressed out of a contiguous
 *    stretch of dialogue). Anything else is `ambiguousRejected` and no row is
 *    written.
 * 4. Only `user` / `assistant` rows count; a `system` or `tool` row is not
 *    something the user said.
 *
 * ## Cost and coverage
 *
 * Heavy on a phone (one FTS `MATCH` per probe, up to three tiers per memory),
 * so it is bounded: `max_memories_per_run` candidates per run, a six-hour
 * interval, and a candidate query that returns nothing once every memory has a
 * source.
 *
 * ## The window rotates, because rejections are permanent
 *
 * A rejection is not a retry-later: the text either attests a message or it does
 * not, and `NOT EXISTS (memory_sources)` only excludes memories that got a row.
 * So a plain `ORDER BY created_at LIMIT n` window would sit on the same oldest n
 * rejected memories on every run and never reach memory n+1 — on the real device
 * database that is a backlog which provably never drains. Measured on a copy of
 * it: of 19 eligible memories 3 are sourceable, 7 are ambiguous and 9 have no
 * evidence, so most of the queue stays queued.
 *
 * The window is therefore an index into the candidate list:
 *
 *     pages  = max(1, ceil(candidateTotal / max_memories_per_run))
 *     window = finished real runs of this job (mod pages)
 *     offset = window * max_memories_per_run
 *
 * The run count comes from `maintenance_runs` (`job_name =
 * 'provenance_backfill'`, `dry_run = 0`, `status` in success/failed), so the same
 * database state plus the same number of finished runs always probes the same
 * window — no randomness and no new schema. An open run is excluded by its
 * `running` status and a dry run by `dry_run = 1`, which is what keeps a dry run
 * from moving the window for everyone else: it reports what the next real run
 * would probe.
 *
 * Two honest approximations, neither of which breaks the property that matters
 * (an unsourced memory is not starved forever):
 *
 * - `maintenance_runs` is pruned after 90 days (`maintenance_history_prune`), so
 *   after that the count drops and the window wraps to an arbitrary but
 *   deterministic point. Every memory is still probed within roughly
 *   `candidateTotal / max_memories_per_run` runs.
 * - The page count is computed from the candidate total at the start of a run, so
 *   as rows are written (a sourced memory leaves the list) the later windows are
 *   shifted against the original list. Rotation is about coverage, not about a
 *   stable partition.
 *
 * Memories inside a window are taken **oldest first**: the gap is historical, and
 * a memory written after K1 already carries a `pipeline` source, hence is not a
 * candidate at all.
 *
 * ## What it writes
 *
 * One `memory_sources` row per attested message plus
 * `memories.source_message_id` (the primary-source convenience column), in one
 * transaction per memory — the shape `memory-writer.ts` writes, so a reader
 * cannot tell a backfilled edge from a pipeline one except by `source`, which
 * is the point. `updated_at` is deliberately untouched: provenance is not a
 * content change, and bumping it would reorder every memory list.
 */

import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { MaintenanceJob, MaintenanceJobResult } from '../maintenance-job.js';
import { tokenizeForIndex } from '../../fts-tokenizer.js';
import { createLogger } from '../../../app/logger.js';

export const PROVENANCE_BACKFILL_JOB_NAME = 'provenance_backfill';

/**
 * Six hours. The backlog is finite (`max_memories_per_run` of it per run) and
 * the steady state is one cheap query, so the interval itself is the politeness
 * knob, not a scheduling decision anyone has to revisit.
 */
export const PROVENANCE_BACKFILL_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Memories scanned per run. Mirrors the suggested `memory.provenance_backfill` default. */
const DEFAULT_MAX_MEMORIES_PER_RUN = 20;

/**
 * More matching messages than this is not a stretch of dialogue a memory was
 * compressed out of — it is a common token. Counted as ambiguous.
 */
const MAX_MESSAGE_HITS = 10;

/** Below this a memory has nothing to probe with; the probe tiers filter further. */
const MIN_MEMORY_CONTENT_CHARS = 8;

/** Shortest probe worth an FTS query. */
const MIN_PROBE_CHARS = 4;

/** Memory kinds that hold bookkeeping rather than conversation. */
const EXCLUDED_MEMORY_KINDS = `'persona', 'scene', 'hygiene_checkpoint'`;

/** `memory.provenance_backfill` — the block `src/app/config.ts` validates. */
export interface ProvenanceBackfillJobConfig {
  /** Off switch. `false` makes every run report `skipped` and write nothing. */
  enabled: boolean;
  /** Hard cap on memories scanned per run. */
  max_memories_per_run: number;
}

/**
 * Defaults mirror the zod schema in `src/app/config.ts`; repeated here so a
 * hand-built job (tests, a caller that bypasses `loadConfig`) is as
 * conservative as a configured one.
 */
export const DEFAULT_PROVENANCE_BACKFILL_CONFIG: ProvenanceBackfillJobConfig = {
  enabled: true,
  max_memories_per_run: DEFAULT_MAX_MEMORIES_PER_RUN,
};

export interface ProvenanceBackfillJobOptions {
  config?: ProvenanceBackfillJobConfig;
  logger?: Logger;
  intervalMs?: number;
}

/**
 * Probe strength, strongest first. A probe is evidence in proportion to how
 * unlikely its text is to appear in another message by accident.
 */
type ProbeTier = 'verbatim' | 'identifier' | 'name';

const PROBE_TIER_ORDER: readonly ProbeTier[] = ['verbatim', 'identifier', 'name'];

export interface Probe {
  /** The literal text verified against the message body. */
  text: string;
  tier: ProbeTier;
}

/**
 * English words that reach the `name` tier only because they start a sentence.
 * A memory begins "User prefers concise replies" far more often than it names a
 * proper noun called `User`, and sourcing a memory on that alone is exactly the
 * false edge this job exists not to write.
 */
const COMMON_ENGLISH_WORDS = new Set([
  'about',
  'after',
  'again',
  'against',
  'answer',
  'answers',
  'assistant',
  'before',
  'being',
  'between',
  'both',
  'cannot',
  'change',
  'changes',
  'could',
  'data',
  'does',
  'done',
  'during',
  'each',
  'even',
  'every',
  'files',
  'first',
  'from',
  'have',
  'here',
  'info',
  'input',
  'into',
  'just',
  'keep',
  'know',
  'last',
  'like',
  'make',
  'many',
  'memories',
  'memory',
  'more',
  'most',
  'much',
  'must',
  'next',
  'note',
  'notes',
  'only',
  'other',
  'output',
  'please',
  'project',
  'projects',
  'question',
  'questions',
  'replies',
  'reply',
  'result',
  'results',
  'same',
  'should',
  'some',
  'such',
  'summary',
  'system',
  'than',
  'thank',
  'thanks',
  'that',
  'their',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'time',
  'today',
  'under',
  'user',
  'users',
  'very',
  'well',
  'what',
  'when',
  'which',
  'while',
  'will',
  'with',
  'would',
  'your',
]);

const URL_RE = /\bhttps?:\/\/[^\s"'<>，。；、）】]+/gu;
const WINDOWS_PATH_RE = /[A-Za-z]:\\[^\s"'<>，。；、）】]+/gu;
const UNIX_PATH_RE = /(?:^|[\s"'（(])(\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)/gu;
const QUOTED_RE = /["“”'‘’「」『』]([^"“”'‘’「」『』\n]{4,60})["“”'‘’「」『』]/gu;
const LATIN_TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9._/@#+-]*/gu;
/** `\b` matters: without it `SQLite` yields a `Lite` probe, which matches any message. */
const PROPER_NOUN_RE = /\b[A-Z][a-z]{3,}\b/gu;
/** Trailing punctuation is part of the sentence, not part of the identifier. */
const PROBE_TRAILING_RE = /[.,;:!?、，。；：）)\]】"'“”‘’]+$/u;

function tierRank(tier: ProbeTier): number {
  return PROBE_TIER_ORDER.indexOf(tier);
}

/**
 * A code-shaped token: a digit, a separator, an interior capital or an
 * all-caps run. `Termux` alone is not one of those — it is a `name`.
 */
function isDistinctiveIdentifier(token: string): boolean {
  if (token.length < MIN_PROBE_CHARS) return false;
  if (!/[A-Za-z]/.test(token)) return /^\d{6,}$/.test(token);
  return /[\d._/@#+-]/.test(token) || /[a-z][A-Z]/.test(token) || /^[A-Z][A-Z0-9]{2,}$/.test(token);
}

function isProperNounish(token: string): boolean {
  if (!/^[A-Z][a-z]{3,}$/.test(token)) return false;
  return !COMMON_ENGLISH_WORDS.has(token.toLowerCase());
}

/**
 * The probes a memory's own text offers, strongest tier first and longest
 * first within a tier (a longer identifier is the more distinctive one).
 *
 * Pure and exported so the thresholds are pinnable without building a database.
 */
export function deriveProbes(content: string): Probe[] {
  const byText = new Map<string, Probe>();
  const addIf = (raw: string, tier: ProbeTier, predicate?: (text: string) => boolean): void => {
    // Strip first, then judge: `words.` must be judged as `words`, or the full
    // stop in the sentence reads as an identifier separator.
    const text = raw.replace(PROBE_TRAILING_RE, '').trim();
    if (text.length < MIN_PROBE_CHARS) return;
    if (predicate && !predicate(text)) return;
    const key = text.toLowerCase();
    const existing = byText.get(key);
    if (existing && tierRank(existing.tier) <= tierRank(tier)) return;
    byText.set(key, { text, tier });
  };

  for (const match of content.matchAll(URL_RE)) addIf(match[0], 'verbatim');
  for (const match of content.matchAll(WINDOWS_PATH_RE)) addIf(match[0], 'verbatim');
  for (const match of content.matchAll(UNIX_PATH_RE)) addIf(match[1], 'verbatim');
  for (const match of content.matchAll(QUOTED_RE)) addIf(match[1], 'verbatim');
  for (const match of content.matchAll(LATIN_TOKEN_RE)) {
    addIf(match[0], 'identifier', isDistinctiveIdentifier);
  }
  for (const match of content.matchAll(PROPER_NOUN_RE)) {
    addIf(match[0], 'name', isProperNounish);
  }

  return [...byText.values()].sort(
    (a, b) =>
      tierRank(a.tier) - tierRank(b.tier) ||
      b.text.length - a.text.length ||
      a.text.localeCompare(b.text),
  );
}

/**
 * FTS5 `MATCH` expression for one probe, or `null` when the probe yields no
 * searchable token.
 *
 * The tokens come from `tokenizeForIndex` — the same function that wrote
 * `messages_fts_jieba.content` — so a CJK phrase becomes the segment sequence
 * the index actually holds. Without that, a single quoted Chinese phrase would
 * be one `unicode61` token and match nothing.
 */
function ftsQueryFor(probe: string): string | null {
  const tokens = tokenizeForIndex(probe)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => /[\p{L}\p{N}]/u.test(token));
  if (tokens.length === 0) return null;
  const unique = [...new Set(tokens)].slice(0, 8);
  return unique.map((token) => `"${token.replaceAll('"', '')}"`).join(' AND ');
}

interface CandidateRow {
  id: string;
  content: string;
}

/** One indexed message that matched a probe and passed the literal check. */
interface FtsHit {
  messageId: string;
}

/** A hit confirmed against `messages` — the table `memory_sources` points into. */
interface AttestedMessage {
  messageId: string;
  sessionId: string;
  role: string;
  createdAt: number;
}

type Decision =
  | { kind: 'matched'; messages: AttestedMessage[] }
  | { kind: 'ambiguous' }
  | { kind: 'no_evidence' };

const CANDIDATE_WHERE = `
    m.status = 'active'
    AND m.kind NOT IN (${EXCLUDED_MEMORY_KINDS})
    AND m.source_message_id IS NULL
    AND length(trim(m.content)) >= @minChars
    AND NOT EXISTS (SELECT 1 FROM memory_sources ms WHERE ms.memory_id = m.id)
`;

/** One window of the rotating candidate list — see the header for the formula. */
const CANDIDATE_SQL = `
  SELECT m.id, m.content
  FROM memories m
  WHERE ${CANDIDATE_WHERE}
  ORDER BY CAST(m.created_at AS INTEGER) ASC, m.id ASC
  LIMIT @limit OFFSET @offset
`;

/** The same predicate without a window: the denominator of the rotation. */
const CANDIDATE_TOTAL_SQL = `SELECT COUNT(*) AS n FROM memories m WHERE ${CANDIDATE_WHERE}`;

/**
 * Finished real runs of this job. An open run is `running` and a dry run has
 * `dry_run = 1`, so neither advances the window.
 */
const COMPLETED_RUNS_SQL = `
  SELECT COUNT(*) AS n FROM maintenance_runs
  WHERE job_name = @jobName AND dry_run = 0 AND status IN ('success', 'failed')
`;

/**
 * Candidate retrieval only: the raw text is verified in JS. `role` is filtered
 * here because a `tool` row is never provenance, and dropping it in SQL saves
 * the literal check on the largest category of stored messages.
 */
const HIT_SQL = `
  SELECT message_id, content_original
  FROM messages_fts_jieba
  WHERE messages_fts_jieba MATCH @query
    AND role IN ('user', 'assistant')
  ORDER BY CAST(created_at AS INTEGER) ASC, message_id ASC
  LIMIT @limit
`;

export function createProvenanceBackfillJob(
  db: Database.Database,
  options: ProvenanceBackfillJobOptions = {},
): MaintenanceJob {
  const config = options.config ?? DEFAULT_PROVENANCE_BACKFILL_CONFIG;
  const logger = options.logger ?? createLogger();
  const maxMemories = Math.max(0, Math.floor(config.max_memories_per_run));

  /** `messages_fts_jieba` is created by migration-v10; a fixture may not have it. */
  let ftsAvailable = true;
  let hitStmt: ReturnType<Database.Database['prepare']> | null = null;

  const candidateStmt = db.prepare(CANDIDATE_SQL);
  const candidateTotalStmt = db.prepare(CANDIDATE_TOTAL_SQL);
  const completedRunsStmt = db.prepare(COMPLETED_RUNS_SQL);
  // `CAST(... AS INTEGER)` rather than `parseEpochMs`: a bound JS number lands in
  // this TEXT column as `1789639714808.0` (better-sqlite3 binds numbers as REAL),
  // which `parseEpochMs` rejects as a bare digit string and turns into 0 — real
  // rows would all look simultaneous. CAST reads both shapes.
  const messageStmt = db.prepare(
    'SELECT id, session_id, role, CAST(created_at AS INTEGER) AS created_at_ms FROM messages WHERE id = ?',
  );
  const betweenStmt = db.prepare(
    `SELECT 1 AS found FROM messages
     WHERE session_id = @sessionId
       AND CAST(created_at AS INTEGER) > @after
       AND CAST(created_at AS INTEGER) < @before
     LIMIT 1`,
  );
  const insertSourceStmt = db.prepare(
    `INSERT OR IGNORE INTO memory_sources (memory_id, message_id, session_id, role, source, created_at)
     VALUES (@memoryId, @messageId, @sessionId, @role, 'backfill', @now)`,
  );
  const setPrimarySourceStmt = db.prepare(
    `UPDATE memories SET source_message_id = @messageId
     WHERE id = @memoryId AND source_message_id IS NULL`,
  );

  /**
   * One transaction per memory: rows and the convenience column move together.
   *
   * Built lazily rather than at construction: the job is instantiated during
   * bootstrap, and bootstrap's tests pass a stub database that answers
   * `prepare()` but has no `transaction()`. Preparing statements eagerly is
   * harmless there; wrapping in a transaction is not, and a job that cannot be
   * constructed with a stub cannot be exercised by the bootstrap path at all.
   */
  let writeProvenanceTxn: ((memoryId: string, messages: AttestedMessage[]) => number) | null = null;

  function writeProvenance(memoryId: string, messages: AttestedMessage[]): number {
    if (!writeProvenanceTxn) {
      writeProvenanceTxn = db.transaction((id: string, msgs: AttestedMessage[]): number => {
        const now = Date.now();
        let written = 0;
        for (const message of msgs) {
          written += insertSourceStmt.run({
            memoryId: id,
            messageId: message.messageId,
            sessionId: message.sessionId,
            role: message.role,
            now,
          }).changes;
        }
        setPrimarySourceStmt.run({ memoryId: id, messageId: msgs[0].messageId });
        return written;
      });
    }
    return writeProvenanceTxn(memoryId, messages);
  }

  /** Prepared on first use, so a database without the index degrades instead of throwing. */
  function hitStatement(): ReturnType<Database.Database['prepare']> | null {
    if (!ftsAvailable) return null;
    if (hitStmt) return hitStmt;
    try {
      hitStmt = db.prepare(HIT_SQL);
    } catch (err) {
      ftsAvailable = false;
      logger.debug(
        { err: err instanceof Error ? err.message : String(err) },
        '[provenance_backfill] messages_fts_jieba unavailable',
      );
      return null;
    }
    return hitStmt;
  }

  function searchProbe(probe: Probe): FtsHit[] {
    const stmt = hitStatement();
    if (!stmt) return [];
    const query = ftsQueryFor(probe.text);
    if (!query) return [];
    const needle = probe.text.toLowerCase();
    let rows: Array<{ message_id: string; content_original: string }>;
    try {
      rows = stmt.all({ query, limit: MAX_MESSAGE_HITS + 1 }) as Array<{
        message_id: string;
        content_original: string;
      }>;
    } catch (err) {
      // An FTS5 syntax error on one probe is not a reason to fail the run: this
      // probe simply offers no evidence.
      logger.debug(
        { probe: probe.text, err: err instanceof Error ? err.message : String(err) },
        '[provenance_backfill] FTS query failed',
      );
      return [];
    }
    return rows
      .filter((row) =>
        String(row.content_original ?? '')
          .toLowerCase()
          .includes(needle),
      )
      .map((row) => ({ messageId: row.message_id }));
  }

  /**
   * Confirm hits against `messages` — the table `memory_sources` points into —
   * so a stale index row cannot become a provenance edge, and read `role` /
   * `session_id` from there rather than from the index, exactly as
   * `memory-writer.ts` does.
   */
  function attest(hits: FtsHit[]): AttestedMessage[] {
    const attested: AttestedMessage[] = [];
    for (const hit of hits) {
      const row = messageStmt.get(hit.messageId) as
        { id: string; session_id: string; role: string; created_at_ms: number } | undefined;
      if (!row) continue;
      if (row.role !== 'user' && row.role !== 'assistant') continue;
      const createdAt = Number(row.created_at_ms);
      if (!Number.isFinite(createdAt)) continue;
      attested.push({
        messageId: row.id,
        sessionId: row.session_id,
        role: row.role,
        createdAt,
      });
    }
    // Chronological, because adjacency is the next check and `messages_fts_jieba`
    // cannot order anything: its `created_at` is written from `parseEpochMs`,
    // which reads a real `…808.0` row as 0 — every indexed message claims epoch 0.
    return attested.sort(
      (a, b) => a.createdAt - b.createdAt || a.messageId.localeCompare(b.messageId),
    );
  }

  /** Nothing may sit between two hits for them to count as one stretch of dialogue. */
  function isOneStretch(messages: AttestedMessage[]): boolean {
    const sessionId = messages[0].sessionId;
    if (messages.some((message) => message.sessionId !== sessionId)) return false;
    for (let i = 1; i < messages.length; i++) {
      const before = messages[i - 1].createdAt;
      const after = messages[i].createdAt;
      if (after <= before) return false;
      if (betweenStmt.get({ sessionId, after: before, before: after })) return false;
    }
    return true;
  }

  function decide(content: string): Decision {
    for (const probe of deriveProbes(content)) {
      const attested = attest(searchProbe(probe));
      if (attested.length === 0) continue;
      // The strongest probe that matches anything decides — falling through to a
      // weaker probe after an ambiguous one would trade precision for a row.
      if (attested.length > 1 && (attested.length > MAX_MESSAGE_HITS || !isOneStretch(attested))) {
        logger.debug(
          { probe: probe.text, hits: attested.length },
          '[provenance_backfill] probe is ambiguous',
        );
        return { kind: 'ambiguous' };
      }
      return { kind: 'matched', messages: attested };
    }
    return { kind: 'no_evidence' };
  }

  return {
    name: PROVENANCE_BACKFILL_JOB_NAME,
    enabled: config.enabled,
    intervalMs: options.intervalMs ?? PROVENANCE_BACKFILL_INTERVAL_MS,
    async run({ dryRun, signal }): Promise<MaintenanceJobResult> {
      const start = Date.now();
      const counts = {
        memoriesConsidered: 0,
        candidatesMatched: 0,
        ambiguousRejected: 0,
        noEvidence: 0,
        rowsWritten: 0,
      };

      if (!config.enabled) {
        // A disabled job does no queries: the counts are zero because nothing
        // ran, and `enabled: false` says why.
        return {
          name: PROVENANCE_BACKFILL_JOB_NAME,
          status: 'skipped',
          dryRun,
          affectedRows: 0,
          durationMs: 0,
          details: { ...counts, elapsedMs: 0, dryRun, enabled: false },
        };
      }

      // Rotation window (see the header). `completedRuns` counts runs that have
      // already finished, so the window a dry run reports is the one the next
      // real run will use.
      const candidateTotal =
        maxMemories > 0
          ? (candidateTotalStmt.get({ minChars: MIN_MEMORY_CONTENT_CHARS }) as { n: number }).n
          : 0;
      const completedRuns =
        maxMemories > 0
          ? (completedRunsStmt.get({ jobName: PROVENANCE_BACKFILL_JOB_NAME }) as { n: number }).n
          : 0;
      const pages = Math.max(1, Math.ceil(candidateTotal / Math.max(1, maxMemories)));
      const windowIndex = completedRuns % pages;
      const windowOffset = windowIndex * maxMemories;

      const candidates =
        candidateTotal > 0
          ? (candidateStmt.all({
              limit: maxMemories,
              offset: windowOffset,
              minChars: MIN_MEMORY_CONTENT_CHARS,
            }) as CandidateRow[])
          : [];
      counts.memoriesConsidered = candidates.length;

      for (const candidate of candidates) {
        if (signal?.aborted) break;
        const decision = decide(candidate.content);
        if (decision.kind === 'no_evidence') {
          counts.noEvidence++;
          continue;
        }
        if (decision.kind === 'ambiguous') {
          counts.ambiguousRejected++;
          continue;
        }
        counts.candidatesMatched++;
        if (dryRun) continue;
        counts.rowsWritten += writeProvenance(candidate.id, decision.messages);
      }

      return {
        name: PROVENANCE_BACKFILL_JOB_NAME,
        status: 'success',
        dryRun,
        affectedRows: counts.rowsWritten,
        durationMs: Date.now() - start,
        details: {
          /** Memories the candidate query returned (bounded by `max_memories_per_run`). */
          memoriesConsidered: counts.memoriesConsidered,
          /** Memories whose text attested a source message. */
          candidatesMatched: counts.candidatesMatched,
          /** Matches refused because more than one message matched and not as one stretch. */
          ambiguousRejected: counts.ambiguousRejected,
          /** Memories whose text offered no probe that matched anything. */
          noEvidence: counts.noEvidence,
          /** `memory_sources` rows actually written (0 on a dry run, by definition). */
          rowsWritten: counts.rowsWritten,
          /** Which slice of the candidate list this run probed (see the header). */
          window: {
            index: windowIndex,
            offset: windowOffset,
            candidateTotal,
            pages,
            limit: maxMemories,
          },
          elapsedMs: Date.now() - start,
          dryRun,
        },
      };
    },
  };
}
