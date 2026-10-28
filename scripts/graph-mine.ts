#!/usr/bin/env node
/**
 * `pnpm graph:mine` — mine entities out of memory text the graph never covered.
 *
 * The same pass the `graph_sync` maintenance job runs after the link
 * projection, exposed for one-off use: filling a graph that was built before
 * mention mining existed, or re-running it by hand after lowering
 * `memory.graph.max_mentions_per_memory`. Deterministic and model-free, so it is
 * safe to run against a live database (it takes the same busy timeout the server
 * uses) and safe to re-run (a mined memory keeps its edges as its own cursor).
 *
 *   pnpm graph:mine                      # mine up to 500 memories
 *   pnpm graph:mine --limit 2000         # raise the per-run bound
 *   pnpm graph:mine --dry-run            # count, then roll everything back
 *   pnpm graph:mine --verbose            # resolved options and per-pass counts
 *
 * Database resolution matches the server: `DATABASE_PATH`, else `database.path`
 * in `config.yaml` (honouring `CONFIG_FILE`), else `~/.ohmyagent/data/app.db`.
 * This command WRITES, so the database is opened read-write.
 */

import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadYamlFile } from '../src/app/config-loader.js';
import { mineGraphFromMemories } from '../src/graph/graph-sync.js';
import { DEFAULT_GRAPH_SYNC_CONFIG } from '../src/graph/graph-config.js';
import { EntityRepository } from '../src/memory/repositories/entity-repository.js';

const DEFAULT_DB_PATH = '~/.ohmyagent/data/app.db';

interface CliOptions {
  limit: number;
  maxMentions: number;
  dryRun: boolean;
  verbose: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    limit: DEFAULT_GRAPH_SYNC_CONFIG.maxLinksPerRun,
    maxMentions: DEFAULT_GRAPH_SYNC_CONFIG.maxMentionsPerMemory,
    dryRun: false,
    verbose: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--limit' || arg === '-l') {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a number`);
      options.limit = parsePositiveInt('--limit', value);
    } else if (arg.startsWith('--limit=')) {
      options.limit = parsePositiveInt('--limit', arg.slice('--limit='.length));
    } else if (arg === '--max-mentions' || arg === '-m') {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a number`);
      options.maxMentions = parsePositiveInt('--max-mentions', value);
    } else if (arg.startsWith('--max-mentions=')) {
      options.maxMentions = parsePositiveInt('--max-mentions', arg.slice('--max-mentions='.length));
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
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
  console.log(`Usage: pnpm graph:mine [--limit <n>] [--max-mentions <n>] [--dry-run] [--verbose]

  --limit, -l <n>         Maximum memories to mine in this run (default: ${DEFAULT_GRAPH_SYNC_CONFIG.maxLinksPerRun})
  --max-mentions, -m <n>  Maximum entities taken from one memory (default: ${DEFAULT_GRAPH_SYNC_CONFIG.maxMentionsPerMemory})
  --dry-run               Do the work, report the counts, then roll it back
  --verbose, -v           Print the resolved options and per-run breakdown

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

function hasEntityTables(db: Database.Database): boolean {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS cnt FROM sqlite_master WHERE type = 'table' AND name IN ('entities', 'entity_edges')",
    )
    .get() as { cnt: number };
  return row.cnt === 2;
}

/** Returns the process exit code; nothing here calls `process.exit` mid-flight. */
function main(): number {
  const options = parseArgs(process.argv.slice(2));
  if (options.help === true) return 0;

  const resolvedDbPath = path.resolve(resolveDbPath());
  if (!fs.existsSync(resolvedDbPath)) {
    console.error(`[graph:mine] database not found: ${resolvedDbPath}`);
    console.error('  Set DATABASE_PATH or configure database.path in config.yaml.');
    return 1;
  }

  const db = new Database(resolvedDbPath, { fileMustExist: true });
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  try {
    if (!hasEntityTables(db)) {
      console.error(
        '[graph:mine] the entities/entity_edges tables are missing — start the agent once so the v10 migration runs.',
      );
      return 1;
    }

    if (options.verbose) {
      console.log(`[graph:mine] ${resolvedDbPath}`);
      console.log(
        `[graph:mine] limit ${options.limit}, max mentions per memory ${options.maxMentions}` +
          (options.dryRun ? ', dry run' : ''),
      );
    }

    const summary = mineGraphFromMemories(db, new EntityRepository(db), {
      limit: options.limit,
      maxMentionsPerMemory: options.maxMentions,
      dryRun: options.dryRun,
    });

    console.log(
      `[graph:mine] entities ${summary.entitiesCreated} created, ${summary.entitiesMatched} matched | ` +
        `edges ${summary.edgesCreated} created, ${summary.edgesRefreshed} refreshed | ` +
        `skipped ${summary.skipped}`,
    );
    if (options.verbose) {
      console.log(
        `[graph:mine] memories ${summary.memoriesMined}, mentions ${summary.mentionsMined}` +
          (options.dryRun ? ' (dry run, nothing written)' : ''),
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`[graph:mine] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
