/**
 * GraphSync — projects the statements `memory_links` carries into
 * `entities`/`entity_edges`.
 *
 * The graph is a **derived view**: it holds nothing a producer did not assert.
 * A `memory_links` row is such an assertion only when it names its subject —
 * `(subject_entity, relation_type, target_entity)` — and the subject is written
 * where it is actually known (the extraction pass in `entity-mining.ts`, or a
 * future SPO producer), never reconstructed here.
 *
 * ## What becomes an edge
 * Exactly one row → one edge:
 *
 *   `memory_links(subject 'Alice Smith', WORKS_AT, 'Acme Corp', confidence 0.9)`
 *   → `alice smith (person) --WORKS_AT (0.9)--> acme corp (organization)`
 *
 * Two kinds of row deliberately produce nothing:
 *
 *   - **No subject** (`subject_entity IS NULL`) — the keyword extractor in
 *     `src/memory/entity-extractor.ts` assigns its relation keyword to *every*
 *     entity found in the text, so such a row says "this text contains a
 *     founding keyword and names Acme", not "X founded Acme". Picking the
 *     highest-confidence row as the subject is what put `SQLite` at the centre
 *     of a memory about vector search; the row keeps NULL and is skipped.
 *   - **`MENTIONED`** — co-occurrence is not a statement. Measured on the real
 *     database, 17 of 18 edges were `MENTIONED`, which is why traversing the
 *     graph produced nothing. Such rows stay in `memory_links` (they serve
 *     one-hop recall) and never reach `entity_edges`.
 *
 * There is no `memory:<id>` placeholder node any more: a memory is not an
 * entity. `LEGACY_PLACEHOLDER_ENTITY_TYPE` survives only so `graph:reset` can
 * find the nodes older versions wrote.
 *
 * ## Temporal model
 * `entity_edges` timestamps are INTEGER epoch-ms and facts are never deleted: a
 * fact that stops being true is *closed* by setting `valid_to`
 * (`closeContradictedEdges`), so "what was true in June" stays answerable.
 * `memory_links.created_at` is a TEXT epoch-ms column and goes through
 * `parseEpochMs` before it becomes `valid_from`.
 *
 * ## Idempotency and progress
 * `EntityRepository.upsertEntity` matches on canonical name and `linkEntities`
 * refreshes the still-open edge for the same (subject, relation, object)
 * instead of stacking duplicates, so a re-run can only refresh. Progress needs
 * no cursor table: a memory counts as projected once one of its edges carries
 * its id as `source_memory_id`, so the edges themselves are the cursor. A
 * memory whose rows are all unsubjected or `MENTIONED` never records an edge
 * and is therefore re-examined on later runs — bounded by `limit`, and cheap
 * because the batch is ordered and capped.
 *
 * Failures are per-row: a malformed link is logged and skipped, and only a
 * broken database (prepare/transaction failure) reaches the caller.
 */

import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { createLogger } from '../app/logger.js';
import type {
  MaintenanceJob,
  MaintenanceJobResult,
} from '../memory/maintenance/maintenance-job.js';
import {
  canonicalizeEntityName,
  EntityRepository,
} from '../memory/repositories/entity-repository.js';
import { parseEpochMs } from '../shared/timestamp.js';
import {
  inferEntityType,
  mineMemoryLinkSubjects,
  MENTION_RELATION_TYPE,
  attestsRelation,
  isTokenAlignedMention,
  isVouchableEntityName,
  type MemoryLinkMiningSummary,
} from './entity-mining.js';
import { DEFAULT_GRAPH_SYNC_CONFIG, type GraphSyncConfig } from './graph-config.js';

/** `maintenance_runs.job_name` of the scheduled projector. */
export const GRAPH_SYNC_JOB_NAME = 'graph_sync';

/**
 * Four projections a day: `memory_links` only grows when the extractor runs
 * (nightly dream cycle / 12h entity backfill), so a tighter interval would
 * mostly re-scan and find nothing.
 */
export const GRAPH_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * `entity_type` of the per-memory placeholder node older versions created for
 * memories with a single link. Nothing writes it any more; `scripts/graph-reset.ts`
 * is the one reader, which is why the constant lives here rather than in that
 * script (the value is graph history, not a CLI detail).
 */
export const LEGACY_PLACEHOLDER_ENTITY_TYPE = 'memory';

export interface GraphSyncOptions {
  /** Max links projected by this call. Default 500. */
  limit?: number;
  /** Links below this confidence are skipped. Default 0.3. */
  minConfidence?: number;
  /** Run the whole projection, then roll it back — nothing is written. */
  dryRun?: boolean;
  /** Cooperative cancellation between memories (scheduler timeout). */
  signal?: AbortSignal;
  /** Optional sink for per-row diagnostics; silent when absent. */
  logger?: Logger;
}

export interface GraphSyncSummary {
  /** Entities this run had to insert. */
  entitiesCreated: number;
  /** Upserts that resolved to an entity that already existed. */
  entitiesMatched: number;
  /** Edges this run had to insert. */
  edgesCreated: number;
  /** Edges that already existed and were re-stated (confidence/valid_from). */
  edgesRefreshed: number;
  /** Open edges this run closed because the subject stated a newer object. */
  edgesClosed: number;
  /** Rows skipped because no producer named their subject (`subject_entity IS NULL`). */
  linksWithoutSubject: number;
  /** Rows skipped because co-occurrence is not a statement (`MENTIONED`). */
  mentionLinksFiltered: number;
  /** Rows that could not be projected (blank target, inactive memory, self-loop, low confidence). */
  skipped: number;
  memoriesProcessed: number;
  linksProcessed: number;
}

interface BatchMemoryRow {
  memory_id: string;
  memory_created_at: string | null;
}

interface LinkRow {
  link_id: string;
  source_memory_id: string;
  subject_entity: string | null;
  subject_entity_type: string | null;
  target_entity: string;
  target_entity_type: string | null;
  relation_type: string;
  confidence: unknown;
  /** The memory text, so an endpoint can be checked against token boundaries. */
  memory_content: string | null;
}

export interface CloseContradictedEdgesInput {
  subjectId: string;
  relationType: string;
  /** Edge target the caller just (re)stated; only *other* objects are closed. */
  keepTargetId: string;
  /** Epoch ms at which the previous object stopped being true. */
  at: number;
}

/**
 * Sentinel thrown inside the dry-run transaction: better-sqlite3 rolls back on
 * throw and offers no other way to abort a transaction, so the rollback *is*
 * the dry run.
 */
const DRY_RUN_ROLLBACK = Symbol('graph-sync dry-run');

/**
 * Memories with projectable links that are not in the graph yet, oldest first.
 *
 * A memory counts as projected once any edge carries its id as
 * `source_memory_id`. Per-link coverage cannot be used here: several links of
 * one memory can restate the same edge.
 */
const BATCH_MEMORY_SQL = `
SELECT m.id AS memory_id, m.created_at AS memory_created_at
FROM memories m
WHERE m.status = 'active'
  AND EXISTS (
    SELECT 1
    FROM memory_links ml
    WHERE ml.source_memory_id = m.id
      AND trim(ml.target_entity) <> ''
      AND coalesce(trim(ml.subject_entity), '') <> ''
      AND upper(trim(ml.relation_type)) <> @mentionRelation
      AND ml.confidence >= @minConfidence
  )
  AND NOT EXISTS (
    SELECT 1
    FROM entity_edges e
    WHERE e.source_memory_id = m.id
  )
ORDER BY m.created_at, m.id
LIMIT @memoryLimit
`;

/** Links whose memory is gone or not active — never projected, always skipped. */
const ORPHAN_LINK_COUNT_SQL = `
SELECT COUNT(*) AS cnt
FROM memory_links ml
LEFT JOIN memories m ON m.id = ml.source_memory_id
WHERE m.id IS NULL OR m.status <> 'active'
`;

function countRows(db: Database.Database, sql: string): number {
  const row = db.prepare(sql).get() as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

function readBatchMemories(
  db: Database.Database,
  limit: number,
  minConfidence: number,
): BatchMemoryRow[] {
  return db.prepare(BATCH_MEMORY_SQL).all({
    memoryLimit: limit,
    minConfidence,
    mentionRelation: MENTION_RELATION_TYPE,
  }) as BatchMemoryRow[];
}

/** All links of the batch's memories, deterministic order (ties the projection must not depend on). */
function readLinksByMemory(db: Database.Database, memoryIds: string[]): Map<string, LinkRow[]> {
  const grouped = new Map<string, LinkRow[]>();
  if (memoryIds.length === 0) return grouped;

  const placeholders = memoryIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT ml.id AS link_id,
              ml.source_memory_id AS source_memory_id,
              ml.subject_entity AS subject_entity,
              ml.subject_entity_type AS subject_entity_type,
              ml.target_entity AS target_entity,
              ml.target_entity_type AS target_entity_type,
              ml.relation_type AS relation_type,
              ml.confidence AS confidence,
              m.content AS memory_content
       FROM memory_links ml
       JOIN memories m ON m.id = ml.source_memory_id
       WHERE ml.source_memory_id IN (${placeholders})
         AND m.status = 'active'
       ORDER BY ml.confidence DESC, ml.target_entity, ml.id`,
    )
    .all(...memoryIds) as LinkRow[];

  for (const row of rows) {
    const bucket = grouped.get(row.source_memory_id);
    if (bucket) bucket.push(row);
    else grouped.set(row.source_memory_id, [row]);
  }
  return grouped;
}

function isMentionLink(link: LinkRow): boolean {
  return link.relation_type.trim().toUpperCase() === MENTION_RELATION_TYPE;
}

function hasSubject(link: LinkRow): boolean {
  return (link.subject_entity ?? '').trim() !== '';
}

function isUsableLink(link: LinkRow, minConfidence: number): boolean {
  if (!link.target_entity.trim()) return false;
  if (!link.relation_type.trim()) return false;
  // Both endpoints have to read as entities and have to sit on token boundaries
  // of the memory that claims them. The measured failure mode was
  // `如何称呼 —ADVISES→ 何称 / 张奇` at confidence 0.95: every endpoint there is a
  // substring of the memory text, so only a boundary test can tell a name from a
  // slice. Enforcing it here (rather than deleting the rows) keeps the link as
  // retrieval evidence while stopping it from becoming a statement.
  if (!isVouchableEntityName(link.subject_entity)) return false;
  if (!isVouchableEntityName(link.target_entity)) return false;
  const content = link.memory_content ?? '';
  if (!isTokenAlignedMention(content, link.subject_entity ?? '')) return false;
  if (!isTokenAlignedMention(content, link.target_entity)) return false;
  // ...and the predicate itself has to be attested by the same text. A real
  // endpoint pair with a relation the sentence never states is still a false
  // statement: 穿衣建议 —ADVISES→ 周五 survived endpoint validation precisely
  // because the verb was part of the entity's own name.
  if (!attestsRelation(content, link.relation_type, link.subject_entity, link.target_entity)) {
    return false;
  }
  const confidence = Number(link.confidence);
  return Number.isFinite(confidence) && confidence >= minConfidence;
}

/**
 * Close the open edges that a newer statement contradicts.
 *
 * The same `(subject, relation)` pointing at a different object is a
 * contradiction: `Alice works_at Acme` and `Alice works_at Initech` cannot both
 * be true at once. The older edge is not deleted — its `valid_to` is set to
 * `at`, which is what makes "what did she work at in June" answerable. An edge
 * that started after `at` (a backfill projecting an older memory last) is
 * closed at its own `valid_from`, so the invariant "one open object per
 * (subject, relation)" still holds without claiming a negative interval.
 *
 * @returns number of edges closed.
 */
export function closeContradictedEdges(
  db: Database.Database,
  input: CloseContradictedEdgesInput,
): number {
  const at = Number.isFinite(input.at) ? Math.floor(input.at) : Date.now();
  const result = db
    .prepare(
      `UPDATE entity_edges
       SET valid_to = CASE
             WHEN valid_from IS NOT NULL AND valid_from > @at THEN valid_from
             ELSE @at
           END
       WHERE source_entity_id = @subjectId
         AND relation_type = @relationType
         AND target_entity_id <> @keepTargetId
         AND valid_to IS NULL`,
    )
    .run({
      subjectId: input.subjectId,
      relationType: input.relationType,
      keepTargetId: input.keepTargetId,
      at,
    });
  return result.changes;
}

/**
 * Project subject-bearing `memory_links` rows into the entity graph.
 *
 * Safe to call repeatedly: a second call over unchanged data creates no rows.
 * Throws only when the database itself is unusable — every per-row problem is
 * counted in the summary.
 */
export function syncGraphFromMemoryLinks(
  db: Database.Database,
  repo: EntityRepository,
  options: GraphSyncOptions = {},
): GraphSyncSummary {
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_GRAPH_SYNC_CONFIG.maxLinksPerRun));
  const minConfidence = options.minConfidence ?? DEFAULT_GRAPH_SYNC_CONFIG.minConfidence;
  const dryRun = options.dryRun === true;
  const { logger, signal } = options;

  const summary: GraphSyncSummary = {
    entitiesCreated: 0,
    entitiesMatched: 0,
    edgesCreated: 0,
    edgesRefreshed: 0,
    edgesClosed: 0,
    linksWithoutSubject: 0,
    mentionLinksFiltered: 0,
    skipped: 0,
    memoriesProcessed: 0,
    linksProcessed: 0,
  };

  if (countRows(db, 'SELECT COUNT(*) AS cnt FROM memory_links') === 0) {
    // Nothing was ever extracted: no entities, no edges, and no reason to open
    // a write transaction at all.
    logger?.debug('[graph-sync] memory_links is empty — nothing to project');
    return summary;
  }

  let upsertCalls = 0;
  let linkCalls = 0;

  const project = db.transaction(() => {
    const entitiesBefore = countRows(db, 'SELECT COUNT(*) AS cnt FROM entities');
    const edgesBefore = countRows(db, 'SELECT COUNT(*) AS cnt FROM entity_edges');

    summary.skipped = countRows(db, ORPHAN_LINK_COUNT_SQL);

    const batch = readBatchMemories(db, limit, minConfidence);
    const linksByMemory = readLinksByMemory(
      db,
      batch.map((memory) => memory.memory_id),
    );

    for (const memory of batch) {
      if (signal?.aborted) break;
      if (summary.linksProcessed >= limit) break;

      const links = linksByMemory.get(memory.memory_id) ?? [];
      let projectedHere = 0;

      for (const link of links) {
        if (!hasSubject(link)) {
          // The truthful answer is "subject unknown". Re-deriving one is what
          // produced the placeholder nodes and the mis-attributed subjects.
          summary.linksWithoutSubject++;
          continue;
        }
        if (isMentionLink(link)) {
          summary.mentionLinksFiltered++;
          continue;
        }
        if (!isUsableLink(link, minConfidence)) {
          summary.skipped++;
          logger?.debug(
            { linkId: link.link_id, memoryId: memory.memory_id },
            '[graph-sync] link skipped (blank target/relation or low confidence)',
          );
          continue;
        }

        const subjectName = link.subject_entity!.trim();
        const targetName = link.target_entity.trim();
        if (canonicalizeEntityName(subjectName) === canonicalizeEntityName(targetName)) {
          summary.skipped++;
          continue;
        }

        const validFromMs = parseEpochMs(memory.memory_created_at);
        const validFrom = validFromMs > 0 ? validFromMs : Date.now();

        try {
          const subject = repo.upsertEntity({
            name: subjectName,
            entityType: link.subject_entity_type?.trim() || inferEntityType(subjectName),
          });
          upsertCalls++;
          const target = repo.upsertEntity({
            name: targetName,
            entityType: link.target_entity_type?.trim() || inferEntityType(targetName),
          });
          upsertCalls++;

          repo.linkEntities({
            sourceId: subject.id,
            targetId: target.id,
            relationType: link.relation_type.trim(),
            confidence: Number(link.confidence),
            sourceMemoryId: memory.memory_id,
            validFrom,
          });
          linkCalls++;
          projectedHere++;
          summary.linksProcessed++;

          summary.edgesClosed += closeContradictedEdges(db, {
            subjectId: subject.id,
            relationType: link.relation_type.trim(),
            keepTargetId: target.id,
            at: validFrom,
          });
        } catch (err) {
          // One malformed row must not abort the run: it stays unprojected and
          // the next pass retries it.
          summary.skipped++;
          logger?.warn(
            { linkId: link.link_id, memoryId: memory.memory_id, err: errMessage(err) },
            '[graph-sync] link skipped',
          );
        }
      }

      if (projectedHere > 0) summary.memoriesProcessed++;
    }

    summary.entitiesCreated =
      countRows(db, 'SELECT COUNT(*) AS cnt FROM entities') - entitiesBefore;
    summary.entitiesMatched = Math.max(0, upsertCalls - summary.entitiesCreated);
    summary.edgesCreated = countRows(db, 'SELECT COUNT(*) AS cnt FROM entity_edges') - edgesBefore;
    summary.edgesRefreshed = Math.max(0, linkCalls - summary.edgesCreated);

    if (dryRun) throw DRY_RUN_ROLLBACK;
  });

  try {
    project();
  } catch (err) {
    if (err !== DRY_RUN_ROLLBACK) throw err;
  }

  return summary;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The `graph_sync` maintenance job.
 *
 * Registered on the existing `MaintenanceScheduler`, which already owns the
 * `maintenance_runs` bookkeeping (one row per run), the interval gate and the
 * per-job error isolation — so the graph can neither run on the turn path nor
 * take the memory pipeline down with it.
 *
 * One job, two passes, in this order: the subject pass (`mineMemoryLinkSubjects`)
 * records what each memory is about on its `memory_links` rows, then the
 * projection turns the rows that state a fact into edges. They share one
 * `maintenance_runs` row and one `limit` per run — each pass applies it to its
 * own unit (memories) — so enabling mining does not double the run cost.
 */
export function createGraphSyncJob(
  db: Database.Database,
  config: GraphSyncConfig = DEFAULT_GRAPH_SYNC_CONFIG,
  logger: Logger = createLogger(),
): MaintenanceJob {
  const repo = new EntityRepository(db);
  const emptyMining: MemoryLinkMiningSummary = {
    memoriesMined: 0,
    mentionsMined: 0,
    linksCreated: 0,
    linksAnnotated: 0,
    skipped: 0,
  };
  return {
    name: GRAPH_SYNC_JOB_NAME,
    enabled: config.enabled,
    intervalMs: GRAPH_SYNC_INTERVAL_MS,
    async run({ dryRun, signal }): Promise<MaintenanceJobResult> {
      const start = Date.now();
      try {
        // Subject first: the projection must read a recorded subject, never
        // derive one, so the pass that writes it has to run before it.
        const mined = config.mineMentions
          ? mineMemoryLinkSubjects(db, {
              limit: config.maxLinksPerRun,
              maxMentionsPerMemory: config.maxMentionsPerMemory,
              dryRun,
              signal,
              logger,
            })
          : emptyMining;
        const summary = syncGraphFromMemoryLinks(db, repo, {
          limit: config.maxLinksPerRun,
          minConfidence: config.minConfidence,
          dryRun,
          signal,
          logger,
        });
        const affectedRows =
          summary.edgesCreated +
          summary.edgesRefreshed +
          summary.edgesClosed +
          mined.linksCreated +
          mined.linksAnnotated;
        // Nothing recorded, nothing projected: report it instead of pretending a
        // run happened.
        if (
          summary.memoriesProcessed === 0 &&
          summary.linksProcessed === 0 &&
          mined.memoriesMined === 0
        ) {
          return {
            name: GRAPH_SYNC_JOB_NAME,
            status: 'skipped',
            dryRun,
            affectedRows: 0,
            durationMs: Date.now() - start,
            details: {
              reason: 'no_projectable_links',
              skipped: summary.skipped,
              linksWithoutSubject: summary.linksWithoutSubject,
              mentionLinksFiltered: summary.mentionLinksFiltered,
              mined,
            },
          };
        }
        return {
          name: GRAPH_SYNC_JOB_NAME,
          status: 'success',
          dryRun,
          affectedRows,
          durationMs: Date.now() - start,
          details: { ...summary, mined },
        };
      } catch (err) {
        // Non-fatal by contract: a graph sync failure must never fail the
        // memory run or the boot. The run row records it for later inspection.
        return {
          name: GRAPH_SYNC_JOB_NAME,
          status: 'failed',
          dryRun,
          affectedRows: 0,
          durationMs: Date.now() - start,
          error: errMessage(err),
        };
      }
    },
  };
}
