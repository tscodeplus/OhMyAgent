#!/usr/bin/env node
/**
 * `pnpm graph:export` — project the memory database into an Obsidian vault.
 *
 * Read-only mirror by design: the database is authored by the agent, the vault
 * is generated output. Run it as often as you like — unchanged rows produce
 * byte-identical notes, and `vault/manual/**` is never touched.
 *
 *   pnpm graph:export                    # write ./vault
 *   pnpm graph:export --out ~/vault      # custom vault directory
 *   pnpm graph:export --dry-run          # show the plan, write nothing
 *   pnpm graph:export --verbose          # one line per written/same/deleted note
 *
 * Database resolution matches the server: `DATABASE_PATH`, else
 * `database.path` in `config.yaml` (honouring `CONFIG_FILE`), else
 * `~/.ohmyagent/data/app.db`. The file is opened with `readonly: true`; this
 * command must not be able to change memory.
 */

import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadYamlFile } from '../src/app/config-loader.js';
import { exportVault } from '../src/graph-export/vault-exporter.js';

const DEFAULT_DB_PATH = '~/.ohmyagent/data/app.db';
const DEFAULT_OUT_DIR = 'vault';

interface CliOptions {
  outDir: string;
  dryRun: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { outDir: DEFAULT_OUT_DIR, dryRun: false, verbose: false };
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
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!options.outDir) throw new Error('--out requires a directory');
  return options;
}

function printHelp(): void {
  console.log(`Usage: pnpm graph:export [--out <dir>] [--dry-run] [--verbose]

  --out, -o <dir>   Vault directory to write (default: ./${DEFAULT_OUT_DIR})
  --dry-run         Report what would change without writing anything
  --verbose, -v     Print every written, unchanged and deleted note

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

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const dbPath = resolveDbPath();
  const resolvedDbPath = path.resolve(dbPath);

  if (!fs.existsSync(resolvedDbPath)) {
    console.error(`[graph:export] database not found: ${resolvedDbPath}`);
    console.error('  Set DATABASE_PATH or configure database.path in config.yaml.');
    process.exit(1);
  }

  // readonly: the exporter reads memory, it never writes it.
  const db = new Database(resolvedDbPath, { readonly: true, fileMustExist: true });
  try {
    const result = exportVault({
      db,
      outDir: options.outDir,
      dryRun: options.dryRun,
      verbose: options.verbose,
    });

    for (const note of result.notes) console.log(`[graph:export] ${note}`);
    console.log(
      `[graph:export] ${result.outDir} — ${result.written.length} written, ` +
        `${result.unchanged.length} unchanged, ${result.deleted.length} deleted` +
        (result.dryRun ? ' (dry run, nothing written)' : ''),
    );
    if (!result.entityTablesPresent) {
      console.log(
        '[graph:export] exported memories and sessions only; run the memory migrations to include entities.',
      );
    }
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(`[graph:export] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
