/**
 * GraphSync — materialises `entities`/`entity_edges` from `memory_links`.
 *
 * The memory entity extractor already pays for one LLM call per finished turn
 * and stores what it found as `memory_links(source_memory_id, target_entity,
 * relation_type, confidence)`. The v10 graph tables exist but had no writer, so
 * `EntityRepository.neighbors()` / `searchEntities()` could only ever see rows
 * some caller inserted by hand. This module is that writer — and it is a pure,
 * deterministic projection of rows that already exist: no prompt, no network,
 * nothing that could disagree with the extraction that produced the links.
 * (The SPO triplet extractor in `src/graph/entity-extractor.ts` stays available
 * as optional enrichment; it is deliberately not called from here.)
 *
 * ## Mapping
 * `memory_links` has no subject column. One extraction pass stores a turn's
 * entities side by side, each carrying the relation keyword it detected, so a
 * memory's own subject is the entity it mentions most confidently:
 *
 *   - ≥2 links: the highest-confidence link names the subject, and every other
 *     link becomes an edge `subject --relation--> target`.
 *   - exactly 1 link: nothing in the row says who the subject is, so the memory
 *     itself becomes the subject through a placeholder entity
 *     `memory:<memory_id>` of type `memory`. Dropping the row instead would
 *     lose the fact entirely.
 *
 * Worked example — memory `4f2a` ("Alice Smith joined Acme Corp in March",
 * created_at 1791333925000) with links `(4f2a, Alice Smith, WORKS_AT, 0.9)` and
 * `(4f2a, Acme Corp, WORKS_AT, 0.8)` projects to:
 *
 *   `alice smith (person) --WORKS_AT (confidence 0.8, source_memory_id 4f2a,
 *    valid_from 1791333925000)--> acme corp (organization)`
 *
 * The same memory holding only `(4f2a, 程语, MENTIONED, 0.6)` projects to:
 *
 *   `memory:4f2a (memory) --MENTIONED (confidence 0.6)--> 程语 (concept)`
 *
 * `entity_type` is not recorded in `memory_links`, so it is inferred from the
 * name's shape — see `inferEntityType`.
 *
 * ## Idempotency and progress
 * `EntityRepository.upsertEntity` matches on canonical name and
 * `linkEntities` refreshes the still-open edge for the same (subject, relation,
 * object) instead of stacking duplicates, so a re-run can only refresh. Progress
 * therefore needs no cursor table and no `maintenance_runs` metadata (there is
 * no metadata column, and stuffing a cursor into `error`/`job_name` would
 * corrupt the audit trail): a memory is projected once one of its edges carries
 * its id as `source_memory_id`, so the edges themselves are the cursor. Per-link
 * coverage cannot serve as the marker — the subject's own link never becomes an
 * edge. A run is capped by `limit` links, and one memory's links are projected
 * as a whole so its subject never changes between runs.
 *
 * A memory whose facts were all restated by an earlier memory shares that
 * earlier memory's edges (same subject/relation/object) and therefore never
 * records a `source_memory_id` of its own; it is re-projected — refreshed,
 * never duplicated — on later runs. That is bounded by `limit`.
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
import { DEFAULT_GRAPH_SYNC_CONFIG, type GraphSyncConfig } from './graph-config.js';

/** `maintenance_runs.job_name` of the scheduled projector. */
export const GRAPH_SYNC_JOB_NAME = 'graph_sync';

/**
 * Four projections a day: `memory_links` only grows when the extractor runs
 * (nightly dream cycle / 12h entity backfill), so a tighter interval would
 * mostly re-scan and find nothing.
 */
export const GRAPH_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** `entity_type` of the per-memory placeholder node. */
export const MEMORY_ENTITY_TYPE = 'memory';

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
  /** Links that could not be projected (blank target, inactive memory, …). */
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
  target_entity: string;
  relation_type: string;
  confidence: unknown;
}

/**
 * Sentinel thrown inside the dry-run transaction: better-sqlite3 rolls back on
 * throw and offers no other way to abort a transaction, so the rollback *is*
 * the dry run.
 */
const DRY_RUN_ROLLBACK = Symbol('graph-sync dry-run');

/**
 * Organization names announce themselves with a suffix; a Latin given+family
 * name is a person. Everything else — including every CJK name, where the
 * extractor's surname heuristics are not available here — stays `concept`,
 * because guessing wrong splits one real entity into two rows under
 * `UNIQUE(canonical_name, entity_type)`. A two-word Title Case name is
 * indistinguishable from a person's name by shape alone and is classified as
 * `person`. No rule produces `place`: nothing in `memory_links` distinguishes a
 * place from any other noun.
 */
const ORGANIZATION_NAME_RE =
  /(公司|集团|大学|学院|研究院|研究所|实验室|医院|Inc\.?|Corp\.?|Ltd\.?|LLC|GmbH|S\.A\.)$/i;
const PERSON_NAME_RE = /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}$/;

export function inferEntityType(name: string): string {
  const trimmed = name.trim();
  if (ORGANIZATION_NAME_RE.test(trimmed)) return 'organization';
  if (PERSON_NAME_RE.test(trimmed)) return 'person';
  return 'concept';
}

/**
 * Memories with links that are not in the graph yet, oldest first.
 *
 * A memory counts as projected once any edge carries its id as
 * `source_memory_id`. Per-link coverage cannot be used here: the subject's own
 * link never becomes an edge (it *is* the subject), so it would look
 * unprojected forever.
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
  return db
    .prepare(BATCH_MEMORY_SQL)
    .all({ memoryLimit: limit, minConfidence }) as BatchMemoryRow[];
}

/** All links of the batch's memories, hottest first (the subject is chosen by order). */
function readLinksByMemory(db: Database.Database, memoryIds: string[]): Map<string, LinkRow[]> {
  const grouped = new Map<string, LinkRow[]>();
  if (memoryIds.length === 0) return grouped;

  const placeholders = memoryIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT ml.id AS link_id,
              ml.source_memory_id AS source_memory_id,
              ml.target_entity AS target_entity,
              ml.relation_type AS relation_type,
              ml.confidence AS confidence
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

function isUsableLink(link: LinkRow, minConfidence: number): boolean {
  if (!link.target_entity.trim()) return false;
  if (!String(link.relation_type ?? '').trim()) return false;
  const confidence = Number(link.confidence);
  return Number.isFinite(confidence) && confidence >= minConfidence;
}

/**
 * Project `memory_links` into the entity graph.
 *
 * Safe to call repeatedly: a second call over unchanged data creates no rows.
 * Throws only when the database itself is unusable — every per-row problem is
 * counted in `skipped`.
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
      // A memory's links are projected as one group: splitting them would let
      // the subject flip between runs. `limit` therefore bounds the run to
      // `limit` links plus at most one group's worth.
      if (summary.linksProcessed >= limit) break;

      const links = linksByMemory.get(memory.memory_id) ?? [];
      const usable = links.filter((link) => {
        if (isUsableLink(link, minConfidence)) return true;
        summary.skipped++;
        logger?.debug(
          { linkId: link.link_id, memoryId: memory.memory_id },
          '[graph-sync] link skipped (blank target/relation or low confidence)',
        );
        return false;
      });
      if (usable.length === 0) continue;

      const anchor = usable[0]!;
      const hasSubject = usable.length > 1;
      const subjectName = hasSubject ? anchor.target_entity.trim() : `memory:${memory.memory_id}`;
      const subjectType = hasSubject ? inferEntityType(subjectName) : MEMORY_ENTITY_TYPE;
      const validFromMs = parseEpochMs(memory.memory_created_at);
      const validFrom = validFromMs > 0 ? validFromMs : Date.now();

      try {
        const subject = repo.upsertEntity({ name: subjectName, entityType: subjectType });
        upsertCalls++;

        for (const link of usable) {
          // The subject's own row carries the subject, not an edge.
          if (hasSubject && link === anchor) continue;

          const targetName = link.target_entity.trim();
          if (canonicalizeEntityName(targetName) === canonicalizeEntityName(subjectName)) {
            summary.skipped++;
            continue;
          }

          const target = repo.upsertEntity({
            name: targetName,
            entityType: inferEntityType(targetName),
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
          summary.linksProcessed++;
        }
        summary.memoriesProcessed++;
      } catch (err) {
        // One malformed memory must not abort the run: it stays unprojected and
        // the next pass retries it.
        summary.skipped += usable.length;
        logger?.warn(
          { memoryId: memory.memory_id, err: err instanceof Error ? err.message : String(err) },
          '[graph-sync] memory skipped',
        );
      }
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

/**
 * The `graph_sync` maintenance job.
 *
 * Registered on the existing `MaintenanceScheduler`, which already owns the
 * `maintenance_runs` bookkeeping (one row per run), the interval gate and the
 * per-job error isolation — so the graph can neither run on the turn path nor
 * take the memory pipeline down with it.
 */
export function createGraphSyncJob(
  db: Database.Database,
  config: GraphSyncConfig = DEFAULT_GRAPH_SYNC_CONFIG,
  logger: Logger = createLogger(),
): MaintenanceJob {
  const repo = new EntityRepository(db);
  return {
    name: GRAPH_SYNC_JOB_NAME,
    enabled: config.enabled,
    intervalMs: GRAPH_SYNC_INTERVAL_MS,
    async run({ dryRun, signal }): Promise<MaintenanceJobResult> {
      const start = Date.now();
      try {
        const summary = syncGraphFromMemoryLinks(db, repo, {
          limit: config.maxLinksPerRun,
          minConfidence: config.minConfidence,
          dryRun,
          signal,
          logger,
        });
        // Nothing extracted yet: report it instead of pretending a run happened.
        if (summary.memoriesProcessed === 0 && summary.linksProcessed === 0) {
          return {
            name: GRAPH_SYNC_JOB_NAME,
            status: 'skipped',
            dryRun,
            affectedRows: 0,
            durationMs: Date.now() - start,
            details: { reason: 'no_projectable_links', skipped: summary.skipped },
          };
        }
        return {
          name: GRAPH_SYNC_JOB_NAME,
          status: 'success',
          dryRun,
          affectedRows: summary.edgesCreated + summary.edgesRefreshed,
          durationMs: Date.now() - start,
          details: { ...summary },
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
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
