#!/usr/bin/env node
/**
 * `pnpm memory:sweep-volatile` — the closing half of plan §4 (entry 1).
 *
 * Changing `writePreference()` to pick `kind` from `detectTopic()` only affects
 * what is written from now on. The rows already in the database keep
 * `kind = 'preference'`, which is one of the two kinds `MemoryHygiene` never
 * touches (`memory-hygiene.ts` retention list), so a cached directory listing
 * written before the fix lives forever *and* keeps being injected every turn by
 * the `<persona>` block. This command is how those rows stop being permanent.
 *
 * It is a script, not a migration, for the reason §4 gives: a migration runs on
 * every open, this needs to run once; and it must not run on the startup path,
 * because on Android a slow boot is a boot the phantom process killer ends.
 *
 * ## What it decides, and what it refuses to decide
 *
 *   - `assessDurability() === 'volatile'` (the same negative list the write path
 *     uses — one implementation, so the sweep and the writer cannot disagree
 *     about what a transient looks like) → downgrade `kind` to `fact`, which
 *     hands the row to hygiene's `tempRetentionDays` horizon (90 by default).
 *   - `detectTopic() === 'preferred_name'` → left alone. A name is a falsifiable
 *     long-term attribute and the read side (`containsPreferredNameExpression`)
 *     treats those rows as authoritative; §3.1 keeps them `preference` on purpose.
 *   - Everything else (`unknown`) → left alone. The gate is a negative list, so
 *     `unknown` means "not provably transient", not "worthless".
 *
 * Nothing is deleted unless `--delete` is passed with `--apply`, and even then
 * the delete goes through `MemoryRepository.delete()` +
 * `EmbeddingRepository.deleteByMemoryId()` so `vec_memory_embeddings` and the
 * jieba FTS index are cleaned up too. Raw SQL here would leave orphan vectors
 * (the `vec_` virtual tables have no FK cascade) and orphan FTS rows — the reason
 * `memory-hygiene.ts` does the same thing through the repositories.
 *
 *   pnpm memory:sweep-volatile                # print the table, write nothing
 *   pnpm memory:sweep-volatile --apply        # downgrade volatile rows to `fact`
 *   pnpm memory:sweep-volatile --apply --delete   # delete them instead
 *   pnpm memory:sweep-volatile --apply --limit 500
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
import { MemoryRepository } from '../src/memory/repositories/memory-repository.js';
import { EmbeddingRepository } from '../src/memory/repositories/embedding-repository.js';
import { assessDurability } from '../src/memory/write/durability.js';
import { detectTopic } from '../src/memory/write/preference-conflict-resolver.js';

const DEFAULT_DB_PATH = '~/.ohmyagent/data/app.db';
const DEFAULT_LIMIT = 2000;

export interface SweepOptions {
  /** Downgrade/delete instead of reporting. */
  apply: boolean;
  /** With `apply`, delete the offending rows instead of downgrading them. */
  delete?: boolean;
  limit?: number;
  log?: (message: string) => void;
}

export type SweepVerdict = 'downgrade' | 'delete' | 'keep';

export interface SweepRow {
  id: string;
  kind: string;
  scope: string;
  scope_key: string | null;
  created_at: string;
  content: string;
  verdict: SweepVerdict;
  /** Why this verdict — printed next to the row and used by the tests. */
  reason: 'volatile' | 'preferred_name' | 'not_provable';
}

export interface SweepSummary {
  scanned: number;
  downgraded: number;
  deleted: number;
  kept: number;
  dryRun: boolean;
  rows: SweepRow[];
}

interface CandidateRow {
  id: string;
  kind: string;
  scope: string;
  scope_key: string | null;
  created_at: string;
  content: string;
}

/**
 * One row's verdict, without touching the database.
 *
 * Exported so the acceptance cases live in a test rather than in a `--dry-run`
 * transcript someone has to read: `preferred_name` must survive, `volatile` must
 * be downgraded, `unknown` must be left alone.
 */
export function judgeSweepRow(row: { kind: string; content: string }): {
  verdict: SweepVerdict;
  reason: SweepRow['reason'];
} {
  if (detectTopic(row.content) === 'preferred_name') {
    return { verdict: 'keep', reason: 'preferred_name' };
  }
  if (assessDurability(row.content) === 'volatile') {
    return { verdict: 'downgrade', reason: 'volatile' };
  }
  return { verdict: 'keep', reason: 'not_provable' };
}

/**
 * Sweep the volatile `preference` rows. Never throws on a single bad row.
 *
 * `--delete` is folded into the verdict rather than applied afterwards so the
 * printed table already says what will happen: a dry run that reports
 * "downgrade" for rows the operator intends to delete is a table that lies.
 */
export function sweepVolatilePreferences(
  db: Database.Database,
  options: SweepOptions,
): SweepSummary {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const memoryRepo = new MemoryRepository(db);
  const embeddingRepo = new EmbeddingRepository(db);

  const candidates = db
    .prepare(
      `SELECT id, kind, scope, scope_key, created_at, content
         FROM memories
        WHERE status = 'active' AND kind = 'preference'
        ORDER BY created_at
        LIMIT ?`,
    )
    .all(limit) as CandidateRow[];

  const rows: SweepRow[] = [];
  const summary: SweepSummary = {
    scanned: candidates.length,
    downgraded: 0,
    deleted: 0,
    kept: 0,
    dryRun: !options.apply,
    rows,
  };

  for (const candidate of candidates) {
    const judged = judgeSweepRow(candidate);
    const verdict: SweepVerdict =
      judged.verdict === 'downgrade' && options.delete ? 'delete' : judged.verdict;
    rows.push({ ...candidate, verdict, reason: judged.reason });
    if (verdict === 'keep') {
      summary.kept += 1;
      continue;
    }

    if (verdict === 'downgrade') {
      summary.downgraded += 1;
      if (options.apply) {
        // Through the repository: it keeps `syncJiebaFts` in step, so the row
        // stays searchable under its new kind.
        memoryRepo.update(candidate.id, { kind: 'fact' });
      }
      options.log?.(`downgraded ${candidate.id} (preference → fact)`);
      continue;
    }

    summary.deleted += 1;
    if (options.apply) {
      embeddingRepo.deleteByMemoryId(candidate.id);
      memoryRepo.delete(candidate.id);
    }
    options.log?.(`deleted ${candidate.id}`);
  }

  return summary;
}

// ── CLI ──

const HELP = `
Downgrade (or delete) the preference memories that state a transient: a
directory listing, a narrated past event, or one task's output requirement.
kind = 'preference' is exempt from retention, so these rows never expire.

Nothing is written without --apply, and nothing is deleted without --delete.

Options:
  --apply          Perform the downgrade (default: dry run)
  --delete         Delete the offending rows instead of downgrading them
  --limit, -l <n>  Maximum rows to scan (default ${DEFAULT_LIMIT})
  --json           Print the plan as JSON
  -h, --help       Show this help

Environment:
  DATABASE_PATH     Overrides database.path from config.yaml
  CONFIG_FILE       Path to config.yaml (default: ./config.yaml)
`;

function parsePositiveInt(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): {
  apply: boolean;
  delete: boolean;
  limit: number;
  json: boolean;
} {
  const options = { apply: false, delete: false, limit: DEFAULT_LIMIT, json: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--delete') options.delete = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--limit' || arg === '-l') {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a number`);
      options.limit = parsePositiveInt('--limit', value);
    } else if (arg.startsWith('--limit=')) {
      options.limit = parsePositiveInt('--limit', arg.slice('--limit='.length));
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (options.delete && !options.apply) {
    throw new Error('--delete requires --apply (a dry run must not name a deletion it cannot do)');
  }
  return options;
}

/** Same `~` expansion and precedence the server uses. */
function resolveDbPath(): string {
  const expand = (value: string): string =>
    value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value;

  if (process.env.DATABASE_PATH) return expand(process.env.DATABASE_PATH);

  const yaml = loadYamlFile(process.env.CONFIG_FILE || './config.yaml', process.env);
  const fromYaml = (yaml?.database as { path?: unknown } | undefined)?.path;
  if (typeof fromYaml === 'string' && fromYaml.trim()) return expand(fromYaml.trim());

  return expand(DEFAULT_DB_PATH);
}

function printTable(summary: SweepSummary): void {
  for (const row of summary.rows) {
    const head = `${row.verdict.padEnd(9)} ${row.id} (${row.reason}) ${row.created_at}`;
    const body = row.content.replace(/\s+/g, ' ').slice(0, 100);
    console.log(`  ${head}\n      ${body}`);
  }
}

/** CLI wrapper. Returns the process exit code; never throws. */
export function runMemorySweepVolatile(argv: readonly string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP.trimStart());
    return 0;
  }

  let options: ReturnType<typeof parseArgs>;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(`[memory:sweep-volatile] ${err instanceof Error ? err.message : String(err)}`);
    console.error(HELP);
    return 1;
  }

  const dbPath = path.resolve(resolveDbPath());
  if (!fs.existsSync(dbPath)) {
    console.error(`[memory:sweep-volatile] database not found: ${dbPath}`);
    console.error('  Set DATABASE_PATH or configure database.path in config.yaml.');
    return 1;
  }

  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  try {
    const summary = sweepVolatilePreferences(db, {
      apply: options.apply,
      delete: options.delete,
      limit: options.limit,
      log: options.json
        ? undefined
        : (message) => console.log(`[memory:sweep-volatile] ${message}`),
    });
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      printTable(summary);
      console.log(
        `[memory:sweep-volatile] scanned ${summary.scanned} | downgraded ${summary.downgraded} | ` +
          `deleted ${summary.deleted} | kept ${summary.kept}` +
          (summary.dryRun ? ' (dry run, nothing written)' : ''),
      );
    }
    return 0;
  } catch (err) {
    console.error(`[memory:sweep-volatile] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}

// Only run when invoked as a script; importing this module from a test must not
// touch the filesystem.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = runMemorySweepVolatile(process.argv.slice(2));
}
