/**
 * Structural hints — the relations the graph already knows about the memories a
 * caller just retrieved.
 *
 * The graph's edges had exactly one consumer (the WebUI), so a correct edge never
 * changed an answer. This is the cheapest possible consumer: no model call, no
 * ranking effect, one indexed query, and the hint block is explicitly marked as
 * incomplete so the agent can tell a retrieved memory from a graph neighbour.
 *
 * Two deliberate limits:
 *
 *   - **Hints never reorder results.** An edge is derived from a memory; letting
 *     it raise that memory's score would turn one bad edge into a ranking bug on
 *     top of a content bug. They are appended, never merged into the score.
 *   - **Every hint carries its source memory.** `Python —USES→ excel-mcp` was
 *     real output at one point; a hint you cannot trace back to the sentence that
 *     produced it is a claim taken on faith.
 */

import type Database from 'better-sqlite3';

export interface GraphHint {
  subject: string;
  relation: string;
  object: string;
  /** The memory that stated this relation. */
  memoryId: string;
  /** Short form for display, so the agent can quote it without a wall of id. */
  memoryRef: string;
}

export interface HintOptions {
  /** Hard cap on hints, across all seeds. */
  limit?: number;
  /** Ignore edges the projection kept but does not trust. */
  minConfidence?: number;
}

const DEFAULT_HINT_LIMIT = 6;
const DEFAULT_HINT_CONFIDENCE = 0.6;

const HINT_SQL = `
SELECT
  -- The stored spelling, not the canonical key: a hint is read by a human (and
  -- quoted by a model), and a lowercased form is not how the corpus writes it.
  coalesce(nullif(trim(s.name), ''), s.canonical_name) AS subject,
  e.relation_type AS relation,
  coalesce(nullif(trim(t.name), ''), t.canonical_name) AS object,
  e.source_memory_id AS memory_id
FROM entity_edges e
JOIN entities s ON s.id = e.source_entity_id
JOIN entities t ON t.id = e.target_entity_id
WHERE e.valid_to IS NULL
  AND e.confidence >= @minConfidence
  AND e.source_memory_id IN (SELECT value FROM json_each(@memoryIds))
ORDER BY e.confidence DESC, subject ASC
LIMIT @limit
`;

function hasGraphTables(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('entities', 'entity_edges')`,
    )
    .get() as { n: number };
  return row.n === 2;
}

/**
 * Hints for a set of memories. Empty when the graph has no edges among them,
 * which is the normal case on an install that never ran a backfill — callers must
 * treat "no hints" as ordinary, not as an error.
 */
export function readHintsForMemories(
  db: Database.Database,
  memoryIds: readonly string[],
  options: HintOptions = {},
): GraphHint[] {
  if (memoryIds.length === 0) return [];
  if (!hasGraphTables(db)) return [];
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_HINT_LIMIT));
  const minConfidence = options.minConfidence ?? DEFAULT_HINT_CONFIDENCE;
  try {
    const rows = db.prepare(HINT_SQL).all({
      memoryIds: JSON.stringify([...new Set(memoryIds)]),
      minConfidence,
      limit,
    }) as Array<{
      subject: string;
      relation: string;
      object: string;
      memory_id: string | null;
    }>;
    return rows
      .filter((row) => row.memory_id)
      .map((row) => ({
        subject: row.subject,
        relation: row.relation,
        object: row.object,
        memoryId: row.memory_id as string,
        memoryRef: (row.memory_id as string).slice(0, 8),
      }));
  } catch {
    // The hint layer is advisory: a query it cannot run must not fail a search.
    return [];
  }
}

/** `A —REL→ B [mem:xxxxxxxx]`, one line per hint. */
export function formatHints(hints: readonly GraphHint[]): string[] {
  return hints.map(
    (hint) => `${hint.subject} —${hint.relation}→ ${hint.object} [mem:${hint.memoryRef}]`,
  );
}
