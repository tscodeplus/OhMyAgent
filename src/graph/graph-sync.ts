/**
 * GraphSync — materialises `entities`/`entity_edges` from `memory_links` and
 * from the memory text the links never covered.
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
 * The projection alone leaves most conversation history out of the graph: the
 * extractor links a handful of entities per turn, so a memory that talks about
 * Excel contributes nothing unless one link happens to name it. `mineGraphFromMemories`
 * closes that gap with deterministic mention mining (`entity-mining.ts`, still
 * no model call), and the same `graph_sync` job runs it right after the
 * projection — see "Mention mining" at the bottom of this file.
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
import { mineMentionedEntities, type MinedMention } from './entity-mining.js';
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

/**
 * Relation of a mined mention edge: "this memory's subject mentioned X".
 *
 * A mined mention carries no verb (deterministic extraction cannot tell
 * WORKS_AT from LIKES), so inventing one would put a claim in the graph that
 * nothing supports. MENTIONED is the one relation the text itself proves.
 */
export const MENTION_RELATION_TYPE = 'MENTIONED';

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
 * Mention mining — the second pass of `graph_sync`.
 *
 * Everything below this point reads `memories` instead of `memory_links`:
 * `mineGraphFromMemories` extracts names from text no link named and writes
 * them with the same `EntityRepository` the projection uses, so the graph gains
 * a deterministic, model-free floor underneath the LLM-derived relations. The
 * two passes are independent on purpose — the projection keeps its cursor
 * (`source_memory_id` on links) and the mining pass keeps its own (an edge of
 * relation `MENTIONED`), so one can be disabled or re-tuned without corrupting
 * the other's progress.
 */
export interface GraphMiningOptions {
  /** Max memories mined by this call. Default `maxLinksPerRun` (500). */
  limit?: number;
  /** Max mentions taken from one memory. Default 8. */
  maxMentionsPerMemory?: number;
  /**
   * A mined name must appear in at least this many memories to become an entity,
   * unless the graph already knows it or it came from the curated vocabulary.
   * Default 2 — see buildMentionFilter for why one occurrence is not enough.
   */
  minDocumentFrequency?: number;
  /** Run the whole pass, then roll it back — nothing is written. */
  dryRun?: boolean;
  /** Cooperative cancellation between memories (scheduler timeout). */
  signal?: AbortSignal;
  /** Optional sink for per-row diagnostics; silent when absent. */
  logger?: Logger;
}

export interface GraphMiningSummary {
  /** Memories that contributed at least one mention. */
  memoriesMined: number;
  /** Mentions accepted (the subject included) — every mention past the subject became an edge. */
  mentionsMined: number;
  entitiesCreated: number;
  entitiesMatched: number;
  edgesCreated: number;
  edgesRefreshed: number;
  /** Memories with nothing minable (blank/emoji/number-only content). */
  skipped: number;
}

interface MineableMemoryRow {
  memory_id: string;
  content: string;
  memory_kind: string | null;
  memory_scope: string | null;
  memory_created_at: string | null;
}

/**
 * Memories nothing has mined yet, oldest first.
 *
 * The marker is the same one the link projection uses — an edge carrying the
 * memory's id as `source_memory_id` — narrowed to `MENTIONED` edges so a memory
 * whose links produced only, say, a `WORKS_AT` edge is still mined for the
 * names in its text. Mined edges always carry `source_memory_id`, and a memory
 * with at least one mention always produces at least one edge, so a mined
 * memory drops out of this batch permanently; only memories with nothing to
 * mine (blank, emoji, numbers) are re-scanned, bounded by `limit`.
 */
const MINEABLE_MEMORY_SQL = `
SELECT m.id AS memory_id,
       m.content AS content,
       m.kind AS memory_kind,
       m.scope AS memory_scope,
       m.created_at AS memory_created_at
FROM memories m
WHERE m.status = 'active'
  AND trim(m.content) <> ''
  -- Two kinds are stored for bookkeeping, not as conversation content, and both
  -- mine as pure noise: the persona row is a distilled JSON profile (its keys and
  -- values read like entity names), and scene rows hold a path pointer
  -- ("scenes/<session>_<date>.md") whose fragments — the directory name, a uuid,
  -- two dates — are the worst offenders in the whole corpus.
  AND m.kind NOT IN ('persona', 'scene')
  AND NOT EXISTS (
    SELECT 1
    FROM entity_edges e
    WHERE e.source_memory_id = m.id
      AND e.relation_type = @mentionRelation
  )
ORDER BY m.created_at, m.id
LIMIT @memoryLimit
`;

function readMineableMemories(db: Database.Database, limit: number): MineableMemoryRow[] {
  return db.prepare(MINEABLE_MEMORY_SQL).all({
    memoryLimit: limit,
    mentionRelation: MENTION_RELATION_TYPE,
  }) as MineableMemoryRow[];
}

/**
 * Mine the memories no edge covers yet and write them into the graph.
 *
 * This is the second half of `graph_sync`: `syncGraphFromMemoryLinks` projects
 * what the extractor already found, this pass covers the (usually much larger)
 * remainder with heuristics from `entity-mining.ts` — no prompt, no network.
 *
 * Shape follows the link projection so one memory means one subject: the most
 * confident mention becomes the subject and every other mention becomes a
 * `MENTIONED` edge to it, which is what connects the mined nodes to each other
 * instead of parking each behind its own placeholder. A memory with a single
 * mention has no stated subject, so it uses the `memory:<id>` placeholder for
 * the same reason the link projection does.
 *
 * Safe to call repeatedly: mined edges are only created for memories that have
 * no `MENTIONED` edge yet, and `EntityRepository` upserts entities by canonical
 * name. Throws only when the database itself is unusable.
 */
export function mineGraphFromMemories(
  db: Database.Database,
  repo: EntityRepository,
  options: GraphMiningOptions = {},
): GraphMiningSummary {
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_GRAPH_SYNC_CONFIG.maxLinksPerRun));
  const maxMentionsPerMemory = Math.max(
    1,
    Math.floor(options.maxMentionsPerMemory ?? DEFAULT_GRAPH_SYNC_CONFIG.maxMentionsPerMemory),
  );
  const dryRun = options.dryRun === true;
  const { logger, signal } = options;

  const summary: GraphMiningSummary = {
    memoriesMined: 0,
    mentionsMined: 0,
    entitiesCreated: 0,
    entitiesMatched: 0,
    edgesCreated: 0,
    edgesRefreshed: 0,
    skipped: 0,
  };

  let upsertCalls = 0;
  let linkCalls = 0;

  const mine = db.transaction(() => {
    const batch = readMineableMemories(db, limit);
    if (batch.length === 0) return;

    const entitiesBefore = countRows(db, 'SELECT COUNT(*) AS cnt FROM entities');
    const edgesBefore = countRows(db, 'SELECT COUNT(*) AS cnt FROM entity_edges');

    // Two passes over the batch instead of one: extraction per memory, then a
    // corpus-level filter before anything is written.
    //
    // Per-memory extraction alone cannot tell a topic from a sentence fragment —
    // "Excel" and "问过" look equally plausible in isolation, and jieba happily
    // emits verbs. Across the batch the difference is stark: a real topic recurs
    // ("Excel" in 5 memories), a fragment is a one-off. So a name mentioned in a
    // single memory is dropped unless the graph already knows it (an existing
    // entity or alias) or it was found in the curated vocabulary.
    //
    // Cheap, deterministic and explainable — no model call and no per-name
    // judgement to disagree with later.
    const extracted = batch.map((memory) => ({
      memory,
      mentions: mineMentionedEntities(
        {
          id: memory.memory_id,
          content: memory.content,
          kind: memory.memory_kind ?? undefined,
          scope: memory.memory_scope ?? undefined,
          created_at: memory.memory_created_at,
        },
        { maxMentions: maxMentionsPerMemory },
      ),
    }));
    // A document-frequency cutoff needs a corpus to measure. With a handful of
    // memories every name occurs once, so applying the cutoff would throw away
    // every non-vocabulary entity and leave a single subject per memory — the
    // graph would look better populated on a large corpus and half-empty on a
    // fresh install, for no reason the user could see. So the cutoff only
    // engages once the batch is at least twice the threshold in size.
    const requestedMinDf = optionMinDocumentFrequency(options);
    const effectiveMinDf = batch.length >= requestedMinDf * 2 ? requestedMinDf : 1;
    const mentionFilter = buildMentionFilter(db, extracted, effectiveMinDf);

    for (const { memory, mentions: rawMentions } of extracted) {
      if (signal?.aborted) break;

      const mentions = rawMentions.filter((mention) => mentionFilter(mention));
      if (mentions.length === 0) {
        summary.skipped++;
        logger?.debug(
          { memoryId: memory.memory_id },
          '[graph-mine] memory skipped (no minable mention)',
        );
        continue;
      }

      const subjectMention = mentions[0]!;
      const hasSubject = mentions.length > 1;
      const subjectName = hasSubject ? subjectMention.name : `memory:${memory.memory_id}`;
      const subjectType = hasSubject ? inferEntityType(subjectName) : MEMORY_ENTITY_TYPE;
      const validFromMs = parseEpochMs(memory.memory_created_at);
      const validFrom = validFromMs > 0 ? validFromMs : Date.now();

      try {
        const subject = repo.upsertEntity({ name: subjectName, entityType: subjectType });
        upsertCalls++;

        for (const mention of mentions) {
          if (hasSubject && mention === subjectMention) continue;

          const target = repo.upsertEntity({
            name: mention.name,
            entityType: inferEntityType(mention.name),
          });
          upsertCalls++;

          repo.linkEntities({
            sourceId: subject.id,
            targetId: target.id,
            relationType: MENTION_RELATION_TYPE,
            // The edge claims the subject mentions the target, so it is only as
            // trustworthy as the weaker of the two extractions.
            confidence: Math.min(subjectMention.confidence, mention.confidence),
            sourceMemoryId: memory.memory_id,
            validFrom,
          });
          linkCalls++;
        }

        summary.memoriesMined++;
        summary.mentionsMined += mentions.length;
      } catch (err) {
        // One malformed memory must not abort the run; it stays unmined and the
        // next pass retries it.
        summary.skipped++;
        logger?.warn(
          { memoryId: memory.memory_id, err: err instanceof Error ? err.message : String(err) },
          '[graph-mine] memory skipped',
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
    mine();
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
 *
 * One job, two passes, in this order: the link projection first (it carries the
 * extractor's LLM-derived relations, which are better than any heuristic), then
 * the mention mining over the memories it did not cover. They share one
 * `maintenance_runs` row and one `limit` per run — each pass applies it to its
 * own unit (links, memories) — so enabling mining does not double the run cost.
 */
export function createGraphSyncJob(
  db: Database.Database,
  config: GraphSyncConfig = DEFAULT_GRAPH_SYNC_CONFIG,
  logger: Logger = createLogger(),
): MaintenanceJob {
  const repo = new EntityRepository(db);
  const emptyMining: GraphMiningSummary = {
    memoriesMined: 0,
    mentionsMined: 0,
    entitiesCreated: 0,
    entitiesMatched: 0,
    edgesCreated: 0,
    edgesRefreshed: 0,
    skipped: 0,
  };
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
        const mined = config.mineMentions
          ? mineGraphFromMemories(db, repo, {
              limit: config.maxLinksPerRun,
              maxMentionsPerMemory: config.maxMentionsPerMemory,
              dryRun,
              signal,
              logger,
            })
          : emptyMining;
        const affectedRows =
          summary.edgesCreated + summary.edgesRefreshed + mined.edgesCreated + mined.edgesRefreshed;
        // Nothing extracted, nothing minable: report it instead of pretending a
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
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

/** Mention must occur in at least this many of the batch's memories. */
const DEFAULT_MIN_DOCUMENT_FREQUENCY = 2;

function optionMinDocumentFrequency(options: GraphMiningOptions): number {
  const value = Number(options.minDocumentFrequency ?? DEFAULT_MIN_DOCUMENT_FREQUENCY);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_MIN_DOCUMENT_FREQUENCY;
}

/**
 * Predicate that decides whether a mined mention survives the corpus filter.
 *
 * Kept as a closure over the counts so the write loop stays a plain loop, and
 * so the reason a mention was dropped is visible in one place:
 *   - seen in >= minDocumentFrequency memories of this batch, or
 *   - already an entity/alias (the graph learned it earlier — dropping it now
 *     would make the graph oscillate between runs), or
 *   - identified by the curated vocabulary rather than position heuristics.
 */
function buildMentionFilter(
  db: Database.Database,
  extracted: Array<{ memory: { memory_id: string }; mentions: MinedMention[] }>,
  minDocumentFrequency: number,
): (mention: MinedMention) => boolean {
  const counts = new Map<string, number>();
  for (const { mentions } of extracted) {
    const seenHere = new Set<string>();
    for (const mention of mentions) {
      const key = canonicalizeEntityName(mention.name);
      if (!key || seenHere.has(key)) continue;
      seenHere.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const known = new Set<string>();
  for (const row of db.prepare('SELECT canonical_name FROM entities').all() as Array<{
    canonical_name: string;
  }>) {
    known.add(row.canonical_name);
  }
  const aliasColumn = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'entity_aliases'")
    .get()
    ? (db.prepare('PRAGMA table_info(entity_aliases)').all() as Array<{ name: string }>).some(
        (column) => column.name === 'alias',
      )
    : false;
  if (aliasColumn) {
    for (const row of db.prepare('SELECT alias FROM entity_aliases').all() as Array<{
      alias: string;
    }>) {
      const key = canonicalizeEntityName(row.alias);
      if (key) known.add(key);
    }
  }

  return (mention: MinedMention): boolean => {
    const key = canonicalizeEntityName(mention.name);
    if (!key) return false;
    if (known.has(key)) return true;
    if (mention.source === 'vocabulary') return true;
    return (counts.get(key) ?? 0) >= minDocumentFrequency;
  };
}
