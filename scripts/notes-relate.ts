#!/usr/bin/env node
/**
 * `pnpm notes:relate` — backfill and repair `note_relations`.
 *
 * Relations are written by `NotesRepository.create()`/`update()` (see
 * `src/notes/relations.ts` for the three rules), so in normal use this command has
 * nothing to do. It exists for the two cases the write path cannot cover:
 *
 *   - **Backfill.** Notes created before the writer existed have no rows. Without this
 *     the 「相关」 block is empty on every note that predates it, which looks exactly
 *     like "the feature does not work" rather than "these notes were never scanned".
 *   - **Drift.** A retitle through raw SQL, a restored backup, or a rule change leaves
 *     rows that no longer match. Rebuilding is cheap and idempotent, so the repair is
 *     the same code as the write.
 *
 * Default is **repair-only**: notes with no relation rows are rebuilt, notes that
 * already have rows are left alone. `--all` recomputes everything, which is what a
 * rule change wants — and the plan's throttle: this is manual, like `graph:sync`,
 * because a boot step on Android is a boot the phantom process killer can end.
 *
 * Usage:
 *   pnpm notes:relate              # rebuild notes that have no rows yet
 *   pnpm notes:relate --all        # recompute every note (after a rule change)
 *   pnpm notes:relate --dry-run    # report what would change, write nothing
 *   pnpm notes:relate --verbose
 *
 * Database resolution matches the server: `DATABASE_PATH`, else `database.path` in
 * `config.yaml` (honouring `CONFIG_FILE`), else `~/.ohmyagent/data/app.db`.
 */

import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { loadYamlFile } from '../src/app/config-loader.js';
import { NoteRelations } from '../src/notes/relations.js';
import { migrateV33 } from '../src/memory/migration-v33.js';

const DEFAULT_DB_PATH = '~/.ohmyagent/data/app.db';

const HELP = `notes:relate — rebuild note relations (derived from session, title and tags)

Usage:
  pnpm notes:relate              rebuild only notes that currently have no relations
  pnpm notes:relate --all        recompute every note
  pnpm notes:relate --dry-run    report what would be rebuilt, write nothing
  pnpm notes:relate --verbose    per-note counts

Relations are normally written by the capture and edit paths; this command is for
notes that predate the writer and for repairing drift.
`;

export interface RelateOptions {
  /** Recompute every note instead of only the unlinked ones. */
  all: boolean;
  dryRun: boolean;
  verbose: boolean;
}

export interface RelateSummary {
  /** Notes examined. */
  scanned: number;
  /** Pairs written (both directions are two rows). */
  pairs: number;
  dryRun: boolean;
}

/** Resolve the database path the same way the server does. */
function resolveDbPath(): string {
  const expand = (value: string): string =>
    value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value;

  if (process.env.DATABASE_PATH) return expand(process.env.DATABASE_PATH);

  const yaml = loadYamlFile(process.env.CONFIG_FILE || './config.yaml', process.env);
  const fromYaml = (yaml?.database as { path?: unknown } | undefined)?.path;
  if (typeof fromYaml === 'string' && fromYaml.trim()) return expand(fromYaml.trim());

  return expand(DEFAULT_DB_PATH);
}

export function parseArgs(argv: readonly string[]): RelateOptions {
  const options: RelateOptions = { all: false, dryRun: false, verbose: false };
  for (const raw of argv) {
    const arg = raw.trim();
    if (arg === '--all') options.all = true;
    else if (arg === '--dry-run' || arg === '-n') options.dryRun = true;
    else if (arg === '--verbose' || arg === '-v') options.verbose = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/**
 * Rebuild the selected notes.
 *
 * `dryRun` still walks the notes and scores their pairs — the numbers are the point of
 * a dry run — but the writes are skipped, so nothing in the table changes.
 */
export function relateNotes(
  db: Database.Database,
  options: RelateOptions,
  log: (message: string) => void = () => {},
): RelateSummary {
  const relations = new NoteRelations(db);
  const targets = options.all
    ? (
        db.prepare(`SELECT id FROM notes WHERE status IN ('active', 'draft')`).all() as Array<{
          id: string;
        }>
      ).map((row) => row.id)
    : relations.unlinked();

  if (options.dryRun) {
    // Score without writing: a copy of the table's rows is not needed, so this asks
    // the same class for candidates and reports the count it *would* write.
    let pairs = 0;
    for (const id of targets) {
      const count = relations.preview(id);
      if (options.verbose) log(`${id}: ${count} related`);
      pairs += count;
    }
    return { scanned: targets.length, pairs, dryRun: true };
  }

  let pairs = 0;
  for (const id of targets) {
    const written = relations.rebuild(id);
    if (options.verbose) log(`${id}: ${written} related`);
    pairs += written;
  }
  return { scanned: targets.length, pairs, dryRun: false };
}

/** CLI wrapper. Returns the process exit code; never throws. */
export function runNotesRelate(argv: readonly string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return 0;
  }

  let options: RelateOptions;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(`[notes:relate] ${err instanceof Error ? err.message : String(err)}`);
    console.error(HELP);
    return 1;
  }

  const dbPath = path.resolve(resolveDbPath());
  if (!fs.existsSync(dbPath)) {
    console.error(`[notes:relate] database not found: ${dbPath}`);
    console.error('  Set DATABASE_PATH or configure database.path in config.yaml.');
    return 1;
  }

  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  try {
    // The table's shape is normally brought up to date by the server's boot
    // (`openDatabase()` runs v33). A script run against a database the server has not
    // opened since the upgrade would otherwise fail with `no such column: basis`, which
    // reads as a bug in this command. v33 is idempotent and additive, so applying it
    // here is the same statement the next boot would run — not a second migration path.
    const columns = db.prepare('PRAGMA table_info(note_relations)').all() as Array<{
      name: string;
    }>;
    if (columns.length === 0 || !columns.some((column) => column.name === 'basis')) {
      const result = migrateV33(db);
      console.log(`[notes:relate] applied migration v33 to ${dbPath} (rebuilt: ${result.rebuilt})`);
    }
    if (options.verbose) {
      console.log(`[notes:relate] ${dbPath}`);
      console.log(
        `[notes:relate] ${options.all ? 'all notes' : 'unlinked notes only'}` +
          `${options.dryRun ? ', dry run' : ''}`,
      );
    }
    const summary = relateNotes(db, options, (message) => console.log(`[notes:relate] ${message}`));
    console.log(
      `[notes:relate] scanned ${summary.scanned} | pairs ${summary.pairs}` +
        (summary.dryRun ? ' (dry run, nothing written)' : ''),
    );
    return 0;
  } catch (err) {
    console.error(`[notes:relate] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    db.close();
  }
}

// Only run when invoked as a script; importing this module from a test must not
// touch the filesystem.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = runNotesRelate(process.argv.slice(2));
}
