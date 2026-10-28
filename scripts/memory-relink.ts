#!/usr/bin/env node
/**
 * `pnpm memory:relink` — backfill `memory_sources` for memories that predate
 * provenance.
 *
 * `memory-writer.ts` now writes `memory_sources` rows in the same transaction as
 * the memory itself, but every memory written before that is unlinked: measured
 * on the live database, `source_message_id` was 0/28 and `memory_sources` did
 * not exist at all. Without a backfill the "hit a memory → jump to the
 * sentences it came from" edge only exists for new rows.
 *
 * The match is deliberately conservative, because a wrong provenance edge is
 * worse than a missing one: it makes an unrelated message look like evidence.
 *
 *   1. The memory's `scope_key` must be a session that still exists. Preferences
 *      are written with the session as their scope key, so that is where their
 *      sentences are; when the key does not identify a session there is nothing
 *      to search and the memory is left alone.
 *   2. Candidate messages are only that session's messages.
 *   3. Coverage = the share of the memory's tokens its sources jointly account
 *      for (jieba tokens, stop words and single characters dropped). Messages are
 *      taken greedily, highest coverage first, until the union reaches
 *      `MIN_COVERAGE` — a summary's ten sources each cover a slice, so a single
 *      message can never explain it.
 *   4. Below `MIN_COVERAGE` nothing is written. Never guess.
 *
 *   pnpm memory:relink                # link up to 500 memories
 *   pnpm memory:relink --limit 2000   # raise the per-run bound
 *   pnpm memory:relink --dry-run      # report what would be linked, write nothing
 *   pnpm memory:relink --verbose      # per-memory decisions as they are made
 *
 * Database resolution matches the server: `DATABASE_PATH`, else `database.path`
 * in `config.yaml` (honouring `CONFIG_FILE`), else `~/.ohmyagent/data/app.db`.
 * This command WRITES, so the database is opened read-write.
 */

import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { loadYamlFile } from '../src/app/config-loader.js';
import { tokenizeForIndex, ZH_STOP_WORDS } from '../src/memory/fts-tokenizer.js';

const DEFAULT_DB_PATH = '~/.ohmyagent/data/app.db';
const DEFAULT_LIMIT = 500;
/** Share of a memory's tokens its sources must jointly cover to be linked. */
const MIN_COVERAGE = 0.8;
/** Per-message floor: a single matching word is not evidence of provenance. */
const MIN_MESSAGE_COVERAGE = 0.15;
/** One summary is compressed out of a handful of messages, not a whole session. */
const MAX_SOURCES_PER_MEMORY = 10;
/** Memories committed per transaction. */
const BATCH_SIZE = 25;

export interface RelinkOptions {
  /** Maximum memories to examine in this run. */
  limit: number;
  /** Do the matching, report the counts, write nothing. */
  dryRun: boolean;
  verbose?: boolean;
  log?: (message: string) => void;
}

export interface RelinkSummary {
  scanned: number;
  linked: number;
  /** No confident match — left alone on purpose. */
  refused: number;
  sourcesWritten: number;
  dryRun: boolean;
}

interface MemoryRow {
  id: string;
  scope_key: string;
  kind: string;
  content: string;
}

interface MessageRow {
  id: string;
  role: string;
  content: string;
}

/** Tokens are the unit of similarity: jieba words, lower-cased, no stop words. */
export function tokenSet(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of tokenizeForIndex(text).split(/\s+/)) {
    const token = raw.trim().toLowerCase();
    if (token.length < 2) continue;
    if (ZH_STOP_WORDS.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

/**
 * The messages that explain `memoryContent`, chosen greedily by coverage.
 *
 * Returns [] when no set of messages covers `MIN_COVERAGE` of the memory's
 * tokens — the caller must treat that as "unknown provenance", not as "no
 * sources worth writing".
 */
export function matchSourceMessages(
  memoryContent: string,
  messages: MessageRow[],
): Array<{ message: MessageRow; coverage: number }> {
  const memoryTokens = tokenSet(memoryContent);
  if (memoryTokens.size === 0) return [];

  const scored = messages
    .map((message) => {
      const messageTokens = tokenSet(message.content);
      let overlap = 0;
      for (const token of messageTokens) {
        if (memoryTokens.has(token)) overlap += 1;
      }
      return { message, coverage: overlap / memoryTokens.size };
    })
    .filter((candidate) => candidate.coverage >= MIN_MESSAGE_COVERAGE)
    .sort((a, b) => b.coverage - a.coverage || a.message.id.localeCompare(b.message.id))
    .slice(0, MAX_SOURCES_PER_MEMORY);

  const covered = new Set<string>();
  const chosen: Array<{ message: MessageRow; coverage: number }> = [];
  for (const candidate of scored) {
    chosen.push(candidate);
    for (const token of tokenSet(candidate.message.content)) {
      if (memoryTokens.has(token)) covered.add(token);
    }
    if (covered.size / memoryTokens.size >= MIN_COVERAGE) break;
  }

  return covered.size / memoryTokens.size >= MIN_COVERAGE ? chosen : [];
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/**
 * Link memories that have no `memory_sources` row yet. Returns the counts; never
 * throws on a single bad row (one unmatched memory is the normal outcome).
 */
export function relinkMemorySources(db: Database.Database, options: RelinkOptions): RelinkSummary {
  const summary: RelinkSummary = {
    scanned: 0,
    linked: 0,
    refused: 0,
    sourcesWritten: 0,
    dryRun: options.dryRun,
  };
  if (!tableExists(db, 'memory_sources')) {
    throw new Error(
      'memory_sources is missing — start the agent once so the v13 migration runs, then retry',
    );
  }

  const memories = db
    .prepare(
      `SELECT m.id, m.scope_key, m.kind, m.content
       FROM memories m
       WHERE m.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM memory_sources s WHERE s.memory_id = m.id)
       ORDER BY m.created_at
       LIMIT ?`,
    )
    .all(options.limit) as MemoryRow[];

  const sessionExists = db.prepare('SELECT 1 FROM sessions WHERE id = ?');
  const selectMessages = db.prepare(
    'SELECT id, role, content FROM messages WHERE session_id = ? ORDER BY created_at',
  );
  const insertSource = db.prepare(
    `INSERT OR IGNORE INTO memory_sources (memory_id, message_id, session_id, role, source, created_at)
     VALUES (?, ?, ?, ?, 'backfill', ?)`,
  );

  let pending: Array<{ memory: MemoryRow; sources: MessageRow[] }> = [];

  const commit = (): void => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    if (options.dryRun) {
      for (const entry of batch) summary.sourcesWritten += entry.sources.length;
      return;
    }
    db.transaction(() => {
      const now = Date.now();
      for (const entry of batch) {
        for (const source of entry.sources) {
          insertSource.run(entry.memory.id, source.id, entry.memory.scope_key, source.role, now);
        }
        summary.sourcesWritten += entry.sources.length;
      }
    })();
  };

  for (const memory of memories) {
    summary.scanned += 1;

    // A scope key that is not a session leaves nowhere to look. `user`-scope
    // memories keyed by something else (`default`, an agent id) fall here.
    if (sessionExists.get(memory.scope_key) === undefined) {
      summary.refused += 1;
      options.log?.(`refused ${memory.id} (scope_key ${memory.scope_key} is not a session)`);
      continue;
    }

    const messages = selectMessages.all(memory.scope_key) as MessageRow[];
    const matched = matchSourceMessages(memory.content, messages);
    if (matched.length === 0) {
      summary.refused += 1;
      options.log?.(`refused ${memory.id} (no confident match)`);
      continue;
    }

    summary.linked += 1;
    if (options.verbose) {
      options.log?.(
        `linked ${memory.id} (${memory.kind}) -> ${matched
          .map((entry) => `${entry.message.id}@${entry.coverage.toFixed(2)}`)
          .join(', ')}`,
      );
    }
    pending.push({ memory, sources: matched.map((entry) => entry.message) });
    if (pending.length >= BATCH_SIZE) commit();
  }
  commit();

  return summary;
}

// ── CLI ──

const HELP = `
Backfill memory provenance: link memories that have no memory_sources row to the
messages they were derived from.

Matching is conservative — a memory whose scope key is not a session, or whose
session messages do not cover at least ${Math.round(MIN_COVERAGE * 100)}% of its tokens,
is left unlinked rather than guessed at.

Options:
  --limit, -l <n>  Maximum memories to examine (default ${DEFAULT_LIMIT})
  --dry-run        Report what would be linked, write nothing
  --verbose, -v    Print the per-memory decision
  -h, --help       Show this help

Environment:
  DATABASE_PATH     Overrides database.path from config.yaml
  CONFIG_FILE       Path to config.yaml (default: ./config.yaml)
`;

function printHelp(): void {
  console.log(HELP.trimStart());
}

function parsePositiveInt(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): { limit: number; dryRun: boolean; verbose: boolean } {
  const options = { limit: DEFAULT_LIMIT, dryRun: false, verbose: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--limit' || arg === '-l') {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a number`);
      options.limit = parsePositiveInt('--limit', value);
    } else if (arg.startsWith('--limit=')) {
      options.limit = parsePositiveInt('--limit', arg.slice('--limit='.length));
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
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

/** CLI wrapper. Returns the process exit code; never throws. */
export function runMemoryRelink(argv: readonly string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return 0;
  }

  let options: ReturnType<typeof parseArgs>;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(`[memory:relink] ${err instanceof Error ? err.message : String(err)}`);
    console.error(HELP);
    return 1;
  }

  const dbPath = path.resolve(resolveDbPath());
  if (!fs.existsSync(dbPath)) {
    console.error(`[memory:relink] database not found: ${dbPath}`);
    console.error('  Set DATABASE_PATH or configure database.path in config.yaml.');
    return 1;
  }

  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  try {
    if (options.verbose) {
      console.log(`[memory:relink] ${dbPath}`);
      console.log(`[memory:relink] limit ${options.limit}${options.dryRun ? ', dry run' : ''}`);
    }
    const summary = relinkMemorySources(db, {
      limit: options.limit,
      dryRun: options.dryRun,
      verbose: options.verbose,
      log: (message) => console.log(`[memory:relink] ${message}`),
    });
    console.log(
      `[memory:relink] scanned ${summary.scanned} | linked ${summary.linked} | ` +
        `refused ${summary.refused} | sources ${summary.sourcesWritten}` +
        (summary.dryRun ? ' (dry run, nothing written)' : ''),
    );
    return 0;
  } catch (err) {
    console.error(`[memory:relink] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}

// Only run when invoked as a script; importing this module from a test must not
// touch the filesystem.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = runMemoryRelink(process.argv.slice(2));
}
