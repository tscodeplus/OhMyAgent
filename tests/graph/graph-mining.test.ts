import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { applySchema } from '../../src/memory/schema';
import { migrateV10 } from '../../src/memory/migration-v10';
import { EntityRepository } from '../../src/memory/repositories/entity-repository';
import {
  MENTION_RELATION_TYPE,
  inferEntityType,
  mineMemoryLinkSubjects,
} from '../../src/graph/entity-mining';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const MEMORY_CREATED_AT = 1_700_000_000_000;

const EXCEL_MEMORY =
  '用户要求在 D:\\tmp\\excel-mcp 下新建 Excel 文件，并通过 excel-mcp 使用 Power Query 获取 E:\\Excel 下所有 Excel 文件的文件名和 Sheet 数。';

interface LinkRow {
  id: string;
  source_memory_id: string;
  target_entity: string;
  relation_type: string;
  subject_entity: string | null;
  subject_entity_type: string | null;
  target_entity_type: string | null;
}

/**
 * The mining pass is the *producer* of `memory_links.subject_entity`: it records
 * what each memory is about so the graph projection can read a subject instead
 * of inventing one. It writes nothing else — co-occurrence rows stay out of
 * `entity_edges` by construction.
 */
describe('entity-mining: recording subjects on memory_links', () => {
  let db: Database.Database;

  function seedMemory(id: string, content: string, options: { createdAt?: number } = {}): void {
    const createdAt = options.createdAt ?? MEMORY_CREATED_AT;
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, status, created_at, updated_at)
       VALUES (?, 'user', 'k', 'fact', ?, 'active', ?, ?)`,
    ).run(id, content, String(createdAt), String(createdAt));
  }

  function links(memoryId?: string): LinkRow[] {
    const sql = `SELECT id, source_memory_id, target_entity, relation_type,
                        subject_entity, subject_entity_type, target_entity_type
                 FROM memory_links`;
    const rows = (
      memoryId === undefined
        ? db.prepare(`${sql} ORDER BY subject_entity, target_entity`).all()
        : db
            .prepare(`${sql} WHERE source_memory_id = ? ORDER BY subject_entity, target_entity`)
            .all(memoryId)
    ) as LinkRow[];
    return rows;
  }

  function count(table: string): number {
    return (db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number }).cnt;
  }

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    migrateV10(db);
  });

  afterEach(() => {
    db.close();
  });

  it('records the subject and both entity types on the rows it writes', () => {
    seedMemory('m1', EXCEL_MEMORY);

    const summary = mineMemoryLinkSubjects(db, {});

    expect(summary.memoriesMined).toBe(1);
    expect(summary.linksCreated).toBeGreaterThan(0);

    const rows = links('m1');
    expect(rows.length).toBe(summary.linksCreated);
    const targets = rows.map((row) => row.target_entity);
    expect(targets).toContain('Power Query');
    expect(targets).toContain('excel-mcp');

    for (const row of rows) {
      // One producer, one subject: the memory's topic, written where it is
      // known rather than reconstructed at projection time.
      expect(row.subject_entity).toBe('Excel');
      expect(row.subject_entity_type).toBe('concept');
      expect(row.relation_type).toBe(MENTION_RELATION_TYPE);
      expect(row.target_entity_type).toBe(inferEntityType(row.target_entity));
      // "Power Query" was typed as a person by the old name-shape rule.
      if (row.target_entity === 'Power Query') expect(row.target_entity_type).toBe('concept');
    }
  });

  it('writes no entities and no edges — co-occurrence is not a statement', () => {
    seedMemory('m1', EXCEL_MEMORY);

    mineMemoryLinkSubjects(db, {});

    expect(count('entities')).toBe(0);
    expect(count('entity_edges')).toBe(0);
  });

  it('gives a subject to rows a keyword extractor wrote without one', () => {
    seedMemory('m1', EXCEL_MEMORY);
    db.prepare(
      `INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type, confidence)
       VALUES ('ext', 'm1', 'Power Query', 'WORKS_AT', 0.9)`,
    ).run();

    const summary = mineMemoryLinkSubjects(db, {});

    expect(summary.linksAnnotated).toBe(1);
    const existing = links('m1').find((row) => row.id === 'ext')!;
    // The relation the extractor asserted is kept; only the missing subject and
    // types are filled in.
    expect(existing.relation_type).toBe('WORKS_AT');
    expect(existing.subject_entity).toBe('Excel');
    expect(existing.target_entity_type).toBe('concept');
  });

  it('leaves the row that carries the subject itself unsubjected', () => {
    seedMemory('m1', 'Excel 和 Power Query');
    db.prepare(
      `INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type, confidence)
       VALUES ('self-row', 'm1', 'Excel', 'MENTIONED', 0.9)`,
    ).run();

    mineMemoryLinkSubjects(db, {});

    const selfRow = links('m1').find((row) => row.id === 'self-row')!;
    // "Excel mentions Excel" is not a statement, and a row without a subject is
    // classed as unknown rather than given a self-referential one.
    expect(selfRow.subject_entity).toBeNull();
    expect(links('m1').some((row) => row.target_entity === 'Power Query')).toBe(true);
  });

  it('writes nothing new on a second run', () => {
    seedMemory('m1', EXCEL_MEMORY);

    const first = mineMemoryLinkSubjects(db, {});
    expect(first.linksCreated).toBeGreaterThan(0);
    const rowsAfterFirst = links();

    const second = mineMemoryLinkSubjects(db, {});

    expect(second).toEqual({
      memoriesMined: 0,
      mentionsMined: 0,
      linksCreated: 0,
      linksAnnotated: 0,
      skipped: 0,
    });
    expect(links()).toEqual(rowsAfterFirst);
  });

  it('reports counts but writes nothing on a dry run', () => {
    seedMemory('m1', EXCEL_MEMORY);

    const summary = mineMemoryLinkSubjects(db, { dryRun: true });

    expect(summary.memoriesMined).toBe(1);
    expect(summary.linksCreated).toBeGreaterThan(0);
    expect(count('memory_links')).toBe(0);
  });

  it('bounds one run by limit and resumes with the next newest memories', () => {
    seedMemory('m0', 'Excel 和 Power Query');
    seedMemory('m1', 'TypeScript 和 SQLite', { createdAt: MEMORY_CREATED_AT + 1000 });

    const first = mineMemoryLinkSubjects(db, { limit: 1 });
    expect(first.memoriesMined).toBe(1);
    expect(links('m1').length).toBeGreaterThan(0);
    expect(links('m0')).toHaveLength(0);

    const second = mineMemoryLinkSubjects(db, { limit: 1 });
    expect(second.memoriesMined).toBe(1);
    expect(links('m0').length).toBeGreaterThan(0);
  });

  it('lets a memory with nothing to record fall out of the window instead of blocking it', () => {
    // A single mention has no second entity to associate: the pass records
    // nothing, and newest-first ordering means it cannot hold a slot forever.
    seedMemory('m-stuck', '记忆系统', { createdAt: MEMORY_CREATED_AT });
    seedMemory('m-new', 'Excel 和 Power Query', { createdAt: MEMORY_CREATED_AT + 1000 });

    expect(mineMemoryLinkSubjects(db, { limit: 1 }).memoriesMined).toBe(1);
    expect(links('m-new').length).toBeGreaterThan(0);
    expect(links('m-stuck')).toHaveLength(0);
  });

  it('skips memories with nothing minable', () => {
    seedMemory('m-empty', '12345 !!! 🎉');

    const summary = mineMemoryLinkSubjects(db, {});

    expect(summary.memoriesMined).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(count('memory_links')).toBe(0);
  });
});

/**
 * Corpus-level filtering: once there are enough memories to have statistics, a
 * name seen in only one of them is a sentence fragment, not a topic.
 *
 * jieba emits plenty of plausible-looking but meaningless two-character tokens
 * ("问过", "白天"), and per-memory heuristics cannot tell them apart from real
 * topics. Across a batch the difference is obvious, so the pass measures
 * document frequency before writing anything.
 */
describe('entity-mining: corpus filter for mined mentions', () => {
  let db: Database.Database;

  function seedMemory(id: string, content: string, offset: number): void {
    const createdAt = MEMORY_CREATED_AT + offset;
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, status, created_at, updated_at)
       VALUES (?, 'user', 'k', 'fact', ?, 'active', ?, ?)`,
    ).run(id, content, String(createdAt), String(createdAt));
  }

  function linkTargets(): string[] {
    return (
      db.prepare('SELECT target_entity FROM memory_links ORDER BY target_entity').all() as Array<{
        target_entity: string;
      }>
    ).map((row) => row.target_entity);
  }

  function minedNames(): string[] {
    return (
      db
        .prepare(
          'SELECT subject_entity AS name FROM memory_links UNION SELECT target_entity FROM memory_links',
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
  }

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db);
    migrateV10(db);
  });

  afterEach(() => {
    db.close();
  });

  it('drops a one-off fragment but keeps a topic the corpus repeats', () => {
    // "ChromaDB" recurs; "问过" appears once.
    seedMemory('d1', '使用 ChromaDB 做向量检索', 0);
    seedMemory('d2', 'ChromaDB 的检索效果不错', 1_000);
    seedMemory('d3', '还是用 ChromaDB 更省事', 2_000);
    seedMemory('d4', '我昨天问过这个问题', 3_000);
    seedMemory('d5', '今天继续整理笔记', 4_000);

    mineMemoryLinkSubjects(db, {});

    const targets = linkTargets();
    expect(targets).toContain('ChromaDB');
    expect(targets).not.toContain('问过');
  });

  it('does not apply the cutoff while the corpus is too small to measure', () => {
    // Two memories cannot support a document-frequency cutoff: with only one
    // occurrence each, every name looks like a fragment.
    seedMemory('s1', EXCEL_MEMORY, 0);
    seedMemory('s2', '用户偏好使用 excel-mcp，而不是 Python', 1_000);

    mineMemoryLinkSubjects(db, {});

    // Whatever role a name lands in (subject of its own memory, target of
    // another), it survives the pass.
    const names = minedNames();
    expect(names).toContain('Power Query');
    expect(names).toContain('Python');
  });

  it('keeps a name the graph already knows even when the batch mentions it once', () => {
    new EntityRepository(db).upsertEntity({ name: 'ChromaDB', entityType: 'concept' });
    seedMemory('k1', '使用 ChromaDB 做向量检索', 0);
    seedMemory('k2', '整理一下项目笔记', 1_000);
    seedMemory('k3', '写一点周报', 2_000);
    seedMemory('k4', '再看一眼文档', 3_000);

    mineMemoryLinkSubjects(db, {});

    // Dropping it would make the graph oscillate between runs as batches slide.
    expect(minedNames()).toContain('ChromaDB');
  });
});

describe('entity-mining: entity type from the name alone', () => {
  it('asserts organization from a suffix and nothing else', () => {
    expect(inferEntityType('Acme Corp')).toBe('organization');
    expect(inferEntityType('清华大学')).toBe('organization');
    expect(inferEntityType('Initech Ltd')).toBe('organization');
  });

  it('never asserts person from the name shape', () => {
    // The defect K3 removes: a two-word Title Case name is not evidence of a
    // person, and `Power Query` was typed as one.
    expect(inferEntityType('Power Query')).toBe('concept');
    expect(inferEntityType('Alice Smith')).toBe('concept');
    expect(inferEntityType('程语')).toBe('concept');
  });

  it('leaves the logger sink optional', () => {
    // Mining must stay usable from the CLI and from tests, where there is no
    // pino instance to hand out.
    const empty = new Database(':memory:');
    empty.pragma('foreign_keys = ON');
    applySchema(empty);
    migrateV10(empty);
    try {
      expect(mineMemoryLinkSubjects(empty, { logger }).memoriesMined).toBe(0);
      expect(mineMemoryLinkSubjects(empty, {}).memoriesMined).toBe(0);
    } finally {
      empty.close();
    }
  });
});
