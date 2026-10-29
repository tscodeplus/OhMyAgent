#!/usr/bin/env node
/**
 * `pnpm knowledge:merge` — propose (and, with `--apply`, perform) merges of
 * knowledge pages that are the same thing under two names.
 *
 * The pass itself lives in `src/memory/knowledge/merge.ts`; this file is the
 * argument parsing, the database resolution and the proposal table. That split
 * is deliberate: the merge rules are the part with consequences, so they are
 * importable and tested directly, and the CLI only decides *whether* to write.
 *
 * Three properties the command is expected to hold, and how each is kept:
 *
 * - **A dry run cannot write.** Default mode opens the database `readonly: true`
 *   (the same discipline `knowledge:reindex --check` follows), so a "proposal"
 *   that changed a row would fail at the SQLite level rather than by promise.
 * - **Idempotent.** A merge archives the loser, and only `active` pages are
 *   candidates, so a second `--apply` finds nothing to do and writes no rows to
 *   `knowledge_log`. The proposal table is the whole state — there is no cursor
 *   to get out of step.
 * - **Bounded.** `--limit` caps the proposals per run (default 50), candidate
 *   detection reads identity columns instead of bodies, and each merge commits
 *   in its own transaction: the phone shares one write lock with IM replies
 *   (plan §9.4 item 2).
 *
 * No model call, no `embeddingClient`, no new table: the evidence is string
 * evidence (`normalized_name`, `alias_collision`, `edit_distance`), which is
 * what the plan asks for in §6 K4 for the first version.
 *
 *   pnpm knowledge:merge                     # proposal table, writes nothing
 *   pnpm knowledge:merge --apply             # merge every proposal in the table
 *   pnpm knowledge:merge --limit 10          # at most 10 proposals
 *   pnpm knowledge:merge --type topic        # one page type
 *   pnpm knowledge:merge --verbose           # print the evidence per proposal
 *
 * Database resolution matches the server: `DATABASE_PATH`, else `database.path`
 * in `config.yaml` (honouring `CONFIG_FILE`), else `~/.ohmyagent/data/app.db`.
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
  applyMergePlan,
  findMergeCandidates,
  type MergeCandidate,
  type MergeOutcome,
  type MergePlan,
} from '../src/memory/knowledge/merge.js';
import { isPageType, PAGE_TYPES, type PageType } from '../src/memory/knowledge/types.js';

const DEFAULT_DB_PATH = '~/.ohmyagent/data/app.db';
const DEFAULT_LIMIT = 50;
const PAGES_TABLE = 'knowledge_pages';
const LOG_PREFIX = '[knowledge:merge]';

/** Column the proposal table pads to; longer titles are clipped with `…`. */
const MAX_TITLE_WIDTH = 40;

interface CliOptions {
  apply: boolean;
  limit: number;
  pageTypes: PageType[];
  verbose: boolean;
  help: boolean;
}

export function parseMergeArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    limit: DEFAULT_LIMIT,
    pageTypes: [],
    verbose: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--limit' || arg === '-l') {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a number`);
      options.limit = parsePositiveInt('--limit', value);
    } else if (arg.startsWith('--limit=')) {
      options.limit = parsePositiveInt('--limit', arg.slice('--limit='.length));
    } else if (arg === '--type' || arg === '-t') {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a page type`);
      options.pageTypes.push(parsePageType(value));
    } else if (arg.startsWith('--type=')) {
      options.pageTypes.push(parsePageType(arg.slice('--type='.length)));
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
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

function parsePageType(value: string): PageType {
  if (!isPageType(value)) {
    throw new Error(`--type must be one of ${PAGE_TYPES.join(', ')}, got "${value}"`);
  }
  return value;
}

function printHelp(): void {
  console.log(`Usage: pnpm knowledge:merge [--apply] [--limit <n>] [--type <page_type>] [--verbose]

  --apply           Perform the merges the table lists (default: propose only)
  --limit, -l <n>   At most <n> proposals in this run (default: ${DEFAULT_LIMIT})
  --type, -t <t>    Only this page type (${PAGE_TYPES.join(' | ')}); repeatable
  --verbose, -v     Print every piece of evidence behind a proposal

Proposes merges of knowledge pages of the same page type **and scope** that name
the same thing: the same normalized name, a colliding alias, or one edit apart.
Two chats holding the same title are the same subject discussed in two places,
so they are never proposed as duplicates; only global pages merge with each
other. No model is called — the evidence is the names as stored.

Applying a merge repoints the loser's citations, its incoming [[wikilinks]] and
its graph entities to the survivor, moves its names onto the survivor, and
archives the loser (nothing is deleted, bodies are not concatenated). The merged
pair is recorded in knowledge_log with action 'merge'. A second --apply finds
nothing to do.

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

function clip(text: string, width: number): string {
  if (text.length <= width) return text;
  return `${text.slice(0, width - 1)}…`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/**
 * The reviewable table: one row per proposal, with the decision inputs a human
 * needs (which page survives, which is archived, why) and nothing generated from
 * the clock, so two dry runs print the same bytes.
 */
function renderProposalTable(candidates: MergeCandidate[], verbose: boolean): string[] {
  if (candidates.length === 0) return [];
  const header = ['#', 'TYPE', 'SCOPE', 'SURVIVES', 'ARCHIVED', 'EVIDENCE'];
  const rows = candidates.map((candidate, index) => [
    String(index + 1),
    candidate.pageType,
    candidate.scope,
    `${clip(candidate.survivor.title, MAX_TITLE_WIDTH)} (${candidate.survivor.slug})`,
    `${clip(candidate.loser.title, MAX_TITLE_WIDTH)} (${candidate.loser.slug})`,
    candidate.evidence.map((entry) => entry.kind).join(', '),
  ]);

  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => row[column].length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, column) => pad(cell, widths[column]))
      .join('  ')
      .replace(/\s+$/, '');

  const lines = [line(header), widths.map((width) => '-'.repeat(width)).join('  ')];
  rows.forEach((row, index) => {
    lines.push(line(row));
    if (!verbose) return;
    for (const evidence of candidates[index].evidence) {
      lines.push(`     ${evidence.kind}: ${evidence.detail}`);
    }
  });
  return lines;
}

function describeOutcome(outcome: MergeOutcome): string {
  if (outcome.status === 'skipped') return `skipped ${outcome.loserId} — ${outcome.reason}`;
  const { repointed } = outcome;
  const parts = [
    `sources ${repointed.sources}`,
    `incoming links ${repointed.incomingLinks}`,
    `aliases +${repointed.aliasesAdded.length}`,
    `graph edges ${repointed.entityEdges}`,
    `memory links ${repointed.memoryLinks}`,
  ];
  if (repointed.entityLosersDeleted.length > 0) {
    parts.push(`entities deleted ${repointed.entityLosersDeleted.length}`);
  }
  if (repointed.entityLosersKept.length > 0) {
    parts.push(`entities kept ${repointed.entityLosersKept.length} (still referenced)`);
  }
  if (repointed.collapsedLinks > 0)
    parts.push(`duplicate links dropped ${repointed.collapsedLinks}`);
  if (repointed.bodiesNeedingRewrite.length > 0) {
    parts.push(`bodies to rewrite ${repointed.bodiesNeedingRewrite.length}`);
  }
  return `${outcome.survivorId} <- ${outcome.loserId}: ${parts.join(', ')}`;
}

/** Returns the process exit code; nothing here calls `process.exit` mid-flight. */
export function runKnowledgeMerge(argv: string[]): number {
  const options = parseMergeArgs(argv);
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

  // A dry run must be incapable of writing, so it is also the only readonly open.
  const db = options.apply
    ? new Database(resolvedDbPath, { fileMustExist: true })
    : new Database(resolvedDbPath, { readonly: true, fileMustExist: true });
  if (options.apply) {
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
  }

  try {
    if (!hasTable(db, PAGES_TABLE)) {
      console.error(
        `${LOG_PREFIX} missing table: ${PAGES_TABLE} — start the agent once so the v14 migration runs.`,
      );
      return 1;
    }

    console.log(`${LOG_PREFIX} ${resolvedDbPath}${options.apply ? '' : ' [dry run]'}`);

    const plan: MergePlan = findMergeCandidates(db, {
      limit: options.limit,
      pageTypes: options.pageTypes,
    });
    for (const note of plan.notes) console.log(`${LOG_PREFIX} ${note}`);

    const table = renderProposalTable(plan.candidates, options.verbose);
    for (const line of table) console.log(line);

    if (plan.candidates.length === 0) {
      console.log(`${LOG_PREFIX} no candidates — nothing to merge`);
      return 0;
    }

    console.log(
      `${LOG_PREFIX} ${plan.candidates.length} proposal(s)` +
        (plan.claimedPairs > 0
          ? `, ${plan.claimedPairs} further pair(s) dropped because one page was claimed`
          : '') +
        (plan.pairCount > plan.candidates.length
          ? `, ${plan.pairCount - plan.candidates.length} withheld by --limit (run again after merging)`
          : ''),
    );

    if (!options.apply) {
      console.log(`${LOG_PREFIX} nothing written — re-run with --apply to merge these`);
      return 0;
    }

    const outcomes = applyMergePlan(db, plan);
    let merged = 0;
    for (const outcome of outcomes) {
      if (outcome.status === 'merged') merged += 1;
      console.log(`${LOG_PREFIX} ${describeOutcome(outcome)}`);
    }
    console.log(`${LOG_PREFIX} merged ${merged} pair(s), recorded in knowledge_log`);
    if (merged < outcomes.length) {
      console.log(
        `${LOG_PREFIX} ${outcomes.length - merged} proposal(s) skipped — nothing was written for them`,
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
    process.exitCode = runKnowledgeMerge(process.argv.slice(2));
  } catch (error) {
    console.error(`${LOG_PREFIX} ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
