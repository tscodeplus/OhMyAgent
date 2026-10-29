/**
 * Migration v19: one entity per name, whatever punctuation the memory used.
 *
 * `canonicalizeEntityName` folded case and collapsed spaces, so `OhMyAgent`,
 * `Oh My Agent` and `IndexTTS-2` / `IndexTTS2` were separate nodes — and because
 * the retrieval expansion joins `memory_links` on the string and edges hang off
 * node ids, the same thing ended up with two half-graphs. On the device that was
 * two duplicate groups out of 378 nodes.
 *
 * Folding separators is only half the fix: `entities.canonical_name` is stored, so
 * rows written under the old rule keep the old key and would never match a lookup
 * computed under the new one. This migration therefore does both halves:
 *
 *   1. merge nodes whose *name* folds to the same key (edges repointed first, or
 *      the foreign-key cascade takes a fact with the duplicate), then
 *   2. rewrite the stored canonical names and aliases.
 *
 * Order matters: (1) has to run while the stored keys are still distinct, because
 * `entities` is unique on `(canonical_name, entity_type)` and rewriting first
 * would collide.
 *
 * Runs AFTER `applySchema()`, next to v17/v18, and is safe to replay: the merge
 * finds nothing the second time and the update matches no rows.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../app/logger.js';
import { duplicateNodePlan } from '../graph/graph-prune.js';
import { canonicalizeEntityName } from './repositories/entity-repository.js';

const logger = createLogger();

export interface MigrateV19Result {
  /** Nodes merged away into their fold-equivalent. */
  merged: number;
  /** Rows whose stored `canonical_name` changed. */
  renamedCanonical: number;
  /** Alias rows whose stored (already canonicalised) value changed. */
  renamedAliases: number;
}

/** The key the new rule computes for an entity's display name. */
function foldKey(name: string): string {
  return canonicalizeEntityName(name);
}

export function migrateV19(db: Database.Database): MigrateV19Result {
  const result: MigrateV19Result = { merged: 0, renamedCanonical: 0, renamedAliases: 0 };
  if (!tableExists(db, 'entities')) return result;

  const run = db.transaction(() => {
    // (1) Merge by folded *name*, before any stored key changes.
    const plan = duplicateNodePlan(db, { nameKey: foldKey });
    for (;;) {
      const ids = plan.selectIds(Number.MAX_SAFE_INTEGER);
      if (ids.length === 0) break;
      const deleted = plan.deleteBatch(ids);
      result.merged += deleted;
      if (deleted === 0) break;
    }

    // (2) Rewrite the stored keys. No same-type collision can remain after (1).
    const rows = db.prepare('SELECT id, name, canonical_name FROM entities').all() as Array<{
      id: string;
      name: string;
      canonical_name: string;
    }>;
    const updateCanonical = db.prepare('UPDATE entities SET canonical_name = ? WHERE id = ?');
    for (const row of rows) {
      const folded = foldKey(row.name);
      if (folded === row.canonical_name) continue;
      updateCanonical.run(folded, row.id);
      result.renamedCanonical++;
    }

    // Aliases are stored already canonicalised, so they carry the same staleness.
    const aliases = db.prepare('SELECT entity_id, alias FROM entity_aliases').all() as Array<{
      entity_id: string;
      alias: string;
    }>;
    const updateAlias = db.prepare(
      'UPDATE OR IGNORE entity_aliases SET alias = ? WHERE entity_id = ? AND alias = ?',
    );
    for (const row of aliases) {
      const folded = foldKey(row.alias);
      if (folded === row.alias) continue;
      if (updateAlias.run(folded, row.entity_id, row.alias).changes > 0) {
        result.renamedAliases++;
      } else {
        // The same alias already exists in its folded form for this entity.
        db.prepare('DELETE FROM entity_aliases WHERE entity_id = ? AND alias = ?').run(
          row.entity_id,
          row.alias,
        );
      }
    }
  });

  run();

  if (result.merged > 0 || result.renamedCanonical > 0) {
    logger.info(
      `[V19] Entity names folded: merged ${result.merged} duplicate node(s), ` +
        `rewrote ${result.renamedCanonical} canonical name(s) / ${result.renamedAliases} alias(es)`,
    );
  }
  return result;
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined
  );
}
