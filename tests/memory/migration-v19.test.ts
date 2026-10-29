/**
 * Migration v19 — one entity per name.
 *
 * Measured need: `OhMyAgent` / `Oh My Agent` and `IndexTTS-2` / `IndexTTS2` were
 * separate nodes on the device. Because edges hang off node ids and the retrieval
 * expansion joins `memory_links` on the string, the same thing owned two
 * half-graphs. The order the migration runs in is the whole point: merging has to
 * happen while the stored keys are still distinct (`entities` is unique on
 * `(canonical_name, entity_type)`), and only then can the keys be rewritten.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../src/memory/db';
import { migrateV19 } from '../../src/memory/migration-v19';
import {
  canonicalizeEntityName,
  EntityRepository,
} from '../../src/memory/repositories/entity-repository';

describe('canonicalizeEntityName', () => {
  it('folds case, spaces and separators to one identity', () => {
    const forms = ['OhMyAgent', 'Oh My Agent', 'oh-my-agent', 'oh_my_agent', ' OH MY AGENT '];
    expect(new Set(forms.map(canonicalizeEntityName))).toEqual(new Set(['ohmyagent']));
  });

  it('folds the version-suffix variants a corpus writes', () => {
    expect(canonicalizeEntityName('IndexTTS-2')).toBe(canonicalizeEntityName('IndexTTS2'));
    expect(canonicalizeEntityName('GLM 5.2')).toBe(canonicalizeEntityName('glm-5.2'));
  });

  it('keeps a dot, so a product name is not folded into a different word', () => {
    expect(canonicalizeEntityName('Node.js')).toBe('node.js');
    expect(canonicalizeEntityName('Node.js')).not.toBe(canonicalizeEntityName('Nodejs'));
  });
});

describe('migration-v19', () => {
  let db: Database.Database;
  let repo: EntityRepository;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oma-v19-'));
    db = openDatabase(join(dir, 'app.db'));
    repo = new EntityRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Insert a node with the *old* canonical rule, as a pre-v19 row looks. */
  function legacyEntity(name: string, entityType: string, createdAt: number): string {
    const id = `e-${name.replace(/\W+/g, '-')}-${entityType}`;
    db.prepare(
      `INSERT INTO entities (id, name, canonical_name, entity_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      name,
      name.trim().replace(/\s+/g, ' ').toLowerCase(),
      entityType,
      createdAt,
      createdAt,
    );
    db.prepare(`INSERT INTO entity_aliases (entity_id, alias, source) VALUES (?, ?, 'upsert')`).run(
      id,
      name.trim().replace(/\s+/g, ' ').toLowerCase(),
    );
    return id;
  }

  function seedMemory(id: string): void {
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, status, created_at, updated_at)
       VALUES (?, 'user', 'u', 'fact', 'text', 'active', '1', '1')`,
    ).run(id);
  }

  function edge(sourceId: string, targetId: string, relation: string, memoryId: string): void {
    db.prepare(
      `INSERT INTO entity_edges (id, source_entity_id, target_entity_id, relation_type, confidence,
                                 source_memory_id, valid_from)
       VALUES (?, ?, ?, ?, 0.9, ?, ?)`,
    ).run(`edge-${sourceId}-${targetId}`, sourceId, targetId, relation, memoryId, Date.now());
  }

  it('merges the nodes that fold to the same name and keeps their edges', () => {
    const a = legacyEntity('OhMyAgent', 'concept', 1);
    const b = legacyEntity('Oh My Agent', 'concept', 2);
    const other = legacyEntity('Termux', 'product', 3);
    seedMemory('m1');
    seedMemory('m2');
    edge(a, other, 'USES', 'm1');
    edge(b, other, 'USES', 'm2');

    const result = migrateV19(db);

    expect(result.merged).toBe(1);
    const nodes = db
      .prepare('SELECT name, canonical_name FROM entities ORDER BY name')
      .all() as Array<{
      name: string;
      canonical_name: string;
    }>;
    expect(nodes).toEqual([
      { name: 'OhMyAgent', canonical_name: 'ohmyagent' },
      { name: 'Termux', canonical_name: 'termux' },
    ]);
    // The graph stores one row per (source, relation, target) — `linkEntities`
    // refreshes the existing row rather than stacking a second — so the merge
    // collapses the two statements into one edge on the keeper, not two.
    expect(db.prepare('SELECT COUNT(*) AS n FROM entity_edges').get()).toEqual({ n: 1 });
    const surviving = db.prepare('SELECT source_entity_id AS s FROM entity_edges').get() as {
      s: string;
    };
    // Equal degree → the oldest wins, i.e. the spelling the corpus used first.
    expect(surviving.s).toBe(a);
  });

  it('rewrites stored canonical names written under the old rule', () => {
    const id = legacyEntity('IndexTTS-2', 'concept', 1);
    // Old rule kept the hyphen.
    expect(
      (
        db.prepare('SELECT canonical_name FROM entities WHERE id = ?').get(id) as {
          canonical_name: string;
        }
      ).canonical_name,
    ).toBe('indextts-2');

    const result = migrateV19(db);

    expect(result.renamedCanonical).toBe(1);
    expect(
      (
        db.prepare('SELECT canonical_name FROM entities WHERE id = ?').get(id) as {
          canonical_name: string;
        }
      ).canonical_name,
    ).toBe('indextts2');
  });

  it('lets the repository find the node by the folded name afterwards', () => {
    legacyEntity('IndexTTS-2', 'concept', 1);
    migrateV19(db);
    db.prepare('DELETE FROM entity_aliases').run();

    expect(repo.findByName('IndexTTS2')).toBeDefined();
    expect(repo.findByName('indextts2')).toBeDefined();
  });

  it('is idempotent', () => {
    legacyEntity('OhMyAgent', 'concept', 1);
    legacyEntity('Oh My Agent', 'concept', 2);
    migrateV19(db);
    const second = migrateV19(db);
    expect(second).toEqual({ merged: 0, renamedCanonical: 0, renamedAliases: 0 });
  });

  it('does nothing on a database without the graph tables', () => {
    const bare = openDatabase(join(dir, 'bare.db'));
    try {
      bare.prepare('DROP TABLE IF EXISTS entity_aliases').run();
      bare.prepare('DROP TABLE IF EXISTS entity_edges').run();
      bare.prepare('DROP TABLE IF EXISTS entities').run();
      expect(migrateV19(bare)).toEqual({ merged: 0, renamedCanonical: 0, renamedAliases: 0 });
    } finally {
      bare.close();
    }
  });
});
