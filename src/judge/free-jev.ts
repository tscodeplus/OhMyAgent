/**
 * Free-Jev support (impl doc §3.3): `opencode/jev-1.13-free` is a limited-time
 * free tier whose content goes to OpenCode (no-training promise). Two duties:
 *
 * 1. Daily notice — fire an injected callback at most once per LOCAL day while
 *    the free tier is actually the judge answering calls (host provides the
 *    channel; this module never sends Feishu messages itself).
 * 2. Sunset detection — 5 consecutive 402/404/410-kind failures disable the
 *    free tier for the rest of the local day and re-check daily.
 */

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
  /** Called once per local day, the first time the free tier produces a verdict that day. */
  onNotice?: () => void;
  /** Injectable for tests. */
  now?: () => Date;
  logger?: Logger;
}

export class FreeJevMonitor {
  private readonly onNotice?: () => void;
  private readonly now: () => Date;
  private readonly logger?: Logger;

  private lastNoticeDay = '';
  /** Consecutive sunset-kind (402/404/410) failures. */
  private sunsetFailures = 0;
  /** Local day key through which the free tier is suspended. */
  private suspendedUntilDay: string | null = null;

  constructor(options: FreeJevMonitorOptions = {}) {
    this.onNotice = options.onNotice;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
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
   * Fire the daily notice when `judgeId` produced an actual verdict today;
   * at most once per local day. Callback errors are swallowed.
   */
  maybeNotice(judgeId: string): void {
    if (!isFreeJevJudgeId(judgeId) || this.isSuspendedToday()) return;
    const today = this.dayKey();
    if (this.lastNoticeDay === today || !this.onNotice) return;
    this.lastNoticeDay = today;
    try {
      this.onNotice();
    } catch (err) {
      this.logger?.warn({ err }, 'judge free-Jev notice callback failed (non-fatal)');
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
