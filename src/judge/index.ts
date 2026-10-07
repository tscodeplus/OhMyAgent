/**
 * Public surface of the judge kernel (`src/judge/`).
 *
 * Consumers: hook points call `JudgeEngine.decide()` / `decideMany()` and must
 * apply only `Verdict.outcome`; bootstrap wires the engine via
 * `AppServices.judge`; WebUI routes read the ledger/breaker surfaces.
 */

export { JudgeEngine, type JudgeEngineOptions } from './engine.js';
export {
  JudgeCircuitBreaker,
  type JudgeBreakerState,
  type JudgeCircuitState,
  type JudgeCircuitBreakerConfig,
} from './circuit-breaker.js';
export { JudgeLedger, type LedgerRecord, type JudgeLedgerOptions } from './ledger.js';
export {
  JudgeResolver,
  getJudgeModels,
  resetJudgeModels,
  parseJudgeRef,
  judgeIdOf,
  JUDGE_PROVIDER_ENV_KEYS,
  type JudgeResolverOptions,
  type ParsedJudgeRef,
} from './judge-resolver.js';
export {
  FreeJevMonitor,
  isFreeJevJudgeId,
  FREE_JEV_MODEL_ID,
  type FreeJevOutcome,
} from './free-jev.js';
export { goldenSampleSpec, GOLDEN_POINT_ID, GOLDEN_SAMPLE_STATE } from './golden-sample.js';
export {
  DECISION_POINTS,
  DECISION_POINT_IDS,
  DECISION_SPECS,
  decisionSpecFor,
  type DecisionPointInfo,
} from './decisions/registry.js';
export {
  foldTestLogBlocks,
  foldMarkerLine,
  type FoldResult,
  type FoldStats,
} from './testlog-fold.js';
export {
  TOOL_ADMISSION_POINT_ID,
  chunkToolOutputText,
  admissionPointerLine,
  type ToolAdmissionChunk,
  type ToolAdmissionState,
} from './decisions/tool-admission.js';
export {
  INTENT_CLASSIFY_POINT_ID,
  judgeIntentAtTurnStart,
  type JudgeIntentAtTurnStartResult,
} from './decisions/intent-classify.js';
export {
  SKILLS_DISCLOSURE_POINT_ID,
  judgeSkillsDisclosure,
  type JudgeSkillsDisclosureResult,
} from './decisions/skills-disclosure.js';
export { admitToolResult, type AdmitToolResultInput } from './admission/admission-hook.js';
export {
  toClassifierQuestion,
  toClassifierQuestions,
  toJudgeAnswer,
  isGrayAnswer,
  validateAnswers,
} from './protocol-map.js';
export { JudgeError, choice, noul, score, defineDecision, DEFAULT_JUDGE_MODE } from './types.js';
export type {
  JudgeMode,
  JudgmentSource,
  FallbackReason,
  ChoiceQ,
  NoulQ,
  ScoreQ,
  JudgeQuestion,
  JudgeAnswer,
  JudgeAnswerMap,
  Verdict,
  DecisionInput,
  PolicyContext,
  DecisionOutcome,
  DecisionSpec,
  JudgeTier,
  ResolvedJudgeChain,
  JudgeModelResolver,
  JudgeEntryConfig,
  JudgeSectionConfig,
} from './types.js';
