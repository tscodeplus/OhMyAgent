#!/usr/bin/env node
/**
 * `pnpm graph:reset` — remove what the pre-K3 graph invented.
 *
 * Before the projection read a recorded subject, `graph-sync` had to guess one
 * for every `memory_links` row that missed it: the highest-confidence link
 * named the subject, and a memory with a single link got a `memory:<id>`
 * placeholder node instead. It also wrote `MENTIONED` edges for plain
 * co-occurrence. Measured on the real database that produced 9 placeholder
 * nodes out of 22 entities and 17 `MENTIONED` edges out of 18 — the graph could
 * not be traversed into anything.
 *
 * This command deletes exactly that legacy data, in this order:
 *   1. `entities` with `entity_type = 'memory'` and every edge touching them,
 *   2. `entity_edges` whose relation is `MENTIONED` (co-occurrence, not a
 *      statement — the projection no longer writes them either),
 *   3. edges with a missing endpoint (written while `PRAGMA foreign_keys` was
 *      off, which the v10 tables cannot prevent),
 *   4. edges whose `source_memory_id` no longer exists in `memories`.
 *
 * Real entities and their edges are never touched. Nothing is re-created here:
 * run `pnpm graph:sync` afterwards to project from `memory_links.subject_entity`.
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
import { LEGACY_PLACEHOLDER_ENTITY_TYPE } from '../src/graph/graph-sync.js';
import { MENTION_RELATION_TYPE } from '../src/graph/entity-mining.js';

const DEFAULT_DB_PATH = '~/.ohmyagent/data/app.db';
const DEFAULT_BATCH_SIZE = 500;

export interface GraphResetOptions {
  /** Rows removed per transaction. Default 500. */
  limit?: number;
  /** Do the work, report the counts, then roll everything back. */
  dryRun?: boolean;
  /** Optional sink for per-step progress; silent when absent. */
  log?: (message: string) => void;
}

export interface GraphResetSummary {
  /** `entities` rows with `entity_type = 'memory'` deleted. */
  placeholderEntities: number;
  /** Edges deleted because one endpoint was such a placeholder. */
  placeholderEdges: number;
  /** Legacy co-occurrence edges (`MENTIONED`) deleted. */
  mentionEdges: number;
  /** Edges deleted because an endpoint no longer exists. */
  orphanEndpointEdges: number;
  /** Edges deleted because their `source_memory_id` no longer exists. */
  orphanMemoryEdges: number;
}

/**
 * Sentinel thrown inside the dry-run transaction: better-sqlite3 rolls back on
 * throw and offers no other way to abort a transaction.
 */
const DRY_RUN_ROLLBACK = Symbol('graph-reset dry-run');

interface DeletePlan {
  key: keyof GraphResetSummary;
  /** Ids still to remove; the batch loop repeats until this returns nothing. */
  selectIds: (limit: number) => string[];
  /** Remove one batch of ids; returns how many rows were actually deleted. */
  deleteBatch: (ids: string[]) => number;
}

function hasTable(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

function placeholderPlan(db: Database.Database, summary: GraphResetSummary): DeletePlan {
  // Foreign-key cascades would do this on their own, but they only fire while
  // `PRAGMA foreign_keys` is on — and the data this command cleans up was
  // written by a process that may have had it off. Deleting explicitly keeps
  // the result identical either way.
  const deleteEdges = db.prepare(
    'DELETE FROM entity_edges WHERE source_entity_id = ? OR target_entity_id = ?',
  );
  const deleteAliases = db.prepare('DELETE FROM entity_aliases WHERE entity_id = ?');
  const deleteEntity = db.prepare('DELETE FROM entities WHERE id = ?');
  return {
    key: 'placeholderEntities',
    selectIds: (limit) =>
      (
        db
          .prepare('SELECT id FROM entities WHERE entity_type = ? ORDER BY created_at, id LIMIT ?')
          .all(LEGACY_PLACEHOLDER_ENTITY_TYPE, limit) as Array<{ id: string }>
      ).map((row) => row.id),
    deleteBatch: (ids) => {
      let deleted = 0;
      for (const id of ids) {
        summary.placeholderEdges += deleteEdges.run(id, id).changes;
        deleteAliases.run(id);
        deleted += deleteEntity.run(id).changes;
      }
      return deleted;
    },
  };
}

function mentionEdgePlan(db: Database.Database): DeletePlan {
  const deleteEdge = db.prepare('DELETE FROM entity_edges WHERE id = ?');
  return {
    key: 'mentionEdges',
    selectIds: (limit) =>
      (
        db
          .prepare(
            `SELECT id FROM entity_edges
             WHERE upper(trim(relation_type)) = ?
             ORDER BY created_at, id
             LIMIT ?`,
          )
          .all(MENTION_RELATION_TYPE, limit) as Array<{ id: string }>
      ).map((row) => row.id),
    deleteBatch: (ids) => ids.reduce((sum, id) => sum + deleteEdge.run(id).changes, 0),
  };
}

function orphanEndpointPlan(db: Database.Database): DeletePlan {
  const deleteEdge = db.prepare('DELETE FROM entity_edges WHERE id = ?');
  return {
    key: 'orphanEndpointEdges',
    selectIds: (limit) =>
      (
        db
          .prepare(
            `SELECT e.id AS id
             FROM entity_edges e
             LEFT JOIN entities s ON s.id = e.source_entity_id
             LEFT JOIN entities t ON t.id = e.target_entity_id
             WHERE s.id IS NULL OR t.id IS NULL
             ORDER BY e.created_at, e.id
             LIMIT ?`,
          )
          .all(limit) as Array<{ id: string }>
      ).map((row) => row.id),
    deleteBatch: (ids) => ids.reduce((sum, id) => sum + deleteEdge.run(id).changes, 0),
  };
}

function orphanMemoryPlan(db: Database.Database): DeletePlan {
  const deleteEdge = db.prepare('DELETE FROM entity_edges WHERE id = ?');
  return {
    key: 'orphanMemoryEdges',
    selectIds: (limit) =>
      (
        db
          .prepare(
            `SELECT e.id AS id
             FROM entity_edges e
             WHERE e.source_memory_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = e.source_memory_id)
             ORDER BY e.created_at, e.id
             LIMIT ?`,
          )
          .all(limit) as Array<{ id: string }>
      ).map((row) => row.id),
    deleteBatch: (ids) => ids.reduce((sum, id) => sum + deleteEdge.run(id).changes, 0),
  };
}

/**
 * Remove the legacy placeholder nodes, the `MENTIONED` edges and the orphan
 * edges. Idempotent: a second call finds nothing.
 */
export function resetGraph(
  db: Database.Database,
  options: GraphResetOptions = {},
): GraphResetSummary {
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_BATCH_SIZE));
  const dryRun = options.dryRun === true;
  const { log } = options;

  const summary: GraphResetSummary = {
    placeholderEntities: 0,
    placeholderEdges: 0,
    mentionEdges: 0,
    orphanEndpointEdges: 0,
    orphanMemoryEdges: 0,
  };

  const runStep = (plan: DeletePlan): void => {
    const deleteBatch = db.transaction((ids: string[]) => plan.deleteBatch(ids));
    for (;;) {
      const ids = plan.selectIds(limit);
      if (ids.length === 0) break;
      const deleted = deleteBatch(ids);
      summary[plan.key] += deleted;
      if (deleted === 0) break;
    }
    log?.(`[graph:reset] ${plan.key}: ${String(summary[plan.key])}`);
  };

  const runAll = (): void => {
    runStep(placeholderPlan(db, summary));
    runStep(mentionEdgePlan(db));
    runStep(orphanEndpointPlan(db));
    runStep(orphanMemoryPlan(db));
  };

  if (!dryRun) {
    runAll();
    return summary;
  }

  // Dry run: the same deletes inside one outer transaction, rolled back at the
  // end. Counting instead of deleting would report step 2 against data step 1
  // has not removed yet, so the numbers would not match a real run.
  const outer = db.transaction(() => {
    runAll();
    throw DRY_RUN_ROLLBACK;
  });
  try {
    outer();
  } catch (err) {
    if (err !== DRY_RUN_ROLLBACK) throw err;
  }
  return summary;
}

interface CliOptions {
  limit: number;
  dryRun: boolean;
  verbose: boolean;
  help: boolean;
}

export function parseResetArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    limit: DEFAULT_BATCH_SIZE,
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

  --limit, -l <n>   Rows removed per transaction (default: ${DEFAULT_BATCH_SIZE})
  --dry-run         Report the counts, then roll every delete back
  --verbose, -v     Print the resolved options and per-step counts

Deletes entity_type='memory' placeholder nodes (and their edges), the legacy
MENTIONED co-occurrence edges, and orphan edges. Real entities are untouched.
Run \`pnpm graph:sync\` afterwards to rebuild the graph from memory_links.

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
    const missing = ['entities', 'entity_edges'].filter((table) => !hasTable(db, table));
    if (missing.length > 0) {
      console.error(
        `[graph:reset] missing table(s): ${missing.join(', ')} — start the agent once so the v10 migration runs.`,
      );
      return 1;
    }

    if (options.verbose) {
      console.log(`[graph:reset] ${resolvedDbPath}`);
      console.log(
        `[graph:reset] batch size ${options.limit}` + (options.dryRun ? ', dry run' : ''),
      );
    }

    const summary = resetGraph(db, {
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
        : '[graph:reset] done — run `pnpm graph:sync` to project from memory_links.subject_entity',
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
