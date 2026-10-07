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

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { FallbackReason, JudgmentSource, JudgeAnswerMap, JudgeMode } from './types.js';

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
}
