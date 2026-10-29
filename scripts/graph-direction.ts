#!/usr/bin/env node
/**
 * `pnpm graph:direction` — how many open edges the text puts the right way round.
 *
 * This is the acceptance gate for `directionOf` (see `entity-mining.ts`), and it
 * exists because the rule deletes data: `edgeIsRefused` now refuses an edge whose
 * memory states the two endpoints in the opposite order, and the next `graph_sync`
 * removes every refused edge it finds. Before trusting that, the operator needs
 * the two numbers it trades between — how many reversed edges are actually there,
 * and how many edges become `unknown` (admissible, but no longer order-verified).
 * A rule without that reading is trading true edges for a principle.
 *
 *   pnpm graph:direction                  # human-readable counts
 *   pnpm graph:direction --json           # the same numbers, machine-readable
 *   pnpm graph:direction --verbose        # also print the database path read
 *
 * READ-ONLY by design: the database is opened with `readonly: true`, so the
 * command cannot change what it measures — running it on a device is safe. It
 * reports; `pnpm graph:sync` (dry run first) is what removes anything.
 *
 * Database resolution matches the server: `DATABASE_PATH`, else `database.path`
 * in `config.yaml` (honouring `CONFIG_FILE`), else `~/.ohmyagent/data/app.db`.
 */

import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadYamlFile } from '../src/app/config-loader.js';
import { directionOf, type EdgeDirection } from '../src/graph/entity-mining.js';

const DEFAULT_DB_PATH = '~/.ohmyagent/data/app.db';

/** How many reversed edges the human-readable output names before summarising. */
const REVERSED_SAMPLE_LIMIT = 20;

interface CliOptions {
  json: boolean;
  verbose: boolean;
}

interface EdgeRow {
  id: string;
  relation: string;
  subject: string;
  target: string;
  memoryId: string | null;
  content: string | null;
}

interface DirectionReport {
  database: string;
  openTypedEdges: number;
  forward: number;
  reversed: number;
  unknown: number;
  reversedEdges: Array<{
    subject: string;
    relation: string;
    target: string;
    memoryId: string | null;
  }>;
}

/**
 * Every open edge with its endpoints and the memory that stated it.
 *
 * `MENTIONED` is excluded rather than counted as `unknown`: co-occurrence is not
 * a statement and never becomes an edge, so a legacy row of that shape (deleted
 * by `cleanupLegacyGraph`) would only inflate the number this report is read for.
 */
const OPEN_TYPED_EDGES_SQL = `SELECT e.id AS id, e.relation_type AS relation,
            s.name AS subject, t.name AS target,
            e.source_memory_id AS memoryId, m.content AS content
       FROM entity_edges e
       JOIN entities s ON s.id = e.source_entity_id
       JOIN entities t ON t.id = e.target_entity_id
       LEFT JOIN memories m ON m.id = e.source_memory_id
      WHERE e.valid_to IS NULL
        AND upper(trim(e.relation_type)) <> 'MENTIONED'
      ORDER BY e.created_at, e.id`;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { json: false, verbose: false };
  for (const arg of argv) {
    if (arg === '--json') {
      options.json = true;
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

function printHelp(): void {
  console.log(`Usage: pnpm graph:direction [--json] [--verbose]

  --json            Print the report as JSON instead of text
  --verbose, -v     Print the resolved database path

Read-only: it counts open typed edges by the word order their source memory
states (forward / reversed / unknown) and changes nothing.

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

function buildReport(db: Database.Database, database: string): DirectionReport {
  const report: DirectionReport = {
    database,
    openTypedEdges: 0,
    forward: 0,
    reversed: 0,
    unknown: 0,
    reversedEdges: [],
  };
  for (const row of db.prepare(OPEN_TYPED_EDGES_SQL).iterate() as Iterable<EdgeRow>) {
    report.openTypedEdges++;
    const direction: EdgeDirection = directionOf(
      row.content ?? '',
      row.relation,
      row.subject,
      row.target,
    );
    if (direction === 'forward') {
      report.forward++;
    } else if (direction === 'reversed') {
      report.reversed++;
      report.reversedEdges.push({
        subject: row.subject,
        relation: row.relation,
        target: row.target,
        memoryId: row.memoryId,
      });
    } else {
      report.unknown++;
    }
  }
  return report;
}

function printReport(report: DirectionReport): void {
  console.log(`[graph:direction] ${report.database}`);
  console.log(
    `[graph:direction] open typed edges: ${report.openTypedEdges} — ` +
      `forward ${report.forward}, reversed ${report.reversed}, unknown ${report.unknown}`,
  );
  if (report.reversedEdges.length > 0) {
    console.log(
      `[graph:direction] reversed (refused by edgeIsRefused, so the next graph_sync deletes them):`,
    );
    for (const edge of report.reversedEdges.slice(0, REVERSED_SAMPLE_LIMIT)) {
      const attribution = edge.memoryId ? ` [mem:${edge.memoryId.slice(0, 8)}]` : '';
      console.log(`  ${edge.subject} —${edge.relation}→ ${edge.target}${attribution}`);
    }
    if (report.reversedEdges.length > REVERSED_SAMPLE_LIMIT) {
      console.log(`  … and ${report.reversedEdges.length - REVERSED_SAMPLE_LIMIT} more`);
    }
  }
  console.log(
    '[graph:direction] unknown is admissible: the text does not state an order, which is ' +
      'unverifiable rather than disproven. Only reversed is refused.',
  );
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const resolvedDbPath = path.resolve(resolveDbPath());

  if (!fs.existsSync(resolvedDbPath)) {
    console.error(`[graph:direction] database not found: ${resolvedDbPath}`);
    console.error('  Set DATABASE_PATH or configure database.path in config.yaml.');
    process.exit(1);
  }

  // Read-only: this command must not be able to change what it measures.
  const db = new Database(resolvedDbPath, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');

  try {
    if (!hasEntityTables(db)) {
      console.error(
        '[graph:direction] the entities/entity_edges tables are missing — start the agent once so the v10 migration runs.',
      );
      process.exit(1);
    }

    const report = buildReport(db, resolvedDbPath);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (options.verbose) console.log(`[graph:direction] database: ${resolvedDbPath}`);
    printReport(report);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(`[graph:direction] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
