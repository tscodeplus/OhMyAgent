/**
 * Judge decision ledger (impl doc §5.4): append-only JSONL under
 * `data/judge-ledger/<yyyy-mm>/<session-id>.jsonl`, one line per judged call,
 * plus an in-memory ring buffer (last 200) backing `GET /api/judge/status`.
 *
 * Writes are best-effort: a ledger failure must never break a judge call, so
 * every fs error is swallowed into the logger. Fresh writes only — timestamps
 * are ISO strings, so `parseEpochMs` (src/shared/timestamp.js) is not needed
 * here (it is for SQLite epoch-ms TEXT columns).
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type {
  DecisionOutcome,
  FallbackReason,
  JudgmentSource,
  JudgeAnswerMap,
  JudgeMode,
} from './types.js';
import { parseEpochMs } from '../shared/timestamp.js';

/** One ledger line (impl doc §5 item 4). */
export interface LedgerRecord {
  ts: string;
  sessionId: string;
  pointId: string;
  decisionId: string;
  mode: JudgeMode;
  judgeId: string;
  source: JudgmentSource;
  fallbackReason?: FallbackReason;
  answers: JudgeAnswerMap;
  /** Judged entries only: what active mode would decide (`spec.policy`). */
  outcome?: DecisionOutcome;
  /** Judged entries only: the pre-judge rule floor (`spec.fallback`). */
  floor?: DecisionOutcome;
  /** Judged entries only: outcome === floor (autopilot agreement signal). */
  agree?: boolean;
  latencyMs: number;
  usage?: { input: number; output: number };
  /** Judged state — persisted only when `judge.recordState` is on. */
  state?: string | Record<string, unknown>;
}

export interface JudgeLedgerOptions {
  /** Base directory. Default `./data/judge-ledger`. */
  dir?: string;
  logger?: Logger;
  /** Injectable for tests. */
  now?: () => number;
  /** Ring buffer capacity. Default 200. */
  ringMax?: number;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'unknown';
}

export class JudgeLedger {
  private readonly dir: string;
  private readonly logger?: Logger;
  private readonly now: () => number;
  private readonly ringMax: number;
  private readonly ring: LedgerRecord[] = [];

  constructor(options: JudgeLedgerOptions = {}) {
    this.dir = options.dir ?? './data/judge-ledger';
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
    this.ringMax = options.ringMax ?? 200;
  }

  /** Append one record to the month file and the ring buffer. Never throws. */
  record(entry: LedgerRecord): void {
    this.ring.push(entry);
    if (this.ring.length > this.ringMax) {
      this.ring.splice(0, this.ring.length - this.ringMax);
    }
    try {
      const date = new Date(this.now());
      const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
      const file = join(this.dir, month, `${sanitizeSegment(entry.sessionId)}.jsonl`);
      mkdirSync(join(this.dir, month), { recursive: true });
      appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (err) {
      this.logger?.warn({ err }, 'Judge ledger write failed (non-fatal)');
    }
  }

  /** Last `n` records (default 20), oldest first. */
  recent(n = 20): LedgerRecord[] {
    return this.ring.slice(Math.max(0, this.ring.length - n));
  }

  /** Filter values for {@link JudgeLedger.query} / GET /api/judge/ledger. */
  query(filter: LedgerQueryFilter = {}): LedgerQueryResult {
    const page = Math.max(1, Math.floor(filter.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Math.floor(filter.pageSize ?? 20)));
    const pointId = filter.pointId?.trim() || undefined;
    const mode = filter.mode?.trim() || undefined;
    const outcome = filter.outcome?.trim() || undefined;
    // `from`/`to` accept ISO strings AND bare epoch-millis digit strings —
    // parseEpochMs handles both (0 = not provided/unparseable → no filter).
    const fromTs = parseEpochMs(filter.from ?? undefined);
    const toTs = parseEpochMs(filter.to ?? undefined);
    const session = filter.session?.trim() || undefined;

    // Source filter: `outcome` matches the judgment source — 'judge' (asked
    // and answered) vs 'fallback' (asked and fell back). 'judged' is an alias
    // for 'judge' so UI filters can use either word.
    const outcome_ =
      outcome === 'judged'
        ? 'judge'
        : outcome === 'judge' || outcome === 'fallback'
          ? outcome
          : null;
    if (outcome && outcome_ === null) {
      return { entries: [], total: 0, page, pageSize };
    }

    const entries: LedgerRecord[] = [];
    this.forEachFile((file) => {
      let content: string;
      try {
        content = readFileSyncIfFile(file);
      } catch {
        return;
      }
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let rec: LedgerRecord;
        try {
          rec = JSON.parse(trimmed) as LedgerRecord;
        } catch {
          continue;
        }
        if (!rec || typeof rec !== 'object' || typeof rec.ts !== 'string') continue;
        if (pointId && rec.pointId !== pointId) continue;
        if (mode && rec.mode !== mode) continue;
        if (outcome_ && rec.source !== outcome_) continue;
        const ts = parseEpochMs(rec.ts);
        if (fromTs > 0 && (ts === 0 || ts < fromTs)) continue;
        if (toTs > 0 && (ts === 0 || ts > toTs)) continue;
        entries.push(rec);
      }
    }, session);

    // Newest first: page 1 of the panel shows the latest judgments.
    entries.sort((a, b) => parseEpochMs(b.ts) - parseEpochMs(a.ts));

    return {
      entries: entries.slice((page - 1) * pageSize, page * pageSize),
      total: entries.length,
      page,
      pageSize,
    };
  }

  /** Visit every month/session JSONL file once; `session` narrows to that file. */
  private forEachFile(visit: (file: string) => void, session?: string): void {
    let months: string[];
    try {
      months = readdirSync(this.dir)
        .filter((m) => /^\d{4}-\d{2}$/.test(m) && statSync(join(this.dir, m)).isDirectory())
        .sort()
        .reverse();
    } catch {
      return;
    }
    for (const month of months) {
      try {
        const files = session
          ? [`${sanitizeSegment(session)}.jsonl`]
          : readdirSync(join(this.dir, month)).filter((f) => f.endsWith('.jsonl'));
        for (const file of files) {
          visit(join(this.dir, month, file));
        }
      } catch {
        continue;
      }
    }
  }
}

/** Query parameters (all optional) for the ledger panel / GET /api/judge/ledger. */
export interface LedgerQueryFilter {
  page?: number;
  pageSize?: number;
  pointId?: string;
  mode?: string;
  /** Judgment source: 'judge' | 'fallback' ('judged' is an alias for 'judge'). */
  outcome?: string;
  /** Inclusive lower bound on `ts` (ISO string or epoch-millis digit string). */
  from?: string;
  /** Inclusive upper bound on `ts` (ISO string or epoch-millis digit string). */
  to?: string;
  /** Exact sessionId — reads only that session's file(s) across months. */
  session?: string;
}

export interface LedgerQueryResult {
  /** Newest-first slice for this page. */
  entries: LedgerRecord[];
  total: number;
  page: number;
  pageSize: number;
}

function readFileSyncIfFile(file: string): string {
  if (!statSync(file).isFile()) throw new Error('not a file');
  return readFileSync(file, 'utf8');
}
