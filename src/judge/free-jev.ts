/**
 * Free-Jev support (impl doc §3.3): `opencode/jev-1.13-free` is a limited-time
 * free tier whose content goes to OpenCode (no-training promise). Two duties:
 *
 * 1. Daily notice — fire an injected callback at most once per USER per LOCAL
 *    day while the free tier is actually the judge answering calls. The
 *    "noticed on" state is persisted as ledger-adjacent metadata (a small JSON
 *    file in the ledger data dir) so a restart does not repeat the notice; the
 *    host delivers it through the channel reply path (`onNotice` callback).
 *    The notice line never carries judged content.
 * 2. Sunset detection — 5 consecutive 402/404/410-kind failures disable the
 *    free tier for the rest of the local day and re-check daily.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';

/** Model id of the free tier. */
export const FREE_JEV_MODEL_ID = 'jev-1.13-free';

/** True when judgeId is the free tier (provider-agnostic: "x/jev-1.13-free"). */
export function isFreeJevJudgeId(judgeId: string): boolean {
  return judgeId.endsWith(`/${FREE_JEV_MODEL_ID}`);
}

/** A result-shaped summary the engine reports for tier outcomes (no pi-mono types needed). */
export interface FreeJevOutcome {
  stopReason: 'stop' | 'error' | 'aborted';
  errorMessage?: string;
}

export interface FreeJevMonitorOptions {
  /**
   * Called at most once per user (sessionId) per local day, the first time
   * the free tier produces a verdict for that session that day. May be async
   * — rejections are logged, never thrown at the engine.
   */
  onNotice?: (sessionId: string) => void | Promise<void>;
  /** Injectable for tests. */
  now?: () => Date;
  logger?: Logger;
  /**
   * Persistence file for the noticed-on state ("sessionId": day key) —
   * ledger-adjacent metadata under the ledger data dir by default. When
   * unset (tests) the state stays in memory only.
   */
  stateFile?: string;
}

/** Bounded noticed-on state: at most this many session keys survive on disk. */
const MAX_NOTICED_SESSIONS = 500;

type NoticedState = Record<string, string>;

function loadNoticedState(file: string | undefined): NoticedState {
  if (!file) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: NoticedState = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
  } catch {
    // missing / corrupt file → fresh state
  }
  return {};
}

export class FreeJevMonitor {
  private readonly onNotice?: (sessionId: string) => void | Promise<void>;
  private readonly now: () => Date;
  private readonly logger?: Logger;
  private readonly stateFile?: string;

  /** sessionId → local day key of the last notice. Persisted when stateFile is set. */
  private noticedBySession: NoticedState;
  /** Consecutive sunset-kind (402/404/410) failures. */
  private sunsetFailures = 0;
  /** Local day key through which the free tier is suspended. */
  private suspendedUntilDay: string | null = null;

  constructor(options: FreeJevMonitorOptions = {}) {
    this.onNotice = options.onNotice;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
    this.stateFile = options.stateFile;
    this.noticedBySession = loadNoticedState(options.stateFile);
  }

  private dayKey(): string {
    const d = this.now();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
  }

  /** Whether the free tier is currently disabled (sunset detected today). */
  isSuspendedToday(): boolean {
    // A new local day clears the suspension and its failure streak — the
    // service gets re-checked daily.
    const today = this.dayKey();
    if (this.suspendedUntilDay !== null && this.suspendedUntilDay !== today) {
      this.suspendedUntilDay = null;
      this.sunsetFailures = 0;
    }
    return this.suspendedUntilDay === today;
  }

  /**
   * Fire the daily notice for `judgeId` when it produced an actual verdict
   * for `sessionId` today; at most once per user (sessionId) per local day.
   * Callback errors are swallowed (async rejections are logged, not raised
   * into the judge call).
   */
  maybeNotice(judgeId: string, sessionId?: string): void {
    if (!isFreeJevJudgeId(judgeId) || this.isSuspendedToday()) return;
    const userKey = sessionId && sessionId.length > 0 ? sessionId : 'unknown';
    const today = this.dayKey();
    if (this.noticedBySession[userKey] === today || !this.onNotice) return;
    this.noticedBySession[userKey] = today;
    this.persistNoticedState(today);
    try {
      const result = this.onNotice(userKey);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).then(
          undefined,
          (err: unknown) =>
            void this.logger?.warn({ err }, 'judge free-Jev notice failed (non-fatal)'),
        );
      }
    } catch (err) {
      this.logger?.warn({ err }, 'judge free-Jev notice callback failed (non-fatal)');
    }
  }

  /** Persist the noticed-on state (keeping only the current day, bounded). */
  private persistNoticedState(today: string): void {
    if (!this.stateFile) return;
    if (!this.noticedBySession) this.noticedBySession = {};
    try {
      const trimmed: NoticedState = {};
      for (const [k, v] of Object.entries(this.noticedBySession)) {
        if (v === today) trimmed[k] = v;
        if (Object.keys(trimmed).length >= MAX_NOTICED_SESSIONS) break;
      }
      this.noticedBySession = trimmed;
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify(this.noticedBySession), 'utf8');
    } catch (err) {
      this.logger?.warn(
        { err, stateFile: this.stateFile ?? join('.', 'none') },
        'judge free-Jev noticed-state persist failed (non-fatal)',
      );
    }
  }

  /** Feed every classify outcome for a free-tier tier into the sunset detector. */
  recordOutcome(judgeId: string, outcome: FreeJevOutcome): void {
    if (!isFreeJevJudgeId(judgeId)) return;
    if (outcome.stopReason === 'stop') {
      this.sunsetFailures = 0;
      if (this.dayKey() !== this.suspendedUntilDay) this.suspendedUntilDay = null;
      return;
    }
    const message = outcome.errorMessage ?? '';
    const isSunsetKind = /\b(402|404|410)\b|payment required|not found|gone/i.test(message);
    if (!isSunsetKind) return;
    this.sunsetFailures += 1;
    if (this.sunsetFailures >= 5) {
      this.suspendedUntilDay = this.dayKey();
      this.sunsetFailures = 0;
      this.logger?.warn(
        { judgeId },
        'Free Jev ended? 5 consecutive 402/404/410 responses — free tier disabled for today (re-checks daily)',
      );
    }
  }
}
