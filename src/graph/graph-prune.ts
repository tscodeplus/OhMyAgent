/**
 * Graph self-heal: evict the rows the current projection refuses.
 *
 * The projector only ever adds (`upsertEntity` / `linkEntities`), which is the
 * right default — a sync that also deletes has to be trusted with the whole
 * graph. But the rules have been tightened twice since the first projection ran
 * (relation attestation, then the mention-vs-edge admission split), and every
 * tightening left already-written edges that the new code would refuse sitting
 * in `entity_edges` forever. The only way to remove one was `pnpm graph:reset`,
 * i.e. deleting and rebuilding the whole graph to evict a single row — exactly
 * the manual step this layer exists to remove.
 *
 * Two repairs, both idempotent, both cheap when there is nothing to do:
 *
 *   - **Open edges no memory attests.** `valid_to IS NOT NULL` edges are history
 *     (a closed fact is still a true record of what was true then) and are left
 *     alone; an open edge that no longer passes the gates is a false statement
 *     and is deleted.
 *   - **Duplicate nodes.** `entities` is unique on `(canonical_name,
 *     entity_type)`, so two producers disagreeing about a type create two nodes
 *     for one name (`Power Query` as `person` from a relation, `concept` from a
 *     mention). A derived projection has no evidence for the distinction — it
 *     chose the type, it did not observe it — so the copies merge into the
 *     better-corroborated row (edges, then age), edges repointed first.
 *
 * This module deliberately depends only on `entity-mining.ts`: `graph-sync`
 * imports it for the scheduled run and `legacy-cleanup` imports the same
 * predicates for the migration path, and a shared module is what keeps the two
 * from drifting apart on "which edges are refused".
 */

import type Database from 'better-sqlite3';
import { attestsRelation, isTokenAlignedMention, isVouchableEntityName } from './entity-mining.js';

/** Batch size for the duplicate merge; matches the legacy cleanup's own batch. */
export const GRAPH_PRUNE_BATCH_SIZE = 500;

const DRY_RUN_ROLLBACK = Symbol('graph-prune dry-run');

export interface EdgeAttestationRow {
  id: string;
  relation: string;
  subject: string;
  target: string;
  content: string | null;
}

/**
 * Would the current projection refuse to draw this edge?
 *
 * The single definition of "refused", shared by the scheduled self-heal, the
 * migration cleanup and `graph:reset`.
 */
export function edgeIsRefused(row: EdgeAttestationRow): boolean {
  const text = row.content ?? '';
  if (!isVouchableEntityName(row.subject)) return true;
  if (!isVouchableEntityName(row.target)) return true;
  if (!isTokenAlignedMention(text, row.subject)) return true;
  if (!isTokenAlignedMention(text, row.target)) return true;
  return !attestsRelation(text, row.relation, row.subject, row.target);
}

/** Open edges with both endpoint names and the memory that stated them. */
export const EDGE_ATTESTATION_SQL = `SELECT e.id AS id, e.relation_type AS relation,
            s.name AS subject, t.name AS target,
            m.content AS content
       FROM entity_edges e
       JOIN entities s ON s.id = e.source_entity_id
       JOIN entities t ON t.id = e.target_entity_id
       LEFT JOIN memories m ON m.id = e.source_memory_id
      WHERE e.valid_to IS NULL
      ORDER BY e.created_at, e.id`;

/** Minimal batch-delete shape; `legacy-cleanup` keeps its own richer plans. */
export interface GraphDeletePlan {
  selectIds: (limit: number) => string[];
  deleteBatch: (ids: string[]) => number;
}

/** Open edges the current rules refuse, as a batch-deletable plan. */
export function refusedEdgePlan(db: Database.Database): GraphDeletePlan {
  const deleteEdge = db.prepare('DELETE FROM entity_edges WHERE id = ?');
  const rows = db.prepare(EDGE_ATTESTATION_SQL);
  return {
    selectIds: () =>
      (rows.all() as EdgeAttestationRow[]).filter(edgeIsRefused).map((row) => row.id),
    deleteBatch: (ids) => ids.reduce((sum, id) => sum + deleteEdge.run(id).changes, 0),
  };
}

/** Same name, different type: as a batch-deletable plan. */
export function duplicateNodePlan(db: Database.Database): GraphDeletePlan {
  const groups = db.prepare(
    `SELECT canonical_name AS canonical
       FROM entities
      GROUP BY canonical_name
     HAVING COUNT(*) > 1
      ORDER BY canonical_name`,
  );
  const members = db.prepare(
    `SELECT id, created_at,
            (SELECT COUNT(*) FROM entity_edges x
              WHERE x.source_entity_id = entities.id OR x.target_entity_id = entities.id) AS degree
       FROM entities WHERE canonical_name = ?`,
  );
  const loserEdges = db.prepare(
    `SELECT id, source_entity_id, target_entity_id, relation_type
       FROM entity_edges
      WHERE source_entity_id = @id OR target_entity_id = @id`,
  );
  const keeperEdge = db.prepare(
    `SELECT 1 FROM entity_edges
      WHERE relation_type = @relation
        AND ((source_entity_id = @a AND target_entity_id = @b)
          OR (source_entity_id = @b AND target_entity_id = @a))
      LIMIT 1`,
  );
  const repointSource = db.prepare(
    'UPDATE entity_edges SET source_entity_id = ? WHERE source_entity_id = ?',
  );
  const repointTarget = db.prepare(
    'UPDATE entity_edges SET target_entity_id = ? WHERE target_entity_id = ?',
  );
  // OR IGNORE: both copies carry their name as an alias, so a plain UPDATE hits
  // the (entity_id, alias) unique index. The leftover row is dropped below.
  const moveAlias = db.prepare(
    'UPDATE OR IGNORE entity_aliases SET entity_id = ? WHERE entity_id = ?',
  );
  const deleteAlias = db.prepare('DELETE FROM entity_aliases WHERE entity_id = ?');
  const deleteEdge = db.prepare('DELETE FROM entity_edges WHERE id = ?');
  const deleteEntity = db.prepare('DELETE FROM entities WHERE id = ?');

  /** loser id → keeper id; rebuilt on each selection so it never goes stale. */
  const losers = new Map<string, string>();
  const selectIds = (): string[] => {
    losers.clear();
    for (const group of groups.all() as Array<{ canonical: string }>) {
      const rows = members.all(group.canonical) as Array<{
        id: string;
        created_at: number;
        degree: number;
      }>;
      if (rows.length < 2) continue;
      const [keeper, ...rest] = rows.sort(
        (a, b) => b.degree - a.degree || Number(a.created_at) - Number(b.created_at),
      );
      for (const loser of rest) losers.set(loser.id, keeper.id);
    }
    return [...losers.keys()];
  };

  return {
    selectIds,
    deleteBatch: (ids) =>
      ids.reduce((sum, id) => {
        const keeperId = losers.get(id) ?? id;
        // Repoint first: the foreign-key cascade would otherwise take these
        // edges with the deleted node and a duplicate would silently cost a fact.
        for (const edge of loserEdges.all({ id }) as Array<{
          id: string;
          source_entity_id: string;
          target_entity_id: string;
          relation_type: string;
        }>) {
          const source = edge.source_entity_id === id ? keeperId : edge.source_entity_id;
          const target = edge.target_entity_id === id ? keeperId : edge.target_entity_id;
          if (source === target) {
            deleteEdge.run(edge.id);
            continue;
          }
          // Both copies may state the same thing; keeping both would stack a
          // duplicate statement that the projector then refreshes twice.
          const duplicate = keeperEdge.get({ relation: edge.relation_type, a: source, b: target });
          if (duplicate) {
            deleteEdge.run(edge.id);
            continue;
          }
          repointSource.run(keeperId, id);
          repointTarget.run(keeperId, id);
        }
        moveAlias.run(keeperId, id);
        deleteAlias.run(id);
        deleteEntity.run(id);
        return sum + 1;
      }, 0),
  };
}

export interface GraphSelfHealSummary {
  edgesPruned: number;
  nodesMerged: number;
}

/**
 * Apply both repairs in one transaction.
 *
 * `dryRun` runs the identical work and rolls it back, so the counts are what a
 * real run would do rather than a separate estimation path that can disagree.
 */
export function selfHealGraph(
  db: Database.Database,
  options: { dryRun?: boolean; log?: (message: string) => void } = {},
): GraphSelfHealSummary {
  const summary: GraphSelfHealSummary = { edgesPruned: 0, nodesMerged: 0 };
  if (!hasGraphTables(db)) return summary;

  const run = db.transaction(() => {
    const edges = refusedEdgePlan(db);
    summary.edgesPruned += edges.deleteBatch(edges.selectIds(GRAPH_PRUNE_BATCH_SIZE));
    const nodes = duplicateNodePlan(db);
    for (;;) {
      const ids = nodes.selectIds(GRAPH_PRUNE_BATCH_SIZE).slice(0, GRAPH_PRUNE_BATCH_SIZE);
      if (ids.length === 0) break;
      summary.nodesMerged += nodes.deleteBatch(ids);
    }
    if (options.dryRun === true) throw DRY_RUN_ROLLBACK;
  });

  try {
    run();
  } catch (err) {
    if (err !== DRY_RUN_ROLLBACK) throw err;
  }
  options.log?.(
    `[graph-prune] edges pruned: ${String(summary.edgesPruned)}, nodes merged: ${String(summary.nodesMerged)}`,
  );
  return summary;
}

function hasGraphTables(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM sqlite_master
        WHERE type = 'table' AND name IN ('entities', 'entity_edges')`,
    )
    .get() as { cnt: number } | undefined;
  return (row?.cnt ?? 0) === 2;
}
