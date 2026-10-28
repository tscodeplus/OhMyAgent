/**
 * `knowledge:export` — the projection is lossless and deterministic, or it is
 * not a backup.
 *
 * The plan (§12 item 1) records the gap this file closes: the exporter writes the
 * body verbatim and puts `aliases`/`tags`/`sources` into frontmatter, but nothing
 * tested it, so "无损还原 `[[wikilink]]`" was code intent rather than a verified
 * result. Two claims are asserted here, in the only form that cannot be satisfied
 * by accident:
 *
 *   - **Deterministic** — two exports of one unchanged database into two
 *     directories are byte-identical, file set included. This is what makes
 *     "run it again and see what changed" meaningful; a single `Date.now()`
 *     anywhere in the renderer turns every note into a diff.
 *   - **Lossless** — a note's frontmatter parses back to the stored identity
 *     columns (`id`, `page_type`, `slug`, `title`, `aliases`, `tags`,
 *     `confidence`, `version`, `sources`), and its body is the stored markdown
 *     character for character, `[[wikilink]]` syntax and all.
 *
 * The exporter is called as a function, not shelled out: a spawned process would
 * test the CLI's argument parsing and leave the rendering — the part that can
 * lose a body — asserted through stdout.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type Database from 'better-sqlite3';
import { exportKnowledge } from '../../scripts/knowledge-export.js';
import { KnowledgeRepository } from '../../src/memory/knowledge/repository.js';
import type { CreateKnowledgePageInput } from '../../src/memory/knowledge/types.js';
import {
  MEMORY_A,
  MEMORY_B,
  MEMORY_C,
  openSeededDatabase,
  TWO_MEMORY_SOURCES,
} from './fixtures.js';

/** A body that starts with its own H1 and carries both wikilink forms. */
const LINKED_CONTENT = [
  '# Excel ETL',
  '',
  '清洗走 [[topic/power-query|Power Query]]，引用见 [[postgres]]。',
  '- 第一行',
  '- 第二行，带 `代码` 与 **粗体**',
].join('\n');

/** A body with no H1, so the exporter has to generate one. */
const HEADINGLESS_CONTENT = '提到 [[topic/excel-etl]] 的一页，但没有标题行。';

interface Seeded {
  linked: string;
  headingless: string;
  archived: string;
  pending: string;
}

describe('knowledge:export', () => {
  let db: Database.Database;
  let tmpRoot: string;
  let firstDir: string;
  let secondDir: string;

  beforeEach(() => {
    db = openSeededDatabase();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-knowledge-export-'));
    firstDir = path.join(tmpRoot, 'first');
    secondDir = path.join(tmpRoot, 'second');
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function insert(
    overrides: Partial<CreateKnowledgePageInput> & { slug: string; title: string; content: string },
  ): string {
    const repository = new KnowledgeRepository(db);
    const result = repository.insertPage(
      {
        pageType: 'topic',
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

  /** The three exported shapes plus two the exporter must not project at all. */
  function seed(): Seeded {
    const linked = insert({
      slug: 'excel-etl',
      title: 'Excel ETL',
      content: LINKED_CONTENT,
      aliases: ['ETL', 'Excel 清洗'],
      tags: ['excel', '数据清洗'],
      confidence: 0.82,
    });
    const headingless = insert({
      slug: 'power-query',
      title: 'Power Query',
      content: HEADINGLESS_CONTENT,
      aliases: ['PQ'],
      sources: [{ kind: 'memory', id: MEMORY_C }],
    });
    const archived = insert({
      slug: 'retired-topic',
      title: 'Retired Topic',
      content: '已归档。',
      status: 'archived',
    });
    const pending = insert({
      slug: 'pending-topic',
      title: 'Pending Topic',
      content: '等待审阅。',
      status: 'pending',
    });
    return { linked, headingless, archived, pending };
  }

  /** Every file under `dir`, as sorted POSIX-style relative paths. */
  function listFiles(dir: string): string[] {
    const found: string[] = [];
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else found.push(path.relative(dir, absolute).split(path.sep).join('/'));
      }
    };
    walk(dir);
    return found.sort();
  }

  /**
   * Split a note into its YAML frontmatter and its body. The separator is the
   * first line that is exactly `---`, so a body containing `---` (a horizontal
   * rule) cannot truncate the split.
   */
  function splitNote(note: string): { frontmatter: Record<string, unknown>; body: string } {
    const lines = note.split('\n');
    expect(lines[0]).toBe('---');
    const end = lines.indexOf('---', 1);
    expect(end).toBeGreaterThan(0);
    return {
      frontmatter: parseYaml(lines.slice(1, end).join('\n')) as Record<string, unknown>,
      // `end + 1` is the blank line the frontmatter block leaves behind.
      body: lines.slice(end + 2).join('\n'),
    };
  }

  function readNote(dir: string, relative: string): string {
    return fs.readFileSync(path.join(dir, ...relative.split('/')), 'utf8');
  }

  it('writes byte-identical notes twice over an unchanged database', () => {
    seed();

    const first = exportKnowledge({ db, outDir: firstDir });
    const second = exportKnowledge({ db, outDir: secondDir });

    expect(first.pageCount).toBe(2);
    expect(second.pageCount).toBe(2);
    expect(second.written).toEqual(first.written);
    expect(second.unchanged).toEqual([]);
    expect(first.notes).toEqual([]);

    const firstFiles = listFiles(firstDir);
    const secondFiles = listFiles(secondDir);
    expect(secondFiles).toEqual(firstFiles);

    // Byte equality, not string equality: an encoding or line-ending difference
    // is exactly the kind of drift a backup is supposed to be immune to.
    for (const relative of firstFiles) {
      const a = fs.readFileSync(path.join(firstDir, ...relative.split('/')));
      const b = fs.readFileSync(path.join(secondDir, ...relative.split('/')));
      expect(a.equals(b), `${relative} differs between two exports`).toBe(true);
    }
  });

  it('is idempotent in place: a re-export rewrites nothing', () => {
    seed();

    exportKnowledge({ db, outDir: firstDir });
    const again = exportKnowledge({ db, outDir: firstDir });

    expect(again.written).toEqual([]);
    expect(again.unchanged.sort()).toEqual(listFiles(firstDir).sort());
  });

  it('round-trips [[wikilinks]], aliases, tags and sources without loss', () => {
    const { linked } = seed();

    exportKnowledge({ db, outDir: firstDir });

    const relative = 'topic/excel-etl.md';
    expect(listFiles(firstDir)).toContain(relative);
    const { frontmatter, body } = splitNote(readNote(firstDir, relative));

    // Identity columns come back exactly as stored.
    expect(frontmatter.id).toBe(linked);
    expect(frontmatter.page_type).toBe('topic');
    expect(frontmatter.slug).toBe('excel-etl');
    expect(frontmatter.title).toBe('Excel ETL');
    expect(frontmatter.aliases).toEqual(['ETL', 'Excel 清洗']);
    expect(frontmatter.tags).toEqual(['excel', '数据清洗']);
    expect(frontmatter.confidence).toBe(0.82);
    expect(frontmatter.version).toBe(1);
    expect(frontmatter.status).toBe('active');
    expect(frontmatter.sources).toEqual([`memory:${MEMORY_A}`, `memory:${MEMORY_B}`]);

    // The body is the stored markdown, character for character — both wikilink
    // forms survive, including the alias (`|`) form.
    expect(body.trimEnd()).toBe(LINKED_CONTENT);
    expect(body).toContain('[[topic/power-query|Power Query]]');
    expect(body).toContain('[[postgres]]');

    // Everything the body stored is still a resolvable wikilink target for
    // Obsidian: the page it names is exported, under exactly that path.
    expect(listFiles(firstDir)).toContain('topic/power-query.md');
  });

  it('generates an H1 only when the body has none', () => {
    seed();

    exportKnowledge({ db, outDir: firstDir });

    const headingless = splitNote(readNote(firstDir, 'topic/power-query.md'));
    expect(headingless.body.startsWith('# Power Query\n')).toBe(true);
    expect(headingless.body.trimEnd()).toBe(`# Power Query\n\n${HEADINGLESS_CONTENT}`);

    // A page that already opens with its own H1 does not get a second title.
    const linked = splitNote(readNote(firstDir, 'topic/excel-etl.md'));
    expect(linked.body.match(/^# /gm)).toHaveLength(1);
    expect(linked.body.trimEnd()).toBe(LINKED_CONTENT);
  });

  it('projects active pages only', () => {
    const { archived, pending } = seed();

    exportKnowledge({ db, outDir: firstDir });

    const files = listFiles(firstDir);
    expect(files).toEqual(['index.md', 'topic/excel-etl.md', 'topic/power-query.md']);
    expect(files.some((file) => file.includes('retired-topic'))).toBe(false);
    expect(files.some((file) => file.includes('pending-topic'))).toBe(false);

    const index = readNote(firstDir, 'index.md');
    expect(index).not.toContain(archived);
    expect(index).not.toContain(pending);
    expect(index).not.toContain('Retired Topic');
    expect(index).not.toContain('Pending Topic');
    // The index links to notes by wikilink, which is what makes the directory
    // browsable as a vault rather than a pile of files.
    expect(index).toContain('[[topic/excel-etl|Excel ETL]]');
    expect(index).toContain('[[topic/power-query|Power Query]]');
  });

  it('a dry run reports the plan and touches nothing', () => {
    seed();

    const result = exportKnowledge({ db, outDir: firstDir, dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.pageCount).toBe(2);
    expect(result.written.sort()).toEqual([
      'index.md',
      'topic/excel-etl.md',
      'topic/power-query.md',
    ]);
    expect(fs.existsSync(firstDir)).toBe(false);
  });
});
