/**
 * `knowledge:merge` — deterministic entity normalization.
 *
 * The assertions that matter are the ones a maintenance pass can get wrong
 * silently: pairing two pages of *different* page types, choosing the wrong
 * survivor, leaving a citation or a wikilink pointing at a page nobody reads any
 * more, resurrecting a merged entity on the next projection, and not being
 * idempotent (a second `--apply` that writes more rows than the first).
 *
 * The proposal list is also asserted to be order-stable across calls: the
 * command's whole value is that a human can review it, and a table that reshuffles
 * between runs is not reviewable.
 *
 * Scope is the other axis: `knowledge_pages` is one table behind every chat, so
 * two conversations holding the same title is a legitimate pair of pages, not a
 * duplicate. A candidate must share its scope, and the tests below pin both
 * halves — no pairing across scopes, pairing still happens inside one.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { KnowledgeRepository } from '../../src/memory/knowledge/repository.js';
import {
  applyMergePlan,
  canDeleteEntity,
  findMergeCandidates,
  isSingleEditApart,
  normalizeMergeName,
  type MergeCandidate,
  type MergePlan,
} from '../../src/memory/knowledge/merge.js';
import type { CreateKnowledgePageInput } from '../../src/memory/knowledge/types.js';
import { relationForPageType } from '../../src/memory/knowledge/types.js';
import {
  MEMORY_A,
  MEMORY_B,
  MEMORY_C,
  openSeededDatabase,
  TWO_MEMORY_SOURCES,
} from './fixtures.js';

const NOW = 1_780_000_000_000;
const CHAT_A = 'feishu:oc_a';
const CHAT_B = 'telegram:42';

interface PageRow {
  id: string;
  status: string;
  version: number;
  aliases: string | null;
}

describe('knowledge:merge', () => {
  let db: Database.Database;
  let repository: KnowledgeRepository;

  beforeEach(() => {
    db = openSeededDatabase();
    repository = new KnowledgeRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function createPage(
    overrides: Partial<CreateKnowledgePageInput> & {
      slug: string;
      title: string;
      /** Omitted means a global page, i.e. the console's namespace. */
      scope?: string;
    },
  ): string {
    const result = repository.insertPage(
      {
        pageType: 'topic',
        content: `${overrides.title} 的正文。`,
        sources: TWO_MEMORY_SOURCES,
        status: 'active',
        updatedBy: 'agent',
        ...overrides,
      },
      'agent',
    );
    if (!result.ok) throw new Error(`fixture page ${overrides.slug} was refused: ${result.code}`);
    return result.page.id;
  }

  function row(id: string): PageRow {
    return db
      .prepare('SELECT id, status, version, aliases FROM knowledge_pages WHERE id = ?')
      .get(id) as PageRow;
  }

  function count(sql: string, ...params: unknown[]): number {
    return (db.prepare(sql).get(...params) as { cnt: number }).cnt;
  }

  function aliasesOf(pageId: string): string[] {
    const parsed: unknown = JSON.parse(row(pageId).aliases ?? '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  }

  /**
   * Three topics that name the same thing plus a project that shares the title,
   * so "same page_type only" has something to exclude:
   *
   *   pageA  topic/power-query       "Power Query"   2 citations  ← survivor
   *   pageB  topic/power-query-tool  "power  query"  1 citation   ← loser
   *   other  project/power-query     "Power Query"   different page type
   */
  function seedPowerQuery(): { pageA: string; pageB: string; other: string } {
    const pageA = createPage({
      slug: 'power-query',
      title: 'Power Query',
      aliases: ['PQ'],
      content: '用 [[topic/excel-etl]] 清洗数据。',
      sources: [...TWO_MEMORY_SOURCES],
    });
    const pageB = createPage({
      slug: 'power-query-tool',
      title: 'power  query',
      aliases: ['Power_Query'],
      content: 'Power Query 是 Excel 的 ETL 工具。',
      sources: [{ kind: 'memory', id: MEMORY_C }],
    });
    const other = createPage({
      pageType: 'project',
      slug: 'power-query',
      title: 'Power Query',
      content: '一个项目。',
      sources: TWO_MEMORY_SOURCES,
    });
    return { pageA, pageB, other };
  }

  describe('name comparison', () => {
    it('folds case, whitespace, punctuation and full-width forms into one key', () => {
      const key = normalizeMergeName('Power Query');
      for (const variant of ['power query', 'power-query', 'power_query', 'power  query']) {
        expect(normalizeMergeName(variant)).toBe(key);
      }
      // A full-width Chinese-IME spelling is the same name, not a second one.
      expect(normalizeMergeName('ＰＯＷＥＲ　ＱＵＥＲＹ')).toBe(key);
      // CJK survives as-is: there is no case to fold and nothing to strip.
      expect(normalizeMergeName('知识图谱')).toBe('知识图谱');
    });

    it('treats exactly one insertion, deletion or substitution as one edit', () => {
      expect(isSingleEditApart('postgres', 'postgress')).toBe(true);
      expect(isSingleEditApart('postgres', 'postgras')).toBe(true);
      expect(isSingleEditApart('postgres', 'postgre')).toBe(true);
      expect(isSingleEditApart('postgres', 'postgres')).toBe(false);
      expect(isSingleEditApart('postgres', 'postgrex')).toBe(true);
      expect(isSingleEditApart('postgres', 'postgxxx')).toBe(false);
      expect(isSingleEditApart('abc', 'abcd')).toBe(true);
    });
  });

  describe('findMergeCandidates', () => {
    it('pairs same-type pages by normalized name and by alias, never across page types', () => {
      const { pageA, pageB, other } = seedPowerQuery();

      const plan = findMergeCandidates(db);

      expect(plan.candidates).toHaveLength(1);
      const [candidate] = plan.candidates;
      expect(candidate.pageType).toBe('topic');
      // Pages written without a scope are the console's, i.e. global.
      expect(candidate.scope).toBe('global');
      // More citations wins: pageA is the page other pages already rely on.
      expect(candidate.survivor.id).toBe(pageA);
      expect(candidate.loser.id).toBe(pageB);
      // Both names and the alias collide, so both reasons are reported.
      expect(candidate.evidence.map((entry) => entry.kind).sort()).toEqual([
        'alias_collision',
        'normalized_name',
      ]);
      for (const evidence of candidate.evidence) {
        expect(evidence.detail).toContain('powerquery');
      }
      // The project page carries the same title; a type-blind merge would fold it in.
      expect(plan.candidates.some((entry) => entry.survivor.id === other)).toBe(false);
      expect(plan.candidates.some((entry) => entry.loser.id === other)).toBe(false);
    });

    it('finds latin names one edit apart, and ignores short names', () => {
      createPage({ slug: 'postgres', title: 'Postgres' });
      createPage({ slug: 'postgress', title: 'Postgress' });
      // Three characters: one edit is not evidence of anything.
      createPage({ slug: 'htm', title: 'HTM' });
      createPage({ slug: 'html', title: 'HTML' });

      const plan = findMergeCandidates(db);

      expect(plan.candidates).toHaveLength(1);
      expect(plan.candidates[0].scope).toBe('global');
      expect(plan.candidates[0].evidence).toEqual([
        {
          kind: 'edit_distance',
          detail: 'title "Postgres" and title "Postgress" differ by one character',
        },
      ]);
    });

    it('is order-stable and obeys --limit without losing the count', () => {
      seedPowerQuery();
      createPage({ slug: 'postgres', title: 'Postgres' });
      createPage({ slug: 'postgress', title: 'Postgress' });

      const first = findMergeCandidates(db);
      const second = findMergeCandidates(db);
      expect(second).toEqual(first);
      expect(first.candidates).toHaveLength(2);
      expect(first.pairCount).toBe(2);

      const limited = findMergeCandidates(db, { limit: 1 });
      expect(limited.candidates).toHaveLength(1);
      expect(limited.candidates[0]).toEqual(first.candidates[0]);
      // The withheld proposal is reported, not silently dropped.
      expect(limited.pairCount).toBe(2);
    });

    it('claims each page at most once, strongest evidence first', () => {
      // Three pages where the first and third are exact-name twins and the middle
      // one is an edit away from both: a pairwise list would propose two merges
      // for the same page.
      createPage({ slug: 'redis', title: 'Redis' });
      createPage({ slug: 'rediss', title: 'Rediss' });
      createPage({ slug: 'redis-cache', title: 'redis' });

      const plan = findMergeCandidates(db);

      const claims = plan.candidates.flatMap((candidate) => [
        candidate.survivor.id,
        candidate.loser.id,
      ]);
      expect(new Set(claims).size).toBe(claims.length);
      expect(plan.candidates).toHaveLength(1);
      // The exact normalized-name pair outranks the one-edit pair.
      expect(plan.candidates[0].evidence.map((entry) => entry.kind)).toContain('normalized_name');
    });

    it('does not pair the same title across scopes', () => {
      // Same page type, same title, three conversations. Before the scope rule
      // this was one proposal and one of the three pages was archived into
      // another conversation's page.
      const inA = createPage({
        slug: 'deploy-process',
        title: 'Deploy process',
        scope: CHAT_A,
      });
      const inB = createPage({ slug: 'deploy-steps', title: 'Deploy process', scope: CHAT_B });
      const global = createPage({ slug: 'deploy-runbook', title: 'Deploy process' });
      // An alias is a claim of identity *inside* its conversation, so two chats
      // that each alias onto `deploy` are still two pages.
      createPage({
        slug: 'release-runbook',
        title: 'Release runbook',
        aliases: ['deploy'],
        scope: CHAT_A,
      });
      createPage({
        slug: 'deploy-notes',
        title: 'Deploy notes',
        aliases: ['deploy'],
        scope: CHAT_B,
      });

      const plan = findMergeCandidates(db);

      expect(plan.candidates).toEqual([]);
      expect(plan.pairCount).toBe(0);
      // Sanity: the pages really are stored in the scopes this test assumes.
      expect(repository.findById(inA)?.scope).toBe(CHAT_A);
      expect(repository.findById(inB)?.scope).toBe(CHAT_B);
      expect(repository.findById(global)?.scope).toBe('global');
    });

    it('still merges two duplicates inside one scope, and leaves another chat alone', () => {
      const survivor = createPage({
        slug: 'power-query',
        title: 'Power Query',
        aliases: ['PQ'],
        sources: [...TWO_MEMORY_SOURCES],
        scope: CHAT_A,
      });
      const loser = createPage({
        slug: 'power-query-tool',
        title: 'power  query',
        sources: [{ kind: 'memory', id: MEMORY_C }],
        scope: CHAT_A,
      });
      // The same duplicate in another chat: not part of this pair, before or after.
      const otherChat = createPage({
        slug: 'power-query-tool',
        title: 'power  query',
        sources: [{ kind: 'memory', id: MEMORY_C }],
        scope: CHAT_B,
      });

      const plan = findMergeCandidates(db);

      expect(plan.candidates).toHaveLength(1);
      const [candidate] = plan.candidates;
      expect(candidate.scope).toBe(CHAT_A);
      expect(candidate.survivor.scope).toBe(CHAT_A);
      expect(candidate.loser.scope).toBe(CHAT_A);
      expect(candidate.survivor.id).toBe(survivor);
      expect(candidate.loser.id).toBe(loser);
      expect([candidate.survivor.id, candidate.loser.id]).not.toContain(otherChat);

      const [outcome] = applyMergePlan(db, findMergeCandidates(db));
      expect(outcome.status).toBe('merged');

      expect(row(survivor).status).toBe('active');
      expect(row(loser).status).toBe('archived');
      // The other chat's page is untouched: nothing renamed, nothing archived.
      expect(row(otherChat).status).toBe('active');
      expect(repository.findById(otherChat)?.title).toBe('power  query');
      expect(aliasesOf(otherChat)).toEqual([]);

      // The audit entry names the scope the merge happened in.
      const log = db.prepare("SELECT reason FROM knowledge_log WHERE action = 'merge'").get() as {
        reason: string;
      };
      const payload = JSON.parse(log.reason) as {
        survivor: { id: string; scope: string };
        loser: { id: string; scope: string };
      };
      expect(payload.survivor).toMatchObject({ id: survivor, scope: CHAT_A });
      expect(payload.loser).toMatchObject({ id: loser, scope: CHAT_A });
    });

    it('proposes nothing when the knowledge layer is absent', () => {
      db.close();
      db = openSeededDatabase();
      db.prepare('DROP TABLE knowledge_pages').run();

      const plan = findMergeCandidates(db);

      expect(plan.candidates).toEqual([]);
      expect(plan.notes[0]).toContain('knowledge_pages not present');
    });

    it('writes nothing: a plan is a read', () => {
      seedPowerQuery();
      const before = {
        pages: count('SELECT COUNT(*) AS cnt FROM knowledge_pages'),
        log: count('SELECT COUNT(*) AS cnt FROM knowledge_log'),
        sources: count('SELECT COUNT(*) AS cnt FROM knowledge_sources'),
      };

      findMergeCandidates(db);

      expect(count('SELECT COUNT(*) AS cnt FROM knowledge_pages')).toBe(before.pages);
      expect(count('SELECT COUNT(*) AS cnt FROM knowledge_log')).toBe(before.log);
      expect(count('SELECT COUNT(*) AS cnt FROM knowledge_sources')).toBe(before.sources);
    });
  });

  describe('applyMergePlan', () => {
    function apply(plan: MergePlan) {
      return applyMergePlan(db, plan);
    }

    it('moves citations, incoming wikilinks and aliases onto the survivor', () => {
      const { pageA, pageB } = seedPowerQuery();
      const linker = createPage({
        slug: 'excel-etl',
        title: 'Excel ETL',
        content: '清洗走 [[topic/power-query-tool|那个工具]]。',
      });
      // Sanity: the linker's wikilink resolved to the loser before the merge.
      expect(
        count(
          'SELECT COUNT(*) AS cnt FROM knowledge_links WHERE from_page_id = ? AND to_page_id = ?',
          linker,
          pageB,
        ),
      ).toBe(1);
      const sourcesBefore = count(
        'SELECT COUNT(*) AS cnt FROM knowledge_sources WHERE page_id = ?',
        pageA,
      );

      const [outcome] = apply(findMergeCandidates(db));

      expect(outcome.status).toBe('merged');
      if (outcome.status !== 'merged') throw new Error('unreachable');
      expect(outcome.repointed.sources).toBe(1);
      expect(outcome.repointed.incomingLinks).toBe(1);
      // The linker's body still says [[topic/power-query-tool]], which no longer
      // resolves — reported rather than rewritten behind the author's back.
      expect(outcome.repointed.bodiesNeedingRewrite).toEqual([linker]);

      // Citations: the loser's one citation is now the survivor's third.
      expect(count('SELECT COUNT(*) AS cnt FROM knowledge_sources WHERE page_id = ?', pageA)).toBe(
        sourcesBefore + 1,
      );
      expect(count('SELECT COUNT(*) AS cnt FROM knowledge_sources WHERE page_id = ?', pageB)).toBe(
        0,
      );

      // Incoming link repointed at the survivor.
      expect(
        count(
          'SELECT COUNT(*) AS cnt FROM knowledge_links WHERE from_page_id = ? AND to_page_id = ?',
          linker,
          pageA,
        ),
      ).toBe(1);
      expect(count('SELECT COUNT(*) AS cnt FROM knowledge_links WHERE to_page_id = ?', pageB)).toBe(
        0,
      );

      // The repointed row carries its predicate immediately, derived from the
      // target's page type — not left NULL for the next boot's backfill.
      expect(
        (
          db
            .prepare(
              'SELECT relation_type FROM knowledge_links WHERE from_page_id = ? AND to_page_id = ?',
            )
            .get(linker, pageA) as { relation_type: string | null }
        ).relation_type,
      ).toBe(relationForPageType('topic'));

      // Names: the loser's title, alias and slug are now the survivor's aliases.
      // Spellings are kept literally — an alias is matched with
      // `lower(value) = lower(?)`, so `power  query` and `Power_Query` are
      // distinct lookup keys, not duplicates of `Power Query`.
      const aliases = aliasesOf(pageA);
      expect(aliases).toContain('PQ');
      expect(aliases).toContain('power  query');
      expect(aliases).toContain('Power_Query');
      expect(aliases).toContain('power-query-tool');
      // ... and the survivor's own title is not repeated as an alias.
      expect(aliases.map((alias) => alias.toLowerCase())).not.toContain('power query');
    });

    it('archives the loser, never deletes it, and promotes the survivor version', () => {
      const { pageA, pageB } = seedPowerQuery();
      const versionBefore = row(pageA).version;

      apply(findMergeCandidates(db));

      const loser = row(pageB);
      expect(loser.status).toBe('archived');
      expect(loser.version).toBe(2);
      // Archived pages are invisible to every reader that filters on status.
      expect(repository.findById(pageB)?.title).toBe('power  query');
      expect(row(pageA).status).toBe('active');
      expect(row(pageA).version).toBe(versionBefore + 1);
      // ... and to search: the loser's slug is now an alias of the survivor, so
      // the old name still resolves — to the survivor, never to the archive.
      const found = repository.findByTitleOrAlias('power-query-tool', {
        status: 'active',
        limit: 10,
      });
      expect(found.map((page) => page.id)).toEqual([pageA]);
      // `pending` and `archived` are not candidates for a name lookup at all.
      expect(
        repository
          .findByTitleOrAlias('power-query-tool', { status: 'archived', limit: 10 })
          .map((page) => page.id),
      ).toEqual([pageB]);
    });

    it('records one merge row in knowledge_log naming both pages, the evidence and the repointing', () => {
      const { pageA, pageB } = seedPowerQuery();

      apply(findMergeCandidates(db));

      const rows = db
        .prepare(
          "SELECT page_id, action, actor, version, reason FROM knowledge_log WHERE action = 'merge'",
        )
        .all() as Array<{
        page_id: string;
        action: string;
        actor: string;
        version: number;
        reason: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].page_id).toBe(pageA);
      expect(rows[0].actor).toBe('system');
      expect(rows[0].version).toBe(2);

      const payload = JSON.parse(rows[0].reason) as {
        survivor: { id: string; slug: string };
        loser: { id: string; slug: string };
        evidence: Array<{ kind: string }>;
        repointed: { sources: number; aliasesAdded: string[] };
        bodyMerged: boolean;
      };
      expect(payload.survivor.id).toBe(pageA);
      expect(payload.loser.id).toBe(pageB);
      expect(payload.evidence.length).toBeGreaterThan(0);
      expect(payload.repointed.sources).toBe(1);
      expect(payload.bodyMerged).toBe(false);
    });

    it('repoints the graph by name and does not resurrect the loser entity', () => {
      const { pageA, pageB } = seedPowerQuery();
      const entity = (id: string, name: string, canonical: string, type: string): void => {
        db.prepare(
          `INSERT INTO entities (id, name, canonical_name, entity_type, description, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?)`,
        ).run(id, name, canonical, type, NOW, NOW);
      };
      entity('ent-survivor', 'Power Query', 'power query', 'concept');
      entity('ent-loser', 'power-query-tool', 'power-query-tool', 'concept');
      entity('ent-excel', 'Excel', 'excel', 'concept');
      db.prepare(
        `INSERT INTO entity_aliases (entity_id, alias, source, created_at) VALUES (?, ?, 'mine', ?)`,
      ).run('ent-loser', 'pq-tool', NOW);
      db.prepare(
        `INSERT INTO entity_edges (
           id, source_entity_id, target_entity_id, relation_type, confidence,
           source_memory_id, source_message_id, valid_from, valid_to, created_at
         ) VALUES ('edge-1', 'ent-excel', 'ent-loser', 'USES', 0.9, NULL, NULL, ?, NULL, ?)`,
      ).run(NOW, NOW);
      db.prepare(
        `INSERT INTO memory_links (
           id, source_memory_id, target_entity, relation_type, confidence,
           subject_entity, subject_entity_type, target_entity_type, created_at
         ) VALUES ('link-1', ?, 'power-query-tool', 'MENTIONED', 0.5, NULL, NULL, NULL, ?)`,
      ).run(MEMORY_A, String(NOW));

      const [outcome] = apply(findMergeCandidates(db));
      if (outcome.status !== 'merged') throw new Error('expected a merge');
      expect(outcome.repointed.entityEdges).toBe(1);
      expect(outcome.repointed.memoryLinks).toBe(1);
      expect(outcome.repointed.entityLosersDeleted).toEqual(['ent-loser']);

      // The edge now ends at the survivor's entity ...
      expect(
        db
          .prepare('SELECT target_entity_id AS target FROM entity_edges WHERE id = ?')
          .get('edge-1'),
      ).toEqual({ target: 'ent-survivor' });
      // ... the loser's alias and canonical name moved there ...
      const aliases = (
        db
          .prepare('SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY alias')
          .all('ent-survivor') as Array<{ alias: string }>
      ).map((entry) => entry.alias);
      expect(aliases).toEqual(['power-query-tool', 'pq-tool']);
      // ... and nothing upstream still points at the deleted row.
      expect(
        count('SELECT COUNT(*) AS cnt FROM entity_aliases WHERE entity_id = ?', 'ent-loser'),
      ).toBe(0);
      expect(count('SELECT COUNT(*) AS cnt FROM entities WHERE id = ?', 'ent-loser')).toBe(0);
      // memory_links text is the projection's input, so it must say the survivor.
      expect(
        db.prepare('SELECT target_entity AS target FROM memory_links WHERE id = ?').get('link-1'),
      ).toEqual({ target: 'Power Query' });
      expect(pageA).not.toBe(pageB);
    });

    it('does not count a memory link that already names the survivor', () => {
      seedPowerQuery();
      // The loser's key and the survivor's key are the same key — that is why the
      // pages were paired. A link that already spells the survivor must not be
      // rewritten onto itself and reported as repointed.
      const insertLink = db.prepare(
        `INSERT INTO memory_links (
           id, source_memory_id, target_entity, relation_type, confidence,
           subject_entity, subject_entity_type, target_entity_type, created_at
         ) VALUES (?, ?, ?, 'MENTIONED', 0.5, NULL, NULL, NULL, ?)`,
      );
      insertLink.run('link-survivor', MEMORY_A, 'Power Query', String(NOW));
      insertLink.run('link-loser', MEMORY_B, 'power-query-tool', String(NOW));

      const [outcome] = apply(findMergeCandidates(db));
      if (outcome.status !== 'merged') throw new Error('expected a merge');

      expect(outcome.repointed.memoryLinks).toBe(1);
      expect(
        db
          .prepare('SELECT target_entity AS target FROM memory_links WHERE id = ?')
          .get('link-survivor'),
      ).toEqual({ target: 'Power Query' });
      expect(
        db
          .prepare('SELECT target_entity AS target FROM memory_links WHERE id = ?')
          .get('link-loser'),
      ).toEqual({ target: 'Power Query' });
    });

    it('refuses to delete an entity row that is still referenced', () => {
      db.prepare(
        `INSERT INTO entities (id, name, canonical_name, entity_type, description, created_at, updated_at)
         VALUES ('ent-x', 'Excel', 'excel', 'concept', NULL, ?, ?)`,
      ).run(NOW, NOW);

      expect(canDeleteEntity(db, 'ent-x')).toBe(true);
      db.prepare(
        `INSERT INTO entity_aliases (entity_id, alias, source, created_at) VALUES ('ent-x', 'xl', 'mine', ?)`,
      ).run(NOW);
      expect(canDeleteEntity(db, 'ent-x')).toBe(false);

      db.prepare('DELETE FROM entity_aliases WHERE entity_id = ?').run('ent-x');
      db.prepare(
        `INSERT INTO entity_edges (
           id, source_entity_id, target_entity_id, relation_type, confidence,
           source_memory_id, source_message_id, valid_from, valid_to, created_at
         ) VALUES ('edge-y', 'ent-x', 'ent-x', 'SELF', 1.0, NULL, NULL, ?, NULL, ?)`,
      ).run(NOW, NOW);
      expect(canDeleteEntity(db, 'ent-x')).toBe(false);
    });

    it('is idempotent: a second apply finds nothing and writes no log rows', () => {
      seedPowerQuery();
      const first = apply(findMergeCandidates(db));
      expect(first.filter((outcome) => outcome.status === 'merged')).toHaveLength(1);
      const logRows = count('SELECT COUNT(*) AS cnt FROM knowledge_log');
      const versions = {
        survivor: row(first[0].status === 'merged' ? first[0].survivorId : '').version,
      };

      const secondPlan = findMergeCandidates(db);
      expect(secondPlan.candidates).toEqual([]);
      const second = apply(secondPlan);

      expect(second).toEqual([]);
      expect(count('SELECT COUNT(*) AS cnt FROM knowledge_log')).toBe(logRows);
      expect(count("SELECT COUNT(*) AS cnt FROM knowledge_log WHERE action = 'merge'")).toBe(1);
      expect(row(first[0].status === 'merged' ? first[0].survivorId : '').version).toBe(
        versions.survivor,
      );
    });

    it('skips a proposal whose page was archived by an earlier merge', () => {
      const { pageA, pageB } = seedPowerQuery();
      const plan = findMergeCandidates(db);
      const candidate: MergeCandidate = plan.candidates[0];
      const logBefore = count('SELECT COUNT(*) AS cnt FROM knowledge_log');

      // Same proposal applied twice in one plan: the second must not fold an
      // archived page into another survivor.
      const outcomes = applyMergePlan(db, { ...plan, candidates: [candidate, candidate] });

      expect(outcomes[0].status).toBe('merged');
      expect(outcomes[1]).toEqual({
        status: 'skipped',
        loserId: pageB,
        reason: 'page is no longer active (merged or archived earlier)',
      });
      expect(row(pageA).status).toBe('active');
      // Only the merged proposal logged anything; the skipped one wrote no rows.
      expect(count('SELECT COUNT(*) AS cnt FROM knowledge_log')).toBe(logBefore + 1);
      expect(count("SELECT COUNT(*) AS cnt FROM knowledge_log WHERE action = 'merge'")).toBe(1);
    });
  });
});
