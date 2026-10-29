/**
 * Legacy graph repair — one implementation, two callers.
 *
 * Releases before K3 wrote a graph the current code cannot read:
 *
 *   - `entities` rows with `entity_type = 'memory'` and a `memory:<id>` name —
 *     the placeholder node the old projector created for a memory with a single
 *     link (9 of 22 entities on the reference database);
 *   - `entity_edges` rows whose relation is `MENTIONED` — co-occurrence only, so
 *     traversing them proves nothing (17 of 18 edges there);
 *   - edges whose endpoint or `source_memory_id` no longer exists, written while
 *     `PRAGMA foreign_keys` was off;
 *   - `memory_links` rows with `subject_entity IS NULL`. The projector only
 *     accepts a link that names its subject, so with zero subjects the graph
 *     could never be rebuilt from the surviving data at all.
 *
 * Repairing that used to be a manual sequence (`pnpm graph:reset` →
 * `graph:mine` → `graph:sync`), which is why an upgraded install looked broken
 * until someone ran it. This module is the shared implementation: migration v17
 * (`migrateV17`) runs the same steps at startup, and `scripts/graph-reset.ts`
 * delegates here instead of carrying its own copy of the SQL — that exact
 * duplication is why `pnpm graph:mine` disagreed with the projection for weeks.
 *
 * ## What a caller gets
 * Small functions over a plain `better-sqlite3` handle, each returning a count
 * object and nothing else:
 *
 *   `countLegacyGraphRows`    — the cheap guard: is there legacy graph data at all?
 *   `cleanupLegacyGraph`      — the deletes (the CLI's whole job)
 *   `backfillMemoryLinkSubjects` — the subject producer (`mineMemoryLinkSubjects`)
 *   `projectGraphFromMemoryLinks` — the projection (`syncGraphFromMemoryLinks`)
 *
 * The guard answers only the first question on purpose: a subject-less
 * `memory_links` row is *not* evidence of legacy damage (the keyword extractor
 * still writes those), so the two writers below are invoked by a caller that
 * separately decided the link backlog is pre-K3 damage — see `migrateV17`, where
 * that decision also keeps a 712-memory device from mining on every boot.
 * `graph_sync` calls the same two functions on its own schedule regardless.
 *
 * ## What cleanup may delete — and what it may never delete
 * Only the four row kinds listed above. A memory, a knowledge page and every
 * entity that is not a placeholder are out of reach: no statement here names
 * `memories`, `memories_fts*`, `knowledge_*` or an entity without
 * `entity_type = 'memory'`. Nothing is re-created either — `backfill` and
 * `project` read the surviving `memory_links` rows.
 *
 * ## Android/Termux
 * Every batch is its own transaction: the 5000 ms `busy_timeout` is shared with
 * IM replies, so one long write lock would make a Feishu/Telegram reply time
 * out. Every step is idempotent — a second call over the same data reports
 * zeros and writes nothing.
 */

import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { EntityRepository } from '../memory/repositories/entity-repository.js';
import {
  mineMemoryLinkSubjects,
  MENTION_RELATION_TYPE,
  type MemoryLinkMiningSummary,
} from './entity-mining.js';
import { duplicateNodePlan as duplicateNodePlanBase, refusedEdgePlan } from './graph-prune.js';
import { DEFAULT_GRAPH_SYNC_CONFIG } from './graph-config.js';
import {
  LEGACY_PLACEHOLDER_ENTITY_TYPE,
  syncGraphFromMemoryLinks,
  type GraphSyncSummary,
} from './graph-sync.js';

/** Rows removed per transaction when the caller does not say. */
export const DEFAULT_LEGACY_CLEANUP_BATCH_SIZE = 500;

export interface LegacyCleanupOptions {
  /** Rows removed per transaction. Default 500. */
  limit?: number;
  /** Do the work, report the counts, then roll everything back. */
  dryRun?: boolean;
  /** Optional sink for per-step progress; silent when absent. */
  log?: (message: string) => void;
}

export interface LegacyCleanupSummary {
  /** `entities` rows with `entity_type = 'memory'` deleted. */
  placeholderEntities: number;
  /** Edges deleted because one endpoint was such a placeholder. */
  placeholderEdges: number;
  /** Legacy co-occurrence edges (`MENTIONED`) deleted. */
  mentionEdges: number;
  /** Edges deleted because an endpoint no longer exists. */
  orphanEndpointEdges: number;
  /** Edges deleted because their `source_memory_id` no longer exists. */
  orphanMemoryEdges: number;
  /** Typed edges deleted because no memory attests the statement or its names. */
  unattestedEdges: number;
  /** Duplicate nodes deleted after being merged into the better-corroborated row. */
  duplicateNodes: number;
}

export interface LegacyGraphCounts {
  /** `entities` rows the cleanup would delete. */
  placeholderEntities: number;
  /**
   * Edges the cleanup would delete, for any of its three edge reasons. Together
   * with `placeholderEntities` this is the whole guard: two subselects over
   * `entities`/`entity_edges`, both of which are empty on an install that never
   * ran the pre-K3 projector.
   */
  deletableEdges: number;
}

export interface SubjectBackfillOptions {
  /** Max memories mined by this call. Default `memory.graph.max_links_per_run`. */
  limit?: number;
  /** Max mentions taken from one memory. Default `memory.graph.max_mentions_per_memory`. */
  maxMentionsPerMemory?: number;
  /** Per-row diagnostics go here; silent when absent. */
  logger?: Logger;
}

export interface GraphProjectionOptions {
  /** Max links projected by this call. Default `memory.graph.max_links_per_run`. */
  limit?: number;
  /** Links below this confidence are skipped. Default `memory.graph.min_confidence`. */
  minConfidence?: number;
  /** Per-row diagnostics go here; silent when absent. */
  logger?: Logger;
}

/**
 * Sentinel thrown inside the dry-run transaction: better-sqlite3 rolls back on
 * throw and offers no other way to abort a transaction.
 */
const DRY_RUN_ROLLBACK = Symbol('legacy-cleanup dry-run');

/**
 * Tables the three steps read. All of them are created by `applySchema()` or the
 * v10/v14 migrations, so a caller that runs before those (a hand-built test
 * database) gets an empty result instead of an exception.
 */
const REQUIRED_TABLES = ['memories', 'memory_links', 'entities', 'entity_edges'] as const;

/** Cheap "is there anything to repair" numbers, in one query over two small tables. */
const LEGACY_COUNT_SQL = `
SELECT
  (SELECT COUNT(*) FROM entities WHERE entity_type = @placeholderType) AS placeholderEntities,
  (SELECT COUNT(*)
     FROM entity_edges e
    WHERE upper(trim(e.relation_type)) = @mentionRelation
       OR NOT EXISTS (SELECT 1 FROM entities s WHERE s.id = e.source_entity_id)
       OR NOT EXISTS (SELECT 1 FROM entities t WHERE t.id = e.target_entity_id)
       OR (e.source_memory_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = e.source_memory_id))
  ) AS deletableEdges
`;

function hasTable(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/** Which of the tables the repair needs are absent (empty on a migrated database). */
export function missingGraphTables(db: Database.Database): string[] {
  return REQUIRED_TABLES.filter((table) => !hasTable(db, table));
}

/** A zeroed summary, so a caller that skips the work still returns the same shape. */
export function emptyLegacyCleanupSummary(): LegacyCleanupSummary {
  return {
    placeholderEntities: 0,
    placeholderEdges: 0,
    mentionEdges: 0,
    orphanEndpointEdges: 0,
    orphanMemoryEdges: 0,
    unattestedEdges: 0,
    duplicateNodes: 0,
  };
}

/**
 * Count what the cleanup would delete.
 *
 * This is the guard that keeps a replaying migration cheap: every migration in
 * this project runs on every `openDatabase()`. So it stays away from
 * `memory_links` and `memories` entirely — the dominant case is an install that
 * never ran the pre-K3 projector, where both tables below are empty (or list a
 * handful of real entities) and the answer is "nothing" in microseconds. A
 * count of unsubjected links would put a `memory_links` scan in the boot path
 * of every device while telling us nothing we act on: those rows belong to
 * `graph_sync` (see `migrateV17`).
 */
export function countLegacyGraphRows(db: Database.Database): LegacyGraphCounts {
  if (missingGraphTables(db).length > 0) {
    return { placeholderEntities: 0, deletableEdges: 0 };
  }
  const row = db.prepare(LEGACY_COUNT_SQL).get({
    placeholderType: LEGACY_PLACEHOLDER_ENTITY_TYPE,
    mentionRelation: MENTION_RELATION_TYPE,
  }) as LegacyGraphCounts | undefined;
  return {
    placeholderEntities: row?.placeholderEntities ?? 0,
    deletableEdges: row?.deletableEdges ?? 0,
  };
}

interface DeletePlan {
  key: keyof LegacyCleanupSummary;
  /** Ids still to remove; the batch loop repeats until this returns nothing. */
  selectIds: (limit: number) => string[];
  /** Remove one batch of ids; returns how many rows were actually deleted. */
  deleteBatch: (ids: string[]) => number;
}

function placeholderPlan(db: Database.Database, summary: LegacyCleanupSummary): DeletePlan {
  // Foreign-key cascades would do this on their own, but they only fire while
  // `PRAGMA foreign_keys` is on — and the data this cleans up was written by a
  // process that may have had it off. Deleting explicitly keeps the result
  // identical either way.
  const deleteEdges = db.prepare(
    'DELETE FROM entity_edges WHERE source_entity_id = ? OR target_entity_id = ?',
  );
  const deleteAliases = db.prepare('DELETE FROM entity_aliases WHERE entity_id = ?');
  const deleteEntity = db.prepare('DELETE FROM entities WHERE id = ?');
  return {
    key: 'placeholderEntities',
    selectIds: (limit) =>
      (
        db
          .prepare('SELECT id FROM entities WHERE entity_type = ? ORDER BY created_at, id LIMIT ?')
          .all(LEGACY_PLACEHOLDER_ENTITY_TYPE, limit) as Array<{ id: string }>
      ).map((row) => row.id),
    deleteBatch: (ids) => {
      let deleted = 0;
      for (const id of ids) {
        summary.placeholderEdges += deleteEdges.run(id, id).changes;
        deleteAliases.run(id);
        deleted += deleteEntity.run(id).changes;
      }
      return deleted;
    },
  };
}

function mentionEdgePlan(db: Database.Database): DeletePlan {
  const deleteEdge = db.prepare('DELETE FROM entity_edges WHERE id = ?');
  return {
    key: 'mentionEdges',
    selectIds: (limit) =>
      (
        db
          .prepare(
            `SELECT id FROM entity_edges
             WHERE upper(trim(relation_type)) = ?
             ORDER BY created_at, id
             LIMIT ?`,
          )
          .all(MENTION_RELATION_TYPE, limit) as Array<{ id: string }>
      ).map((row) => row.id),
    deleteBatch: (ids) => ids.reduce((sum, id) => sum + deleteEdge.run(id).changes, 0),
  };
}

function orphanEndpointPlan(db: Database.Database): DeletePlan {
  const deleteEdge = db.prepare('DELETE FROM entity_edges WHERE id = ?');
  return {
    key: 'orphanEndpointEdges',
    selectIds: (limit) =>
      (
        db
          .prepare(
            `SELECT e.id AS id
             FROM entity_edges e
             LEFT JOIN entities s ON s.id = e.source_entity_id
             LEFT JOIN entities t ON t.id = e.target_entity_id
             WHERE s.id IS NULL OR t.id IS NULL
             ORDER BY e.created_at, e.id
             LIMIT ?`,
          )
          .all(limit) as Array<{ id: string }>
      ).map((row) => row.id),
    deleteBatch: (ids) => ids.reduce((sum, id) => sum + deleteEdge.run(id).changes, 0),
  };
}

function orphanMemoryPlan(db: Database.Database): DeletePlan {
  const deleteEdge = db.prepare('DELETE FROM entity_edges WHERE id = ?');
  return {
    key: 'orphanMemoryEdges',
    selectIds: (limit) =>
      (
        db
          .prepare(
            `SELECT e.id AS id
             FROM entity_edges e
             WHERE e.source_memory_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = e.source_memory_id)
             ORDER BY e.created_at, e.id
             LIMIT ?`,
          )
          .all(limit) as Array<{ id: string }>
      ).map((row) => row.id),
    deleteBatch: (ids) => ids.reduce((sum, id) => sum + deleteEdge.run(id).changes, 0),
  };
}

/**
 * Edges whose statement the current code no longer attests.
 *
 * The projector only adds, so an edge it created before the endpoint and
 * relation checks existed stays forever. On the real device corpus that left
 * `穿衣建议 —ADVISES→ 周五` (the keyword was inside the entity's own name) and
 * `LTS —ADVISES→ 常规` (220 characters away, another clause) as false
 * statements with a provenance stamp. This step removes them, using the same
 * predicates the projector now applies: both endpoints vouchable and
 * token-aligned, the relation attested by the memory text, and the direction the
 * text states not provably reversed.
 *
 * The predicates are `edgeIsRefused`/`refusedEdgePlan` from `graph-prune.ts` —
 * imported, never re-derived, so the CLI, the migration and the scheduled heal
 * cannot disagree about which edges are refused.
 *
 * Runs as part of `cleanupLegacyGraph`, i.e. the CLI and the migration share it.
 */
function unattestedEdgePlan(db: Database.Database): DeletePlan {
  const plan = refusedEdgePlan(db);
  return {
    key: 'unattestedEdges',
    selectIds: (limit) => plan.selectIds(limit),
    deleteBatch: (ids) => plan.deleteBatch(ids),
  };
}

function duplicateNodePlan(db: Database.Database): DeletePlan {
  const plan = duplicateNodePlanBase(db);
  return {
    key: 'duplicateNodes',
    selectIds: (limit) => plan.selectIds(limit),
    deleteBatch: (ids) => plan.deleteBatch(ids),
  };
}

/**
 * Delete the legacy placeholder nodes, the `MENTIONED` edges and the orphan
 * edges, plus any edge the current projector would not create.
 *
 * Idempotent: a second call finds nothing and reports zeros. Memories, knowledge
 * pages and real entities are never touched.
 */
export function cleanupLegacyGraph(
  db: Database.Database,
  options: LegacyCleanupOptions = {},
): LegacyCleanupSummary {
  const summary = emptyLegacyCleanupSummary();
  if (missingGraphTables(db).length > 0) return summary;

  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_LEGACY_CLEANUP_BATCH_SIZE));
  const dryRun = options.dryRun === true;
  const { log } = options;

  const runStep = (plan: DeletePlan): void => {
    const deleteBatch = db.transaction((ids: string[]) => plan.deleteBatch(ids));
    for (;;) {
      const ids = plan.selectIds(limit);
      if (ids.length === 0) break;
      const deleted = deleteBatch(ids);
      summary[plan.key] += deleted;
      if (deleted === 0) break;
    }
    log?.(`[legacy-cleanup] ${plan.key}: ${String(summary[plan.key])}`);
  };

  const runAll = (): void => {
    runStep(placeholderPlan(db, summary));
    runStep(mentionEdgePlan(db));
    runStep(orphanEndpointPlan(db));
    runStep(orphanMemoryPlan(db));
    runStep(unattestedEdgePlan(db));
    runStep(duplicateNodePlan(db));
  };

  if (!dryRun) {
    runAll();
    return summary;
  }

  // Dry run: the same deletes inside one outer transaction, rolled back at the
  // end. Counting instead of deleting would report step 2 against data step 1
  // has not removed yet, so the numbers would not match a real run.
  const outer = db.transaction(() => {
    runAll();
    throw DRY_RUN_ROLLBACK;
  });
  try {
    outer();
  } catch (err) {
    if (err !== DRY_RUN_ROLLBACK) throw err;
  }
  return summary;
}

/**
 * Record a subject on the `memory_links` rows that have none.
 *
 * The pass itself is `mineMemoryLinkSubjects` — deterministic regex/jieba
 * heuristics, no model call, which is what makes it acceptable to run from a
 * migration. The bound is `memory.graph.max_links_per_run`, the same one the
 * scheduled `graph_sync` job uses, so a migration cannot do more work in one
 * boot than a normal maintenance run.
 */
export function backfillMemoryLinkSubjects(
  db: Database.Database,
  options: SubjectBackfillOptions = {},
): MemoryLinkMiningSummary {
  const { limit, maxMentionsPerMemory, logger } = options;
  return mineMemoryLinkSubjects(db, {
    limit: limit ?? DEFAULT_GRAPH_SYNC_CONFIG.maxLinksPerRun,
    maxMentionsPerMemory: maxMentionsPerMemory ?? DEFAULT_GRAPH_SYNC_CONFIG.maxMentionsPerMemory,
    logger,
  });
}

/**
 * Project the subject-bearing `memory_links` rows into `entities`/`entity_edges`.
 *
 * Same bound and same defaults as the scheduled job; the projection reads the
 * subject the backfill wrote and never derives one, which is what keeps the
 * placeholder nodes from coming back.
 */
export function projectGraphFromMemoryLinks(
  db: Database.Database,
  options: GraphProjectionOptions = {},
): GraphSyncSummary {
  const { limit, minConfidence, logger } = options;
  return syncGraphFromMemoryLinks(db, new EntityRepository(db), {
    limit: limit ?? DEFAULT_GRAPH_SYNC_CONFIG.maxLinksPerRun,
    minConfidence: minConfidence ?? DEFAULT_GRAPH_SYNC_CONFIG.minConfidence,
    logger,
  });
}
