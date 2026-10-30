/**
 * The writer half of the graph's materialised metrics (plan §4.3).
 *
 * `entity_graph_metrics` and `entity_components` are a **derived view** of the graph, and
 * this is their only producer: `graph_sync` calls it after every projection, `graph:reset`
 * clears it. Nothing in the read paths writes to them — a read surface that refreshed a
 * derived table would be the graph layer's version of a cache that owns its own
 * invalidation, and the two directions of that cycle are how a "read" starts taking
 * multi-second write locks on a phone.
 *
 * Recompute is always **full**, never incremental:
 *
 *   - the live pass is one union-find over the live edges plus two `GROUP BY`s, which is
 *     milliseconds at this corpus size;
 *   - an incremental pass would have to be right on three paths at once — an edge closed,
 *     a memory deleted, and a node merged across entity types (`graph-prune` folds
 *     duplicates). The merge is the dangerous one: it leaves rows pointing at an
 *     `entity_id` that no longer exists, and a phantom degree makes the ranking place a
 *     node on the canvas that cannot be opened.
 *
 * A full pass makes that class of bug impossible instead of unlikely.
 */

import type Database from 'better-sqlite3';
import {
  graphTablesPresent,
  readComponentMembership,
  readEntityMetricRows,
  tableExists,
  type ComponentMembershipRow,
  type EntityMetricRow,
} from './graph-query.js';

export interface MaterializeResult {
  /** Rows written to `entity_graph_metrics` (0 on a dry run). */
  metrics: number;
  /** Rows written to `entity_components` (0 on a dry run). */
  components: number;
  computedAt: number;
  dryRun: boolean;
}

/**
 * Recompute both tables from scratch.
 *
 * `dryRun` computes the same rows and throws them away — the maintenance runner's dry run
 * must report the same counts a real run would write, or an operator comparing them learns
 * nothing.
 */
export function materializeGraphMetrics(
  db: Database.Database,
  options: { dryRun?: boolean; now?: number } = {},
): MaterializeResult {
  const computedAt = options.now ?? Date.now();
  const dryRun = options.dryRun === true;

  // A pre-v10 database has no graph to measure: report zeros rather than letting the
  // foreign keys on the metric tables fail on a table that never existed.
  if (
    !graphTablesPresent(db) ||
    !tableExists(db, 'entity_graph_metrics') ||
    !tableExists(db, 'entity_components')
  ) {
    return { metrics: 0, components: 0, computedAt, dryRun };
  }

  const metrics: EntityMetricRow[] = readEntityMetricRows(db);
  const membership: ComponentMembershipRow[] = readComponentMembership(db);

  if (dryRun) {
    return { metrics: metrics.length, components: membership.length, computedAt, dryRun };
  }

  const insertMetric = db.prepare(
    `INSERT OR REPLACE INTO entity_graph_metrics
       (entity_id, degree_out, degree_in, degree_total, degree_live, mention_count, computed_at)
     VALUES (@entityId, @degreeOut, @degreeIn, @degreeTotal, @degreeLive, @mentionCount, @computedAt)`,
  );
  const insertComponent = db.prepare(
    `INSERT OR REPLACE INTO entity_components
       (entity_id, component_id, component_size, computed_at)
     VALUES (@entityId, @componentId, @componentSize, @computedAt)`,
  );

  // One transaction: a half-written snapshot is worse than none, because the read paths
  // would take the materialised branch (the table is non-empty) and mix two generations of
  // numbers in one panel.
  db.transaction(() => {
    db.prepare('DELETE FROM entity_graph_metrics').run();
    db.prepare('DELETE FROM entity_components').run();
    for (const row of metrics) insertMetric.run({ ...row, computedAt });
    for (const row of membership) insertComponent.run({ ...row, computedAt });
  })();

  return { metrics: metrics.length, components: membership.length, computedAt, dryRun };
}

/**
 * Drop the snapshot without recomputing it.
 *
 * Used by `graph:reset` (and by the legacy-cleanup migration): once the edges are gone the
 * stored degrees describe a graph that no longer exists, and the read paths would happily
 * serve them because the table is still non-empty.
 */
export function clearGraphMetrics(db: Database.Database): { metrics: number; components: number } {
  const cleared = { metrics: 0, components: 0 };
  if (tableExists(db, 'entity_graph_metrics')) {
    cleared.metrics = db.prepare('DELETE FROM entity_graph_metrics').run().changes;
  }
  if (tableExists(db, 'entity_components')) {
    cleared.components = db.prepare('DELETE FROM entity_components').run().changes;
  }
  return cleared;
}
