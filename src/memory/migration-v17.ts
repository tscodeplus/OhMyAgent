/**
 * Migration v17: repair the graph data the pre-K3 projector left behind.
 *
 * Unlike v2–v16 this migration adds no column and creates no table: the schema
 * is already correct, the *data* is not. A database that a pre-K3 build
 * projected holds `entity_type = 'memory'` placeholder nodes, `MENTIONED`
 * co-occurrence edges and `memory_links` rows with no subject, and the current
 * projector refuses all three — so the graph stayed empty until the operator ran
 * `pnpm graph:reset` → `graph:mine` → `graph:sync` by hand. An upgrade must not
 * need that.
 *
 * Three steps, all from `src/graph/legacy-cleanup.ts` (the same code the CLI
 * calls, so the migration and `pnpm graph:reset` cannot drift):
 *
 *   1. `cleanupLegacyGraph` — delete the placeholder nodes, the `MENTIONED`
 *      edges and the orphan edges;
 *   2. `backfillMemoryLinkSubjects` — record a subject on every link that has
 *      none, bounded by `memory.graph.max_links_per_run`;
 *   3. `projectGraphFromMemoryLinks` — rebuild `entities`/`entity_edges` from the
 *      surviving link rows.
 *
 * ## Which databases it actually touches
 * The common upgrade is *not* a pre-K3 one. The reference Termux device runs a
 * build from before the graph existed at all: `entities`/`entity_edges` are
 * created empty by v10 and `memory_links` holds ordinary pre-v15 rows with no
 * subject. There is no legacy projection there to delete, so step 1 is empty and
 * v17 must not reach steps 2–3: mining 712 memories on every boot on a phone is
 * exactly the per-start cost a replaying migration cannot afford.
 *
 * So steps 2–3 run only when step 1 found the pre-K3 projector's own signature
 * — a placeholder entity or a `MENTIONED` edge. Those two row kinds are what
 * pre-K3 code *wrote*; a subject-less link on its own is not evidence of
 * anything, because the keyword extractor still writes such rows today. That
 * leaves one honest gap, documented rather than papered over: on a database
 * whose links never had subjects but which pre-K3 code never projected either,
 * the backfill and projection are the scheduled `graph_sync` job's work (every
 * 6 h, same `max_links_per_run` bound, same two passes) rather than the boot's.
 * Preferring a 6-hour delay over an unbounded boot scan is the tradeoff.
 *
 * ## Why it can run on every start
 * Migrations here are unconditional replays, not version-gated one-shots, so the
 * cost of the steady state is the cost of every boot. `countLegacyGraphRows`
 * therefore reads only `entities` and `entity_edges` — two subselects, no
 * `memories` scan, no `memory_links` scan — and the migration returns
 * immediately when they are empty. There is no meta table for a one-shot marker
 * and none is needed: the absence of legacy rows *is* the marker, and it cannot
 * go stale the way a version flag can.
 *
 * Note the ordering constraint this module lives with: it runs after
 * `applySchema()`, so on a device upgrading from a pre-graph build it runs in the
 * very open() call that created `entities`/`entity_edges`. Empty tables are the
 * expected input there, not an error edge case.
 *
 * ## Cost and failure
 * No model call anywhere: mining is regex + jieba, the projection re-reads
 * `memory_links`. Each pass keeps its own small transactions (the 5000 ms
 * `busy_timeout` is shared with IM replies), and nothing here can delete a
 * memory, a knowledge page or a non-placeholder entity.
 */

import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import {
  backfillMemoryLinkSubjects,
  cleanupLegacyGraph,
  countLegacyGraphRows,
  emptyLegacyCleanupSummary,
  projectGraphFromMemoryLinks,
  type LegacyCleanupSummary,
} from '../graph/legacy-cleanup.js';
import type { MemoryLinkMiningSummary } from '../graph/entity-mining.js';
import type { GraphSyncSummary } from '../graph/graph-sync.js';

export interface MigrateV17Result {
  /** Rows the legacy cleanup deleted (all zero on a clean database). */
  cleaned: LegacyCleanupSummary;
  /**
   * What the subject backfill did. `linksCreated + linksAnnotated` is the number
   * of `memory_links` rows that actually changed, and is 0 once every link names
   * a subject.
   */
  mined: MemoryLinkMiningSummary;
  /** What the projection wrote. */
  projected: GraphSyncSummary;
}

function emptyMiningSummary(): MemoryLinkMiningSummary {
  return {
    memoriesMined: 0,
    mentionsMined: 0,
    linksCreated: 0,
    linksAnnotated: 0,
    skipped: 0,
  };
}

function emptyProjectionSummary(): GraphSyncSummary {
  return {
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
}

/**
 * Bring a pre-K3 database up to the shape a current install has.
 *
 * Safe to call on every startup, and cheap when there is nothing to repair: a
 * database that never ran the pre-K3 projector (every real device) has empty
 * `entities`/`entity_edges`, so this returns after one two-subselect query.
 * `logger` is forwarded to the two passes for per-row diagnostics — the summary
 * line belongs to the caller (`db.ts`).
 */
export function migrateV17(db: Database.Database, logger?: Logger): MigrateV17Result {
  const legacyRows = countLegacyGraphRows(db);
  if (legacyRows.placeholderEntities === 0 && legacyRows.deletableEdges === 0) {
    // The steady state for every install that was never pre-K3: no placeholder
    // node, no `MENTIONED` edge, no orphan edge. Nothing to delete, so nothing
    // to mine and nothing to project — those two are `graph_sync`'s work.
    logger?.debug('[migration-v17] no legacy graph rows — nothing to repair');
    return {
      cleaned: emptyLegacyCleanupSummary(),
      mined: emptyMiningSummary(),
      projected: emptyProjectionSummary(),
    };
  }

  const cleaned = cleanupLegacyGraph(db);

  // Only the pre-K3 projector's signature earns the backfill: it wrote
  // `memory:<id>` placeholders and `MENTIONED` edges, so their presence is what
  // says "the subject-less links here are its damage". Orphan edges alone are
  // ordinary database hygiene (a deleted memory leaves its edges behind) and
  // must not trigger a memories scan at boot; a device with 712 memories and 123
  // pre-v15 links would pay for one on every start forever.
  const preK3Projection = cleaned.placeholderEntities > 0 || cleaned.mentionEdges > 0;
  if (!preK3Projection) {
    logger?.debug(
      '[migration-v17] orphan edges removed only — leaving the subject backfill and projection to graph_sync',
    );
    return { cleaned, mined: emptyMiningSummary(), projected: emptyProjectionSummary() };
  }

  // Order matters: the placeholder nodes have to go before the backfill, or the
  // projection would find their edges still pointing at nodes nothing produces.
  const mined = backfillMemoryLinkSubjects(db, { logger });
  const projected = projectGraphFromMemoryLinks(db, { logger });

  return { cleaned, mined, projected };
}
