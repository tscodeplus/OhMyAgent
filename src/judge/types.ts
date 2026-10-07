/**
 * Judge kernel core types (MyDocs/JEV_JUDGE_KERNEL_PLAN.md §5/§7,
 * MyDocs/JEV_JUDGE_KERNEL_IMPLEMENTATION.md §2).
 *
 * Three bounded question shapes (choice / noul / score) with calibrated
 * answers, the verdict ledger shape, and the decision-point spec contract.
 * This module intentionally has NO runtime imports — it is the dependency
 * floor of `src/judge/` (the protocol mapping to pi-mono classifier types
 * lives in `protocol-map.ts`).
 */

import type { ClassifierContext, ClassifierResult } from '@earendil-works/pi-ai';

// ─── Errors ────────────────────────────────────────────────────────────────

/** Raised for misconfiguration the user must correct (bad ref syntax, llm: placeholder, unknown model). */
export class JudgeError extends Error {
  readonly code: 'unsupported' | 'invalid-ref' | 'unknown-model' | 'not-classifier';

  constructor(code: JudgeError['code'], message: string) {
    super(message);
    this.name = 'JudgeError';
    this.code = code;
  }
}

// ─── Modes ─────────────────────────────────────────────────────────────────

/** Decision-point mode: `active` applies, `shadow` questions and records only, `off` never asks. */
export type JudgeMode = 'active' | 'shadow' | 'off';

/** mu rule: every decision point starts in shadow — record, don't change behavior. */
export const DEFAULT_JUDGE_MODE: JudgeMode = 'shadow';

export type JudgmentSource = 'judge' | 'fallback';

/** Why a verdict fell back. Ledgered for every shadow/active line (never written for `off`). */
export type FallbackReason =
  /** off-mode: no call was made. */
  | 'mode-off'
  /** Circuit breaker open for this decision point. */
  | 'circuit-open'
  /** Every chain ref lacked a provider key (or the required provider env). */
  | 'no-key'
  /** Ref syntax not supported yet (e.g. the phase-3 `llm:` adapter). */
  | 'unsupported-ref'
  /** Model ref could not be resolved to a classifier model. */
  | 'unknown-model'
  /** Model returned answers that failed fail-closed validation (service itself healthy). */
  | 'parse-rejected'
  /** Judge call failed (network/provisionable error — feeds the circuit breaker). */
  | 'unavailable'
  /** Call aborted by the caller. */
  | 'aborted'
  /** Answer(s) landed in the calibrated gray zone and the cascade chain was exhausted. */
  | 'gray-zone';

// ─── Question builders (system-one choice/noul/score semantics) ────────────

export interface ChoiceQ {
  type: 'choice';
  instructions: string;
  /** `null` = self-explanatory label. Escape hatches (`other`/`none`) must carry a description. */
  criteria: Record<string, string | null>;
}

export interface NoulQ {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface ScoreQ {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export type JudgeQuestion = ChoiceQ | NoulQ | ScoreQ;

export const choice = (instructions: string, criteria: Record<string, string | null>): ChoiceQ => ({
  type: 'choice',
  instructions,
  criteria,
});
export const noul = (instructions: string, criteria?: { true: string; false: string }): NoulQ => ({
  type: 'noul',
  instructions,
  ...(criteria ? { criteria } : {}),
});
export const score = (instructions: string, criteria: string[]): ScoreQ => ({
  type: 'score',
  instructions,
  criteria,
});

// ─── Answers / verdicts ────────────────────────────────────────────────────

/**
 * A bounded answer with a calibrated probability.
 * `noul` probability IS the uncertainty (0.5 = maximally unsure) — no
 * confidence field; `choice`/`score` carry confidence.
 */
export type JudgeAnswer =
  | { type: 'noul'; probability: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; confidence: number };

export type JudgeAnswerMap = Record<string, JudgeAnswer>;

/** One judged decision for `pointId`. Returned by `JudgeEngine.decide/decideMany` — these never reject. */
export interface Verdict {
  pointId: string;
  /** spec.id + version (e.g. "tool.admission@v1") so ledger stats can track wording evolution. */
  decisionId: string;
  /** Validated judge answers; `{}` when the call fell back. */
  answers: JudgeAnswerMap;
  /** Winning judge (e.g. "opencode/jev-1.13") or "" when unanswered. */
  judgeId: string;
  source: JudgmentSource;
  fallbackReason?: FallbackReason;
  latencyMs: number;
  usage?: { input: number; output: number };
  /** Effective mode — hook points read this, not their own config. */
  mode: JudgeMode;
  /**
   * Behavior decision: `spec.policy(...)` in active mode, `spec.fallback`
   * otherwise (shadow/off/unanswered). Hook points MUST apply only this
   * field; `answers` are for the ledger and shadow audits.
   */
  outcome: DecisionOutcome;
}

// ─── Decision specs ───────────────────────────────────────────────────────

/** Input for one decide() call: minimal sanitized state plus an optional subset of question ids. */
export interface DecisionInput {
  /** buildState product — minimized, secrets stripped (plan §7.4). */
  state: unknown;
  questionIds?: string[];
  /** Session id for the ledger file path; defaults to "unknown" when omitted. */
  sessionId?: string;
}

/** Context handed to `spec.policy`. Individual decision points extend it via generics in phase 1. */
export interface PolicyContext {
  mode: JudgeMode;
  input: DecisionInput;
}

/** What a decision point changes. Bounded set — new actions are added per decision point, not invented per call. */
export type DecisionOutcome =
  | { action: 'keep-all' }
  | { action: 'keep'; ids: string[] }
  | { action: 'discard' }
  | { action: 'replace'; find: string; replacement: string }
  | { action: 'none' }
  | { action: 'proceed' }
  | { action: 'ask' }
  | { action: 'route'; choice: string };

/**
 * A decision point: its questions, an applied policy (active mode only) and
 * the safe fallback used whenever there is no judgment (fail open to the
 * pre-judge behavior — plan §5 lifecycle rule 2).
 */
export interface DecisionSpec<
  TQuestions extends Record<string, JudgeQuestion> = Record<string, JudgeQuestion>,
> {
  id: string;
  /** Bump when wording/policy semantics change; the ledger keys on (id, version). */
  version: number;
  questions: TQuestions;
  /** Build the minimal state for this point from the caller-provided input. */
  buildState?: (input: DecisionInput) => unknown;
  /** Applied only in active mode; the result goes into `Verdict.outcome`. */
  policy?: (answers: JudgeAnswerMap, ctx: PolicyContext) => DecisionOutcome;
  /** No-verdict behavior — must equal the pre-judge behavior exactly. */
  fallback: DecisionOutcome;
}

/** Type-preserving identity — documents that a literal is a full DecisionSpec. */
export const defineDecision = <TQuestions extends Record<string, JudgeQuestion>>(
  spec: DecisionSpec<TQuestions>,
): DecisionSpec<TQuestions> => spec;

// ─── Judge chain (resolver output) ────────────────────────────────────────

/**
 * One candidate judge. `classify` maps to pi-mono `Models.classify` and, like
 * it, resolves with `stopReason: "error"` results — implementations must not
 * reject for request-level failures.
 */
export interface JudgeTier {
  /** e.g. "opencode/jev-1.13". */
  judgeId: string;
  classify(
    context: ClassifierContext,
    opts: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ClassifierResult>;
}

/** The resolved cascade for one decision point. Empty `tiers` = nothing usable. */
export interface ResolvedJudgeChain {
  tiers: JudgeTier[];
  /** Chain refs dropped because the provider had no key; reported once per startup. */
  noKeyRefs: string[];
  /** Chain refs that could not be parsed/resolved at all. */
  unresolvableRefs: string[];
}

/** Engine-facing resolver: pointId → ordered cascade. Injected (the mock in tests is just a stub of this). */
export type JudgeModelResolver = (pointId: string) => ResolvedJudgeChain;

// ─── Config section (schema lives in src/app/config.ts; shape mirrored here) ──

export interface JudgeEntryConfig {
  type: 'typesafe' | 'http';
  baseUrl?: string;
  /** Environment variable NAME that holds the key; inline keys are rejected at load. */
  apiKeyEnv?: string;
}

/** The `judge:` section of config.yaml — the only source of truth (plan §8.1). */
export interface JudgeSectionConfig {
  enabled: boolean;
  /** Explicit primary judge provider — no implicit env-detection chain. */
  provider?: string;
  /** Model ref within `provider` (e.g. "jev-1.13"). */
  modelRef?: string;
  /** Explicit cascade chain members, ref-syntax strings. Empty/absent = no cascade. */
  fallbackTiers?: string[];
  /** Per-point override: replaces the whole chain for that point. */
  routes?: Record<string, string[]>;
  /** modes[pointId] ?? modes.default; unset → DEFAULT_JUDGE_MODE (shadow). */
  modes: Record<string, JudgeMode>;
  /** Custom judges (phase-M5); keys stay out of the config file via apiKeyEnv. */
  judges?: Record<string, JudgeEntryConfig>;
  features: {
    testLogFold: 'off' | 'rules' | 'jev';
    admission: {
      chunkSizeChars: number;
      keepThreshold: number;
    };
  };
  timeoutMs: number;
  /** Persist the judged state into ledger lines (contains user content — default off). */
  recordState: boolean;
}
