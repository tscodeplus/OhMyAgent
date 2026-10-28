#!/bin/bash
# ============================================================================
# deploy-termux.sh — Dev tool: deploy from desktop/WSL to Termux over SSH
#
# Packages git-tracked files on dev machine and transfers them to Termux via SCP.
# For end-user installation directly on Termux, use install.sh instead.
#
# An upgrade carries the live database across, so `deploy` is not just "replace
# the code and restart". It does this, in this order:
#
#   1. snapshots the database — VACUUM INTO data/backups/pre-upgrade-*.db —
#      while the old service is still running, and re-opens the copy to verify
#      it (quick_check + row counts) before anything is replaced;
#   2. swaps the source and rebuilds (tsc + ui);
#   3. restarts and lets the new process migrate the database itself: every
#      schema migration, and the v17 repair of the pre-v15 graph data, run
#      inside openDatabase() before the server listens. The deploy has no
#      migration step of its own — there is no `graph:reset`/`graph:mine` to run;
#   4. verifies the RUNNING process: /api/health, that the process started after
#      this build, that openDatabase() finished every migration, that the
#      messages FTS backfill indexed every message, and that no row count fell
#      below the snapshot. A failed check prints the backup path and the log
#      command.
#
# Usage:
#   bash scripts/deploy-termux.sh                       # Upgrade (backup + verify)
#   bash scripts/deploy-termux.sh verify                # Read-only preflight: what would it do?
#   bash scripts/deploy-termux.sh check                 # Read-only: verify the live upgrade
#   bash scripts/deploy-termux.sh check --local         # same, run ON the device
#   DELETE_DATABASE=true bash scripts/deploy-termux.sh  # Deploy with a fresh DB
#   bash scripts/deploy-termux.sh start|stop|restart|status|logs
#
# Config:
#   Reads ~/.ssh/termux_askpass for SSH password by default.
#   Override with env vars: TERMUX_HOST / TERMUX_PORT / TERMUX_USER
# ============================================================================

set -euo pipefail

# ─── Configuration ───
TERMUX_HOST="${TERMUX_HOST:-192.168.1.201}"
TERMUX_PORT="${TERMUX_PORT:-8022}"
TERMUX_USER="${TERMUX_USER:-u0_a4}"
TERMUX_PROJECT_DIR="${TERMUX_PROJECT_DIR:-~/.ohmyagent}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_TARBALL="/tmp/ohmyagent-deploy.tar.gz"
SESSION_NAME="ohmyagent"

# Filled in by prepare_deploy(), used by the backup/verification steps.
DEPLOY_COMMIT=""
DEPLOY_LABEL=""
BACKUP_REL=""
# Set by `--local`: run the read-only commands here instead of over SSH.
LOCAL_MODE=false

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ─── SSH setup ───
setup_ssh() {
  export SSH_ASKPASS="${HOME}/.ssh/termux_askpass"
  export SSH_ASKPASS_REQUIRE="force"
  export DISPLAY=:0

  if [ ! -f "$SSH_ASKPASS" ]; then
    warn "SSH_ASKPASS script not found: $SSH_ASKPASS"
    warn "Creating temporary askpass..."
    mkdir -p "$(dirname "$SSH_ASKPASS")"
    if [ -n "${TERMUX_PASSWORD:-}" ]; then
      echo "#!/bin/sh"; echo "echo '${TERMUX_PASSWORD}'" > "$SSH_ASKPASS"
      chmod 700 "$SSH_ASKPASS"
    else
      error "Set TERMUX_PASSWORD env var or create $SSH_ASKPASS"
    fi
  fi
}

ssh_cmd() {
  ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p "$TERMUX_PORT" "${TERMUX_USER}@${TERMUX_HOST}" "$@"
}

# Run a bash script on the device (or here, with --local). The script arrives on
# stdin, so nothing has to be quoted through the ssh command line.
on_device() {
  if [ "$LOCAL_MODE" = true ]; then
    ( cd "$PROJECT_DIR" && bash -s )
  else
    ssh_cmd "cd $TERMUX_PROJECT_DIR && bash -s"
  fi
}

# ─── Deploy metadata (dev box) ───
# The label names the backup file and the deploy stamp: `git describe` when the
# repository has tags, the short sha otherwise, `-dirty` when the tarball also
# carries uncommitted changes (it does — package_source ships them).
prepare_deploy() {
  cd "$PROJECT_DIR"
  DEPLOY_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "")
  if [ -z "$DEPLOY_COMMIT" ]; then
    error "Not a git repository: $PROJECT_DIR (needed to label the backup and verify the deployed commit)"
  fi
  local label
  label=$(git describe --tags --always 2>/dev/null || git rev-parse --short HEAD)
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    label="${label}-dirty"
  fi
  # `/` appears in branch-derived describes; keep the name filesystem-safe.
  DEPLOY_LABEL=$(printf '%s' "$label" | tr '/ ' '--')
  local stamp
  stamp=$(date +%Y%m%d-%H%M%S)
  BACKUP_REL="data/backups/pre-upgrade-${DEPLOY_LABEL}-${stamp}.db"
  info "Deploying $DEPLOY_LABEL ($(printf '%.12s' "$DEPLOY_COMMIT"))"
}

# ─── Device database helper ───
# One node program, sent to the device on stdin (never written to disk there)
# and run by the already-installed node against the already-installed
# better-sqlite3 — no new packages, no sqlite3 CLI. It resolves the database
# path the way the server does (DATABASE_PATH, else .env, else
# config.yaml `database.path`, else data/app.db) so the checks cannot verify a
# file the server is not using.
#
# Modes (OMA_MODE): plan | check | backup | stamp.
# Output is line-oriented: OK / FAIL / WARN / INFO, plus `RECENTBACKUP <path>`.
# The program always exits 0 — a check that cannot run is a FAIL line, not a
# stack trace the shell has to interpret.
read -r -d '' DB_PROGRAM <<'NODE_PROGRAM' || true
'use strict';
// ── Termux upgrade helper (sent by scripts/deploy-termux.sh) ────────────────
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MODE = process.env.OMA_MODE || 'plan';
const BACKUP_REL = process.env.OMA_BACKUP_PATH || '';
const EXPECT_HEAD = process.env.OMA_EXPECT_HEAD || '';
const STAMP_COMMIT = process.env.OMA_COMMIT || '';
const STAMP_LABEL = process.env.OMA_LABEL || '';
// `/proc` is the only process inspector that is always there on Termux (no
// procps, no ps). Overridable so the parse can be exercised off-device.
const PROC_ROOT = process.env.OMA_PROC_ROOT || '/proc';

const PROJECT = process.cwd();
const STAMP_PATH = path.join(PROJECT, 'data', 'deploy-stamp.json');
const BUILD_ENTRY = path.join(PROJECT, 'dist', 'src', 'index.js');
const SOURCE_ENTRY = path.join(PROJECT, 'src', 'index.ts');
const BACKUP_DIR = path.join(PROJECT, 'data', 'backups');
const isCheck = MODE === 'check';

// Objects that only migrations v4–v16 can add. `CREATE TABLE IF NOT EXISTS`
// cannot add a column to an existing table, so a process that died inside
// openDatabase() leaves exactly one of these missing — that is the symptom the
// HTTP-only health check used to hide.
const REQUIRED_TABLES = [
  'entities', // v10 graph
  'entity_aliases',
  'entity_edges',
  'memory_sources', // v13 provenance
  'knowledge_pages', // v14 knowledge layer
  'knowledge_sources',
  'knowledge_links',
  'knowledge_log',
  'knowledge_fts_jieba',
  'mcp_oauth_credentials', // v8
  'messages_fts_jieba', // v10
];
const REQUIRED_COLUMNS = {
  sessions: ['project_id', 'channel', 'external_chat_id', 'title', 'archived_at', 'archive_exempt_until'], // v4/v9/v11/v12
  memories: ['embedding_status'], // v13
  memory_links: ['subject_entity', 'subject_entity_type', 'target_entity_type'], // v15
  persona_distillation_runs: ['input_memory_ids', 'output_diff'], // v16
};
const COUNTED_TABLES = ['memories', 'sessions', 'messages', 'knowledge_pages'];

const lines = [];
let failures = 0;
const out = (line) => lines.push(line);
const ok = (label, detail) => out('OK   ' + label + (detail ? ' — ' + detail : ''));
const warn = (label, detail) => out('WARN ' + label + (detail ? ' — ' + detail : ''));
const info = (label, detail) => out('INFO ' + label + (detail ? ' — ' + detail : ''));
const fail = (label, detail) => {
  failures++;
  out('FAIL ' + label + (detail ? ' — ' + detail : ''));
};
// `check` judges the live process; `plan` runs before anything is deployed and
// only reports what it finds. Same facts, different verdict.
const judge = (cond, label, okDetail, badDetail) => {
  if (cond) return ok(label, okDetail);
  return isCheck ? fail(label, badDetail) : info(label, badDetail);
};

const mb = (bytes) => (bytes / 1048576).toFixed(1) + ' MB';
const ago = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
const secs = (s) => (s === null ? 'age unknown' : s + 's');

function statSafe(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: PROJECT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PROJECT, 'package.json'), 'utf8')).version || '';
  } catch {
    return '';
  }
}

// The server binds `OHMYAGENT_PORT`, else `PORT`, else 9191 (`src/app/bootstrap.ts`),
// reading both from the environment dotenv filled out of .env — so the health
// probe has to look in the same two places, or a moved port reads as "nothing is
// listening".
function resolvePort() {
  if (process.env.OMA_PORT) return process.env.OMA_PORT;
  if (process.env.OHMYAGENT_PORT) return process.env.OHMYAGENT_PORT;
  if (process.env.PORT) return process.env.PORT;
  try {
    const envText = fs.readFileSync(path.join(PROJECT, '.env'), 'utf8');
    const match = /^[ \t]*(?:OHMYAGENT_PORT|PORT)[ \t]*=[ \t]*(\d+)/m.exec(envText);
    if (match) return match[1];
  } catch {
    /* no .env */
  }
  return '9191';
}

// Same order the server resolves it: DATABASE_PATH, else .env (dotenv), else
// `database.path` in config.yaml, else the documented default. Returned with
// its source so a wrong resolution is visible instead of silent.
function resolveDbPath() {
  if (process.env.DATABASE_PATH) {
    return { file: process.env.DATABASE_PATH, source: 'DATABASE_PATH' };
  }
  try {
    const envText = fs.readFileSync(path.join(PROJECT, '.env'), 'utf8');
    const match = /^[ \t]*DATABASE_PATH[ \t]*=[ \t]*(.*)$/m.exec(envText);
    if (match) {
      return { file: match[1].trim().replace(/^["']|["']$/g, ''), source: '.env' };
    }
  } catch {
    /* no .env */
  }
  try {
    const yaml = fs.readFileSync(path.join(PROJECT, 'config.yaml'), 'utf8');
    const block = /^database:[ \t]*\r?\n((?:[ \t]+\S.*\r?\n?)*)/m.exec(yaml);
    if (block) {
      const key = /^[ \t]+path:[ \t]*(.*)$/m.exec(block[1]);
      if (key) {
        const raw = key[1].replace(/[ \t]+#.*$/, '').trim().replace(/^["']|["']$/g, '');
        return { file: raw, source: 'config.yaml database.path' };
      }
    }
  } catch {
    /* no config.yaml */
  }
  return { file: 'data/app.db', source: 'default' };
}

function absoluteDbPath(file) {
  return path.resolve(PROJECT, file.replace(/^~(?=$|[/\\])/, os.homedir()));
}

function openDb(file, readonly) {
  const Database = require('better-sqlite3');
  return readonly
    ? new Database(file, { readonly: true, fileMustExist: true })
    : new Database(file, { fileMustExist: true });
}

function tableExists(db, table) {
  try {
    return Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(table));
  } catch {
    return false;
  }
}

function columnNames(db, table) {
  try {
    return db.pragma('table_info("' + table + '")').map((c) => c.name);
  } catch {
    return [];
  }
}

function countRows(db, table, where) {
  try {
    const sql = 'SELECT COUNT(*) AS n FROM "' + table + '"' + (where ? ' WHERE ' + where : '');
    return db.prepare(sql).get().n;
  } catch {
    return null;
  }
}

// A process's start time is field 22 of /proc/<pid>/stat: clock ticks since
// boot, on a clock that cannot be stepped. `/proc/uptime` would turn that into
// an absolute age, but Android denies it to an unprivileged app (EACCES on the
// reference device), so the reference point is this checker process's own start
// ticks — "now" to within one tick. Every age below therefore reads "started N
// seconds before this check", which is what the deploy-stamp comparison needs.
const TICKS_PER_SEC = 100; // USER_HZ; fixed at 100 on Android arm64

function startTicks(statFile) {
  try {
    const stat = fs.readFileSync(statFile, 'utf8');
    const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    return Number.isFinite(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

function processAgeSec(pid) {
  const now = startTicks(PROC_ROOT + '/self/stat');
  const started = startTicks(PROC_ROOT + '/' + pid + '/stat');
  if (now === null || started === null) return null;
  return Math.max(0, Math.round((now - started) / TICKS_PER_SEC));
}

// `available: false` means /proc itself could not be read — that is a limit of
// the checker, not evidence about the deploy, so it is reported as a WARN.
function runningProcesses() {
  const marker = path.join('dist', 'src', 'index.js');
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(PROC_ROOT);
  } catch {
    return { available: false, procs: found };
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let cmdline;
    try {
      cmdline = fs.readFileSync(PROC_ROOT + '/' + entry + '/cmdline', 'utf8');
    } catch {
      continue;
    }
    if (cmdline.includes(marker)) found.push({ pid: Number(entry), ageSec: processAgeSec(entry) });
  }
  return { available: true, procs: found };
}

function readStamp() {
  try {
    const stamp = JSON.parse(fs.readFileSync(STAMP_PATH, 'utf8'));
    if (typeof stamp.deployedAtMs !== 'number') return null;
    return stamp;
  } catch {
    return null;
  }
}

function recentBackup() {
  let names;
  try {
    names = fs.readdirSync(BACKUP_DIR).filter((n) => n.startsWith('pre-upgrade-') && n.endsWith('.db'));
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  const files = names
    .map((name) => ({ name, stat: statSafe(path.join(BACKUP_DIR, name)) }))
    .filter((f) => f.stat)
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  if (files.length === 0) return null;
  return { rel: path.join('data', 'backups', files[0].name), stat: files[0].stat, count: files.length };
}

// The snapshot taken before the source swap is a complete database, so it is
// also the "before" column an upgrade is judged against. `OMA_BACKUP_PATH`
// names the one this deploy took; a standalone `check` falls back to the newest
// pre-upgrade file, which is then labelled with its own name and age.
function snapshotFile() {
  if (BACKUP_REL) {
    const stat = statSafe(path.resolve(PROJECT, BACKUP_REL));
    if (stat) return { rel: BACKUP_REL, stat, count: 1 };
  }
  return recentBackup();
}

const SNAPSHOT_TABLES = ['memories', 'messages', 'sessions', 'memory_links'];

// Row counts before/after, plus the one verdict that matters: no table lost
// rows. A migration that drops memories is invisible to /api/health and to
// every schema check above — it only shows up as a count that went down.
function compareWithSnapshot(live, backup) {
  if (!backup) {
    info(
      'before/after',
      'no data/backups/pre-upgrade-*.db snapshot to compare against — row counts cannot be judged',
    );
    return;
  }
  let beforeDb;
  try {
    beforeDb = openDb(path.resolve(PROJECT, backup.rel), true);
  } catch (err) {
    warn('before/after', 'could not open ' + backup.rel + ': ' + err.message);
    return;
  }
  const before = {};
  for (const table of SNAPSHOT_TABLES) before[table] = countRows(beforeDb, table);
  beforeDb.close();

  info('pre-upgrade snapshot', backup.rel + ' (' + mb(backup.stat.size) + ', ' + ago(backup.stat.mtimeMs) + ')');
  const cell = (value, width) => String(value === null ? '-' : value).padStart(width);
  out('TBL  ' + 'table'.padEnd(14) + cell('before', 9) + cell('after', 9) + cell('change', 9));
  for (const table of SNAPSHOT_TABLES) {
    const a = before[table];
    const b = live[table];
    const change = a === null || b === null ? null : (b > a ? '+' : '') + (b - a);
    out('TBL  ' + table.padEnd(14) + cell(a, 9) + cell(b, 9) + cell(change, 9));
  }

  const lost = SNAPSHOT_TABLES.filter((t) => before[t] !== null && live[t] !== null && live[t] < before[t]);
  if (lost.length === 0) {
    ok('data preserved', 'no row count fell below the pre-upgrade snapshot');
  } else {
    fail(
      'data preserved',
      lost.map((t) => t + ' ' + before[t] + ' -> ' + live[t]).join(', ') +
        ' — rows that existed before the upgrade are gone; restore ' +
        backup.rel,
    );
  }
}

async function health() {
  const port = resolvePort();
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/api/health', {
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.json().catch(() => null);
    return { port, status: res.status, body };
  } catch (err) {
    return { port, error: err.message };
  }
}

// ── backup mode ────────────────────────────────────────────────────────────
function runBackup() {
  const { file, source } = resolveDbPath();
  const sourceFile = absoluteDbPath(file);
  const targetRel = BACKUP_REL || path.join('data', 'backups', 'pre-upgrade.db');
  const target = path.resolve(PROJECT, targetRel);

  const sourceStat = statSafe(sourceFile);
  if (!sourceStat) {
    fail('backup', 'no database at ' + sourceFile + ' (resolved from ' + source + ') — nothing to snapshot');
    return;
  }
  if (fs.existsSync(target)) {
    fail('backup', 'refusing to overwrite ' + target);
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });

  // VACUUM INTO works from a read-only connection and takes a consistent
  // snapshot including the WAL, which `cp` would corrupt.
  let db;
  try {
    db = openDb(sourceFile, true);
    db.exec("VACUUM INTO '" + target.replace(/'/g, "''") + "'");
    db.close();
  } catch (err) {
    try {
      if (db) db.close();
    } catch {
      /* already closed */
    }
    // A half-written snapshot is worse than none: it looks restorable.
    try {
      fs.unlinkSync(target);
    } catch {
      /* nothing to remove */
    }
    fail('backup', 'VACUUM INTO failed: ' + err.message);
    return;
  }

  const copyStat = statSafe(target);
  ok('backup', target + ' (' + (copyStat ? mb(copyStat.size) : 'size unknown') + ')');

  // Verify the copy instead of trusting the command: a bad snapshot is found
  // here, with the service still running, not on the day it is restored.
  try {
    const copyDb = openDb(target, true);
    const integrity = copyDb.pragma('quick_check', { simple: true });
    const copyCounts = COUNTED_TABLES.map((table) => countRows(copyDb, table));
    copyDb.close();
    const sourceDb = openDb(sourceFile, true);
    const sourceCounts = COUNTED_TABLES.map((table) => countRows(sourceDb, table));
    sourceDb.close();
    if (integrity !== 'ok') {
      fail('backup integrity', 'quick_check on the snapshot: ' + integrity);
      return;
    }
    const mismatched = COUNTED_TABLES.map((table, i) => ({ table, copy: copyCounts[i], source: sourceCounts[i] })).filter(
      (row) => row.copy !== row.source,
    );
    if (mismatched.length > 0) {
      fail(
        'backup contents',
        'row counts differ from the source: ' + mismatched.map((row) => row.table + ' ' + row.copy + '/' + row.source).join(', '),
      );
      return;
    }
    ok(
      'backup contents',
      'quick_check ok; ' +
        COUNTED_TABLES.map((table, i) => (copyCounts[i] === null ? null : table + ' ' + copyCounts[i]))
          .filter(Boolean)
          .join(', '),
    );
  } catch (err) {
    fail('backup integrity', 'could not re-open the snapshot: ' + err.message);
  }
}

// ── stamp mode ─────────────────────────────────────────────────────────────
function runStamp() {
  const payload = {
    label: STAMP_LABEL,
    commit: STAMP_COMMIT,
    deployedAt: new Date().toISOString(),
    deployedAtMs: Date.now(),
    packageVersion: packageVersion(),
  };
  fs.mkdirSync(path.dirname(STAMP_PATH), { recursive: true });
  fs.writeFileSync(STAMP_PATH, JSON.stringify(payload, null, 2) + '\n');
  ok('deploy stamp', STAMP_PATH + ' → ' + (STAMP_LABEL || '(no label)'));
}

// ── plan / check modes ─────────────────────────────────────────────────────
async function runReport() {
  const { file, source } = resolveDbPath();
  const dbPath = absoluteDbPath(file);
  const head = git(['rev-parse', 'HEAD']);
  const subject = git(['log', '-1', '--format=%s']);
  const version = packageVersion();
  const stamp = readStamp();
  const backup = recentBackup();

  info('project', PROJECT);
  if (head) {
    info('git HEAD', head.slice(0, 12) + (subject ? ' ' + subject : ''));
  } else {
    warn('git HEAD', 'no git repository — cannot identify the deployed commit');
  }
  info(
    'deploy stamp',
    stamp ? stamp.label + ' at ' + stamp.deployedAt + ' (' + stamp.commit.slice(0, 12) + ')' : 'absent — this install was not deployed by scripts/deploy-termux.sh',
  );

  // Build freshness. With a deploy stamp, "the build belongs to this deploy" is a
  // same-clock comparison (dist is written between the source swap and the stamp).
  // The dist-vs-src mtime comparison is reported too, but as a WARN: those two
  // timestamps come from different clocks (tar preserves the dev box's mtimes),
  // so a phone whose clock runs behind the dev box would otherwise fail an
  // upgrade that is perfectly fine.
  const built = statSafe(BUILD_ENTRY);
  const sourceStat = statSafe(SOURCE_ENTRY);
  const BUILD_WINDOW_MS = 30 * 60 * 1000;
  if (!built) {
    judge(false, 'build', '', 'dist/src/index.js is missing — run pnpm build');
  } else if (stamp) {
    judge(
      built.mtimeMs >= stamp.deployedAtMs - BUILD_WINDOW_MS,
      'build',
      'dist/src/index.js built ' + ago(built.mtimeMs) + ', ' + Math.round((stamp.deployedAtMs - built.mtimeMs) / 1000) + 's before the deploy stamp',
      'dist/src/index.js (' + ago(built.mtimeMs) + ') predates this deploy (' + ago(stamp.deployedAtMs) + ') — pnpm build did not run',
    );
  } else {
    judge(
      !sourceStat || built.mtimeMs + 1000 >= sourceStat.mtimeMs,
      'build',
      'dist/src/index.js ' + ago(built.mtimeMs),
      'dist/src/index.js (' + ago(built.mtimeMs) + ') is older than src/index.ts (' + ago(sourceStat.mtimeMs) + ') — the build does not match the source',
    );
  }
  if (built && sourceStat && built.mtimeMs + 60000 < sourceStat.mtimeMs) {
    warn(
      'build vs source',
      'dist/src/index.js (' + ago(built.mtimeMs) + ') is older than src/index.ts (' + ago(sourceStat.mtimeMs) + ') — a stale build, or the dev box and phone clocks disagree',
    );
  }

  // Running process, its age, and whether it postdates this deploy.
  const scan = runningProcesses();
  const procs = scan.procs;
  if (!scan.available) {
    warn('process', 'cannot read ' + PROC_ROOT + ' — process checks skipped, use `sv status ohmyagent`');
  } else {
    judge(
      procs.length > 0,
      'process',
      procs.map((p) => 'pid ' + p.pid + ', up ' + secs(p.ageSec)).join('; '),
      'no node process running dist/src/index.js — the service is not up',
    );
  }
  if (procs.length > 0 && stamp) {
    const stampAgeSec = Math.max(0, Math.round((Date.now() - stamp.deployedAtMs) / 1000));
    const procAge = procs[0].ageSec;
    // The process must have started AFTER the stamp was written, i.e. it must be
    // younger than the stamp. An older process is the pre-upgrade one that never
    // restarted, which HTTP alone cannot tell apart from a healthy boot.
    if (procAge === null) {
      warn('running code', 'cannot read the process start time from ' + PROC_ROOT + ' — the restart cannot be confirmed');
    } else {
      judge(
        procAge <= stampAgeSec + 5,
        'running code',
        'process up ' + secs(procAge) + ', deploy stamp ' + secs(stampAgeSec) + ' old (restarted after the build)',
        'process has been up ' + secs(procAge) + ' but the deploy stamp is only ' + secs(stampAgeSec) + ' old — this is the OLD process, the restart did not take',
      );
    }
  }
  if (EXPECT_HEAD) {
    judge(
      head === EXPECT_HEAD,
      'deployed commit',
      head.slice(0, 12) + ' matches the dev box HEAD',
      'device HEAD ' + (head || '?').slice(0, 12) + ' != dev box HEAD ' + EXPECT_HEAD.slice(0, 12) + ' — the source swap did not land',
    );
  }

  // HTTP is necessary but not sufficient: it only says something is listening.
  const probe = await health();
  if (probe.error) {
    judge(
      false,
      'health',
      '',
      'http://127.0.0.1:' + probe.port + '/api/health: ' + probe.error + ' — nothing is listening',
    );
  } else if (!probe.body || probe.body.ok !== true) {
    judge(false, 'health', '', 'status ' + probe.status + ' body ' + JSON.stringify(probe.body));
  } else {
    ok('health', 'status ' + probe.status + ', version ' + (probe.body.version || 'unknown'));
    if (probe.body.version && version) {
      judge(
        probe.body.version === version,
        'version',
        '/api/health reports ' + probe.body.version + ' == package.json',
        'the running process reports ' + probe.body.version + ' but package.json says ' + version + ' — the process started before this build',
      );
    }
  }

  info('database path', dbPath + ' (resolved from ' + source + ')');
  const dbStat = statSafe(dbPath);
  if (!dbStat) {
    judge(false, 'database file', '', dbPath + ' does not exist');
    return;
  }
  ok('database file', mb(dbStat.size) + ', modified ' + ago(dbStat.mtimeMs));
  const wal = statSafe(dbPath + '-wal');
  if (wal) info('write-ahead log', mb(wal.size) + ' (included in a VACUUM INTO snapshot)');

  if (backup) {
    info('backups', backup.rel + ' (newest of ' + backup.count + ' pre-upgrade snapshot(s))');
    out('RECENTBACKUP ' + backup.rel);
  } else {
    info('backups', 'none in data/backups/ yet');
    out('RECENTBACKUP');
  }
  const free = dfFreeKb();
  if (free !== null) info('free space', mb(free * 1024) + ' at the project directory');

  let db;
  try {
    db = openDb(dbPath, true);
  } catch (err) {
    judge(false, 'database open', '', 'could not open ' + dbPath + ': ' + err.message);
    return;
  }
  try {
    const integrity = db.pragma('quick_check', { simple: true });
    judge(integrity === 'ok', 'database integrity', 'quick_check ok', 'quick_check: ' + integrity);

    const missingTables = REQUIRED_TABLES.filter((table) => !tableExists(db, table));
    const missingColumns = [];
    let columnTotal = 0;
    for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
      const present = new Set(columnNames(db, table));
      columnTotal += columns.length;
      for (const column of columns) {
        if (!present.has(column)) missingColumns.push(table + '.' + column);
      }
    }
    judge(
      missingTables.length === 0 && missingColumns.length === 0,
      'migrations',
      REQUIRED_TABLES.length + ' tables + ' + columnTotal + ' migrated columns present (v4–v16)',
      'missing ' +
        [...missingTables, ...missingColumns].join(', ') +
        (isCheck
          ? ' — openDatabase() did not finish; the error is in the log'
          : ' — this install predates them; the new build creates them on its first boot'),
    );

    // v10 indexes every `messages` row: 1813 of them on the reference device,
    // the slowest step of the whole upgrade and the one that can give up
    // quietly — a backfill that stopped halfway still serves queries and still
    // passes every check above.
    if (tableExists(db, 'messages_fts_jieba')) {
      const indexed = countRows(db, 'messages_fts_jieba');
      const total = countRows(db, 'messages');
      if (indexed !== null && total !== null) {
        judge(
          indexed === total,
          'messages_fts_jieba',
          indexed + ' rows for ' + total + ' messages',
          'messages_fts_jieba holds ' + indexed + ' rows for ' + total + ' messages — the v10 backfill did not finish',
        );
      }
    }

    // What the pre-v15 projection invented: per-memory placeholder nodes and
    // co-occurrence edges. Migration v17 deletes them at boot (`cleanupLegacyGraph`),
    // so a leftover row here means that migration did not get to run.
    const placeholders = countRows(db, 'entities', "entity_type = 'memory'");
    if (placeholders !== null) {
      judge(
        placeholders === 0,
        'graph placeholders',
        "no entity_type='memory' nodes",
        placeholders + " row(s) with entity_type='memory' remain — migration v17 should have deleted them; check the log, or run pnpm graph:reset",
      );
    }
    const mentions = countRows(db, 'entity_edges', "relation_type = 'MENTIONED'");
    if (mentions !== null) {
      judge(
        mentions === 0,
        'graph MENTIONED edges',
        'no co-occurrence edges',
        mentions + " row(s) with relation_type='MENTIONED' remain — migration v17 should have deleted them; check the log, or run pnpm graph:reset",
      );
    }

    const links = countRows(db, 'memory_links');
    const linksWithSubject = countRows(db, 'memory_links', 'subject_entity IS NOT NULL');
    // `null` here means the column does not exist yet: the migrations check
    // above owns that verdict, and a "null/123" line would only be noise.
    if (links !== null && linksWithSubject !== null) {
      if (links === 0) {
        ok('graph subjects', 'no memory_links rows yet — nothing to mine');
      } else if (linksWithSubject > 0) {
        ok('graph subjects', linksWithSubject + '/' + links + ' links name a subject');
      } else {
        // Not a failure: the subject pass is `graph_sync`'s job on the
        // scheduler's clock (first tick after boot, then every 6 h), not this
        // deploy's, so a fresh upgrade is allowed to report zero here.
        warn(
          'graph subjects',
          links +
            ' links, none names a subject yet — the graph_sync job fills these in on its next sweep (first tick after boot, then every 6 h), or pnpm graph:mine fills them now',
        );
      }
    }

    const live = {
      memories: countRows(db, 'memories'),
      messages: countRows(db, 'messages'),
      sessions: countRows(db, 'sessions'),
      memory_links: links,
    };
    const counts = [
      ['memories', live.memories],
      ["memories active", countRows(db, 'memories', "status = 'active'")],
      ['sessions', live.sessions],
      ['messages', live.messages],
      ['knowledge_pages', countRows(db, 'knowledge_pages')],
      ["knowledge_pages active", countRows(db, 'knowledge_pages', "status = 'active'")],
      ['entities', countRows(db, 'entities')],
      ['entity_edges', countRows(db, 'entity_edges')],
      ['memory_links', live.memory_links],
    ];
    info(
      'row counts',
      counts
        .filter(([, n]) => n !== null)
        .map(([table, n]) => table + ' ' + n)
        .join(', '),
    );
    if (isCheck) compareWithSnapshot(live, snapshotFile());
  } finally {
    db.close();
  }
}

function dfFreeKb() {
  try {
    const text = execFileSync('df', ['-k', PROJECT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const rows = text.trim().split('\n');
    const fields = rows[rows.length - 1].trim().split(/\s+/);
    const available = Number(fields[fields.length - 3]);
    return Number.isFinite(available) ? available : null;
  } catch {
    return null;
  }
}

async function main() {
  try {
    if (MODE === 'backup') {
      runBackup();
    } else if (MODE === 'stamp') {
      runStamp();
    } else {
      await runReport();
    }
  } catch (err) {
    fail(MODE, err && err.message ? err.message : String(err));
  } finally {
    for (const line of lines) console.log(line);
    console.log('SUMMARY ' + failures + ' failed check(s)');
  }
}

main();
NODE_PROGRAM

# Run the helper on the device (or here with --local). Extra env assignments are
# passed through as `NAME=value` words — unquoted on purpose: the local path
# hands them straight to `env` (which does not re-interpret quotes), while the
# remote path lets the remote shell parse them, so a quoted value would mean two
# different things on the two paths. Every value here is generated by this
# script and contains no whitespace or quoting characters.
device_node() {
  local mode="$1"
  local extra="${2:-}"
  if [ "$LOCAL_MODE" = true ]; then
    # shellcheck disable=SC2086 # `extra` is an env-assignment list, split on purpose
    ( cd "$PROJECT_DIR" && printf '%s\n' "$DB_PROGRAM" | env OMA_MODE="$mode" $extra node )
  else
    # shellcheck disable=SC2086
    printf '%s\n' "$DB_PROGRAM" | ssh_cmd "cd $TERMUX_PROJECT_DIR && OMA_MODE=$mode $extra node"
  fi
}

# Count how many lines of a captured report start with FAIL.
count_failures() {
  local report="$1"
  local count
  count=$(printf '%s\n' "$report" | grep -c '^FAIL' || true)
  printf '%s' "${count:-0}"
}

# `sv status` from the device (or here with --local); never fatal.
device_service_status() {
  on_device <<'STATUS_EOF'
export SVDIR="${SVDIR:-${PREFIX:-}/var/service}"
if command -v sv >/dev/null 2>&1; then
  sv status ohmyagent 2>&1 || true
else
  echo "sv: not installed (pkg install termux-services)"
fi
STATUS_EOF
}

# ─── Package source (include .git so git pull works on remote) ───
# Uses git ls-files to respect .gitignore, then appends .git directory for
# remote git pull support. Untracked files not covered by .gitignore are also
# included (--others --exclude-standard) so local dev changes deploy correctly.
package_source() {
  info "Packaging project source (respecting .gitignore)..."
  cd "$PROJECT_DIR"

  # Collect git-aware file list (respects .gitignore + .git/info/exclude)
  local filelist
  filelist=$(mktemp)
  {
    # Tracked files
    git ls-files -z --cached
    # Untracked files not ignored
    git ls-files -z --others --exclude-standard
  } > "$filelist"

  # Package file list + .git directory (needed for git pull on remote)
  tar -czf "$DEPLOY_TARBALL" \
    --null -T "$filelist" \
    .git

  rm -f "$filelist"

  local size
  size=$(du -h "$DEPLOY_TARBALL" | cut -f1)
  info "Packaged: $DEPLOY_TARBALL ($size)"
}

# ─── Transfer ───
transfer() {
  info "Transferring to Termux..."
  scp -o StrictHostKeyChecking=no -P "$TERMUX_PORT" \
    "$DEPLOY_TARBALL" "${TERMUX_USER}@${TERMUX_HOST}:~/ohmyagent-deploy.tar.gz"
  info "Transfer complete"
}

# ─── Pre-upgrade backup ───
# Before anything is replaced: a consistent snapshot of the live database plus a
# verification that the snapshot is readable and complete. Everything after this
# point is recoverable by restoring this file.
backup_database() {
  if [ "${DELETE_DATABASE:-}" = "true" ]; then
    info "Skipping pre-upgrade backup: DELETE_DATABASE=true wipes data/app.db anyway, nothing to preserve"
    return 0
  fi

  info "Backing up the live database → $BACKUP_REL"
  local report
  report=$(device_node backup "OMA_BACKUP_PATH=$BACKUP_REL") ||
    error "Could not run the backup helper on the device (ssh ${TERMUX_USER}@${TERMUX_HOST}:${TERMUX_PORT})"
  printf '%s\n' "$report" | sed 's/^/  /'
  if [ "$(count_failures "$report")" -gt 0 ]; then
    error "Pre-upgrade backup FAILED — nothing was changed. Fix the problem above (the database is untouched) and redeploy."
  fi
}

# ─── Stop service ───
stop_service() {
  info "Stopping ohmyagent service..."
  # sv down sends TERM to the runit service. On Termux, pkill -f can
  # inadvertently kill the SSH session, so we rely solely on sv down here.
  ssh_cmd "export SVDIR=\$PREFIX/var/service && sv down ohmyagent 2>/dev/null || true"
  sleep 2
  info "Stopped"
}

# ─── Install & build ───
install_and_build() {
  info "Installing and building on Termux..."

  ssh_cmd "DELETE_DATABASE='${DELETE_DATABASE:-}' bash -s" << 'REMOTE_SCRIPT'
set -e
cd ~/.ohmyagent

# Step 1: Database handling
echo "[1/7] Database..."
if [ "$DELETE_DATABASE" = "true" ]; then
  rm -f data/app.db data/app.db-wal data/app.db-shm
  echo "  Old database removed"
else
  echo "  Preserving database (set DELETE_DATABASE=true to clear)"
fi

# Step 2: Extract source
echo "[2/7] Extracting source..."
# Clean stale compiled output and source directories. extensions/ must also
# be cleaned — stale .js files from previous builds are NOT in the git tarball
# and would be copied by copy-extension-resources.js over fresh tsc output.
rm -rf dist src extensions
tar xzf ~/ohmyagent-deploy.tar.gz
rm ~/ohmyagent-deploy.tar.gz

# Make git remote use HTTPS so git pull works without SSH keys
if [ -d .git ]; then
  git remote set-url origin https://github.com/tscodeplus/OhMyAgent.git 2>/dev/null || true
  echo "  Git remote set to HTTPS"
fi

# Step 3: Install dependencies (full output — don't hide errors with tail)
echo "[3/7] Installing dependencies..."
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY 2>/dev/null || true
# Native builds (better-sqlite3, sqlite-vec) must compile against Termux's
# local Node headers via $PREFIX — otherwise node-gyp tries to download
# node-vX-headers.tar.gz from nodejs.org, which often fails on the device.
export ANDROID_NDK_HOME="$PREFIX"
export npm_config_nodedir="$PREFIX"
# sharp has no prebuilt for Termux and its source build (needs libvips) always
# fails. It is optional at runtime (nut-js screenshots degrade gracefully), so
# drop it from the build allow-list on the device (pnpm 11 allowBuilds map /
# onlyBuiltDependencies list / .npmrc array entries — match any line loosely
# because indentation differs between the two pnpm config formats).
sed -i '/sharp/d' pnpm-workspace.yaml
sed -i '/sharp/d' .npmrc
# Over SSH there is no TTY, so when pnpm decides the existing modules dir
# (e.g. an older pnpm layout) must be purged it aborts with
# ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY instead of asking. Try the fast
# incremental install first; fall back to a from-scratch install (the pnpm
# store cache keeps this fast) only when pnpm actually aborted on the purge
# prompt — other failures are surfaced as-is.
INSTALL_LOG=$(mktemp)
if ! pnpm install > "$INSTALL_LOG" 2>&1; then
  if grep -q "NO_TTY" "$INSTALL_LOG"; then
    echo "  Incremental install aborted (no-TTY purge prompt); installing from scratch..."
    rm -rf node_modules
    pnpm install 2>&1
  else
    echo "  pnpm install failed:"
    cat "$INSTALL_LOG"
    rm -f "$INSTALL_LOG"
    exit 1
  fi
fi
rm -f "$INSTALL_LOG"

# sharp: no prebuilt for Termux, but it compiles against the system libvips
# (pkg install libvips) via SHARP_FORCE_GLOBAL_LIBVIPS. It is optional at
# runtime (nut-js screenshots degrade gracefully), so a failed build is
# non-fatal — but it used to work on this device, so keep it working.
echo "[3b/7] Checking sharp..."
if node -e "require('sharp')" >/dev/null 2>&1; then
  echo "  sharp already available"
else
  echo "  Building sharp against system libvips..."
  pkg install -y pkg-config binutils xorgproto libvips >/dev/null 2>&1 || true
  pnpm add -D --ignore-scripts node-addon-api node-gyp >/dev/null 2>&1 || true
  # pnpm rebuild silently skips sharp (it is not in the build allow-list on
  # the device), so run sharp's own build script directly. Needs
  # ANDROID_NDK_HOME (set above) or node-gyp fails with
  # "Undefined variable android_ndk_path in binding.gyp".
  SHARP_PKG_DIR=$(find node_modules/.pnpm -maxdepth 1 -type d -name 'sharp@*' | head -1)/node_modules/sharp
  (cd "$SHARP_PKG_DIR" && SHARP_FORCE_GLOBAL_LIBVIPS=1 npm run build) 2>&1 | tail -5 || true
  if node -e "require('sharp')" >/dev/null 2>&1; then
    echo "  sharp OK"
  else
    echo "  sharp build failed (optional, continuing)"
  fi
fi

# Step 5: Compile better-sqlite3
echo "[4/7] Checking better-sqlite3..."
export ANDROID_NDK_HOME="$PREFIX"
export npm_config_nodedir="$PREFIX"
if [ -n "$(find node_modules -name better_sqlite3.node -path '*/better-sqlite3/*' 2>/dev/null | head -1)" ]; then echo "  Skipping rebuild (binary exists)"; else echo "  Rebuilding better-sqlite3..."; pnpm rebuild better-sqlite3 2>&1; fi

# Step 6: Compile TypeScript + copy locales + copy extension resources
echo "[5/7] Compiling TypeScript..."
# tsc on this codebase needs >1GB old-space; Node's default heap on the device
# (~1GB) now causes "Ineffective mark-compacts near heap limit" OOM (exit 134).
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=4096"
pnpm build

# Verify build output exists before proceeding
if [ ! -f dist/src/index.js ]; then
  echo "ERROR: Build failed — dist/src/index.js not found"
  exit 1
fi
echo "  Build OK: dist/src/index.js exists"

# Step 7: Build WebUI (ui/dist)
echo "[6/7] Building WebUI frontend..."
if [ -f ui/package.json ]; then
  cd ui
  if ! pnpm install > "$INSTALL_LOG" 2>&1; then
    if grep -q "NO_TTY" "$INSTALL_LOG"; then
      echo "  ui install aborted (no-TTY purge); retrying from scratch..."
      rm -rf node_modules
      pnpm install 2>&1
    else
      echo "  ui pnpm install failed:"
      cat "$INSTALL_LOG"
      rm -f "$INSTALL_LOG"
      exit 1
    fi
  fi
  rm -f "$INSTALL_LOG"
  NODE_OPTIONS="--max-old-space-size=4096" pnpm build 2>&1
  cd ..
  echo "  WebUI built to ui/dist/"
else
  echo "  ui/package.json not found, skipping WebUI build"
fi

# Configure runit (sv) service
SERVICE_DIR="$PREFIX/var/service/ohmyagent"
mkdir -p "$SERVICE_DIR/log"

cat > "$SERVICE_DIR/run" << 'RUNEOF'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock >/dev/null 2>&1 || true
export ANDROID_NDK_HOME=/data/data/com.termux/files/usr
export npm_config_nodedir=/data/data/com.termux/files/usr
export WEBUI_STATIC_ROOT=/data/data/com.termux/files/home/.ohmyagent/ui/dist
cd /data/data/com.termux/files/home/.ohmyagent
exec /data/data/com.termux/files/usr/bin/node dist/src/index.js 2>&1
RUNEOF
chmod +x "$SERVICE_DIR/run"

cat > "$SERVICE_DIR/log/run" << 'LOGEOF'
#!/data/data/com.termux/files/usr/bin/bash
exec svlogd -tt /data/data/com.termux/files/home/.ohmyagent/data/logs/
LOGEOF
chmod +x "$SERVICE_DIR/log/run"

# Ensure runtime directories exist
mkdir -p data/logs

echo "Install and build complete"
REMOTE_SCRIPT

  info "Install and build complete"
}

# ─── Deploy stamp ───
# The only durable record of "this build was deployed at this moment": the
# verification compares the running process's age against it, which is what
# separates "up and migrated" from "up and still running yesterday's code".
write_deploy_stamp() {
  info "Recording deploy stamp (data/deploy-stamp.json)..."
  local report
  report=$(device_node stamp "OMA_COMMIT=$DEPLOY_COMMIT OMA_LABEL=$DEPLOY_LABEL") ||
    error "Could not run the stamp helper on the device (ssh ${TERMUX_USER}@${TERMUX_HOST}:${TERMUX_PORT})"
  printf '%s\n' "$report" | sed 's/^/  /'
  if [ "$(count_failures "$report")" -gt 0 ]; then
    warn "Could not write the deploy stamp — the 'running code' check will be skipped"
  fi
}

# ─── Start service ───
start_service() {
  info "Restarting ohmyagent service (force-restart)..."
  ssh_cmd "export SVDIR=\$PREFIX/var/service && sv force-restart ohmyagent 2>&1 || true"
  # Termux cold start takes a while (better-sqlite3 init, embedding models,
  # WebSocket connect) — 6s was too short and the health check warned falsely.
  sleep 20

  info "Verifying service..."
  local status
  status=$(device_service_status)
  echo "  $status"

  local http_code
  # `; true` keeps ssh's exit code 0 even when curl fails, so http_code is
  # exactly curl's %{http_code} (302/200, or 000 on connection failure).
  http_code=$(ssh_cmd "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:\${PORT:-9191}/ 2>/dev/null; true" || echo "000")
  if [ "$http_code" != "000" ]; then
    info "HTTP service OK (status: $http_code)"
  else
    warn "HTTP service not responding, check logs: bash scripts/deploy-termux.sh logs"
  fi
}

# ─── Post-restart verification ───
# HTTP alone cannot tell "up and migrated" from "up and running the old code".
# The helper program checks the process, the build, the commit and the schema
# state; this function turns any FAIL into a report that names the backup and
# the log command, and returns 1 so `deploy` exits non-zero.
verify_upgrade() {
  echo ""
  if [ -n "$BACKUP_REL" ]; then
    echo "=== Post-upgrade verification ==="
  else
    echo "=== Live install verification (read-only) ==="
  fi
  local fails=0 status report recent
  status=$(device_service_status)
  if printf '%s' "$status" | grep -q 'run:'; then
    echo -e "  ${GREEN}OK  ${NC} service — $status"
  else
    echo -e "  ${RED}FAIL${NC} service — $status"
    fails=$((fails + 1))
  fi

  report=$(device_node check "OMA_EXPECT_HEAD=$DEPLOY_COMMIT${BACKUP_REL:+ OMA_BACKUP_PATH=$BACKUP_REL}") ||
    error "Could not run the verification helper on the device (ssh ${TERMUX_USER}@${TERMUX_HOST}:${TERMUX_PORT})"
  printf '%s\n' "$report" | sed 's/^/  /'

  recent=$(printf '%s\n' "$report" | sed -n 's/^RECENTBACKUP //p' | head -1)
  fails=$((fails + $(count_failures "$report")))

  if [ "$fails" -eq 0 ]; then
    echo ""
    info "Upgrade verified: the running process is this build and the database is migrated"
    return 0
  fi

  local backup_shown="${BACKUP_REL:-$recent}"
  if [ -z "$backup_shown" ]; then
    backup_shown="data/backups/pre-upgrade-*.db"
  fi
  echo ""
  echo -e "${RED}[FAIL]${NC} $fails check(s) failed — the upgrade is NOT verified."
  echo "       Database backup : ${TERMUX_PROJECT_DIR}/$backup_shown"
  echo "       Server log      : bash scripts/deploy-termux.sh logs"
  echo "                         (migration failures appear as [migration-vN]/[schema] lines at startup)"
  if [ "$LOCAL_MODE" = true ]; then
    # On the device there is no SSH in the path, so the restore is two sv calls
    # and a copy — the same steps, without a hop this machine cannot make.
    echo "       Restore it with : sv down ohmyagent"
    echo "                         cd ~/.ohmyagent && mv data/app.db data/app.db.failed && rm -f data/app.db-wal data/app.db-shm && cp $backup_shown data/app.db"
    echo "                         sv up ohmyagent"
  else
    echo "       Restore it with : bash scripts/deploy-termux.sh stop"
    echo "                         ssh -p ${TERMUX_PORT} ${TERMUX_USER}@${TERMUX_HOST} \"cd ~/.ohmyagent && mv data/app.db data/app.db.failed && rm -f data/app.db-wal data/app.db-shm && cp $backup_shown data/app.db\""
    echo "                         bash scripts/deploy-termux.sh start"
  fi
  return 1
}

# ─── Read-only: check the live install ───
do_check() {
  # Propagates verify_upgrade's status, so `check` is usable as a gate.
  verify_upgrade
}

# ─── Read-only: what an upgrade would do ───
do_preflight() {
  echo "============================================="
  echo "  OhMyAgent Termux preflight (read-only)"
  echo "============================================="
  echo ""
  local status report recent
  status=$(device_service_status)
  echo "=== Service ==="
  echo "  $status"
  echo ""

  echo "=== Current install ==="
  report=$(device_node plan) ||
    error "Could not run the inspection helper on the device (ssh ${TERMUX_USER}@${TERMUX_HOST}:${TERMUX_PORT})"
  printf '%s\n' "$report" | sed 's/^/  /'
  recent=$(printf '%s\n' "$report" | sed -n 's/^RECENTBACKUP //p' | head -1)
  echo ""

  local stamp
  stamp=$(date +%Y%m%d-%H%M%S)
  local would_backup="data/backups/pre-upgrade-${DEPLOY_LABEL}-${stamp}.db"
  echo "=== What 'deploy' would do ==="
  echo "  1. snapshot the database: VACUUM INTO $would_backup"
  echo "     then re-open the copy (quick_check + row counts) before anything is stopped"
  echo "     (skipped with DELETE_DATABASE=true, which wipes data/app.db instead)"
  echo "  2. stop the service and swap the source for ${DEPLOY_LABEL}"
  echo "  3. pnpm install + pnpm build + WebUI build (several minutes on the phone)"
  echo "  4. start the service — the new process migrates the database itself in"
  echo "     openDatabase(): schema migrations v4-v16 plus the v17 legacy-graph"
  echo "     repair. No manual migration, no graph:reset/graph:mine step."
  echo "  5. wait 20s, then verify health, the running commit, the build age, every"
  echo "     migration, the messages FTS backfill, and the before/after row counts"
  echo "     against the snapshot from step 1"
  echo ""
  if [ -n "$recent" ]; then
    echo "  Newest existing backup: $recent"
  fi
  echo "  Nothing above mutated the device: this is a read-only report."
}

# ─── Full deploy ───
do_deploy() {
  echo "============================================="
  echo "  OhMyAgent Termux Deploy"
  echo "============================================="
  echo ""

  setup_ssh
  prepare_deploy
  package_source
  transfer
  # The snapshot is taken while the old service is still running: VACUUM INTO
  # is safe against a live database, and a backup failure then aborts before
  # anything has been stopped or replaced.
  backup_database
  stop_service
  install_and_build
  write_deploy_stamp
  start_service

  if verify_upgrade; then
    echo ""
    info "Deploy complete"
  else
    echo ""
    warn "Deploy finished with verification failures — see the FAIL lines above"
    exit 1
  fi
}

# ─── Logs ───
do_logs() {
  setup_ssh
  ssh_cmd 'tail -f ~/.ohmyagent/data/logs/current'
}

# ─── Status ───
do_status() {
  setup_ssh
  echo "=== sv status ==="
  device_service_status
  echo ""
  echo "=== HTTP check ==="
  ssh_cmd "curl -s -o /dev/null -w 'HTTP: %{http_code}\n' http://127.0.0.1:\${PORT:-9191}/ 2>/dev/null || echo 'No response'"
  echo ""
  echo "=== Recent logs ==="
  ssh_cmd 'tail -10 ~/.ohmyagent/data/logs/current 2>/dev/null'
  echo ""
  echo "For a read-only upgrade verification (health + running commit + migrations + before/after row counts):"
  echo "  bash scripts/deploy-termux.sh check"
  echo "Before upgrading, for what the upgrade would do:"
  echo "  bash scripts/deploy-termux.sh verify"
}

# ─── Main ───
main() {
  local cmd="${1:-deploy}"
  local flag="${2:-}"

  # `--dry-run` and `verify` are the same read-only report as `preflight`.
  case "$cmd" in
    --dry-run | verify) cmd="preflight" ;;
  esac

  case "$flag" in
    '') ;;
    --local) LOCAL_MODE=true ;;
    *) error "Unknown option: $flag (supported: --local)" ;;
  esac

  if [ "$LOCAL_MODE" = true ]; then
    case "$cmd" in
      preflight|check) ;;
      *) error "--local only applies to the read-only commands (preflight/verify, check)" ;;
    esac
  fi

  case "$cmd" in
    deploy)
      do_deploy
      ;;
    preflight)
      if [ "$LOCAL_MODE" = false ]; then
        setup_ssh
      fi
      cd "$PROJECT_DIR"
      DEPLOY_LABEL=$(git describe --tags --always 2>/dev/null || git rev-parse --short HEAD 2>/dev/null || echo unknown)
      DEPLOY_LABEL=$(printf '%s' "$DEPLOY_LABEL" | tr '/ ' '--')
      do_preflight
      ;;
    check)
      # A standalone `check` compares the device against this working tree's
      # HEAD; on the device itself there is nothing to compare with, so the
      # deploy stamp recorded in data/deploy-stamp.json is the only expectation.
      if [ "$LOCAL_MODE" = false ]; then
        setup_ssh
        DEPLOY_COMMIT=$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null || echo "")
      fi
      do_check
      ;;
    start)
      setup_ssh
      start_service
      ;;
    stop)
      setup_ssh
      stop_service
      ;;
    restart)
      setup_ssh
      stop_service
      start_service
      ;;
    status)
      do_status
      ;;
    logs)
      do_logs
      ;;
    *)
      echo "Usage: $0 {deploy|verify|preflight|check|start|stop|restart|status|logs} [--local]"
      echo ""
      echo "  deploy    - Upgrade (backup → swap → build → boot-migrate → verify)"
      echo "  verify    - Read-only: what an upgrade would do (aliases: preflight, --dry-run)"
      echo "  check     - Read-only: verify the live install (health, commit, migrations, row counts)"
      echo "  start     - Start service only"
      echo "  stop      - Stop service only"
      echo "  restart   - Restart service"
      echo "  status    - View status"
      echo "  logs      - View logs (tail -f)"
      echo ""
      echo "  --local   - run verify/check on this machine (i.e. on the device)"
      exit 1
      ;;
  esac
}

main "$@"
