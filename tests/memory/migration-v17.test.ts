/**
 * Migration v17: repairing a pre-K3 graph in place.
 *
 * The fixture is the measured shape of the reference database before the manual
 * `graph:reset` → `graph:mine` → `graph:sync` sequence: `memory:<id>` placeholder
 * nodes, `MENTIONED` co-occurrence edges, subject-less `memory_links` rows — plus
 * the things that must survive it (a real `FOUNDED` edge with a real subject, a
 * real entity, a memory, a knowledge page).
 *
 * Two properties are load-bearing here. `migrateV17` is a *replay*: every
 * migration in this project runs on every `openDatabase()`, so a second run must
 * find nothing and change nothing. And the work must be bounded: the backfill
 * mines at most `memory.graph.max_links_per_run` memories, because a migration
 * that walks the whole corpus at boot is a startup cost on a phone.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema';
import { migrateV10 } from '../../src/memory/migration-v10';
import { migrateV14 } from '../../src/memory/migration-v14';
import { migrateV17 } from '../../src/memory/migration-v17';
import { openDatabase } from '../../src/memory/db';
import { EntityRepository } from '../../src/memory/repositories/entity-repository';
import { mineMemoryLinkSubjects } from '../../src/graph/entity-mining';
import { LEGACY_PLACEHOLDER_ENTITY_TYPE } from '../../src/graph/graph-sync';
import { DEFAULT_GRAPH_SYNC_CONFIG } from '../../src/graph/graph-config';

const NOW = 1_700_000_000_000;

interface EntityRow {
  name: string;
  entity_type: string;
}

interface EdgeRow {
  relation_type: string;
  valid_to: number | null;
  source_memory_id: string | null;
}

interface LinkRow {
  id: string;
  target_entity: string;
  relation_type: string;
  subject_entity: string | null;
}

describe('migration-v17: repairing the pre-K3 graph', () => {
  let db: Database.Database;
  let repo: EntityRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    migrateV10(db);
    migrateV14(db);
    repo = new EntityRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedMemory(id: string, content: string, createdAt = NOW): void {
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, status, created_at, updated_at)
       VALUES (?, 'user', 'u1', 'fact', ?, 'active', ?, ?)`,
    ).run(id, content, String(createdAt), String(createdAt));
  }

  function seedLink(input: {
    id: string;
    memoryId: string;
    target: string;
    relation: string;
    confidence: number;
  }): void {
    db.prepare(
      `INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(input.id, input.memoryId, input.target, input.relation, input.confidence, String(NOW));
  }

  function seedPlaceholder(id: string): string {
    const entityId = `ent-${id}`;
    db.prepare(
      `INSERT INTO entities (id, name, canonical_name, entity_type, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).run(entityId, id, id, LEGACY_PLACEHOLDER_ENTITY_TYPE, NOW, NOW);
    return entityId;
  }

  function seedEdge(input: {
    id: string;
    source: string;
    target: string;
    relation: string;
    sourceMemoryId?: string | null;
  }): void {
    db.prepare(
      `INSERT INTO entity_edges (
         id, source_entity_id, target_entity_id, relation_type, confidence,
         source_memory_id, source_message_id, valid_from, valid_to, created_at
       ) VALUES (?, ?, ?, ?, 0.8, ?, NULL, ?, NULL, ?)`,
    ).run(
      input.id,
      input.source,
      input.target,
      input.relation,
      input.sourceMemoryId ?? null,
      NOW,
      NOW,
    );
  }

  function entities(): EntityRow[] {
    return db.prepare('SELECT name, entity_type FROM entities ORDER BY name').all() as EntityRow[];
  }

  function edges(): EdgeRow[] {
    return db
      .prepare(
        'SELECT relation_type, valid_to, source_memory_id FROM entity_edges ORDER BY relation_type',
      )
      .all() as EdgeRow[];
  }

  function links(): LinkRow[] {
    return db
      .prepare(
        `SELECT id, target_entity, relation_type, subject_entity
         FROM memory_links ORDER BY id`,
      )
      .all() as LinkRow[];
  }

  /** Full data snapshot, for "the second run changed literally nothing" assertions. */
  function snapshot(): string {
    return JSON.stringify({
      entities: entities(),
      edges: edges(),
      links: links(),
      memories: db.prepare('SELECT id, content, status FROM memories ORDER BY id').all(),
      pages: db.prepare('SELECT id, slug, status FROM knowledge_pages ORDER BY id').all(),
    });
  }

  /**
   * The reference database's pre-K3 shape, plus everything that must survive.
   *
   * Each legacy memory's text names its subject first and its link target
   * second, which is the real-world shape: the linker recorded the entity it
   * found, not the subject of the sentence.
   */
  function seedLegacyDatabase(): void {
    const alice = repo.upsertEntity({ name: 'Alice Smith', entityType: 'person' });
    const acme = repo.upsertEntity({ name: 'Acme Corp', entityType: 'organization' });
    const chengyu = repo.upsertEntity({ name: '程语', entityType: 'concept' });

    // The one legitimate fact in the graph, stated by a memory that exists.
    seedMemory('mem-legit', 'GitHub 上的 Alice Smith 创建了 Acme Corp');
    seedEdge({
      id: 'legit-founded',
      source: alice.id,
      target: acme.id,
      relation: 'FOUNDED',
      sourceMemoryId: 'mem-legit',
    });

    // Legacy co-occurrence between two real entities: not a statement.
    seedEdge({ id: 'mention-real', source: alice.id, target: chengyu.id, relation: 'MENTIONED' });

    // Two placeholder nodes and the co-occurrence edges that pointed at them.
    const placeholderA = seedPlaceholder('memory:m1');
    const placeholderB = seedPlaceholder('memory:m2');
    seedEdge({
      id: 'placeholder-a',
      source: placeholderA,
      target: chengyu.id,
      relation: 'MENTIONED',
    });
    seedEdge({ id: 'placeholder-b', source: placeholderB, target: acme.id, relation: 'MENTIONED' });

    // An edge whose memory is gone, and one whose endpoint is gone (written
    // while `PRAGMA foreign_keys` was off).
    seedEdge({
      id: 'orphan-memory',
      source: acme.id,
      target: chengyu.id,
      relation: 'EMPLOYS',
      sourceMemoryId: 'memory-that-is-gone',
    });
    db.pragma('foreign_keys = OFF');
    seedEdge({
      id: 'orphan-endpoint',
      source: alice.id,
      target: 'deleted-entity',
      relation: 'KNOWS',
    });
    db.pragma('foreign_keys = ON');

    // Three links written before the subject column existed.
    seedMemory('mem-a', 'TypeScript 升级之后 Excel 的兼容性要注意');
    seedLink({
      id: 'link-a',
      memoryId: 'mem-a',
      target: 'Excel',
      relation: 'AFFECTS',
      confidence: 0.8,
    });
    seedMemory('mem-b', 'Feishu 和 Telegram 的机器人差异很明显');
    seedLink({
      id: 'link-b',
      memoryId: 'mem-b',
      target: 'Telegram',
      relation: 'COMPARES',
      confidence: 0.7,
    });
    seedMemory('mem-c', 'SQLite 与 Redis 的写入性能对比');
    seedLink({
      id: 'link-c',
      memoryId: 'mem-c',
      target: 'Redis',
      relation: 'USES',
      confidence: 0.6,
    });

    // Knowledge pages are a different store; the cleanup may not touch them.
    db.prepare(
      `INSERT INTO knowledge_pages (id, page_type, slug, title, content, status, created_at, updated_at)
       VALUES ('page-1', 'topic', 'graph', 'Graph', 'body', 'active', ?, ?)`,
    ).run(NOW, NOW);
  }

  it('turns the pre-K3 shape into the post-migration shape', () => {
    seedLegacyDatabase();

    const result = migrateV17(db);

    // 1. Cleanup: the two placeholders took their edges with them, the real
    // co-occurrence edge went, and both orphan kinds went.
    expect(result.cleaned).toEqual({
      placeholderEntities: 2,
      placeholderEdges: 2,
      mentionEdges: 1,
      orphanEndpointEdges: 1,
      orphanMemoryEdges: 1,
      unattestedEdges: 0,
    });

    // 2. Subject backfill: the three legacy rows gained a subject. The
    // unlinked memory gained one `MENTIONED` row per extra mention it names
    // (its own subject is `GitHub`, so the two entities it talks about become
    // associations) — co-occurrence stays in `memory_links` and never becomes
    // an edge, which is why the projection below adds exactly three.
    expect(result.mined.linksAnnotated).toBe(3);
    expect(result.mined.linksCreated).toBe(2);
    expect(result.mined.memoriesMined).toBeGreaterThan(0);

    // 3. Projection rebuilt the graph from the surviving rows.
    expect(result.projected.edgesCreated).toBe(3);
    expect(result.projected.linksWithoutSubject).toBe(0);
    expect(result.projected.mentionLinksFiltered).toBe(0);

    // No placeholder node survives, and every real entity does.
    expect(entities()).toEqual([
      { name: 'Acme Corp', entity_type: 'organization' },
      { name: 'Alice Smith', entity_type: 'person' },
      { name: 'Excel', entity_type: 'concept' },
      { name: 'Feishu', entity_type: 'concept' },
      { name: 'Redis', entity_type: 'concept' },
      { name: 'SQLite', entity_type: 'concept' },
      { name: 'Telegram', entity_type: 'concept' },
      { name: 'TypeScript', entity_type: 'concept' },
      { name: '程语', entity_type: 'concept' },
    ]);

    // The legitimate fact survived; every MENTIONED and orphan edge is gone.
    expect(edges()).toEqual([
      { relation_type: 'AFFECTS', valid_to: null, source_memory_id: 'mem-a' },
      { relation_type: 'COMPARES', valid_to: null, source_memory_id: 'mem-b' },
      { relation_type: 'FOUNDED', valid_to: null, source_memory_id: 'mem-legit' },
      { relation_type: 'USES', valid_to: null, source_memory_id: 'mem-c' },
    ]);

    // Every link names its subject now, and the producer's own columns were
    // filled in rather than the row being replaced.
    const legacyLinks = links().filter((row) => row.id.startsWith('link-'));
    expect(legacyLinks).toEqual([
      {
        id: 'link-a',
        target_entity: 'Excel',
        relation_type: 'AFFECTS',
        subject_entity: 'TypeScript',
      },
      {
        id: 'link-b',
        target_entity: 'Telegram',
        relation_type: 'COMPARES',
        subject_entity: 'Feishu',
      },
      { id: 'link-c', target_entity: 'Redis', relation_type: 'USES', subject_entity: 'SQLite' },
    ]);
    expect(links().every((row) => (row.subject_entity ?? '') !== '')).toBe(true);
  });

  it('never deletes a memory, a knowledge page or a real entity', () => {
    seedLegacyDatabase();

    migrateV17(db);

    expect(db.prepare('SELECT COUNT(*) AS cnt FROM memories').get()).toEqual({ cnt: 4 });
    expect(db.prepare('SELECT id, slug, status FROM knowledge_pages').all()).toEqual([
      { id: 'page-1', slug: 'graph', status: 'active' },
    ]);
    expect(entities().filter((row) => row.entity_type === LEGACY_PLACEHOLDER_ENTITY_TYPE)).toEqual(
      [],
    );
    // The FOUNDED edge is the one statement in the database; it stays open.
    expect(edges().filter((row) => row.relation_type === 'FOUNDED')).toHaveLength(1);
  });

  it('is a no-op on a second run — the replay every startup performs', () => {
    seedLegacyDatabase();
    migrateV17(db);
    const afterFirst = snapshot();

    const second = migrateV17(db);

    expect(second.cleaned).toEqual({
      placeholderEntities: 0,
      placeholderEdges: 0,
      mentionEdges: 0,
      orphanEndpointEdges: 0,
      orphanMemoryEdges: 0,
      unattestedEdges: 0,
    });
    expect(second.mined.linksCreated).toBe(0);
    expect(second.mined.linksAnnotated).toBe(0);
    expect(second.mined.memoriesMined).toBe(0);
    expect(second.projected.entitiesCreated).toBe(0);
    expect(second.projected.edgesCreated).toBe(0);
    expect(second.projected.edgesRefreshed).toBe(0);
    expect(snapshot()).toBe(afterFirst);
  });

  it('does nothing at all on a graph that is already clean', () => {
    const alice = repo.upsertEntity({ name: 'Alice Smith', entityType: 'person' });
    const acme = repo.upsertEntity({ name: 'Acme Corp', entityType: 'organization' });
    repo.linkEntities({
      sourceId: alice.id,
      targetId: acme.id,
      relationType: 'WORKS_AT',
      confidence: 1,
      validFrom: NOW,
    });
    const before = snapshot();

    const result = migrateV17(db);

    expect(result.projected.edgesCreated).toBe(0);
    expect(result.mined.linksCreated).toBe(0);
    expect(snapshot()).toBe(before);
  });

  it('does not touch a database that has no graph tables yet', () => {
    const empty = new Database(':memory:');

    const result = migrateV17(empty);

    expect(result.cleaned.placeholderEntities).toBe(0);
    expect(result.projected.edgesCreated).toBe(0);
    empty.close();
  });

  it('bounds the backfill at max_links_per_run', () => {
    // 2000 memories, none of them linked — far more than one run may mine.
    const insert = db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, status, created_at, updated_at)
       VALUES (?, 'user', 'u1', 'fact', ?, 'active', ?, ?)`,
    );
    const seedAll = db.transaction(() => {
      for (let index = 0; index < 2000; index++) {
        insert.run(`bulk-${index}`, `Excel and SQLite note ${index}`, String(NOW), String(NOW));
      }
    });
    seedAll();
    // A single legacy placeholder is enough to make the migration consider the
    // database unrepaired and run the backfill.
    seedPlaceholder('memory:m1');

    const result = migrateV17(db);

    const limit = DEFAULT_GRAPH_SYNC_CONFIG.maxLinksPerRun;
    expect(result.mined.memoriesMined).toBeLessThanOrEqual(limit);
    const minedMemories = (
      db.prepare('SELECT COUNT(DISTINCT source_memory_id) AS cnt FROM memory_links').get() as {
        cnt: number;
      }
    ).cnt;
    expect(minedMemories).toBeLessThanOrEqual(limit);
    // Bounded, not finished: the rest is the scheduled job's work.
    const unmined = (
      db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM memories m
           WHERE NOT EXISTS (SELECT 1 FROM memory_links ml WHERE ml.source_memory_id = m.id)`,
        )
        .get() as { cnt: number }
    ).cnt;
    expect(unmined).toBeGreaterThan(0);
  });

  /**
   * The shape every real upgrade has: the reference Termux device runs a build
   * from before the graph existed. 712 memories, 123 `memory_links` rows with no
   * subject, and `entities`/`entity_edges` created empty by v10 in the same
   * open() — i.e. nothing to repair. This is the steady state, so its per-boot
   * cost is the number that matters.
   */
  function seedDeviceData(
    target: Database.Database,
    memoryCount: number,
    // A pre-v3 `memories` table has no `status` column (migration v3 adds it with
    // DEFAULT 'active'), so the seed has to match the table it writes into.
    options: { status: boolean } = { status: true },
  ): void {
    const kinds = ['preference', 'summary', 'scene', 'fact', 'task', 'persona'];
    const insertMemory = options.status
      ? target.prepare(
          `INSERT INTO memories (id, scope, scope_key, kind, content, status, created_at, updated_at)
           VALUES (?, 'user', 'u1', ?, ?, 'active', ?, ?)`,
        )
      : target.prepare(
          `INSERT INTO memories (id, scope, scope_key, kind, content, created_at, updated_at)
           VALUES (?, 'user', 'u1', ?, ?, ?, ?)`,
        );
    const insertLink = target.prepare(
      `INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type, confidence, created_at)
       VALUES (?, ?, ?, ?, 0.7, ?)`,
    );
    const seed = target.transaction(() => {
      for (let index = 0; index < memoryCount; index++) {
        const kind = kinds[index % kinds.length]!;
        const content =
          kind === 'scene'
            ? `scenes/session-${index}_2026-05-01.md`
            : `用户偏好 Excel 报表，飞书 通知第 ${index} 条记录`;
        insertMemory.run(`mem-${index}`, kind, content, String(NOW + index), String(NOW + index));
      }
      for (let index = 0; index < 123; index++) {
        insertLink.run(
          `link-${index}`,
          `mem-${index}`,
          index % 2 === 0 ? 'Excel' : '飞书',
          'MENTIONS',
          String(NOW),
        );
      }
    });
    seed();
  }

  function count(db: Database.Database, sql: string): number {
    return (db.prepare(sql).get() as { cnt: number }).cnt;
  }

  it('leaves a device-shaped database completely alone — nothing to migrate', () => {
    seedDeviceData(db, 712);
    const before = snapshot();

    const started = Date.now();
    const result = migrateV17(db);
    const elapsedMs = Date.now() - started;

    // Removes nothing, mines nothing, projects nothing.
    expect(result.cleaned).toEqual({
      placeholderEntities: 0,
      placeholderEdges: 0,
      mentionEdges: 0,
      orphanEndpointEdges: 0,
      orphanMemoryEdges: 0,
      unattestedEdges: 0,
    });
    expect(result.mined).toEqual({
      memoriesMined: 0,
      mentionsMined: 0,
      linksCreated: 0,
      linksAnnotated: 0,
      skipped: 0,
    });
    expect(result.projected.edgesCreated).toBe(0);
    expect(result.projected.entitiesCreated).toBe(0);

    // The 123 pre-v15 links keep their NULL subject and no graph node appears:
    // the subject backfill is graph_sync's work, not the boot's.
    expect(count(db, 'SELECT COUNT(*) AS cnt FROM memory_links')).toBe(123);
    expect(count(db, 'SELECT COUNT(*) AS cnt FROM memory_links WHERE subject_entity IS NULL')).toBe(
      123,
    );
    expect(count(db, 'SELECT COUNT(*) AS cnt FROM entities')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS cnt FROM entity_edges')).toBe(0);
    expect(snapshot()).toBe(before);

    // ...and it did not read the memories corpus to decide that. One mining pass
    // is what a wrong guard would cost on every single boot; measure it (dry
    // run: nothing is written) and require the migration to be an order of
    // magnitude cheaper. The 5 ms floor keeps a fast machine from making this
    // assertion flaky.
    const miningStarted = Date.now();
    mineMemoryLinkSubjects(db, {
      limit: DEFAULT_GRAPH_SYNC_CONFIG.maxLinksPerRun,
      dryRun: true,
    });
    const oneMiningPassMs = Date.now() - miningStarted;
    expect(elapsedMs).toBeLessThan(Math.max(oneMiningPassMs / 10, 5));
  });

  it('removes orphan edges without mining the corpus', () => {
    // Orphan edges are ordinary hygiene (deleting a memory leaves them behind),
    // not evidence of a pre-K3 projection, so the clean-up runs and the
    // expensive passes do not.
    seedDeviceData(db, 712);
    const alice = repo.upsertEntity({ name: 'Alice Smith', entityType: 'person' });
    const acme = repo.upsertEntity({ name: 'Acme Corp', entityType: 'organization' });
    seedEdge({
      id: 'orphan-memory',
      source: alice.id,
      target: acme.id,
      relation: 'FOUNDED',
      sourceMemoryId: 'memory-that-is-gone',
    });

    const result = migrateV17(db);

    expect(result.cleaned.orphanMemoryEdges).toBe(1);
    expect(result.mined.memoriesMined).toBe(0);
    expect(result.mined.linksAnnotated).toBe(0);
    expect(result.projected.edgesCreated).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS cnt FROM entity_edges')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS cnt FROM entities')).toBe(2);
    expect(count(db, 'SELECT COUNT(*) AS cnt FROM memory_links WHERE subject_entity IS NULL')).toBe(
      123,
    );

    // And the next boot finds nothing at all.
    expect(migrateV17(db).cleaned.orphanMemoryEdges).toBe(0);
  });

  /**
   * A build from before the graph feature existed: no graph tables, no
   * knowledge tables, `memory_links` without a subject, `sessions` without a
   * channel. `openDatabase()` has to upgrade it in one call, with v17 running in
   * the same open() that creates `entities`/`entity_edges`.
   */
  function writePreGraphDatabase(file: string, memoryCount: number): void {
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        thread_id TEXT,
        user_id TEXT NOT NULL,
        project_id TEXT,
        created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
        updated_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
        metadata TEXT
      );
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
        updated_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000)
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_call_id TEXT,
        created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000),
        metadata TEXT
      );
      CREATE TABLE memory_links (
        id TEXT PRIMARY KEY,
        source_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        target_entity TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL DEFAULT (cast(strftime('%s','now') as integer) * 1000)
      );
    `);
    legacy
      .prepare(
        `INSERT INTO sessions (id, chat_id, user_id, created_at, updated_at)
         VALUES ('s1', 'chat-1', 'u1', ?, ?)`,
      )
      .run(String(NOW), String(NOW));
    legacy
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at)
         VALUES ('msg-1', 's1', 'user', 'hello', ?)`,
      )
      .run(String(NOW));
    seedDeviceData(legacy, memoryCount, { status: false });
    legacy.close();
  }

  it('upgrades a pre-graph database in a single open()', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-v17-'));
    const file = path.join(dir, 'app.db');
    writePreGraphDatabase(file, 712);

    const opened = openDatabase(file);
    try {
      // v10 created the graph tables in this very open(), so v17 saw them empty
      // and must have left them empty instead of erroring or projecting.
      expect(count(opened, 'SELECT COUNT(*) AS cnt FROM entities')).toBe(0);
      expect(count(opened, 'SELECT COUNT(*) AS cnt FROM entity_edges')).toBe(0);
      expect(count(opened, 'SELECT COUNT(*) AS cnt FROM knowledge_pages')).toBe(0);
      // v15 added the column and v17 did not fill it: 123 links stay unsubjected
      // until graph_sync runs.
      expect(count(opened, 'SELECT COUNT(*) AS cnt FROM memory_links')).toBe(123);
      expect(
        count(opened, 'SELECT COUNT(*) AS cnt FROM memory_links WHERE subject_entity IS NULL'),
      ).toBe(123);
      // Nothing was lost on the way through v2/v3/v13/v14/v15/v16.
      expect(count(opened, "SELECT COUNT(*) AS cnt FROM memories WHERE status = 'active'")).toBe(
        712,
      );
      expect(count(opened, 'SELECT COUNT(*) AS cnt FROM messages')).toBe(1);

      // The steady state after an upgrade: the next boot is a pure no-op.
      const replay = migrateV17(opened);
      expect(replay.cleaned).toEqual({
        placeholderEntities: 0,
        placeholderEdges: 0,
        mentionEdges: 0,
        orphanEndpointEdges: 0,
        orphanMemoryEdges: 0,
        unattestedEdges: 0,
      });
      expect(replay.mined.memoriesMined).toBe(0);
      expect(replay.projected.edgesCreated).toBe(0);
    } finally {
      opened.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
