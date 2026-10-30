/**
 * `entity_backfill` — the producer that puts a real predicate back into
 * `memory_links`.
 *
 * Background: the deterministic extractor used to type a relation by testing a
 * keyword against the *whole* memory, so 建议 anywhere in a weather answer made
 * every entity in it an `ADVISES` expert. That path now emits `MENTIONED` only
 * (`src/memory/entity-extractor.ts`), and `graph_sync` refuses to project a
 * row whose relation the text does not attest — which is correct, but it also
 * means the false rows are gone and nothing replaces them. A memory written
 * before the cleanup keeps its `MENTIONED` pairs in `memory_links`, no new
 * memory is written with a model configured on a phone, and the user's graph
 * stays empty. This job is the missing producer.
 *
 * ## Two generations, cheapest first
 *
 * 1. **Deterministic pass** — memories with no links at all get their mention
 *    rows (`MENTIONED`, no model). Exactly what this job did before; unchanged
 *    so an install with no aux model is not slower or noisier than it was.
 * 2. **LLM pass** — a memory no producer has ever typed (no non-`MENTIONED`
 *    link) is sent to `extractEntitiesLLM`, and only the typed relations it
 *    returns are written. This is why the job is generation-aware: the
 *    deterministic pass seeds mentions, the LLM pass promotes a subset of them
 *    to statements on a later run, and the mention rows themselves are left
 *    exactly as they were.
 *
 * ## Cost discipline (this runs on a phone, on a schedule, forever)
 *
 * - `max_memories_per_run` is a hard cap on **LLM calls per run**, not per
 *   batch, and it is reported as `llmCallBudget` in the result details.
 * - Memories already carrying a typed link are never candidates again, and
 *   memories shorter than {@link MIN_LLM_CONTENT_CHARS} are skipped.
 * - A memory the deterministic pass *scanned* in this run is still a candidate
 *   for the model. The deterministic pass only ever writes `MENTIONED` rows, so
 *   "it already looked at this one" is not "this one has been typed" — and
 *   excluding it starves exactly the memories the deterministic pass found
 *   nothing in: they have no links, so every run selects them for the mention
 *   pass, and if that pass writes nothing they would never be asked. Measured on
 *   the reference database before this rule changed: 13 of 28 memories had no
 *   links at all and `llmCalls: 0, degradedReason: null` — a run that reported
 *   success while refusing to ask anyone anything.
 * - No aux model configured (or `memory.entity_extraction.llm: false`) means the
 *   LLM pass does not run at all: `llmAttempted: false` and a `degradedReason`
 *   say so. It never throws, and the deterministic pass is untouched.
 * - A memory whose model answer is rejected by the gates stays a candidate and
 *   is retried on a later run. That is bounded by the same per-run cap, and the
 *   alternative (an attempt cursor) is schema this job is not allowed to add.
 *   Candidates are ordered newest-first for the same reason
 *   `mineMemoryLinkSubjects` does: an old memory that records nothing keeps a
 *   slot only until `max_memories_per_run` newer candidates exist.
 *
 * ## The gates are the projector's, not a second opinion
 *
 * A row this job writes must be one `syncGraphFromMemoryLinks` would project,
 * otherwise the graph fills with rows that look authoritative and never appear.
 * So every typed relation is checked with `isVouchableEntityName`,
 * `isTokenAlignedMention` and `attestsRelation` — the three predicates the
 * projector applies — and a rejection is counted (`rejectedByGates`) and logged
 * rather than written.
 *
 * The subject is *copied*, never invented: the model answers
 * `entity → relation`, not a subject/predicate/object triple, so the only
 * subject this job may record is the one a producer already put on the memory's
 * rows (`mineMemoryLinkSubjects`). Without that copy a typed row written for an
 * already-mined memory would keep `subject_entity IS NULL` forever — mining
 * skips memories that carry a subject, so nothing would ever fill it — and the
 * projector skips such a row. When the memory has no subject yet the typed row
 * is written without one, and the next `graph_sync` mining pass annotates it.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { MemoryLinkRepository } from '../../repositories/memory-link-repository.js';
import type { MaintenanceJob, MaintenanceJobResult } from '../maintenance-job.js';
import type { AuxModelConfig } from '../../aux-llm-client.js';
import {
  extractEntities,
  extractTriplesLLM,
  type EntityTriple,
  type LLMExtractionConfig,
} from '../../entity-extractor.js';
import {
  attestsRelation,
  inferEntityType,
  isTokenAlignedMention,
  isVouchableEntityName,
  MENTION_RELATION_TYPE,
} from '../../../graph/entity-mining.js';
import { canonicalizeEntityName } from '../../repositories/entity-repository.js';
import { createLogger } from '../../../app/logger.js';
import { generateId } from '../../../shared/ids.js';

export const ENTITY_BACKFILL_JOB_NAME = 'entity_backfill';

/** Two runs a day: the deterministic pass only fires for memories nothing mined. */
export const ENTITY_BACKFILL_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Today's behaviour: a deterministic mention below this is not written. */
const DETERMINISTIC_MIN_CONFIDENCE = 0.5;

/** Mention rows per run for memories no producer has touched — unchanged from before. */
const DETERMINISTIC_BATCH_LIMIT = 100;

/**
 * Shorter memories are skipped by the LLM pass. `张伟在Acme工作` is ten
 * characters and worth a call; `好的` / `N/A` / a bare date are not, and a model
 * sent one will answer with something the gates then have to reject.
 */
const MIN_LLM_CONTENT_CHARS = 10;

/** Memory kinds that hold bookkeeping, not conversation (`mineMemoryLinkSubjects` skips them too). */
const EXCLUDED_MEMORY_KINDS = `'persona', 'scene'`;

/** `memory.entity_extraction` — the block `src/app/config.ts` validates. */
export interface EntityExtractionJobConfig {
  /** Off switch for the LLM pass. `false` leaves this job exactly as it was. */
  llm: boolean;
  /** Hard cap on LLM calls per run. */
  max_memories_per_run: number;
  /** Drop a model relation below this confidence (`extractTriplesLLM` filters it). */
  min_confidence: number;
  /**
   * Extraction-specific `provider/model` override.
   *
   * This job is throughput-bound, not quality-bound: it wants a fast model that
   * answers in JSON immediately, while the auxiliary model is chosen for
   * summarisation quality. Measured on the reference corpus, the reasoning aux
   * model burned its whole token budget thinking and returned nothing, while a
   * small fast model answered correctly in a fifth of the time.
   */
  model?: string;
}

/**
 * Defaults mirror the zod schema in `src/app/config.ts`; they are repeated here
 * so a hand-built job (tests, a caller that bypasses `loadConfig`) is as
 * conservative as a configured one.
 */
export const DEFAULT_ENTITY_EXTRACTION_JOB_CONFIG: EntityExtractionJobConfig = {
  llm: true,
  max_memories_per_run: 5,
  min_confidence: 0.6,
};

export interface EntityBackfillJobOptions {
  config?: EntityExtractionJobConfig;
  /**
   * Shared `memory_aux_models` config. Passed by reference on purpose:
   * `createMemoryServices` mutates it in place on hot-reload, so a snapshot
   * taken here would pin the job to the model configured at startup.
   */
  auxConfig?: AuxModelConfig;
  logger?: Logger;
  intervalMs?: number;
}

interface MemoryRow {
  id: string;
  content: string;
  scope: string;
  kind: string;
}

/**
 * Why memories the ledger has never answered are not, or not yet, LLM candidates.
 *
 * `total` is every active memory with no non-error ledger row; the four buckets
 * partition it. `candidates` is the queue the next run will read from, so a
 * `total` that stays high while `candidates` is 0 is a finished backlog, not a
 * stuck one.
 */
interface UnattemptedBreakdown {
  total: number;
  /** `persona`/`scene` — bookkeeping rows, never conversation. */
  byKind: number;
  /** Shorter than {@link MIN_LLM_CONTENT_CHARS}: a model sent one answers noise. */
  tooShort: number;
  /** Already carries a typed link, so a producer has spoken for it. */
  alreadyTyped: number;
  /** Readable by {@link LLM_CANDIDATE_SQL}; only the per-run budget limits them. */
  candidates: number;
}

/** Why the LLM pass did not run; `null` when it did. */
type DegradedReason = 'llm_disabled' | 'no_aux_model' | 'llm_failed';

/**
 * Memories no producer has ever typed: the memory either has no links at all
 * (the deterministic pass seeds those) or only `MENTIONED` ones.
 */
const LLM_CANDIDATE_SQL = `
  SELECT m.id, m.content, m.scope, m.kind
  FROM memories m
  WHERE m.status = 'active'
    AND m.kind NOT IN (${EXCLUDED_MEMORY_KINDS})
    AND length(trim(m.content)) >= @minChars
    AND NOT EXISTS (
      SELECT 1 FROM memory_links ml
      WHERE ml.source_memory_id = m.id
        AND upper(trim(ml.relation_type)) <> @mentionRelation
    )
    -- The model has already read this text. Without this the job re-buys "no
    -- relation stated" on every run: a null answer cannot be stored in
    -- memory_links, so it had nowhere to be remembered (migration v18). The
    -- ledger's content hash records what was read; a memory whose text changes
    -- has its ledger row dropped by the repository on update, so an edit re-opens
    -- extraction without this query needing a hash SQLite cannot compute.
    AND NOT EXISTS (
      SELECT 1 FROM entity_extraction_log el
      WHERE el.memory_id = m.id
        AND el.outcome <> 'error'
    )
  ORDER BY m.created_at DESC, m.id DESC
  LIMIT @limit
`;

/** Unchanged from the pre-LLM job: memories with no link rows at all. */
const DETERMINISTIC_CANDIDATE_SQL = `
  SELECT m.id, m.content, m.scope, m.kind FROM memories m
  LEFT JOIN memory_links ml ON ml.source_memory_id = m.id
  WHERE ml.id IS NULL AND m.status = 'active'
  LIMIT ${DETERMINISTIC_BATCH_LIMIT}
`;

/**
 * One existing `memory_links` row of a candidate memory, as far as this job reads
 * it.
 *
 * `subject_entity` is read here rather than through `MemoryLinkRepository`
 * because that repository's `MemoryLink` interface predates the v15 subject
 * columns; the job needs them to copy a recorded subject onto the row it writes.
 */
interface ExistingLinkRow {
  target_entity: string;
  relation_type: string;
  subject_entity: string | null;
  subject_entity_type: string | null;
  confidence: unknown;
}

function hasAuxModel(auxConfig: AuxModelConfig | undefined): boolean {
  if (!auxConfig) return false;
  return Boolean(auxConfig.modelRef) || (auxConfig.fallbackRefs?.length ?? 0) > 0;
}

/**
 * The subject a producer already recorded for this memory, if any.
 *
 * `mineMemoryLinkSubjects` writes one subject on every row of a memory, so the
 * rows agree; the highest-confidence row wins instead of assuming that, and a
 * memory whose rows disagree still yields a deterministic answer.
 */
function recordedSubject(
  links: ExistingLinkRow[],
): { subject: string; subjectType: string | null } | null {
  let best: { subject: string; subjectType: string | null; confidence: number } | null = null;
  for (const link of links) {
    const subject = (link.subject_entity ?? '').trim();
    if (!subject) continue;
    const confidence = Number(link.confidence);
    if (!best || (Number.isFinite(confidence) ? confidence : 0) > best.confidence) {
      best = {
        subject,
        subjectType: (link.subject_entity_type ?? '').trim() || null,
        confidence: Number.isFinite(confidence) ? confidence : 0,
      };
    }
  }
  return best ? { subject: best.subject, subjectType: best.subjectType } : null;
}

/**
 * The projector's gate set, applied at write time.
 *
 * Returns the reason a row would not be projected, or `null` when every gate
 * passes. Each gate is the projector's own predicate — validated here so the
 * job cannot write a row that would be skipped, and named here so the log says
 * which one refused it.
 */
/** Stable fingerprint of the exact text a model was shown. */
function contentHashFor(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Identity of a typed statement: same subject, same target. */
function linkPairKey(subject: string | null, target: string): string {
  const subjectKey = canonicalizeEntityName(subject ?? '');
  const targetKey = canonicalizeEntityName(target);
  if (subjectKey === '' || targetKey === '') return '';
  return `${subjectKey}|${targetKey}`;
}

function gateRejection(
  content: string,
  relationType: string,
  subject: string | null,
  target: string,
): string | null {
  if (!isVouchableEntityName(target)) return 'target_not_vouchable';
  if (!isTokenAlignedMention(content, target)) return 'target_is_a_fragment';
  if (subject) {
    // A subject the memory already recorded still has to be a name the
    // projector accepts, or every row of that memory is skipped anyway.
    if (!isVouchableEntityName(subject)) return 'subject_not_vouchable';
    if (canonicalizeEntityName(subject) === canonicalizeEntityName(target)) return 'self_loop';
    if (!isTokenAlignedMention(content, subject)) return 'subject_is_a_fragment';
  }
  // With no recorded subject this fails open on the subject span by design (the
  // projector has the same behaviour): the relation is unverifiable, not
  // disproven, and the row cannot become an edge until a subject is recorded.
  if (!attestsRelation(content, relationType, subject, target)) return 'relation_unattested';
  return null;
}

export function createEntityBackfillJob(
  db: Database.Database,
  memoryLinkRepo: MemoryLinkRepository,
  options: EntityBackfillJobOptions = {},
): MaintenanceJob {
  const config = options.config ?? DEFAULT_ENTITY_EXTRACTION_JOB_CONFIG;
  const logger = options.logger ?? createLogger();
  const maxLlmCalls = Math.max(0, Math.floor(config.max_memories_per_run));

  const annotateLink = db.prepare(
    `UPDATE memory_links
     SET subject_entity = @subject,
         subject_entity_type = @subjectType,
         target_entity_type = @targetType
     WHERE id = @id`,
  );

  /**
   * The extraction ledger (v18). One row per memory: what the model was shown and
   * what came of it, so a null answer is remembered instead of re-bought.
   */
  const recordExtraction = db.prepare(`
    INSERT INTO entity_extraction_log (memory_id, content_hash, outcome, triples_written, created_at)
    VALUES (@memoryId, @contentHash, @outcome, @written, @now)
    ON CONFLICT(memory_id) DO UPDATE SET
      content_hash = excluded.content_hash,
      outcome = excluded.outcome,
      triples_written = excluded.triples_written,
      created_at = excluded.created_at
  `);

  const selectExistingLinks = db.prepare(
    `SELECT target_entity, relation_type, subject_entity, subject_entity_type, confidence
     FROM memory_links
     WHERE source_memory_id = ?`,
  );

  /**
   * Why the LLM pass cannot see a memory the ledger has never answered.
   *
   * Measured on the reference database: "111 memories were never attempted" was
   * true but unexplainable from the job's own output, so it took a hand-written
   * query against the device database to discover that 77 of them are `scene`
   * rows (file-path pointers, excluded by design) and 16 were simply queued
   * behind a budget of five calls per run. Reporting the breakdown turns the next
   * such question into a read of `maintenance_runs.details`.
   *
   * Same predicates as {@link LLM_CANDIDATE_SQL}, in the same order, so
   * `candidates` here and `llmCalls` there cannot disagree about a memory.
   * `outcome = 'error'` stays a candidate on purpose: a failed call is not an
   * answer.
   */
  const countUnattempted = db.prepare(`
    SELECT CASE
             WHEN m.kind IN (${EXCLUDED_MEMORY_KINDS}) THEN 'byKind'
             WHEN length(trim(m.content)) < @minChars THEN 'tooShort'
             WHEN EXISTS (
               SELECT 1 FROM memory_links ml
               WHERE ml.source_memory_id = m.id
                 AND upper(trim(ml.relation_type)) <> @mentionRelation
             ) THEN 'alreadyTyped'
             ELSE 'candidate'
           END AS reason,
           COUNT(*) AS n
      FROM memories m
     WHERE m.status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM entity_extraction_log el
         WHERE el.memory_id = m.id
           AND el.outcome <> 'error'
       )
     GROUP BY 1
  `);

  /** Fold {@link countUnattempted}'s rows into one reportable object. */
  const readUnattemptedBreakdown = (): UnattemptedBreakdown => {
    const rows = countUnattempted.all({
      minChars: MIN_LLM_CONTENT_CHARS,
      mentionRelation: MENTION_RELATION_TYPE,
    }) as Array<{ reason: string; n: number }>;
    const breakdown: UnattemptedBreakdown = {
      total: 0,
      byKind: 0,
      tooShort: 0,
      alreadyTyped: 0,
      candidates: 0,
    };
    for (const row of rows) {
      const count = Number(row.n);
      breakdown.total += count;
      if (row.reason === 'byKind') breakdown.byKind += count;
      else if (row.reason === 'tooShort') breakdown.tooShort += count;
      else if (row.reason === 'alreadyTyped') breakdown.alreadyTyped += count;
      else breakdown.candidates += count;
    }
    return breakdown;
  };

  function readLlmCandidates(limit: number): MemoryRow[] {
    if (limit <= 0) return [];
    return db.prepare(LLM_CANDIDATE_SQL).all({
      limit,
      minChars: MIN_LLM_CONTENT_CHARS,
      mentionRelation: MENTION_RELATION_TYPE,
    }) as MemoryRow[];
  }

  /**
   * Write the typed relations one model answer asserts.
   *
   * Mention rows are ignored here — the deterministic pass owns those, and a
   * memory in this pass already has them. Returns how many rows were written,
   * how many the gates refused, and how many were a second relation on a target
   * that already had one (a duplicate is not a gate failure).
   */
  /**
   * Write the relations the model stated, each carrying its own subject.
   *
   * The previous version composed a triple out of two answers — the mined subject
   * plus whatever relation the model gave the target — and produced
   * `Python —USES→ excel-mcp` from a memory saying Python was *not* to be used.
   * A triple is written only when all three of its parts came from the same
   * answer, and the projector's attestation gates still run on top: a row that
   * cannot become an edge is not worth storing.
   */
  function writeTypedRelations(
    row: MemoryRow,
    triples: EntityTriple[],
  ): { written: number; rejected: number; duplicates: number } {
    const existing = selectExistingLinks.all(row.id) as ExistingLinkRow[];
    // Only an identical (subject, target) pair blocks a second row: the same
    // target under a different subject is a different statement.
    const typedPairs = new Set(
      existing
        .filter((link) => link.relation_type.trim().toUpperCase() !== MENTION_RELATION_TYPE)
        .map((link) => linkPairKey(link.subject_entity ?? null, link.target_entity))
        .filter((key) => key !== ''),
    );
    let written = 0;
    let rejected = 0;
    let duplicates = 0;

    for (const triple of triples) {
      const subject = triple.subject.trim();
      const target = triple.object.trim();
      const relationType = triple.relation.trim();
      if (relationType.toUpperCase() === MENTION_RELATION_TYPE) continue;

      const reason = gateRejection(row.content, relationType, subject, target);
      if (reason) {
        rejected++;
        logger.debug(
          { memoryId: row.id, subject, target, relationType, reason },
          '[entity_backfill] model triple rejected by the graph gates',
        );
        continue;
      }

      const pairKey = linkPairKey(subject, target);
      if (pairKey !== '' && typedPairs.has(pairKey)) {
        duplicates++;
        continue;
      }

      try {
        const subjectType = triple.subjectType ?? inferEntityType(subject);
        const link = memoryLinkRepo.create({
          id: generateId(),
          source_memory_id: row.id,
          subject_entity: subject,
          subject_entity_type: subjectType,
          target_entity: target,
          relation_type: relationType,
          confidence: triple.confidence,
        });
        // `create` writes the subject; this fills the target type the projector
        // reads, so both columns come from one place for old and new rows alike.
        annotateLink.run({
          id: link.id,
          subject,
          subjectType,
          targetType: inferEntityType(target),
        });
        if (pairKey !== '') typedPairs.add(pairKey);
        written++;
      } catch (err) {
        logger.debug(
          { memoryId: row.id, err: err instanceof Error ? err.message : String(err) },
          '[entity_backfill] typed link insert failed',
        );
        rejected++;
      }
    }

    return { written, rejected, duplicates };
  }

  return {
    name: ENTITY_BACKFILL_JOB_NAME,
    enabled: true,
    intervalMs: options.intervalMs ?? ENTITY_BACKFILL_INTERVAL_MS,
    async run({ dryRun, signal }): Promise<MaintenanceJobResult> {
      const start = Date.now();
      const deterministicRows = db.prepare(DETERMINISTIC_CANDIDATE_SQL).all() as MemoryRow[];

      const degradedReason: DegradedReason | null = !config.llm
        ? 'llm_disabled'
        : hasAuxModel(options.auxConfig)
          ? null
          : 'no_aux_model';
      const llmBudget = degradedReason ? 0 : maxLlmCalls;

      if (dryRun) {
        // A dry run must not spend money: report the candidate counts and leave
        // both passes unexecuted.
        return {
          name: ENTITY_BACKFILL_JOB_NAME,
          status: 'success',
          dryRun: true,
          affectedRows: 0,
          durationMs: Date.now() - start,
          details: {
            wouldProcess: deterministicRows.length,
            llmCandidates: degradedReason ? 0 : readLlmCandidates(llmBudget).length,
            llmAttempted: false,
            llmCalls: 0,
            llmCallBudget: llmBudget,
            degradedReason,
            // The same breakdown the real run reports: a dry run is how an
            // operator asks "what would you two do", and "0 candidates" is
            // unreadable without the reason the others are not candidates.
            unattempted: readUnattemptedBreakdown(),
          },
        };
      }

      // ── Generation 1: mentions, no model ──────────────────────────────
      let mentionLinksWritten = 0;
      for (const row of deterministicRows) {
        if (signal?.aborted) break;
        try {
          const entities = extractEntities(row.content, { scope: row.scope, kind: row.kind });
          for (const entity of entities) {
            if (entity.confidence < DETERMINISTIC_MIN_CONFIDENCE) continue;
            memoryLinkRepo.create({
              id: generateId(),
              source_memory_id: row.id,
              target_entity: entity.entity,
              relation_type: entity.relationType,
              confidence: entity.confidence,
            });
            mentionLinksWritten++;
          }
        } catch (err) {
          // Unchanged behaviour: one malformed memory must not abort the batch.
          logger.debug(
            { memoryId: row.id, err: err instanceof Error ? err.message : String(err) },
            '[entity_backfill] deterministic extraction failed',
          );
        }
      }

      // ── Generation 2: typed relations, budgeted ───────────────────────
      let llmCalls = 0;
      let typedLinksWritten = 0;
      /** Model calls that fell back to the deterministic extractor. */
      let llmFailures = 0;
      let rejectedByGates = 0;
      let duplicateTargets = 0;

      if (!degradedReason && llmBudget > 0) {
        // The window is the budget: the SQL already excludes memories with a
        // typed link, and `length(content) >= MIN_LLM_CONTENT_CHARS` already
        // removes the short ones, so nothing read here is skipped below.
        const candidates = readLlmCandidates(llmBudget);
        const llmConfig: LLMExtractionConfig = {
          // A task-specific model overrides the auxiliary model for this call
          // only; the shared config object is not mutated.
          auxConfig: config.model
            ? { ...options.auxConfig, modelRef: config.model }
            : options.auxConfig,
          enabled: true,
          minConfidence: config.min_confidence,
          logger,
        };

        for (const row of candidates) {
          if (signal?.aborted) break;
          if (llmCalls >= llmBudget) break;
          llmCalls++;

          let triples: EntityTriple[];
          let extractionFailed = false;
          try {
            triples = await extractTriplesLLM(row.content, llmConfig, {
              scope: row.scope,
              kind: row.kind,
              onFallback: (reason) => {
                llmFailures++;
                // A failed call is not an answer: it must never let the ledger
                // claim this memory was examined.
                if (reason === 'llm_error') extractionFailed = true;
              },
            });
          } catch (err) {
            // `extractTriplesLLM` catches model failures itself; this is the
            // last-resort guard so a broken extractor cannot fail the run.
            //
            // The ledger row is written anyway. `error` deliberately keeps the
            // memory a candidate (a failure is not an answer), so this records what
            // happened rather than claiming progress — but without it a throw left
            // no trace at all, which is why "these memories were never attempted"
            // needed a device query to explain.
            recordExtraction.run({
              memoryId: row.id,
              contentHash: contentHashFor(row.content),
              outcome: 'error',
              written: 0,
              now: Date.now(),
            });
            logger.warn(
              { memoryId: row.id, err: err instanceof Error ? err.message : String(err) },
              '[entity_backfill] LLM extraction threw',
            );
            continue;
          }

          const result = writeTypedRelations(row, triples);
          typedLinksWritten += result.written;
          rejectedByGates += result.rejected;
          duplicateTargets += result.duplicates;

          recordExtraction.run({
            memoryId: row.id,
            contentHash: contentHashFor(row.content),
            outcome: extractionFailed ? 'error' : triples.length > 0 ? 'triples' : 'none',
            written: result.written,
            now: Date.now(),
          });
        }
      }

      // Every call failed → the run did no model work at all, whatever the
      // budget said. Reporting `llmAttempted: true` with zero typed links is
      // what hid a dead aux model: the numbers looked like "nothing to do".
      const llmFailed = llmCalls > 0 && llmFailures === llmCalls;
      const effectiveDegraded: DegradedReason | null = llmFailed ? 'llm_failed' : degradedReason;

      const linksCreated = mentionLinksWritten + typedLinksWritten;
      return {
        name: ENTITY_BACKFILL_JOB_NAME,
        status: 'success',
        dryRun: false,
        affectedRows: linksCreated,
        durationMs: Date.now() - start,
        details: {
          /** Memories the deterministic pass scanned (the pre-LLM job's `processed`). */
          processed: deterministicRows.length,
          /** `memory_links` rows written by the deterministic pass (all `MENTIONED`). */
          mentionLinksWritten,
          /** `memory_links` rows written by the LLM pass (all typed). */
          typedLinksWritten,
          /** `memory_links` rows written in total (mentions + typed). */
          linksCreated,
          /** Memories this run looked at: the deterministic batch plus the LLM calls made. */
          memoriesConsidered: deterministicRows.length + llmCalls,
          /** True when at least one model extraction was attempted this run. */
          llmAttempted: llmCalls > 0 && !llmFailed,
          llmCalls,
          /** Model calls that produced nothing and fell back to the regex path. */
          llmFailures,
          /** Hard per-run cap on model calls (`memory.entity_extraction.max_memories_per_run`). */
          llmCallBudget: llmBudget,
          /** Relations the model asserted that the projector would not have projected. */
          rejectedByGates,
          /** Relations dropped because the memory already links that target. */
          duplicateTargets,
          /** `llm_disabled` | `no_aux_model` | `llm_failed`, or `null` when the LLM pass ran. */
          degradedReason: effectiveDegraded,
          /**
           * The unattempted backlog, broken down by the filter that holds each
           * memory back (`entity_extraction_log` is the ledger that defines
           * "attempted"). Added because "never attempted: 111" was measurable but
           * not diagnosable from this result.
           */
          unattempted: readUnattemptedBreakdown(),
        },
      };
    },
  };
}
