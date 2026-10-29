import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../../src/memory/schema';
import { migrateV10 } from '../../src/memory/migration-v10';
import { EntityRepository } from '../../src/memory/repositories/entity-repository';
import { syncGraphFromMemoryLinks } from '../../src/graph/graph-sync';

/**
 * Nodes and edges are different claims and get different evidence.
 *
 * The regression these tests pin: `entities` was populated only from links the
 * projector accepted as *edges*, so refusing `MENTIONED` (correct — co-occurrence
 * is not a statement) also refused it as a *node*. On the reference device 814
 * of 868 links were `MENTIONED`, the `entities` table held 4 leftovers, and the
 * user-visible symptom was "38 memories talk about Ubuntu and the knowledge
 * graph does not know Ubuntu exists".
 */
describe('graph-sync: mention nodes are admitted independently of edges', () => {
  let db: Database.Database;
  let repo: EntityRepository;
  const T = 1_700_000_000_000;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    migrateV10(db);
    repo = new EntityRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedMemory(id: string, content: string): void {
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, status, created_at, updated_at)
       VALUES (?, 'user', 'k', 'fact', ?, 'active', ?, ?)`,
    ).run(id, content, String(T), String(T));
  }

  function seedMention(memoryId: string, target: string, subject: string | null = null): void {
    db.prepare(
      `INSERT INTO memory_links (id, source_memory_id, target_entity, relation_type, confidence,
                                 subject_entity, subject_entity_type, target_entity_type)
       VALUES (?, ?, ?, 'MENTIONED', 0.9, ?, ?, 'concept')`,
    ).run(`l-${memoryId}-${target}`, memoryId, target, subject, subject ? 'concept' : null);
  }

  const names = () =>
    (db.prepare('SELECT name FROM entities ORDER BY name').all() as Array<{ name: string }>).map(
      (row) => row.name,
    );

  it('creates a node for a mentioned-but-never-subject entity, and no edge', () => {
    // The shape that produced the bug: 38 memories mention Ubuntu, none states a
    // fact about it.
    for (let index = 0; index < 38; index++) {
      seedMemory(`u${index}`, `在 Termux 里用 proot-distro 装了 Ubuntu ${index}，apt 源换成清华。`);
      seedMention(`u${index}`, 'Ubuntu');
    }

    const summary = syncGraphFromMemoryLinks(db, repo);

    expect(summary.linksProcessed).toBe(0); // no statement, so no edge
    expect(summary.linksWithoutSubject).toBe(0); // they never enter the edge batch
    expect(summary.mentionNodesAdmitted).toBe(1);
    expect(summary.mentionNodesCreated).toBe(1);
    expect(summary.edgesCreated).toBe(0);
    expect(repo.findByName('Ubuntu')).toBeDefined();
    expect(count('entity_edges')).toBe(0);
  });

  function count(table: 'entities' | 'entity_edges'): number {
    return (db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number }).cnt;
  }

  it('refuses a node whose name is a slice of the words in the memory', () => {
    // Verbatim from the real corpus: the deterministic extractor cut `如何称呼`
    // into `何称` by slicing CJK at surname shapes.
    seedMemory('m1', '你想让我如何称呼你？');
    seedMention('m1', '何称');

    const summary = syncGraphFromMemoryLinks(db, repo);

    expect(summary.mentionNodesAdmitted).toBe(0);
    expect(repo.findByName('何称')).toBeUndefined();
  });

  it('keeps a node whose canonical form does not appear in the text', () => {
    // `PQ` in the memory, `Power Query` as the recorded name: the alignment gate
    // fails open when the name is absent, because canonicalisation is exactly
    // the case it cannot measure. Rejecting here would delete real entities.
    seedMemory('m2', '用 PQ 把三张表合并了，比手动 VLOOKUP 快。');
    seedMention('m2', 'Power Query');

    syncGraphFromMemoryLinks(db, repo);

    expect(repo.findByName('Power Query')).toBeDefined();
  });

  it('admits the subject of a MENTIONED row as a node too', () => {
    seedMemory('m3', 'Excel 里的 Power Query 可以撤销，但要注意步骤顺序。');
    seedMention('m3', 'Power Query', 'Excel');

    syncGraphFromMemoryLinks(db, repo);

    expect(names()).toContain('Excel');
    expect(names()).toContain('Power Query');
    expect(count('entity_edges')).toBe(0);
  });

  it('honours project_mention_nodes: false', () => {
    seedMemory('m4', 'Android 上用 Termux 跑 Node。');
    seedMention('m4', 'Android');

    const summary = syncGraphFromMemoryLinks(db, repo, { projectMentionNodes: false });

    expect(summary.mentionNodesAdmitted).toBe(0);
    expect(names()).toEqual([]);
  });

  it('is idempotent: a second run admits the same nodes without creating rows', () => {
    seedMemory('m5', 'Termux 里的 Node 版本是 26。');
    seedMention('m5', 'Termux');

    syncGraphFromMemoryLinks(db, repo);
    const afterFirst = count('entities');
    const second = syncGraphFromMemoryLinks(db, repo);

    expect(second.mentionNodesAdmitted).toBe(1);
    expect(second.mentionNodesCreated).toBe(0);
    expect(count('entities')).toBe(afterFirst);
  });

  it('caps admitted nodes by maxMentionNodes, busiest name first', () => {
    for (let index = 0; index < 5; index++) {
      seedMemory(`c${index}`, `Common 出现在第 ${index} 条，Rare 只出现在这里。`);
      seedMention(`c${index}`, 'Common');
    }
    seedMemory('rare', 'Rare 只出现一次。');
    seedMention('rare', 'Rare');

    // Alphabetical order would drop `Rare`; mention-count order keeps the name
    // the corpus actually talks about, which is the point of the cap.
    const summary = syncGraphFromMemoryLinks(db, repo, { maxMentionNodes: 1 });

    expect(summary.mentionNodesAdmitted).toBe(1);
    expect(names()).toEqual(['Common']);
  });

  it('does not draw a node from an inactive memory', () => {
    db.prepare(
      `INSERT INTO memories (id, scope, scope_key, kind, content, status, created_at, updated_at)
       VALUES ('gone', 'user', 'k', 'fact', ?, 'superseded', ?, ?)`,
    ).run('Ubuntu 24.04 LTS 的源要换掉。', String(T), String(T));
    seedMention('gone', 'Ubuntu');

    const summary = syncGraphFromMemoryLinks(db, repo);

    expect(summary.mentionNodesAdmitted).toBe(0);
    expect(repo.findByName('Ubuntu')).toBeUndefined();
  });
});
