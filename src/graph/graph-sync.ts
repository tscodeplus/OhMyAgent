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
 * Two kinds of row produce no **edge** — and every row that names an entity
 * produces a **node**, which is a different claim:
 *
 *   - **No subject** (`subject_entity IS NULL`) — the keyword extractor in
 *     `src/memory/entity-extractor.ts` assigns its relation keyword to *every*
 *     entity found in the text, so such a row says "this text contains a
 *     founding keyword and names Acme", not "X founded Acme". Picking the
 *     highest-confidence row as the subject is what put `SQLite` at the centre
 *     of a memory about vector search; the row keeps NULL and is skipped as an
 *     edge.
 *   - **`MENTIONED`** — co-occurrence is not a statement. Measured on the real
 *     database, 17 of 18 edges were `MENTIONED`, which is why traversing the
 *     graph produced nothing. Such rows stay in `memory_links` (they serve
 *     one-hop recall) and never reach `entity_edges`.
 *
 * Both still yield **nodes** through {@link projectMentionNodes}. A node asserts
 * "this corpus names X", which a mention does prove once the name survives the
 * same canonicalisation and token-boundary gates; an edge asserts "X is the
 * subject of this fact", which the same row does not. Coupling the two emptied
 * the graph: on the reference device 814 of 868 links were `MENTIONED`, so the
 * `entities` table held 4 leftovers while 379 names — `Ubuntu`, `Termux`,
 * `飞书` — were attestable. That is the same mistake the admission rules were
 * meant to prevent, in the other direction.
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
 * no cursor table for memories that project: a memory counts as projected once
 * one of its edges carries its id as `source_memory_id`, so the edges
 * themselves are the cursor. A memory whose rows are all unsubjected or
 * `MENTIONED` never records an edge and is therefore re-examined on later runs
 * — bounded by `limit`, and cheap because the batch is ordered and capped.
 *
 * The one case the edge-cursor cannot converge on — a memory whose
 * edge-eligible rows the JS gates refuse (`isVouchableEntityName`,
 * `isTokenAlignedMention`, `attestsRelation`, `directionOf` — none of which are
 * visible to SQL) — is answered by the **link-refusal ledger**
 * (`entity_link_refusals`, migration v23, the projector's answer to the same
 * problem v18's `entity_extraction_log` solves for the extraction model). Once
 * every edge-eligible link of a memory failed the current gates, a ledger row
 * removes it from the next batches until the gates change (`rule_version`) or
 * the memory is edited (`updated_at` vs `decided_at`), so a backlog of
 * gate-refused rows can no longer fill `limit` and starve later memories.
 *
 * The ledger row records a **verdict on the content under the current rules**,
 * never a bookmark on an edge. It is written only from the gate evaluation and
 * stays independent of edge existence on purpose: when self-heal or
 * `graph:reset` deletes an edge — for whatever reason — the memory falls back
 * into the batch, the same gates re-decide it, and the honest outcomes are
 * re-project or re-ledger. Nothing there can resurrect a permanent skip.
 *
 * A run distinguishes what it saw: `memoriesFresh` counts batch memories that
 * carried at least one edge-eligible candidate (they were actually scanned
 * against the gates), `memoriesStuck` the subset whose candidates ALL refused
 * and were ledgered. Zero stuck plus zero processed means "nothing new"; stuck
 * alone means "new garbage refused once" — two sentences the old `skipped`
 * statistic conflated.
 *
 * Failures are per-row: a malformed link is logged and skipped, and only a
 * broken database (prepare/transaction failure) reaches the caller.
 */

import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { createHash } from 'node:crypto';
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
  LINK_REFUSAL_RULE_VERSION,
  attestsRelation,
  isTokenAlignedMention,
  isVouchableEntityName,
  type MemoryLinkMiningSummary,
} from './entity-mining.js';
import { ENTITY_LINK_REFUSALS_TABLE } from '../memory/migration-v23.js';
import { discoverAliases } from './alias-discovery.js';
import { DEFAULT_GRAPH_SYNC_CONFIG, type GraphSyncConfig } from './graph-config.js';
import { selfHealGraph } from './graph-prune.js';

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
  /** Admit nodes from mentions, independently of edges. Default true. */
  projectMentionNodes?: boolean;
  /** Cap on nodes admitted per call, most-mentioned first. Default 2000. */
  maxMentionNodes?: number;
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
  /**
   * Nodes admitted from mentions in this run, i.e. entities that carry no edge
   * yet (`Ubuntu` is mentioned in 38 memories and states no fact in any of them).
   *
   * Admissions, not creations: a mention that merges into an already existing
   * node through an alias is admitted without a new `entities` row. Split into
   * created/already (P8 of the 2026-10-30 review) because the old
   * implementation counted every already-existing candidate as "admitted" on
   * every run, which read as if 2000 new nodes surfaced every six hours.
   */
  mentionNodesAdmitted: number;
  /** Of those, the ones that gained an `entities` row this run. */
  mentionNodesCreated: number;
  /**
   * Of the admitted ones, the names that already existed as nodes when the run
   * began (skipped without evidence sampling). Absent when the mention pass
   * did not run.
   */
  mentionNodesAlready?: number;
  /**
   * Batch memories this run evaluated that carried at least one edge-eligible
   * candidate link. `memoriesStuck` is its subset refused under the current
   * rules and ledgered; the remainder is the work still outstanding.
   */
  memoriesFresh?: number;
  /** Fresh memories whose every edge-eligible link the current rules refuse. */
  memoriesStuck?: number;
  /** Rows that could not be projected (blank target, inactive memory, self-loop, low confidence). */
  skipped: number;
  memoriesProcessed: number;
  linksProcessed: number;
}

interface BatchMemoryRow {
  memory_id: string;
  memory_created_at: string | null;
  /** Needed by `discoverAliases`: an abbreviation is only real if this text says so. */
  memory_content: string | null;
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
const BATCH_MEMORY_SELECT = `
SELECT m.id AS memory_id, m.created_at AS memory_created_at, m.content AS memory_content
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
  )`;

/**
 * The refusal ledger's exclusion clause, appended when
 * `entity_link_refusals` (migration v23) exists. The ledger row means "the JS
 * gates refuse every edge-eligible link of this content under rule version N";
 * SQL honours it only while the version still matches the gate set in code AND
 * the memory has not been edited since the verdict (`decided_at` >=
 * `updated_at`), because a gate bump or a content edit invalidates the verdict
 * and puts the memory back into the batch for re-evaluation (the row is then
 * rewritten or deleted — SQLite has no sha256, so the bumps ride on these two
 * columns rather than the stored hash).
 */
const BATCH_MEMORY_LEDGER_CLAUSE = `
  AND NOT EXISTS (
    SELECT 1
    FROM entity_link_refusals r
    WHERE r.memory_id = m.id
      AND r.rule_version = @ruleVersion
      AND r.decided_at >= CAST(m.updated_at AS INTEGER)
  )`;

function batchMemorySql(withLedger: boolean): string {
  return withLedger
    ? `${BATCH_MEMORY_SELECT}${BATCH_MEMORY_LEDGER_CLAUSE}
ORDER BY m.created_at, m.id
LIMIT @memoryLimit`
    : `${BATCH_MEMORY_SELECT}
ORDER BY m.created_at, m.id
LIMIT @memoryLimit`;
}

/** Ledger statements, prepared once per sync call when the table exists. */
interface LinkRefusalLedger {
  write: Database.Statement;
  clear: Database.Statement;
}

function openLinkRefusalLedger(db: Database.Database): LinkRefusalLedger | undefined {
  const present =
    db
      .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(ENTITY_LINK_REFUSALS_TABLE) !== undefined;
  if (!present) return undefined;
  return {
    write: db.prepare(`
      INSERT INTO entity_link_refusals (memory_id, content_hash, rule_version, decided_at)
      VALUES (@memoryId, @contentHash, @ruleVersion, @decidedAt)
      ON CONFLICT(memory_id) DO UPDATE SET
        content_hash = excluded.content_hash,
        rule_version = excluded.rule_version,
        decided_at = excluded.decided_at
    `),
    clear: db.prepare(`DELETE FROM ${ENTITY_LINK_REFUSALS_TABLE} WHERE memory_id = @memoryId`),
  };
}

/** Stable fingerprint of the text a verdict was decided on (parity with migration v18). */
function contentHashFor(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

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
  withLedger: boolean,
): BatchMemoryRow[] {
  const params: Record<string, unknown> = {
    memoryLimit: limit,
    minConfidence,
    mentionRelation: MENTION_RELATION_TYPE,
  };
  if (withLedger) params.ruleVersion = LINK_REFUSAL_RULE_VERSION;
  return db.prepare(batchMemorySql(withLedger)).all(params) as BatchMemoryRow[];
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

/**
 * The structural gates — everything the current rules refuse independent of a
 * config knob: blank relation/target, ungovernmentalizable names, fragments,
 * unattested predicates, self-loops. Kept as its own predicate because this is
 * exactly the refusal class the link-refusal ledger may remember (see the
 * batch SQL): the verdict is a property of the content and the gate vocabulary.
 * Confidence is deliberately NOT here — `minConfidence` is an operator knob,
 * and a memory hidden over a knob could not re-appear when the operator lowers
 * it without a manual ledger edit.
 */
function failsLinkGates(link: LinkRow): boolean {
  if (!link.target_entity.trim()) return true;
  if (!link.relation_type.trim()) return true;
  // Both endpoints have to read as entities and have to sit on token boundaries
  // of the memory that claims them. The measured failure mode was
  // `如何称呼 —ADVISES→ 何称 / 张奇` at confidence 0.95: every endpoint there is a
  // substring of the memory text, so only a boundary test can tell a name from a
  // slice. Enforcing it here (rather than deleting the rows) keeps the link as
  // retrieval evidence while stopping it from becoming a statement.
  if (!isVouchableEntityName(link.subject_entity)) return true;
  if (!isVouchableEntityName(link.target_entity)) return true;
  const content = link.memory_content ?? '';
  if (!isTokenAlignedMention(content, link.subject_entity ?? '')) return true;
  if (!isTokenAlignedMention(content, link.target_entity)) return true;
  // ...and the predicate itself has to be attested by the same text. A real
  // endpoint pair with a relation the sentence never states is still a false
  // statement: 穿衣建议 —ADVISES→ 周五 survived endpoint validation precisely
  // because the verb was part of the entity's own name.
  if (!attestsRelation(content, link.relation_type, link.subject_entity, link.target_entity)) {
    return true;
  }
  // A self-loop states nothing: the same name on both ends, however spelled.
  if (
    canonicalizeEntityName(link.subject_entity!.trim()) ===
    canonicalizeEntityName(link.target_entity.trim())
  ) {
    return true;
  }
  return false;
}

/** Projectable in structure but below the caller's confidence floor. */
function isLowConfidence(link: LinkRow, minConfidence: number): boolean {
  const confidence = Number(link.confidence);
  return !(Number.isFinite(confidence) && confidence >= minConfidence);
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
 * Names the link rows name, most-mentioned first.
 *
 * `UNION ALL` over both endpoints because a name can be a subject in one memory
 * and a target in another; the count is the only ordering signal available
 * without reading memory text, and it is the right one — the busiest names are
 * the ones a graph should show first.
 */
const MENTION_NODE_SQL = `
SELECT name, MAX(entity_type) AS entity_type, COUNT(*) AS mentions
FROM (
  SELECT trim(target_entity) AS name, trim(coalesce(target_entity_type, '')) AS entity_type
  FROM memory_links
  WHERE trim(coalesce(target_entity, '')) <> '' AND confidence >= @minConfidence
  UNION ALL
  SELECT trim(subject_entity) AS name, trim(coalesce(subject_entity_type, '')) AS entity_type
  FROM memory_links
  WHERE trim(coalesce(subject_entity, '')) <> '' AND confidence >= @minConfidence
)
GROUP BY name
ORDER BY mentions DESC, name ASC
LIMIT @cap
`;

/** Up to five memories that name a candidate — enough to find one clean mention. */
const MENTION_EVIDENCE_SQL = `
SELECT m.content AS content
FROM memory_links ml
JOIN memories m ON m.id = ml.source_memory_id
WHERE m.status = 'active'
  AND (trim(coalesce(ml.target_entity, '')) = @name OR trim(coalesce(ml.subject_entity, '')) = @name)
LIMIT @sample
`;

interface MentionNodeOutcome {
  /** Candidates the gates would admit — created rows plus already-existing names. */
  admitted: number;
  /** Of those, the names that already existed as nodes (skipped without sampling). */
  already: number;
}

/** Bound per `IN` clause of the batched node-existence check. */
const MENTION_EXISTENCE_CHUNK = 500;

/**
 * Canonical names that already exist as nodes, in one query per 500 candidates.
 *
 * The old implementation sampled evidence and called `findByName` per candidate
 * (~4000 queries in steady state on the reference device). A name that already
 * exists as a node gains nothing from this pass — re-admission is a no-op — so
 * one batched existence check replaces the two per-name queries entirely.
 */
function existingEntityCanonicalNames(db: Database.Database, names: string[]): Set<string> {
  const existing = new Set<string>();
  for (let index = 0; index < names.length; index += MENTION_EXISTENCE_CHUNK) {
    const chunk = names.slice(index, index + MENTION_EXISTENCE_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT DISTINCT canonical_name FROM entities WHERE canonical_name IN (${placeholders})`,
      )
      .all(...chunk) as Array<{ canonical_name: string }>;
    for (const row of rows) existing.add(row.canonical_name);
  }
  return existing;
}

/**
 * Admit entities from mentions, independently of edges.
 *
 * A node is a weaker claim than an edge and needs weaker evidence: the name has
 * to read as an entity (`isVouchableEntityName`) and to sit on token boundaries
 * of at least one memory that names it (`isTokenAlignedMention`). No relation, no
 * subject, no model — a `MENTIONED` row is precisely the assertion "this text
 * names this", and that is what a node records.
 *
 * Names that already exist as nodes are skipped before evidence sampling: the
 * gates can only re-confirm what some producer already admitted, so sampling is
 * reserved for genuinely new names and the steady-state run costs one grouped
 * query plus one batched `IN` check (never skip the pass — the candidate set is
 * always re-read, so a new mention is always seen).
 *
 * Counter semantics (corrected when the pass was batched, P8 of the 2026-10-30
 * review; AGENTS.md pins `mentionNodesAdmitted` / `mentionNodesCreated` as "the
 * node pass", not as distinct-nonzero counts): `already` reports the names that
 * existed before the run, `admitted` stays admissions total, and `created` is
 * measured by the caller as the `entities`-row delta — so a mention merging into
 * an existing node through an alias is admitted but not created, and the old
 * "2000 admitted every run" inflation is visible as `already` instead.
 *
 * Runs inside the caller's transaction so a dry run rolls the nodes back with
 * the edges.
 */
function projectMentionNodes(
  db: Database.Database,
  repo: EntityRepository,
  options: { minConfidence: number; cap: number },
): MentionNodeOutcome {
  const candidates = db.prepare(MENTION_NODE_SQL).all({
    minConfidence: options.minConfidence,
    cap: options.cap,
  }) as Array<{ name: string; entity_type: string | null; mentions: number }>;
  if (candidates.length === 0) return { admitted: 0, already: 0 };

  // Existence is checked on both sides in canonical form — the key `entities`
  // is unique on, SQLite's `IN` is case-sensitive, and `findByName` used to
  // apply the same fold per candidate.
  const existing = existingEntityCanonicalNames(
    db,
    candidates
      .map((candidate) => candidate.name.trim())
      .filter((name) => isVouchableEntityName(name))
      .map((name) => canonicalizeEntityName(name))
      .filter((canonical) => canonical !== ''),
  );

  const evidence = db.prepare(MENTION_EVIDENCE_SQL);
  let admitted = 0;
  let already = 0;

  for (const candidate of candidates) {
    const name = candidate.name.trim();
    if (!isVouchableEntityName(name)) continue;

    // Reuse an existing node whatever its type: `entities` is unique on
    // (canonical_name, entity_type), so a mention whose inferred type disagrees
    // with the one an edge established would otherwise create a *second* node
    // for the same name — `Alice Smith` twice, once `person` and once `concept`.
    // The edge's type is the better-informed one (it came from a typed
    // relation), so it wins by simply already existing.
    if (existing.has(canonicalizeEntityName(name))) {
      already++;
      admitted++;
      continue;
    }

    const rows = evidence.all({ name, sample: 5 }) as Array<{ content: string | null }>;
    if (rows.length === 0) continue;
    // One clean mention is enough: the gate is about whether this is a name in
    // *some* context, not about how the corpus spells it everywhere.
    const attested = rows.some((row) => isTokenAlignedMention(String(row.content ?? ''), name));
    if (!attested) continue;

    repo.upsertEntity({
      name,
      entityType: candidate.entity_type?.trim() || inferEntityType(name),
    });
    admitted++;
  }

  return { admitted, already };
}

/**
 * Project subject-bearing `memory_links` rows into the entity graph.
 *
 * Safe to call repeatedly: a second call over unchanged data creates no rows.
 * Throws only when the database itself is unusable — every per-row problem is
 * counted in the summary.
 */
/**
 * Aliases one memory states for one name, cached for the run.
 *
 * `upsertEntity` records them as `entity_aliases`, which makes the *next* lookup
 * of the abbreviation resolve to this node instead of forking a new one — the
 * merge happens through the existing lookup order, not through a repair pass.
 * Cached because a busy memory upserts the same few names many times, and the
 * scan is regex over the whole content.
 */
function makeAliasLookup(): (memoryId: string, text: string, name: string) => string[] {
  const cache = new Map<string, string[]>();
  return (memoryId, text, name) => {
    const key = JSON.stringify([memoryId, name.toLowerCase()]);
    const hit = cache.get(key);
    if (hit) return hit;
    const aliases = discoverAliases(text, name);
    cache.set(key, aliases);
    return aliases;
  };
}

export function syncGraphFromMemoryLinks(
  db: Database.Database,
  repo: EntityRepository,
  options: GraphSyncOptions = {},
): GraphSyncSummary {
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_GRAPH_SYNC_CONFIG.maxLinksPerRun));
  const minConfidence = options.minConfidence ?? DEFAULT_GRAPH_SYNC_CONFIG.minConfidence;
  const dryRun = options.dryRun === true;
  const { logger, signal } = options;
  const aliasesFor = makeAliasLookup();

  const summary: GraphSyncSummary = {
    entitiesCreated: 0,
    entitiesMatched: 0,
    edgesCreated: 0,
    edgesRefreshed: 0,
    edgesClosed: 0,
    linksWithoutSubject: 0,
    mentionLinksFiltered: 0,
    mentionNodesAdmitted: 0,
    mentionNodesCreated: 0,
    skipped: 0,
    memoriesProcessed: 0,
    linksProcessed: 0,
    // Always present so run details never have to guess whether the counters
    // were measured; `mentionNodesAlready` stays absent when the mention pass
    // did not run.
    memoriesFresh: 0,
    memoriesStuck: 0,
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

    const ledger = openLinkRefusalLedger(db);
    const batch = readBatchMemories(db, limit, minConfidence, ledger !== undefined);
    const linksByMemory = readLinksByMemory(
      db,
      batch.map((memory) => memory.memory_id),
    );

    for (const memory of batch) {
      if (signal?.aborted) break;
      if (summary.linksProcessed >= limit) break;

      const links = linksByMemory.get(memory.memory_id) ?? [];
      const content = memory.memory_content ?? '';
      let projectedHere = 0;
      // Per-memory bookkeeping for the refusal ledger. `edgeEligible` counts the
      // links the batch shape selected (subject named, not `MENTIONED`);
      // `lowConfidence` and `writeFailure` are the two refusal causes the
      // ledger must NOT record — one is an operator knob, the other a broken
      // write that the next pass should retry rather than remember.
      let edgeEligible = 0;
      let lowConfidence = 0;
      let writeFailure = false;

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
        edgeEligible++;
        if (failsLinkGates(link)) {
          summary.skipped++;
          logger?.debug(
            { linkId: link.link_id, memoryId: memory.memory_id },
            '[graph-sync] link refused by the gates (fragment name, unattested relation, self-loop)',
          );
          continue;
        }
        if (isLowConfidence(link, minConfidence)) {
          lowConfidence++;
          summary.skipped++;
          logger?.debug(
            { linkId: link.link_id, memoryId: memory.memory_id },
            '[graph-sync] link skipped (below min_confidence)',
          );
          continue;
        }

        const subjectName = link.subject_entity!.trim();
        const targetName = link.target_entity.trim();

        const validFromMs = parseEpochMs(memory.memory_created_at);
        const validFrom = validFromMs > 0 ? validFromMs : Date.now();

        try {
          const subject = repo.upsertEntity({
            name: subjectName,
            entityType: link.subject_entity_type?.trim() || inferEntityType(subjectName),
            aliases: aliasesFor(memory.memory_id, content, subjectName),
          });
          upsertCalls++;
          const target = repo.upsertEntity({
            name: targetName,
            entityType: link.target_entity_type?.trim() || inferEntityType(targetName),
            aliases: aliasesFor(memory.memory_id, content, targetName),
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
          writeFailure = true;
          summary.skipped++;
          logger?.warn(
            { linkId: link.link_id, memoryId: memory.memory_id, err: errMessage(err) },
            '[graph-sync] link skipped',
          );
        }
      }

      if (edgeEligible > 0) {
        summary.memoriesFresh = (summary.memoriesFresh ?? 0) + 1;
      }

      if (projectedHere > 0) {
        summary.memoriesProcessed++;
        // The memory carried a gate-passing link: whatever a ledger row said
        // under older rules is obsolete. Cheap enough to re-check on every
        // projected memory; the batch rarely delivers ledgered memories at all
        // (only on a rule bump or an edit), and the verdict changes hands here
        // rather than surviving stale.
        if (ledger) ledger.clear.run({ memoryId: memory.memory_id });
      } else if (edgeEligible > 0 && lowConfidence === 0 && !writeFailure) {
        // Every edge-eligible link of this memory failed the structural gates.
        // The count is a gate observation, so it is reported even when the
        // ledger table is absent (a fixture without migration v23); the write
        // is what needs the table.
        summary.memoriesStuck = (summary.memoriesStuck ?? 0) + 1;
        if (ledger) {
          // Ledger the refusal: a verdict on the content under the CURRENT
          // rules — written from the gate evaluation only, never from edge
          // existence, so a deleted edge (self-heal, `graph:reset`, a deleted
          // source memory elsewhere) drops the memory back into the batch and
          // the same gates re-decide it honestly instead of resurrecting an
          // obsolete skip. Dry runs write it too and the transaction rolls it
          // back with the projection: a rehearsal must not redirect the next
          // real run, but its summary still reports what it would have done.
          ledger.write.run({
            memoryId: memory.memory_id,
            contentHash: contentHashFor(content),
            ruleVersion: LINK_REFUSAL_RULE_VERSION,
            decidedAt: Date.now(),
          });
        }
      }
    }

    // Nodes last, and independently of the loop above: the batch query only
    // selects memories that carry an edge-eligible link, so a memory whose rows
    // are all `MENTIONED` (38 of them name `Ubuntu` on the reference device)
    // never enters the loop at all. Reading the names from `memory_links`
    // directly is what lets a mentioned-but-never-subject entity exist.
    //
    // Counted separately from the edge pass so `entitiesMatched` keeps meaning
    // "an edge upsert that hit an existing row" — the idempotency property a
    // caller can rely on. Mention upserts are idempotent too, they are just not
    // links, and mixing them made a re-run look like it had matched something.
    const entitiesAfterEdges = countRows(db, 'SELECT COUNT(*) AS cnt FROM entities');
    if (options.projectMentionNodes !== false) {
      const nodes = projectMentionNodes(db, repo, {
        minConfidence,
        cap: Math.max(
          1,
          Math.floor(options.maxMentionNodes ?? DEFAULT_GRAPH_SYNC_CONFIG.maxMentionNodes),
        ),
      });
      summary.mentionNodesAdmitted = nodes.admitted;
      summary.mentionNodesAlready = nodes.already;
      summary.mentionNodesCreated =
        countRows(db, 'SELECT COUNT(*) AS cnt FROM entities') - entitiesAfterEdges;
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
          projectMentionNodes: config.projectMentionNodes,
          maxMentionNodes: config.maxMentionNodes,
        });
        const affectedRows =
          summary.edgesCreated +
          summary.edgesRefreshed +
          summary.edgesClosed +
          mined.linksCreated +
          mined.linksAnnotated;

        // The projector never deletes, so an edge the current rules would refuse
        // (attestation tightened, mention-vs-edge admission split) would sit in
        // the table forever, and `graph:reset` was the only way to evict it.
        // Self-heal on every run instead: it is one indexed scan plus one GROUP
        // BY, and it keeps "did the graph need rebuilding?" from being a question
        // an operator has to answer.
        const healed = selfHealGraph(db, { dryRun });
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
              // stuck vs fresh disambiguate this branch: stuck counts
              // gate-refused memories this run ledgered, fresh the batch
              // memories that carried a candidate at all. stuck alone means
              // "new garbage refused once"; both zero means "nothing new".
              memoriesFresh: summary.memoriesFresh ?? 0,
              memoriesStuck: summary.memoriesStuck ?? 0,
              linksWithoutSubject: summary.linksWithoutSubject,
              mentionLinksFiltered: summary.mentionLinksFiltered,
              mined,
              healed,
            },
          };
        }
        return {
          name: GRAPH_SYNC_JOB_NAME,
          status: 'success',
          dryRun,
          affectedRows,
          durationMs: Date.now() - start,
          details: { ...summary, mined, healed },
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
