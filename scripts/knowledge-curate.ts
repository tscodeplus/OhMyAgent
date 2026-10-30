#!/usr/bin/env node
/**
 * `pnpm knowledge:curate` — run the knowledge curator on demand, optionally over
 * an explicit historical window.
 *
 * Why this exists: the DreamCycle phase only ever reads memories created **since
 * the last successful run**, and a first run looks back one night
 * (`FIRST_RUN_LOOKBACK_MS`). On the reference install that made the page layer
 * unable to start at all — the newest memory was six weeks old, so every run
 * looked back 24 hours from the previous run, found `no_candidates`, recorded
 * that as a success, and moved the window another day forward. 453 memories were
 * eligible and unreachable.
 *
 *   pnpm knowledge:curate --dry-run                 # what would the nightly run see?
 *   pnpm knowledge:curate --dry-run --since=2026-05-01
 *   pnpm knowledge:curate --since=2026-05-01        # backfill that window
 *   pnpm knowledge:curate --since=2026-05-01 --rounds=5
 *
 * Two properties are deliberate:
 *
 *   1. **It does not advance the nightly window.** Only `DreamCycle` writes a
 *      `maintenance_runs` row for `dreamcycle_knowledge_curate`, and the window is
 *      "since the last successful row". A backfill from the CLI therefore cannot
 *      make the phase believe a night it never covered was covered.
 *   2. **Re-running a window is safe.** A page's identity is
 *      `(page_type, scope, slug)`, so a second pass updates what the first wrote
 *      instead of duplicating it. `--rounds` is the honest form of "keep going":
 *      `max_pages_per_run` still bounds how many pages one pass writes, and a
 *      window with more candidates than `CANDIDATE_LIMIT` is re-read from the
 *      front each time.
 *
 * The curator, its thresholds and its admission rules are the same objects the
 * nightly phase uses (`buildKnowledgeCurateConfig` + `KnowledgeCurator`); this
 * script is a door, not a second implementation.
 *
 * Config: `CONFIG_FILE` (default `./config.yaml`), `DATABASE_PATH`, else
 * `database.path` from the YAML, else `~/.ohmyagent/data/app.db` — the same
 * resolution every other `pnpm` command uses.
 */

import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { pino } from 'pino';
import { loadConfig } from '../src/app/config.js';
import { loadYamlFile } from '../src/app/config-loader.js';
import { buildAuxModelConfig } from '../src/app/composers/memory-services.js';
import { hasTable } from '../src/graph-export/sqlite-schema.js';
import {
  KnowledgeCurator,
  buildKnowledgeCurateConfig,
  countCurateCandidates,
  curateWindowStart,
  type CurateRunReport,
} from '../src/memory/knowledge/curate.js';
import { createKnowledgeService } from '../src/memory/knowledge/service.js';
import { parseEpochMs } from '../src/shared/timestamp.js';

const DEFAULT_DB_PATH = '~/.ohmyagent/data/app.db';
const LOG_PREFIX = '[knowledge:curate]';
/** Pages one pass may write when the config does not say otherwise. */
const DEFAULT_MAX_PAGES = 3;

interface Options {
  since?: number;
  dryRun: boolean;
  rounds: number;
  maxPages?: number;
  scope?: string;
  json: boolean;
  verbose: boolean;
  help: boolean;
}

function resolveHome(value: string): string {
  return value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value;
}

function resolveDbPath(): string {
  if (process.env.DATABASE_PATH) return resolveHome(process.env.DATABASE_PATH);
  const yaml = loadYamlFile(process.env.CONFIG_FILE || './config.yaml', process.env);
  const fromYaml = (yaml?.database as { path?: unknown } | undefined)?.path;
  if (typeof fromYaml === 'string' && fromYaml.trim()) return resolveHome(fromYaml.trim());
  return resolveHome(DEFAULT_DB_PATH);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    dryRun: false,
    rounds: 1,
    json: false,
    verbose: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--verbose') {
      options.verbose = true;
      continue;
    }
    const [name, ...rest] = arg.split('=');
    const value = rest.join('=');
    if (name === '--since') {
      // ISO-8601 or epoch ms, the two shapes a caller actually has. `parseEpochMs`
      // is the project's single answer to `new Date("1788237296000")`.
      const parsed = parseEpochMs(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--since: not a date or epoch ms: ${value}`);
      }
      options.since = parsed;
      continue;
    }
    if (name === '--rounds') {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`--rounds: ${value}`);
      options.rounds = parsed;
      continue;
    }
    if (name === '--max-pages') {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`--max-pages: ${value}`);
      options.maxPages = parsed;
      continue;
    }
    if (name === '--scope') {
      options.scope = value;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return options;
}

function usage(): void {
  console.log(`${LOG_PREFIX} run the knowledge curator on demand

Usage: pnpm knowledge:curate [options]

  --since=<ISO-8601|epoch ms>  Window start (default: what the nightly run would use)
  --dry-run                    Count candidates only — no model call, no write
  --rounds=<n>                 Repeat the same window n times (default 1)
  --max-pages=<n>              Pages per round (default: knowledge.curate.max_pages_per_run)
  --scope=<scope>              Write into one conversation instead of 'global'
  --json                       Print the raw report as JSON
  --verbose                    Debug logging
  -h, --help                   This text`);
}

/** One human line per report, so a backfill's progress is readable in a log. */
function summarize(report: CurateRunReport): string {
  const rejected = Object.entries(report.rejected)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(' ');
  return [
    `window from ${new Date(report.since).toISOString()}`,
    `candidates=${report.candidates}`,
    `groups=${report.groups}`,
    `created=${report.created}`,
    `updated=${report.updated}`,
    `failed=${report.failed}`,
    rejected ? `rejected[${rejected}]` : '',
    report.skipped ? `skipped=${report.skipped}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }

  const dbPath = resolveDbPath();
  const logger = pino({
    level: options.verbose ? 'debug' : 'warn',
    base: undefined,
  });

  // The config is read the way the server reads it, so `--since` cannot drag a
  // backfill outside the layer's own switches (`knowledge.enabled`, `mode`).
  const config = loadConfig(process.env, process.env.CONFIG_FILE);
  const db = new Database(dbPath);

  try {
    if (!hasTable(db, 'knowledge_pages')) {
      console.error(
        `${LOG_PREFIX} ${dbPath} has no knowledge_pages table — start the server once so ` +
          'openDatabase() runs the migrations (v14 creates the page layer), then retry.',
      );
      return 1;
    }

    const windowStart = options.since ?? curateWindowStart(db);
    const minConfidence = config.knowledge.curate.minMemoryConfidence;

    if (options.dryRun) {
      const total = countCurateCandidates(db, { since: windowStart, minConfidence });
      const payload = {
        database: dbPath,
        windowStart,
        windowStartIso: new Date(windowStart).toISOString(),
        nowIso: new Date().toISOString(),
        candidates: total,
        minMemoryConfidence: minConfidence,
        enabled: config.knowledge.enabled,
        mode: config.knowledge.curate.mode,
        maxPagesPerRun: config.knowledge.curate.maxPagesPerRun,
      };
      console.log(
        options.json
          ? JSON.stringify(payload, null, 2)
          : `${LOG_PREFIX} ${JSON.stringify(payload)}`,
      );
      return 0;
    }

    const auxConfig = buildAuxModelConfig(config);
    const knowledgeService = createKnowledgeService({
      db,
      config: {
        enabled: config.knowledge.enabled,
        requireSources: config.knowledge.curate.requireSources,
        minMemoryConfidence: minConfidence,
        shadow: config.knowledge.curate.shadow,
        logRetentionDays: config.knowledge.logRetentionDays,
      },
      logger,
    });

    const curator = new KnowledgeCurator({
      db,
      knowledgeService,
      logger,
      config: buildKnowledgeCurateConfig(
        {
          enabled: config.knowledge.enabled,
          mode: config.knowledge.curate.mode,
          shadow: config.knowledge.curate.shadow,
          maxPagesPerRun:
            options.maxPages ?? config.knowledge.curate.maxPagesPerRun ?? DEFAULT_MAX_PAGES,
          requireSources: config.knowledge.curate.requireSources,
          minMemoryConfidence: minConfidence,
          modelRef: config.knowledge.curate.modelRef,
        },
        () => auxConfig,
      ),
    });

    const reports: CurateRunReport[] = [];
    for (let round = 1; round <= options.rounds; round++) {
      const report = await curator.run({
        trigger: 'manual',
        // The window is pinned for every round: `run()` would otherwise fall back
        // to `windowStart()`, which this process never advances.
        since: windowStart,
        ...(options.scope ? { scope: options.scope } : {}),
      });
      reports.push(report);
      if (!options.json) {
        console.log(`${LOG_PREFIX} round ${round}/${options.rounds}: ${summarize(report)}`);
      }
      // Nothing left to read, or nothing the model could group: another round
      // would spend the same calls on the same window.
      if (report.skipped === 'no_candidates' || report.skipped === 'no_groups') break;
      if (report.aborted) break;
    }

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            database: dbPath,
            dryRun: false,
            shadow: config.knowledge.curate.shadow,
            rounds: reports.length,
            reports,
          },
          null,
          2,
        ),
      );
    }

    // A shadow-mode backfill produces reviewable drafts, not facts: saying so
    // prevents "I ran it and the graph still shows nothing" (pending pages are
    // not injected, searched or linked until approved).
    if (config.knowledge.curate.shadow) {
      console.log(
        `${LOG_PREFIX} shadow mode is on (knowledge.curate.shadow) — pages were written as ` +
          "'pending' and need approval before they are searchable or injectable.",
      );
    }

    return 0;
  } finally {
    db.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`${LOG_PREFIX} ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
