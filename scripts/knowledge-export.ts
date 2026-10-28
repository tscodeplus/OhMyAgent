#!/usr/bin/env node
/**
 * `pnpm knowledge:export` — one-way projection of `knowledge_pages` into markdown.
 *
 * The database is the source of truth; the files are disposable output. That
 * split is enforced here, not by convention:
 *
 *   - the connection is opened `readonly: true`, so this command cannot change a
 *     page even if it wanted to,
 *   - only `status = 'active'` pages are projected (§7 of the plan: the same
 *     hard filter `knowledge_search`/`knowledge_get`/link resolution apply — a
 *     shadow-mode `pending` page must not leak into a browsable export),
 *   - output is deterministic: pages are sorted by `(page_type, slug)`, the
 *     frontmatter key order is fixed, and every timestamp comes from the row
 *     rather than the clock. Two runs against an unchanged database produce
 *     byte-identical notes, which is what makes a second run report nothing
 *     changed,
 *   - page bodies are written verbatim, so `[[wikilinks]]` stay intact and an
 *     Obsidian vault can be opened on top of the result.
 *
 * Markdown rendering reuses `src/graph-export/format.ts` (`frontmatterBlock`,
 * `singleLine`, `wikilink`) and `src/graph-export/slug.ts` (`safeFileStem`,
 * `safeJoin`) — the same helpers the memory vault projection uses — instead of a
 * second emitter with its own YAML and path rules.
 *
 * This command never deletes: a page removed from the database leaves its
 * previous file behind. Export into an empty directory when an exact projection
 * matters.
 *
 *   pnpm knowledge:export                    # write ./knowledge
 *   pnpm knowledge:export --out ~/knowledge  # custom directory
 *   pnpm knowledge:export --dry-run          # report the plan, write nothing
 *   pnpm knowledge:export --verbose          # one line per written/same note
 *
 * Database resolution matches the server: `DATABASE_PATH`, else `database.path`
 * in `config.yaml` (honouring `CONFIG_FILE`), else `~/.ohmyagent/data/app.db`.
 */

import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { loadYamlFile } from '../src/app/config-loader.js';
import { hasTable } from '../src/graph-export/sqlite-schema.js';
import {
  formatTimestamp,
  frontmatterBlock,
  singleLine,
  wikilink,
} from '../src/graph-export/format.js';
import { safeFileStem, safeJoin } from '../src/graph-export/slug.js';

const DEFAULT_DB_PATH = '~/.ohmyagent/data/app.db';
const DEFAULT_OUT_DIR = 'knowledge';

const PAGES_TABLE = 'knowledge_pages';
const SOURCES_TABLE = 'knowledge_sources';

/** Written at the root of the export; not a page. */
const INDEX_NOTE = 'index.md';

const LOG_PREFIX = '[knowledge:export]';

const PAGES_ABSENT_NOTICE =
  'knowledge_pages not present — start the agent once so the v14 migration runs';

/** One `knowledge_pages` row with the JSON columns parsed and timestamps rendered. */
interface ExportPage {
  id: string;
  pageType: string;
  slug: string;
  title: string;
  content: string;
  aliases: string[];
  tags: string[];
  confidence: number | null;
  version: number;
  createdAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  /** Citations as `<kind>:<id>`, sorted. */
  sources: string[];
}

interface GeneratedNote {
  /** Export-relative POSIX path. */
  path: string;
  content: string;
}

type Row = Record<string, unknown>;

export interface ExportKnowledgeOptions {
  db: Database.Database;
  outDir: string;
  /** Compute the plan and report it without touching the filesystem. */
  dryRun?: boolean;
  /** Print one line per written / unchanged note. */
  verbose?: boolean;
}

export interface ExportKnowledgeResult {
  outDir: string;
  /** Export-relative POSIX paths, sorted. */
  written: string[];
  unchanged: string[];
  /** Active pages projected (or that would be, in a dry run). */
  pageCount: number;
  /** Operator-facing messages (a missing table, an unreadable JSON column). */
  notes: string[];
  dryRun: boolean;
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

/**
 * A JSON array column (`aliases`, `tags`) as a trimmed string list.
 *
 * Malformed JSON is data corruption, so it is reported rather than swallowed —
 * but it is reported and skipped instead of aborting the whole export, because a
 * browsable dump of every other page is still worth having.
 */
function parseStringArray(
  value: unknown,
  field: string,
  pageId: string,
  notes: string[],
): string[] {
  const text = asText(value);
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  } catch {
    notes.push(
      `${PAGES_TABLE}.${field} of page ${pageId} is not a JSON array — exported without it`,
    );
    return [];
  }
}

/** `<kind>:<id>` citations, grouped by page. */
function readSources(db: Database.Database, notes: string[]): Map<string, string[]> {
  const byPage = new Map<string, string[]>();
  if (!hasTable(db, SOURCES_TABLE)) {
    notes.push(`${SOURCES_TABLE} not present — pages are exported without citations`);
    return byPage;
  }
  const rows = db
    .prepare(
      `SELECT page_id, source_kind, source_id FROM ${SOURCES_TABLE}
       ORDER BY page_id, source_kind, source_id`,
    )
    .all() as Row[];
  for (const row of rows) {
    const pageId = asText(row.page_id);
    const kind = asText(row.source_kind);
    const id = asText(row.source_id);
    if (!pageId || !kind || !id) continue;
    const list = byPage.get(pageId) ?? [];
    list.push(`${kind}:${id}`);
    byPage.set(pageId, list);
  }
  return byPage;
}

/**
 * Read the pages this command projects: `active` only, newest-agnostic, sorted by
 * `(page_type, slug)` so the file set does not depend on insertion order.
 */
function readPages(db: Database.Database, notes: string[]): ExportPage[] {
  if (!hasTable(db, PAGES_TABLE)) {
    notes.push(PAGES_ABSENT_NOTICE);
    return [];
  }
  const sourcesByPage = readSources(db, notes);
  const rows = db
    .prepare(`SELECT * FROM ${PAGES_TABLE} WHERE status = 'active' ORDER BY page_type, slug, id`)
    .all() as Row[];

  const pages: ExportPage[] = [];
  for (const row of rows) {
    const id = asText(row.id);
    const pageType = asText(row.page_type);
    const slug = asText(row.slug);
    const title = asText(row.title);
    const content = row.content === null || row.content === undefined ? null : String(row.content);
    // A row without an identity or a body cannot become a note; skipping it is
    // less destructive than inventing a name for it.
    if (!id || !pageType || !slug || !title || content === null) {
      notes.push(
        `page ${id ?? '<unknown id>'} is missing id/page_type/slug/title/content — skipped`,
      );
      continue;
    }
    pages.push({
      id,
      pageType,
      slug,
      title,
      content,
      aliases: parseStringArray(row.aliases, 'aliases', id, notes),
      tags: parseStringArray(row.tags, 'tags', id, notes),
      confidence: asNumber(row.confidence),
      version: asNumber(row.version) ?? 1,
      createdAt: formatTimestamp(row.created_at),
      updatedAt: formatTimestamp(row.updated_at),
      updatedBy: asText(row.updated_by),
      sources: sourcesByPage.get(id) ?? [],
    });
  }
  return pages;
}

/**
 * File stem per page, disambiguated when two slugs of the same page type
 * collapse to the same file name (`a_b` and `a-b` are distinct slugs but one
 * stem). Mirrors `assignStems` in `vault-exporter.ts`, which is not exported;
 * the suffix is a hash of the slug, so it depends only on the data. The key is
 * per page-type directory: `topic/x` and `project/x` are two pages that must
 * keep the plain name `x.md` in their own directories.
 */
function assignStems(pages: ExportPage[]): Map<string, string> {
  const stems = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const page of pages) {
    const stem = safeFileStem(page.slug);
    const key = `${safeFileStem(page.pageType)}/${stem}`;
    stems.set(page.id, stem);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const page of pages) {
    const stem = stems.get(page.id)!;
    const key = `${safeFileStem(page.pageType)}/${stem}`;
    if ((counts.get(key) ?? 0) < 2) continue;
    const suffix = createHash('sha256').update(page.slug).digest('hex').slice(0, 8);
    stems.set(page.id, `${stem}-${suffix}`);
  }
  return stems;
}

/** Export-relative path of a page note: `<page_type>/<stem>.md`. */
function notePath(page: ExportPage, stems: Map<string, string>): string {
  return `${safeFileStem(page.pageType)}/${stems.get(page.id)!}.md`;
}

/** True when the body already opens with an H1 — then it needs no generated title. */
function startsWithHeading(content: string): boolean {
  const firstLine =
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  return /^#\s/.test(firstLine);
}

function renderPageNote(page: ExportPage): string {
  const frontmatter: Record<string, unknown> = {
    id: page.id,
    page_type: page.pageType,
    slug: page.slug,
    title: page.title,
  };
  if (page.aliases.length > 0) frontmatter.aliases = page.aliases;
  if (page.tags.length > 0) frontmatter.tags = page.tags;
  if (page.confidence !== null) frontmatter.confidence = page.confidence;
  frontmatter.version = page.version;
  frontmatter.status = 'active';
  if (page.createdAt) frontmatter.created_at = page.createdAt;
  if (page.updatedAt) frontmatter.updated_at = page.updatedAt;
  if (page.updatedBy) frontmatter.updated_by = page.updatedBy;
  if (page.sources.length > 0) frontmatter.sources = page.sources;

  // The body is written verbatim: a `[[wikilink]]` rewritten here would no
  // longer be the text the page stores. A generated H1 is added only when the
  // page body does not already start with one, so no note gets two titles.
  const body = page.content.trimEnd();
  const lines: string[] = [frontmatterBlock(frontmatter)];
  if (!startsWithHeading(body)) lines.push(`# ${singleLine(page.title)}`, '');
  lines.push(body, '');
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function renderIndexNote(pages: ExportPage[], stems: Map<string, string>): string {
  const byType = new Map<string, ExportPage[]>();
  for (const page of pages) {
    const list = byType.get(page.pageType) ?? [];
    list.push(page);
    byType.set(page.pageType, list);
  }
  const types = [...byType.keys()].sort((a, b) => a.localeCompare(b));

  const lines: string[] = [
    frontmatterBlock({ title: 'OhMyAgent knowledge export' }),
    '# OhMyAgent knowledge export',
    '',
    'This directory is a **projection** of the `knowledge_pages` table:',
    '`pnpm knowledge:export` rewrites `index.md` and one directory per page type in',
    'one direction. Pages are authored in the database (through the agent or the',
    'WebUI), never in these files — edits to a generated note are lost on the next',
    'export.',
    '',
    'Only `active` pages are exported; `pending` and `archived` pages stay in the database.',
    '',
    '## Counts',
    '',
    '| Page type | Pages |',
    '| --- | --- |',
  ];
  for (const type of types) lines.push(`| ${type} | ${byType.get(type)!.length} |`);
  lines.push(`| **Total** | ${pages.length} |`, '');

  for (const type of types) {
    lines.push(`## ${type}`, '');
    for (const page of byType.get(type)!) {
      const target = notePath(page, stems).replace(/\.md$/, '');
      lines.push(`- ${wikilink(target, page.title)}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function writeNote(absolutePath: string, content: string): void {
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.tmp`;
  fs.writeFileSync(temporaryPath, content, 'utf8');
  fs.renameSync(temporaryPath, absolutePath);
}

/**
 * Project the active knowledge pages into `outDir`.
 *
 * Read-only with respect to the database; idempotent with respect to the
 * directory — a note whose text has not changed is not rewritten.
 */
export function exportKnowledge(options: ExportKnowledgeOptions): ExportKnowledgeResult {
  const dryRun = options.dryRun ?? false;
  const outDir = path.resolve(options.outDir);
  const notes: string[] = [];

  const pages = readPages(options.db, notes);
  const stems = assignStems(pages);

  const generated: GeneratedNote[] = [];
  for (const page of pages) {
    generated.push({ path: notePath(page, stems), content: renderPageNote(page) });
  }
  if (hasTable(options.db, PAGES_TABLE)) {
    generated.push({ path: INDEX_NOTE, content: renderIndexNote(pages, stems) });
  }
  generated.sort((a, b) => a.path.localeCompare(b.path));

  const written: string[] = [];
  const unchanged: string[] = [];
  if (!dryRun) fs.mkdirSync(outDir, { recursive: true });

  for (const note of generated) {
    const absolutePath = safeJoin(outDir, ...note.path.split('/'));
    const existing = fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, 'utf8') : null;
    if (existing === note.content) {
      unchanged.push(note.path);
      continue;
    }
    if (!dryRun) writeNote(absolutePath, note.content);
    written.push(note.path);
  }

  written.sort();
  unchanged.sort();

  if (options.verbose) {
    for (const notePath of written) console.log(`  write    ${notePath}`);
    for (const notePath of unchanged) console.log(`  same     ${notePath}`);
  }

  return { outDir, written, unchanged, pageCount: pages.length, notes, dryRun };
}

interface CliOptions {
  outDir: string;
  dryRun: boolean;
  verbose: boolean;
  help: boolean;
}

export function parseExportArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    outDir: DEFAULT_OUT_DIR,
    dryRun: false,
    verbose: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--out' || arg === '-o') {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a directory`);
      options.outDir = value;
    } else if (arg.startsWith('--out=')) {
      options.outDir = arg.slice('--out='.length);
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!options.outDir) throw new Error('--out requires a directory');
  return options;
}

function printHelp(): void {
  console.log(`Usage: pnpm knowledge:export [--out <dir>] [--dry-run] [--verbose]

  --out, -o <dir>   Directory to write (default: ./${DEFAULT_OUT_DIR})
  --dry-run         Report what would change without writing anything
  --verbose, -v     Print every written and unchanged note

Projects the active knowledge pages to markdown, one directory per page type.
Read-only against the database; a second run over unchanged pages reports
nothing changed. Files are never deleted, so export into an empty directory when
an exact projection matters.

Environment:
  DATABASE_PATH     Overrides database.path from config.yaml
  CONFIG_FILE       Path to config.yaml (default: ./config.yaml)`);
}

/** Same `~` expansion the server applies before opening the database. */
function resolveHome(dbPath: string): string {
  return dbPath.startsWith('~') ? path.join(os.homedir(), dbPath.slice(1)) : dbPath;
}

function resolveDbPath(): string {
  if (process.env.DATABASE_PATH) return resolveHome(process.env.DATABASE_PATH);

  const configPath = process.env.CONFIG_FILE || './config.yaml';
  const yaml = loadYamlFile(configPath, process.env);
  const fromYaml = (yaml?.database as { path?: unknown } | undefined)?.path;
  if (typeof fromYaml === 'string' && fromYaml.trim()) return resolveHome(fromYaml.trim());

  return resolveHome(DEFAULT_DB_PATH);
}

/** Returns the process exit code; nothing here calls `process.exit` mid-flight. */
export function runKnowledgeExport(argv: string[]): number {
  const options = parseExportArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }

  const resolvedDbPath = path.resolve(resolveDbPath());
  if (!fs.existsSync(resolvedDbPath)) {
    console.error(`${LOG_PREFIX} database not found: ${resolvedDbPath}`);
    console.error('  Set DATABASE_PATH or configure database.path in config.yaml.');
    return 1;
  }

  // readonly: this command projects knowledge, it never writes it.
  const db = new Database(resolvedDbPath, { readonly: true, fileMustExist: true });
  try {
    const result = exportKnowledge({
      db,
      outDir: options.outDir,
      dryRun: options.dryRun,
      verbose: options.verbose,
    });

    for (const note of result.notes) console.log(`${LOG_PREFIX} ${note}`);

    if (result.written.length === 0) {
      console.log(
        `${LOG_PREFIX} ${result.outDir} — nothing changed, ${result.unchanged.length} note(s) up to date` +
          ` (${result.pageCount} page(s))` +
          (result.dryRun ? ' [dry run]' : ''),
      );
    } else {
      console.log(
        `${LOG_PREFIX} ${result.outDir} — ${result.written.length} written, ` +
          `${result.unchanged.length} unchanged (${result.pageCount} page(s))` +
          (result.dryRun ? ' [dry run, nothing written]' : ''),
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

// Only run when invoked as a script; importing this module from a test must not
// open a database.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    process.exitCode = runKnowledgeExport(process.argv.slice(2));
  } catch (error) {
    console.error(`${LOG_PREFIX} ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
