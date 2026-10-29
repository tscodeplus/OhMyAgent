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

**Not yet an invariant — direction.** None of the three gates reads word order: `attestsRelation()` measures distance symmetrically, so `A —USES→ B` and `B —USES→ A` pass identically, and `readTriple()` checks that `evidence` _contains_ both endpoints without checking their order. A reversed edge is not merely noise: `closeContradictedEdges` closes other open edges for the same `(subject, relation)`, so one reversed row retracts a true one from "current". Until an order-aware check ships, treat any direction the text does not state as unverified.

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

- two graphs (entities × pages) are disconnected — no `knowledge_pages.entity_id`;
- the page graph is untyped and has no backlink query;
- `knowledge_fts_jieba.title` is `UNINDEXED` and the name leg is exact-match only;
- pages have no scope isolation;
- the model can receive hints but cannot query the graph (no depth / relation / asOf parameters);
- no graph eval, and graph hints are not covered by the injection reference probe;
- edge direction is unverified (see the note under §2) — no gate reads word order, so `A —USES→ B` and `B —USES→ A` both pass; the cheapest fix is an order-aware verdict that refuses only provably reversed pairs, with a passive-voice whitelist.

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
