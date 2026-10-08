/**
 * JudgeEngine (impl doc §3.1) — decide/decideMany for one decision point.
 *
 * Execution order:
 *   1. mode check (modes[pointId] ?? modes.default ?? shadow) — `off`: not
 *      asked, NO ledger line, fallback verdict returned;
 *   2. circuit-breaker check (per decision point);
 *   3. judge chain resolution (JudgeModelResolver — injected, no network);
 *   4. per tier: classify with timeoutMs + merged AbortSignal (classify never
 *      rejects; stopReason checked; aborts/throws are tier failures);
 *   5. fail-closed validation (invalid answers discarded; ALL invalid or the
 *      call failed → next tier, fallbackReason recorded);
 *   6. gray-zone cascade escalation to the next tier; chain exhausted → fallback;
 *   7. policy applied ONLY in active mode; ledger line for every non-off call.
 *
 * decide/decideMany NEVER reject — every failure lands in spec.fallback and is
 * ledgered. The policy result is returned in Verdict.outcome; hook points must
 * apply only that field, never the raw answers (shadow stays behavior-neutral).
 */

import type { ClassifierAnswer, ClassifierQuestion, ClassifierResult } from '@earendil-works/pi-ai';
import type { Logger } from 'pino';
import { JudgeCircuitBreaker } from './circuit-breaker.js';
import type { FreeJevMonitor } from './free-jev.js';
import { isFreeJevJudgeId } from './free-jev.js';
import { JudgeLedger } from './ledger.js';
import { outcomeEquals } from './outcome.js';
import { toClassifierQuestions, validateAnswers } from './protocol-map.js';
import {
  DEFAULT_JUDGE_MODE,
  type DecisionInput,
  type DecisionOutcome,
  type DecisionSpec,
  type FallbackReason,
  type JudgeAnswerMap,
  type JudgeModelResolver,
  type JudgeQuestion,
  type JudgmentSource,
  type JudgeMode,
  type JudgeSectionConfig,
  type JudgeTier,
  type ResolvedJudgeChain,
  type Verdict,
} from './types.js';

export interface JudgeEngineOptions {
  config: JudgeSectionConfig;
  resolver: JudgeModelResolver;
  ledger?: JudgeLedger;
  breaker?: JudgeCircuitBreaker;
  /** Injected host for the once-per-day free-Jev notice + sunset detection. */
  freeJev?: FreeJevMonitor;
  logger?: Logger;
  /** Injectable for tests. */
  now?: () => number;
}

export class JudgeEngine {
  readonly ledger: JudgeLedger;
  readonly breaker: JudgeCircuitBreaker;
  readonly freeJev?: FreeJevMonitor;

  private config: JudgeSectionConfig;
  private readonly resolver: JudgeModelResolver;
  private readonly logger?: Logger;
  private readonly now: () => number;

  constructor(options: JudgeEngineOptions) {
    this.config = options.config;
    this.resolver = options.resolver;
    this.ledger = options.ledger ?? new JudgeLedger({ logger: options.logger });
    this.breaker = options.breaker ?? new JudgeCircuitBreaker();
    this.logger = options.logger;
    this.freeJev = options.freeJev;
    this.now = options.now ?? (() => Date.now());
  }

  /** Live judge section — the single feature/mode source for hook points. */
  get section(): JudgeSectionConfig {
    return this.config;
  }

  /** Hot-reload support: swap the judge section in place. */
  updateConfig(config: JudgeSectionConfig): void {
    this.config = config;
  }

  /** Effective mode for one point (per-call lookup so reloads apply). */
  modeFor(pointId: string): JudgeMode {
    const modes = this.config.modes;
    return modes?.[pointId] ?? modes?.default ?? DEFAULT_JUDGE_MODE;
  }

  /**
   * One judged decision for an optional question subset (shared state).
   * Never rejects.
   */
  async decide(spec: DecisionSpec, input?: DecisionInput, signal?: AbortSignal): Promise<Verdict> {
    const started = this.now();
    const call = {
      state: input?.state,
      sessionId: input?.sessionId,
      questionIds: input?.questionIds,
    };

    if (this.modeFor(spec.id) === 'off') {
      // Not asked, not ledgered.
      return this.finish(spec, call, started, 'off', {
        source: 'fallback',
        fallbackReason: 'mode-off',
      });
    }

    try {
      const mode = this.modeFor(spec.id);
      if (this.breaker.isOpen(spec.id)) {
        return this.finish(spec, call, started, mode, {
          source: 'fallback',
          fallbackReason: 'circuit-open',
        });
      }

      const chain = this.safeChain(spec.id);
      if (chain.tiers.length === 0) {
        const reason: FallbackReason = chain.noKeyRefs.length > 0 ? 'no-key' : 'unavailable';
        return this.finish(spec, call, started, mode, {
          source: 'fallback',
          fallbackReason: reason,
        });
      }

      const run = await this.runCascade(spec, call, started, mode, chain, signal);
      if (run.verdict) return run.verdict;

      if (run.serviceFailure) {
        // Consecutive-service-failure accounting for the circuit breaker.
        this.breaker.recordFailure(spec.id);
      }
      const reason: FallbackReason = run.aborted
        ? 'aborted'
        : run.serviceFailure
          ? 'unavailable'
          : run.parseRejected
            ? 'parse-rejected'
            : run.suspensionSkipped
              ? 'unavailable' // only free-Jev sunset suspension remained
              : 'gray-zone';
      return this.finish(spec, call, started, mode, {
        source: 'fallback',
        fallbackReason: reason,
      });
    } catch (err) {
      this.logger?.warn(
        { err, pointId: spec.id },
        'Judge decide() failed unexpectedly — falling back',
      );
      const mode = this.modeFor(spec.id);
      return this.finish(spec, call, started, mode, {
        source: 'fallback',
        fallbackReason: 'unavailable',
      });
    }
  }

  /** All questions of the spec in ONE classify call — state billed once. */
  async decideMany(
    spec: DecisionSpec,
    input: Pick<DecisionInput, 'state' | 'sessionId'> = { state: null },
    signal?: AbortSignal,
  ): Promise<Verdict> {
    return await this.decide(spec, { ...input }, signal);
  }

  // ─── internals ────────────────────────────────────────────────────────

  private safeChain(pointId: string): ResolvedJudgeChain {
    try {
      return this.resolver(pointId);
    } catch (err) {
      this.logger?.warn({ err, pointId }, 'Judge resolver threw (treated as unavailable)');
      return { tiers: [], noKeyRefs: [], unresolvableRefs: [] };
    }
  }

  private async runCascade(
    spec: DecisionSpec,
    call: { state: unknown; sessionId?: string; questionIds?: string[] },
    started: number,
    mode: JudgeMode,
    chain: ResolvedJudgeChain & { tiers: JudgeTier[] },
    callerSignal?: AbortSignal,
  ): Promise<{
    verdict?: Verdict;
    serviceFailure: boolean;
    parseRejected: boolean;
    gray: boolean;
    suspensionSkipped: boolean;
    aborted: boolean;
  }> {
    const questionIds = (call.questionIds ?? Object.keys(spec.questions)).filter(
      (id): id is string => Boolean(id) && id in spec.questions,
    );
    if (questionIds.length === 0) {
      this.logger?.warn({ pointId: spec.id }, 'Judge decide() called with no known question ids');
      return {
        serviceFailure: false,
        parseRejected: true,
        gray: false,
        suspensionSkipped: false,
        aborted: false,
      };
    }
    const questions: Record<string, JudgeQuestion> = {};
    for (const id of questionIds) {
      questions[id] = spec.questions[id];
    }
    const classifierQuestions = toClassifierQuestions(questions);
    const state: unknown = spec.buildState ? spec.buildState(call) : call.state;

    let serviceFailure = false;
    let parseRejected = false;
    let gray = false;
    let suspensionSkipped = false;

    for (const tier of chain.tiers) {
      if (this.freeJev && isFreeJevJudgeId(tier.judgeId) && this.freeJev.isSuspendedToday()) {
        // Free-Jev sunset detected earlier today: skip to the next tier.
        suspensionSkipped = true;
        continue;
      }
      let result: ClassifierResult;
      try {
        result = await this.classifyWithTimeout(tier, classifierQuestions, state, callerSignal);
      } catch (err) {
        this.logger?.warn({ err, judgeId: tier.judgeId, pointId: spec.id }, 'Judge classify threw');
        serviceFailure = true;
        continue;
      }
      if (callerSignal?.aborted) {
        return {
          serviceFailure,
          parseRejected,
          gray,
          suspensionSkipped,
          aborted: true,
        };
      }
      if (this.freeJev) this.freeJev.recordOutcome(tier.judgeId, result);

      if (!result || result.stopReason === 'error' || result.stopReason === 'aborted') {
        serviceFailure = true;
        continue;
      }

      const rawAnswers = result.answers ?? {};
      const predicted: Record<string, ClassifierAnswer | undefined> = {};
      for (const id of questionIds) {
        predicted[id] = rawAnswers[id];
      }
      const validate = validateAnswers(questions, predicted);
      if (Object.keys(validate.valid).length === 0) {
        // Healthy service, unusable output — fail-closed, next tier. NOT a
        // breaker failure (the service is healthy).
        parseRejected = true;
        continue;
      }
      if (validate.anyGray) {
        // Calibrated gray zone → escalate the whole call to the next tier.
        gray = true;
        continue;
      }

      // ── Judged ──
      if (this.freeJev) this.freeJev.maybeNotice(tier.judgeId, call.sessionId);
      this.breaker.recordSuccess(spec.id);
      const verdict = this.finish(spec, call, started, mode, {
        source: 'judge',
        judgeId: tier.judgeId,
        answers: validate.valid,
        usage: result.usage
          ? { input: result.usage.input, output: result.usage.output }
          : undefined,
      });
      return { verdict, serviceFailure, parseRejected, gray, suspensionSkipped, aborted: false };
    }
    return { serviceFailure, parseRejected, gray, suspensionSkipped, aborted: false };
  }

  /** classify() never rejects, but the injected tier / transport can — belt and braces. */
  private async classifyWithTimeout(
    tier: JudgeTier,
    questions: Record<string, ClassifierQuestion>,
    state: unknown,
    callerSignal?: AbortSignal,
  ): Promise<ClassifierResult> {
    const controller = new AbortController();
    const timeoutMs = this.config.timeoutMs > 0 ? this.config.timeoutMs : 4000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const forward = (): void => controller.abort();
    callerSignal?.addEventListener('abort', forward, { once: true });
    try {
      return await tier.classify(
        { state: state as never, questions },
        { signal: controller.signal, timeoutMs },
      );
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', forward);
    }
  }

  /** Build the verdict, apply policy (active + judged only), ledger every non-off call. */
  private finish(
    spec: DecisionSpec,
    call: { state: unknown; sessionId?: string; questionIds?: string[] },
    started: number,
    mode: JudgeMode,
    judgment: {
      source: JudgmentSource;
      judgeId?: string;
      fallbackReason?: FallbackReason;
      answers?: JudgeAnswerMap;
      usage?: { input: number; output: number };
    },
  ): Verdict {
    const judged = judgment.source === 'judge';
    const answers = judged ? (judgment.answers ?? {}) : {};
    let outcome = spec.fallback;
    /** What a hypothetical ACTIVE mode would decide (autopilot telemetry). */
    let judgedOutcome: DecisionOutcome | undefined;
    if (judged && mode !== 'off') {
      try {
        judgedOutcome = spec.policy
          ? spec.policy(answers, {
              mode: 'active',
              input: { state: call.state, questionIds: call.questionIds },
            })
          : spec.fallback;
      } catch (err) {
        // A broken policy must not crash the turn — fail open to the fallback.
        this.logger?.warn(
          { err, pointId: spec.id },
          'Judge spec.policy threw — using spec.fallback',
        );
        judgedOutcome = spec.fallback;
      }
      if (mode === 'active') outcome = judgedOutcome;
    }

    const verdict: Verdict = {
      pointId: spec.id,
      decisionId: `${spec.id}@v${spec.version}`,
      answers,
      judgeId: judged ? (judgment.judgeId ?? '') : '',
      source: judgment.source,
      fallbackReason: judged ? undefined : judgment.fallbackReason,
      latencyMs: Math.max(0, this.now() - started),
      usage: judgment.usage,
      mode,
      outcome,
    };

    if (this.ledger && mode !== 'off') {
      // Shadow-flight telemetry (judged entries only): what active would have
      // decided vs the pre-judge floor. The autopilot's promotion gates are
      // computed from this agreement — no human labeling anywhere.
      const agree =
        judged && judgedOutcome ? outcomeEquals(judgedOutcome, spec.fallback) : undefined;
      this.ledger.record({
        ts: new Date(this.now()).toISOString(),
        sessionId: call.sessionId ?? 'unknown',
        pointId: spec.id,
        decisionId: verdict.decisionId,
        mode,
        judgeId: verdict.judgeId,
        source: verdict.source,
        fallbackReason: verdict.fallbackReason,
        answers: verdict.answers,
        ...(agree !== undefined ? { agree, outcome: judgedOutcome, floor: spec.fallback } : {}),
        latencyMs: verdict.latencyMs,
        usage: verdict.usage,
        ...(this.config.recordState && call.state != null
          ? { state: call.state as string | Record<string, unknown> }
          : {}),
      });
    }
    return verdict;
  }
}
