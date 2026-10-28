#!/usr/bin/env node
/**
 * `pnpm graph:reset` — remove what the pre-K3 graph invented.
 *
 * Before the projection read a recorded subject, `graph-sync` had to guess one
 * for every `memory_links` row that missed it: the highest-confidence link named
 * the subject, and a memory with a single link got a `memory:<id>` placeholder
 * node instead. It also wrote `MENTIONED` edges for plain co-occurrence.
 * Measured on the real database that produced 9 placeholder nodes out of 22
 * entities and 17 `MENTIONED` edges out of 18 — the graph could not be traversed
 * into anything.
 *
 * The deletes live in `src/graph/legacy-cleanup.ts`, not here: migration v17
 * runs the same code at startup (so an upgrade repairs itself), and this command
 * exists for a one-off run against a live database. Keeping one implementation
 * is the point — the previous copy in this script drifted from the projection
 * and `pnpm graph:mine` was broken for weeks because of it.
 *
 * This command only cleans. Nothing is re-created here: run `pnpm graph:mine`
 * then `pnpm graph:sync` afterwards, or let migration v17 do all three on the
 * next start.
 *
 *   pnpm graph:reset                      # delete in batches of 500
 *   pnpm graph:reset --dry-run            # report the counts, change nothing
 *   pnpm graph:reset --limit 100          # smaller batches (one commit each)
 *   pnpm graph:reset --verbose            # per-step counts
 *
 * Android/Termux: every batch is its own transaction, because the 5000 ms
 * `busy_timeout` is shared with IM replies and a single long write lock would
 * make a Feishu/Telegram reply time out. The command is idempotent — a second
 * run finds nothing and reports zeros.
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
import {
  cleanupLegacyGraph,
  DEFAULT_LEGACY_CLEANUP_BATCH_SIZE,
  missingGraphTables,
} from '../src/graph/legacy-cleanup.js';

/**
 * The script's public name for the cleanup. Kept as a re-export so the CLI, its
 * tests and the migration keep exactly one implementation.
 */
export { cleanupLegacyGraph as resetGraph };

const DEFAULT_DB_PATH = '~/.ohmyagent/data/app.db';

interface CliOptions {
  limit: number;
  dryRun: boolean;
  verbose: boolean;
  help: boolean;
}

export function parseResetArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    limit: DEFAULT_LEGACY_CLEANUP_BATCH_SIZE,
    dryRun: false,
    verbose: false,
    help: false,
  };
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

function printHelp(): void {
  console.log(`Usage: pnpm graph:reset [--limit <n>] [--dry-run] [--verbose]

  --limit, -l <n>   Rows removed per transaction (default: ${DEFAULT_LEGACY_CLEANUP_BATCH_SIZE})
  --dry-run         Report the counts, then roll every delete back
  --verbose, -v     Print the resolved options and per-step counts

Deletes entity_type='memory' placeholder nodes (and their edges), the legacy
MENTIONED co-occurrence edges, and orphan edges. Real entities are untouched.
Run \`pnpm graph:mine\` and \`pnpm graph:sync\` afterwards to rebuild the graph
from memory_links — or let migration v17 do all three on the next start.

Environment:
  DATABASE_PATH     Overrides database.path from config.yaml
  CONFIG_FILE       Path to config.yaml (default: ./config.yaml)`);
}

/** Same `~` expansion the server applies before opening the database. */
function resolveHome(dbPath: string): string {
  return dbPath.startsWith('~') ? path.join(os.homedir(), dbPath.slice(1)) : dbPath;
}

export function resolveDbPath(): string {
  if (process.env.DATABASE_PATH) return resolveHome(process.env.DATABASE_PATH);

  const configPath = process.env.CONFIG_FILE || './config.yaml';
  const yaml = loadYamlFile(configPath, process.env);
  const fromYaml = (yaml?.database as { path?: unknown } | undefined)?.path;
  if (typeof fromYaml === 'string' && fromYaml.trim()) return resolveHome(fromYaml.trim());

  return resolveHome(DEFAULT_DB_PATH);
}

/** Returns the process exit code; nothing here calls `process.exit` mid-flight. */
export function runGraphReset(argv: string[]): number {
  const options = parseResetArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }

  const resolvedDbPath = path.resolve(resolveDbPath());
  if (!fs.existsSync(resolvedDbPath)) {
    console.error(`[graph:reset] database not found: ${resolvedDbPath}`);
    console.error('  Set DATABASE_PATH or configure database.path in config.yaml.');
    return 1;
  }

  // Read-write: this command deletes rows.
  const db = new Database(resolvedDbPath, { fileMustExist: true });
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  try {
    const missing = missingGraphTables(db);
    if (missing.length > 0) {
      console.error(
        `[graph:reset] missing table(s): ${missing.join(', ')} — start the agent once so the schema and migrations create them.`,
      );
      return 1;
    }

    if (options.verbose) {
      console.log(`[graph:reset] ${resolvedDbPath}`);
      console.log(
        `[graph:reset] batch size ${options.limit}` + (options.dryRun ? ', dry run' : ''),
      );
    }

    const summary = cleanupLegacyGraph(db, {
      limit: options.limit,
      dryRun: options.dryRun,
      log: options.verbose ? (message) => console.log(message) : undefined,
    });

    console.log(
      `[graph:reset] placeholders ${summary.placeholderEntities} entities + ${summary.placeholderEdges} edges | ` +
        `MENTIONED edges ${summary.mentionEdges} | ` +
        `orphans ${summary.orphanEndpointEdges} endpoint, ${summary.orphanMemoryEdges} memory`,
    );
    console.log(
      options.dryRun
        ? '[graph:reset] dry run — nothing was deleted'
        : '[graph:reset] done — run `pnpm graph:mine` then `pnpm graph:sync` to rebuild from memory_links.subject_entity',
    );
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
    process.exitCode = runGraphReset(process.argv.slice(2));
  } catch (error) {
    console.error(`[graph:reset] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
