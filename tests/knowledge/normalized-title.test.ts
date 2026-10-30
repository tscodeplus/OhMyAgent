/**
 * `normalized_title` (P10 in the 2026-10-30 knowledge review): the name leg of
 * `knowledge_search` was `lower(trim(title)) LIKE 'x%'` — an expression no
 * index can serve, so every `.inject` lookup scanned the table. The stored
 * comparison key (migration-v24) makes it an indexed prefix that folds case,
 * punctuation, whitespace and full-width spellings.
 *
 * Two halves are pinned here: the read lane (prefix + exact + scope) and the
 * migration (column + count-guarded backfill, replay-safe across opens).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/memory/db.js';
import { migrateV24 } from '../../src/memory/migration-v24.js';
import { KnowledgeRepository } from '../../src/memory/knowledge/repository.js';
import { normalizeMergeName } from '../../src/memory/knowledge/merge.js';
import { TWO_MEMORY_SOURCES } from './fixtures.js';

let db: Database.Database;
let repository: KnowledgeRepository;

beforeEach(() => {
  db = openDatabase(':memory:');
  repository = new KnowledgeRepository(db);
});

afterEach(() => {
  db.close();
});

function insert(slug: string, title: string, content = 'body text'): string {
  const result = repository.insertPage(
    {
      pageType: 'topic',
      slug,
      title,
      content,
      sources: TWO_MEMORY_SOURCES,
      status: 'active',
      updatedBy: 'agent',
    },
    'agent',
  );
  if (!result.ok) throw new Error(`insert ${slug} failed: ${result.code}`);
  return result.page.id;
}

function prefix(query: string, limit = 10, scope?: string): string[] {
  return repository
    .findByTitleOrAlias(query, { status: 'active', limit, scope })
    .map((page) => page.slug);
}

describe('title prefix over the normalized column', () => {
  it('matches case-, punctuation- and width-folded prefixes', () => {
    insert('power-query', 'Power Query');

    expect(prefix('power que')).toEqual(['power-query']);
    expect(prefix('POWER quer')).toEqual(['power-query']);
    // A full-width IME spelling folds onto the same key (NFKC).
    expect(prefix('\uFF30\uFF2F\uFF37\uFF25\uFF32\u2000\uFF31')).toEqual(['power-query']);
    // Nothing to fold: an old unresolved message stays unreachable.
    expect(prefix('pivot eng')).toEqual([]);
  });

  it('keeps the exact-title-first order and the newest-first tiebreak', () => {
    insert('power-query', 'Power Query');
    insert('power-query-tools', 'Power Query Tools', 'another body');

    // The exact title outranks the mere prefix; the rest is newest first.
    const ranked = prefix('power query', 5);
    expect(ranked).toEqual(['power-query', 'power-query-tools']);
  });

  it('is maintained on update, so a retitled page stops and starts matching', () => {
    const id = insert('pivot-engine', 'Power Query', 'body');

    repository.updatePage({ id }, { title: 'Pivot Engine' }, 'agent', 'global');

    expect(prefix('power quer')).toEqual([]);
    expect(prefix('pivot eng')).toEqual(['pivot-engine']);
  });

  it('still applies scope to the name leg', () => {
    insert('deploy-process', 'Deploy process');
    repository.insertPage(
      {
        pageType: 'topic',
        slug: 'other-chat',
        title: 'Deploy process other chat',
        content: 'body',
        sources: TWO_MEMORY_SOURCES,
        status: 'active',
        updatedBy: 'agent',
        scope: 'feishu:oc_b',
      },
      'agent',
    );

    expect(prefix('deploy proc', 10, 'feishu:oc_a')).toEqual(['deploy-process']);
    // Newest-updated first: both prefix-match, neither is an exact title.
    expect(prefix('deploy proc', 10)).toEqual(['other-chat', 'deploy-process']);
  });

  it('a query with no letter or digit left matches nothing, like the LIKE path did', () => {
    insert('pct', '100% Done');
    expect(prefix('%')).toEqual([]);
    expect(prefix('_')).toEqual([]);
  });

  it('the stored fold equals normalizeMergeName on every write', () => {
    const id = insert('full-width', 'ＰＯＷＥＲ');
    const row = db.prepare('SELECT normalized_title FROM knowledge_pages WHERE id = ?').get(id) as {
      normalized_title: string | null;
    };
    expect(row.normalized_title).toBe(normalizeMergeName('ＰＯＷＥＲ'));
  });
});

describe('migration-v24', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oma-v24-'));
    file = join(dir, 'app.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is part of the openDatabase chain: fresh schema has the column and index', async () => {
    const opened = openDatabase(file);
    const columns = opened.prepare('PRAGMA table_info(knowledge_pages)').all() as Array<{
      name: string;
    }>;
    expect(columns.map((c) => c.name)).toContain('normalized_title');
    const index = opened
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_knowledge_pages_normalized_title');
    expect(index).toBeDefined();
    opened.close();
  });

  it('opening the same database twice replays without error and without double backfill', async () => {
    const first = openDatabase(file);
    const repo = new KnowledgeRepository(first);
    for (const [slug, title] of [
      ['a-page', 'Alpha  Beta'],
      ['b-page', 'Gamma\nDelta'],
      ['c-page', 'Ｏｍａ'],
    ]) {
      const result = repo.insertPage(
        {
          pageType: 'topic',
          slug,
          title,
          content: 'body',
          sources: TWO_MEMORY_SOURCES,
          status: 'active',
          updatedBy: 'agent',
        },
        'agent',
      );
      if (!result.ok) throw new Error(`seed ${slug} failed: ${result.code}`);
    }
    first.close();

    const second = openDatabase(file);
    const rows = second
      .prepare('SELECT slug, normalized_title, COUNT(*) AS n FROM knowledge_pages GROUP BY id')
      .all() as Array<{ slug: string; normalized_title: string | null; n: number }>;
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.n === 1)).toBe(true);
    for (const row of rows) {
      const page = second
        .prepare('SELECT title FROM knowledge_pages WHERE slug = ?')
        .get(row.slug) as { title: string };
      expect(row.normalized_title).toBe(normalizeMergeName(page.title));
    }

    // A re-opened database replays the migration as a read-only probe: nothing
    // left to add or fill.
    const replay = migrateV24(second);
    expect(replay.added).toEqual([]);
    expect(replay.backfilled).toBe(0);
    second.close();
  });

  it('backfills NULL rows itself and is count-guarded on the next run', () => {
    const opened = openDatabase(file);
    const repository = new KnowledgeRepository(opened);
    repository.insertPage(
      {
        pageType: 'topic',
        slug: 'legacy-page',
        title: 'Legacy Page',
        content: 'body',
        sources: TWO_MEMORY_SOURCES,
        status: 'active',
        updatedBy: 'agent',
      },
      'agent',
    );

    // Simulate the pre-migration state: the column emptied and its index gone.
    opened.prepare('UPDATE knowledge_pages SET normalized_title = NULL').run();
    opened.prepare('DROP INDEX IF EXISTS idx_knowledge_pages_normalized_title').run();

    const result = migrateV24(opened);
    expect(result.backfilled).toBe(1);
    expect(result.added).toEqual([]); // the column itself was never dropped

    const row = opened
      .prepare('SELECT normalized_title FROM knowledge_pages WHERE slug = ?')
      .get('legacy-page') as { normalized_title: string };
    expect(row.normalized_title).toBe('legacypage');

    const again = migrateV24(opened);
    expect(again.backfilled).toBe(0);
    opened.close();
  });
});
