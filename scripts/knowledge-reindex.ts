#!/usr/bin/env node
/**
 * `pnpm knowledge:reindex` — rebuild `knowledge_fts_jieba` from `knowledge_pages`,
 * or report whether the two still agree.
 *
 * The index is a cache of a segmentation decision: `content` holds the
 * jieba-segmented body, so a tokenizer change, or a row that drifted because a
 * process died between the page write and the index write, can only be repaired
 * by re-deriving it. `--check` is the read-only half of the command — it
 * compares the two tables and exits non-zero on any mismatch.
 *
 *   pnpm knowledge:reindex              # rebuild every page
 *   pnpm knowledge:reindex --check      # report only, exit 1 on any mismatch
 *   pnpm knowledge:reindex --limit 200  # index at most 200 pages, then stop
 *   pnpm knowledge:reindex --verbose    # one line per indexed page
 *
 * Android/Termux: this is deliberately a manual command, never a startup step
 * (plan §9.4 item 1 — the phantom process killer turns a slow boot into
 * "sometimes does not start"), and each page commits in its own transaction
 * (§9.4 item 2 — the 5000 ms `busy_timeout` is shared with IM replies). That is
 * also why `rebuild()` in `indexer.ts` is not called here: it does the identical
 * DELETE-then-INSERT inside *one* transaction, which is right for an in-process
 * repair and wrong for a phone. The per-page primitive it wraps
 * (`indexKnowledgePage`) is reused, so there is no second FTS write path, and a
 * run killed halfway leaves the processed pages correct and the rest untouched —
 * this command never deletes the whole index first.
 *
 * Database resolution matches the server: `DATABASE_PATH`, else `database.path`
 * in `config.yaml` (honouring `CONFIG_FILE`), else `~/.ohmyagent/data/app.db`.
 * `--check` opens the file `readonly: true`; a rebuild is the only mode that
 * writes.
 */

import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { loadYamlFile } from '../src/app/config-loader.js';
import { hasTable } from '../src/graph-export/sqlite-schema.js';
import {
  checkConsistency,
  indexKnowledgePage,
  type KnowledgeIndexConsistency,
} from '../src/memory/knowledge/indexer.js';
import type { PageType } from '../src/memory/knowledge/types.js';

const DEFAULT_DB_PATH = '~/.ohmyagent/data/app.db';
const PAGES_TABLE = 'knowledge_pages';
const INDEX_TABLE = 'knowledge_fts_jieba';

/** Ids printed per inconsistency list; the count in the header stays exact. */
const MAX_LISTED_IDS = 20;

const LOG_PREFIX = '[knowledge:reindex]';

interface PageRow {
  id: string;
  page_type: string;
  title: string;
  content: string;
}

export interface KnowledgeReindexOptions {
  /** Compare the tables and write nothing. */
  check?: boolean;
  /** Pages indexed in this run; omitted means every page. */
  limit?: number;
  /** Called once per indexed page; silent when absent. */
  log?: (message: string) => void;
}

export interface KnowledgeReindexSummary {
  mode: 'check' | 'rebuild';
  /** Pages whose index row was rewritten by this run (0 in check mode). */
  indexedPages: number;
  /** Index rows removed because their page no longer exists. */
  orphanRowsRemoved: number;
  /** Pages this run did not reach because of `limit`. */
  remainingPages: number;
  /** State of the index after the run (or as found, in check mode). */
  consistency: KnowledgeIndexConsistency;
}

/**
 * Rebuild the index, or check it.
 *
 * The caller owns the connection; this function never opens or closes it.
 */
export function reindexKnowledge(
  db: Database.Database,
  options: KnowledgeReindexOptions = {},
): KnowledgeReindexSummary {
  if (options.check) {
    return {
      mode: 'check',
      indexedPages: 0,
      orphanRowsRemoved: 0,
      remainingPages: 0,
      consistency: checkConsistency(db),
    };
  }

  // `LIMIT -1` is SQLite's "no limit", so one prepared statement serves both the
  // whole-table and the `--limit` batch case.
  const pages = db
    .prepare(`SELECT id, page_type, title, content FROM ${PAGES_TABLE} ORDER BY id LIMIT ?`)
    .all(options.limit ?? -1) as PageRow[];

  // One transaction per page: `indexKnowledgePage` is the DELETE-then-INSERT
  // pair that keeps a superseded body out of the index, and this wrapper is the
  // only thing the CLI adds to it.
  const indexOne = db.transaction((page: PageRow) => {
    indexKnowledgePage(db, {
      id: page.id,
      title: page.title,
      pageType: page.page_type as PageType,
      content: page.content,
    });
  });
  for (const page of pages) {
    indexOne(page);
    options.log?.(`  index    ${page.id} ${page.title}`);
  }

  // A page with no index row is unsearchable; a page that was deleted while its
  // index row stayed is searchable garbage. The FTS table has no foreign key to
  // `knowledge_pages`, so only this pass can remove the second kind. One
  // statement, because the row count is bounded by the pages ever deleted, not
  // by the corpus.
  const orphanRowsRemoved = db
    .prepare(`DELETE FROM ${INDEX_TABLE} WHERE page_id NOT IN (SELECT id FROM ${PAGES_TABLE})`)
    .run().changes;

  const totalPages = (
    db.prepare(`SELECT COUNT(*) AS cnt FROM ${PAGES_TABLE}`).get() as { cnt: number }
  ).cnt;

  return {
    mode: 'rebuild',
    indexedPages: pages.length,
    orphanRowsRemoved,
    remainingPages: Math.max(0, totalPages - pages.length),
    consistency: checkConsistency(db),
  };
}

interface CliOptions {
  check: boolean;
  limit: number | undefined;
  verbose: boolean;
  help: boolean;
}

export function parseReindexArgs(argv: string[]): CliOptions {
  const options: CliOptions = { check: false, limit: undefined, verbose: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--check') {
      options.check = true;
    } else if (arg === '--limit' || arg === '-l') {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a number`);
      options.limit = parsePositiveInt('--limit', value);
    } else if (arg.startsWith('--limit=')) {
      options.limit = parsePositiveInt('--limit', arg.slice('--limit='.length));
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (options.check && options.limit !== undefined) {
    throw new Error('--check writes nothing, so --limit does not apply to it');
  }
  return options;
}

function parsePositiveInt(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function printHelp(): void {
  console.log(`Usage: pnpm knowledge:reindex [--check] [--limit <n>] [--verbose]

  --check           Report page count vs index row count and exit 1 on a
                    mismatch; writes nothing
  --limit, -l <n>   Index at most <n> pages, then stop (batches on a phone)
  --verbose, -v     Print one line per indexed page

Rebuilds knowledge_fts_jieba from knowledge_pages. One transaction per page, so
an interrupted run never leaves the index half-deleted.

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

/** Comma-joined ids, truncated so a badly drifted index stays readable. */
function formatIdList(ids: string[]): string {
  if (ids.length <= MAX_LISTED_IDS) return ids.join(', ');
  return `${ids.slice(0, MAX_LISTED_IDS).join(', ')} … (+${ids.length - MAX_LISTED_IDS} more)`;
}

function printConsistency(consistency: KnowledgeIndexConsistency): void {
  console.log(
    `${LOG_PREFIX} pages ${consistency.pageCount}, index rows ${consistency.indexedRowCount}`,
  );
  if (consistency.missingPageIds.length > 0) {
    console.log(
      `${LOG_PREFIX} missing index rows (${consistency.missingPageIds.length}): ${formatIdList(consistency.missingPageIds)}`,
    );
  }
  if (consistency.duplicatePageIds.length > 0) {
    console.log(
      `${LOG_PREFIX} duplicated index rows (${consistency.duplicatePageIds.length}): ${formatIdList(consistency.duplicatePageIds)}`,
    );
  }
  if (consistency.orphanPageIds.length > 0) {
    console.log(
      `${LOG_PREFIX} orphan index rows (${consistency.orphanPageIds.length}): ${formatIdList(consistency.orphanPageIds)}`,
    );
  }
}

/** Returns the process exit code; nothing here calls `process.exit` mid-flight. */
export function runKnowledgeReindex(argv: string[]): number {
  const options = parseReindexArgs(argv);
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

  // `--check` must be incapable of writing, so it is also the only readonly open.
  const db = options.check
    ? new Database(resolvedDbPath, { readonly: true, fileMustExist: true })
    : new Database(resolvedDbPath, { fileMustExist: true });
  if (!options.check) {
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
  }

  try {
    const missing = [PAGES_TABLE, INDEX_TABLE].filter((table) => !hasTable(db, table));
    if (missing.length > 0) {
      console.error(
        `${LOG_PREFIX} missing table(s): ${missing.join(', ')} — start the agent once so the v14 migration runs.`,
      );
      return 1;
    }

    console.log(`${LOG_PREFIX} ${resolvedDbPath}`);

    const summary = reindexKnowledge(db, {
      check: options.check,
      limit: options.limit,
      log: options.verbose ? (message) => console.log(`${LOG_PREFIX}${message}`) : undefined,
    });

    if (summary.mode === 'check') {
      printConsistency(summary.consistency);
      if (summary.consistency.consistent) {
        console.log(`${LOG_PREFIX} consistent — index matches knowledge_pages`);
        return 0;
      }
      console.log(`${LOG_PREFIX} inconsistent — run \`pnpm knowledge:reindex\` to rebuild`);
      return 1;
    }

    console.log(
      `${LOG_PREFIX} indexed ${summary.indexedPages} page(s), removed ${summary.orphanRowsRemoved} orphan index row(s)`,
    );
    if (summary.remainingPages > 0) {
      console.log(
        `${LOG_PREFIX} ${summary.remainingPages} page(s) not reached by --limit — run again to continue (the index is partial)`,
      );
    }
    printConsistency(summary.consistency);

    if (summary.remainingPages > 0) return 0;
    if (summary.consistency.consistent) {
      console.log(`${LOG_PREFIX} done — index matches knowledge_pages`);
      return 0;
    }
    console.log(`${LOG_PREFIX} still inconsistent after a full rebuild — see the lists above`);
    return 1;
  } finally {
    db.close();
  }
}

// Only run when invoked as a script; importing this module from a test must not
// open a database.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    process.exitCode = runKnowledgeReindex(process.argv.slice(2));
  } catch (error) {
    console.error(`${LOG_PREFIX} ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
