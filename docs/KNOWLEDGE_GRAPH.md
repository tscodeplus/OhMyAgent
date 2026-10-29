# Knowledge graph: rationale, rejected designs, measurements

> **Status**: rationale record, not architecture. `AGENTS.md` keeps the invariants an agent must not break; this file keeps the _why_ and the numbers that produced them, so a future change can be argued against evidence instead of taste.
> **Scope**: `src/graph/`, `src/memory/knowledge/`, `src/graph-export/`.
> **Baseline**: written 2026-10-29 against `136dff0`. Readings are point-in-time and do not need to stay current — the invariants do.

---

## 1. The one-sentence rule

**A node is a mention. An edge is a statement.**

They have different evidence, different admission rules, and different consumers. Every design failure in this area has been a violation of that split in one direction or the other:

| Direction                    | What it produced                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Statement treated as mention | Edges were ignored as retrieval evidence; the graph was drawn and never read.                                                                    |
| Mention treated as statement | 371 nodes and a graph full of co-occurrence that answers nothing; `Python —USES→ excel-mcp` from a memory that said Python must **not** be used. |

---

## 2. Invariants (also listed in `AGENTS.md`)

1. `MENTIONED` is never an `entity_edges` row. `projectMentionNodes()` admits nodes; the projector skips the link (`isMentionLink`).
2. An edge exists only when a producer asserted `(subject, relation, object)`; `source_memory_id` is the attribution, not a decoration.
3. Attestation is fail-open on what it cannot measure and fail-closed on what it can. A relation keyword must appear outside both endpoint spans and within `RELATION_EVIDENCE_WINDOW` (60 chars) of each; the nearest occurrence governs negation.
4. A fact that stops being true is **closed** (`valid_to`), never deleted.
5. `graph-prune` may only delete an open edge no memory attests (a closed edge is history), and duplicate entity nodes merge into the edge-bearing copy rather than being kept in parallel.
6. `status = 'active'` is a hard read filter in the knowledge layer; a `pending` page is invisible to search, injection and link resolution.
7. A column-adding migration must be registered **before** `applySchema()`; new-table migrations run after it. Every migration replays on every open.

8. **Direction is a gate, not an assumption.** `attestsRelation()` measures distance, and distance is symmetric, so `directionOf()` places the predicate between the two endpoint spans and returns `forward` / `reversed` / `unknown`. Only `reversed` is refused — at write time by `readTriple()` (quoted evidence first, the memory second) and at projection/prune time by `edgeIsRefused()`; `unknown` stays admissible, because a direction the text does not state is unprovable, not disproven. A passive marker (被/由/受/为…所/给/是…的, `used by`) keeps a sentence forward: it states the same relation in surface order, so calling it reversed would delete a true edge. The reason this is a gate and not a nicety: `closeContradictedEdges` closes the other open edges of the same `(subject, relation)`, so a reversed row retracts a true one from "current", and "closed, not deleted" does not help a reader who queries `valid_to IS NULL`. `pnpm graph:direction` reports the three counts read-only; the rule is code, and the passive list lives beside `RELATION_EVIDENCE`, never in config.

9. **A page links to an entity node; it never creates one.** `knowledge_pages.entity_id` is filled by a lookup on the canonicalised title (`migration-v21` backfills NULL-only, `KnowledgeRepository` resolves on insert and re-resolves only when the title moves). NULL is the truthful state for a page whose name no memory has attested — page-first is a legitimate order, and a page is not a producer that may vouch for a node. The read side is `entity_query`'s `pages` array, which is omitted (not empty) when the knowledge layer is absent: "no pages" and "no such layer" are different answers.

10. **An edge's weight ages at read time, and only when asked.** `entity_edges.confidence` is what the producer asserted and never changes after projection; `src/graph/decay.ts` computes `effective_confidence` from the edge's own `valid_from` to the instant being asked about (so `asOf` answers about that instant, not today), and it is omitted unless `memory.graph.decay_half_life_days` is a positive number. A stored decayed value would lose the producer's number, change what `asOf` means, and need a rewrite job. The stored number is never overwritten.

11. **A page link's predicate comes from the target's `page_type`.** `knowledge_links.relation_type` is derived from the closed set in `knowledge/types.ts` (`topic → ABOUT`, `project → PART_OF`, `decision → DECIDED_BY`, `entity → MENTIONS`, `snippet → QUOTES`) at write time and backfilled for existing rows. It is not parsed from the body and not configurable: the wikilink stays `[[page_type/slug]]`, which Obsidian already resolves, and the vocabulary stays in code for the same reason `RELATION_EVIDENCE` does.

---

## 3. Rejected design: promote `MENTIONED` into an edge

This is the single most tempting "improvement" in the codebase — the table already has 800+ mention rows and the graph looks empty. It fails mechanically, not aesthetically. Six consequences, in order of severity:

### 3.1 Self-healing stops working, permanently

```ts
// src/graph/entity-mining.ts:271-275
if (normalized === MENTION_RELATION_TYPE) return true; // nothing to attest
if (!pattern) return true;
if (!text) return true; // source memory gone ⇒ not disproven
```

`isTokenAlignedMention('' , name)` also returns `true` (fail-open on empty text, `entity-mining.ts:396`). Therefore `edgeIsRefused()` in `graph-prune.ts` is **always false** for a `MENTIONED` edge:

- the "delete open edges no memory attests" pass can never evict one;
- deleting the source memory leaves a zombie edge that no job will ever remove;
- the only remaining exit is `pnpm graph:reset`, i.e. rebuilding the whole graph to evict one row — the exact manual step `graph-prune` exists to eliminate.

### 3.2 The typed-relation backfill starves itself

`BATCH_MEMORY_SQL` (`graph-sync.ts:197-219`) treats a memory as projected when **any** edge carries its id — deliberately per-memory, because "several links of one memory can restate the same edge":

```sql
AND NOT EXISTS (SELECT 1 FROM entity_edges e WHERE e.source_memory_id = m.id)
```

Once every memory that mentions anything has a mention edge, every such memory reads as "projected" and is never selected for typed extraction again. The graph grows its noisiest rows and stops growing the ones with content.

### 3.3 Hints get flooded with co-occurrence

`HINT_SQL` (`neighborhood.ts:42-60`) filters on `valid_to IS NULL` and `confidence >= 0.6` only — never on `relation_type`. Mention confidence is the heuristic 0.75–0.9 band (`entity-mining.ts:896,951,989`), so every mention edge qualifies. `memory_recall`'s 6-slot hint block would be filled with "these two appeared in the same sentence", and hints are deliberately appended, never scored (`neighborhood.ts:12-20`) — so the cost is prompt tokens with no effect on ranking.

### 3.4 Degree centrality collapses into mention count

The WebUI overview orders by degree, then mention count, then name (`graph-routes.ts:381-385`). If mentions are edges, the two keys are the same number: "densest cluster" degrades to "most often named", and `?types=` filtering becomes nearly useless (one relation type left that anyone has).

### 3.5 Direction would be invented

`MENTIONED` is symmetric; `entity_edges` is directed and carries `valid_from`/`valid_to`. The implementation would have to either write two rows (double traversal, duplicate hits under a relation filter) or impose a canonical ordering (`A < B`) — an arrow with no evidence behind it. The graph already admits it cannot verify direction (`USES` reversed passes attestation); mention edges would make that true of every row.

### 3.6 Row-count and maintenance cost

Reference device: 868 links, 814 of them `MENTIONED`, against 2 that were edge-usable — the comparison is not "a few more rows", it is a different order of magnitude. `refusedEdgePlan` runs `EDGE_ATTESTATION_SQL`, a **three-table JOIN with no LIMIT**, on every `graph_sync`; `loadOverview` computes degree with a per-entity subquery. On a phone running a 6-hour maintenance job, that is real time spent to produce rows nothing can trust.

### The correct shape

Give mentions their own tier, never an edge:

- **statistics**: node admission (`projectMentionNodes`), `mentionNodesAdmitted` / `mentionNodesCreated`, overview tiebreaker — already implemented;
- **planning input**: a materialised `mention_count` (column or view) as a ranking input to `curate` admission, so "named n times, no page yet" becomes the curation queue;
- **traversal, if ever needed**: a separate read path (`readMentionNeighbors`) reachable only from an explicit `entity_query(include_mentions: true)` — never in hints, never in degree, never in `entity_edges`.

---

## 4. Measurements that produced the current rules

Kept because each one is the reason a rule exists. They are not targets and should not be "kept stable".

| Reading                                                                                                                                 | What it justified                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 17 of 18 edges were `MENTIONED`; traversal produced nothing                                                                             | `MENTIONED` never becomes an edge                                                                                |
| 868 links / 814 `MENTIONED` / 46 subject-less / 2 edge-usable on the reference device                                                   | The projection must read a producer-recorded subject, never derive one                                           |
| `entities` held 4 leftovers while 379 names were attestable; 38 memories named Ubuntu                                                   | `projectMentionNodes()` — node admission decoupled from edge admission                                           |
| 14 typed `memory_links` at confidence 0.9–0.95 from one 建议 occurrence (`如何称呼 —ADVISES→ 何称`, `复杂任务 —FOUNDED→ 何时`)          | Deterministic extractor emits `MENTIONED` only; token-boundary checks                                            |
| Device graph at 371 nodes / 0 edges after the vocabulary was too narrow                                                                 | `USES`/`DEPENDS_ON`/`PART_OF`/`EXTENDS` added to `RELATION_EVIDENCE`                                             |
| 200 extraction calls → 16 memories stated a relation → 9 edges passed the gates; 8 held up on manual review, 1 had a doubtful direction | Direction verification is the remaining weakness; do not add more relations before it                            |
| 1 of 20 provenance candidates provable, 6 ambiguous, 13 no evidence                                                                     | `provenance_backfill` stays stingy: one unambiguous message or no row                                            |
| Duplicate node groups 2 → 0 after `migration-v19`                                                                                       | `canonicalizeEntityName` folds `-`/`_`/space; the column is stored, so migration and function must ship together |

---

## 5. Known gaps

These are gaps in the design, not rules: each is verified against the code as of 2026-10-29, and none is covered by a rule in §2.

- **pages have no scope isolation** — `knowledge_pages` has no `scope` column, so a page curated from one IM chat is a candidate answer in every other chat on the same database, `findByTitleOrAlias` lets a curation in chat B _update_ chat A's page, and `/knowledge share` publishes to everyone. The identity needed to fix it already exists: `ToolDefinition.execute(args, ctx)` receives a `ToolExecutionContext` carrying `sessionId`, `channel`, `chatId` and `projectId` — the knowledge tools simply ignore the second argument. So the remaining work is inside the knowledge layer (a column, a unique index on `(page_type, scope, slug)`, and scope-aware repository/service/tools/curation/injection/API), not a platform change.

This file should not grow into a backlog. When a gap closes, delete it here and record the rule it produced in §2.

---

## 6. How to re-check

```bash
# Invariant 1: no mention edges should exist
sqlite3 data/app.db "SELECT relation_type, COUNT(*) FROM entity_edges GROUP BY 1;"

# Zombie edges: open edges whose source memory is gone
sqlite3 data/app.db "SELECT COUNT(*) FROM entity_edges WHERE valid_to IS NULL
  AND source_memory_id IS NOT NULL
  AND source_memory_id NOT IN (SELECT id FROM memories);"

# Duplicate nodes the fold should have merged
sqlite3 data/app.db "SELECT COUNT(*) FROM (SELECT canonical_name FROM entities
  GROUP BY 1 HAVING COUNT(*) > 1);"

# Mention-only names that never became pages (curation candidates)
sqlite3 data/app.db "SELECT target_entity, COUNT(DISTINCT source_memory_id) n
  FROM memory_links WHERE upper(relation_type)='MENTIONED'
  GROUP BY 1 HAVING n >= 3 ORDER BY n DESC LIMIT 20;"

pnpm graph:sync --dry-run   # self-heal plan without writing
```
