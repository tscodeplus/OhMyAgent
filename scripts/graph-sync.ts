#!/usr/bin/env node
/**
 * `pnpm graph:sync` — materialise `entities`/`entity_edges` from `memory_links`.
 *
 * The same projection the maintenance scheduler runs (`graph_sync`), exposed for
 * one-off use: seeding the graph of an existing database after an upgrade, or
 * re-running it by hand after raising `memory.graph.max_links_per_run`.
 *
 *   pnpm graph:sync                       # project up to 500 links
 *   pnpm graph:sync --limit 2000          # raise the per-run bound
 *   pnpm graph:sync --dry-run             # count, then roll everything back
 *   pnpm graph:sync --verbose             # per-step counts as they are applied
 *
 * Database resolution matches the server: `DATABASE_PATH`, else `database.path`
 * in `config.yaml` (honouring `CONFIG_FILE`), else `~/.ohmyagent/data/app.db`.
 * Unlike `scripts/export-vault.ts` this command WRITES, so the database is
 * opened read-write — a read-only handle would make every statement fail.
 */

import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadYamlFile } from '../src/app/config-loader.js';
import { syncGraphFromMemoryLinks } from '../src/graph/graph-sync.js';
import { selfHealGraph } from '../src/graph/graph-prune.js';
import { DEFAULT_GRAPH_SYNC_CONFIG } from '../src/graph/graph-config.js';
import { EntityRepository } from '../src/memory/repositories/entity-repository.js';

const DEFAULT_DB_PATH = '~/.ohmyagent/data/app.db';

interface CliOptions {
  limit: number;
  dryRun: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    limit: DEFAULT_GRAPH_SYNC_CONFIG.maxLinksPerRun,
    dryRun: false,
    verbose: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--limit' || arg === '-l') {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a number`);
      options.limit = parseLimit(value);
    } else if (arg.startsWith('--limit=')) {
      options.limit = parseLimit(arg.slice('--limit='.length));
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

function parseLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`--limit must be a positive integer, got "${value}"`);
  }
  return limit;
}

function printHelp(): void {
  console.log(`Usage: pnpm graph:sync [--limit <n>] [--dry-run] [--verbose]

  --limit, -l <n>   Maximum links to project in this run (default: ${DEFAULT_GRAPH_SYNC_CONFIG.maxLinksPerRun})
  --dry-run         Do the work, report the counts, then roll it back
  --verbose, -v     Print the resolved options and per-run breakdown

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

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const resolvedDbPath = path.resolve(resolveDbPath());

  if (!fs.existsSync(resolvedDbPath)) {
    console.error(`[graph:sync] database not found: ${resolvedDbPath}`);
    console.error('  Set DATABASE_PATH or configure database.path in config.yaml.');
    process.exit(1);
  }

  // Read-write: this command inserts entities and edges.
  const db = new Database(resolvedDbPath, { fileMustExist: true });
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  try {
    if (!hasEntityTables(db)) {
      console.error(
        '[graph:sync] the entities/entity_edges tables are missing — start the agent once so the v10 migration runs.',
      );
      process.exit(1);
    }

    if (options.verbose) {
      console.log(`[graph:sync] ${resolvedDbPath}`);
      console.log(
        `[graph:sync] limit ${options.limit}, min confidence ${DEFAULT_GRAPH_SYNC_CONFIG.minConfidence}` +
          (options.dryRun ? ', dry run' : ''),
      );
    }

    const summary = syncGraphFromMemoryLinks(db, new EntityRepository(db), {
      limit: options.limit,
      dryRun: options.dryRun,
    });

    // The same eviction the scheduled job performs. Without it this CLI and the
    // 6-hourly job would disagree about what the graph contains, which is the
    // drift that made "run graph:reset" a documented step in the first place.
    const healed = selfHealGraph(db, { dryRun: options.dryRun });
    if (healed.edgesPruned > 0 || healed.nodesMerged > 0) {
      console.log(
        `[graph:sync] pruned ${healed.edgesPruned} edge(s) the current rules refuse, ` +
          `merged ${healed.nodesMerged} duplicate node(s)`,
      );
    }

    console.log(
      `[graph:sync] entities ${summary.entitiesCreated} created, ${summary.entitiesMatched} matched | ` +
        `edges ${summary.edgesCreated} created, ${summary.edgesRefreshed} refreshed | ` +
        `skipped ${summary.skipped}`,
    );
    if (options.verbose) {
      console.log(
        `[graph:sync] memories ${summary.memoriesProcessed}, links ${summary.linksProcessed}` +
          (options.dryRun ? ' (dry run, nothing written)' : ''),
      );
    }
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(`[graph:sync] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
