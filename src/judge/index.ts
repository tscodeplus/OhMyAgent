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
export { currentJudgeEngine, setJudgeEngineResolver } from './engine-lookup.js';
export {
  MEMORY_CAPTURE_POINT_ID,
  MEMORY_CAPTURE_THRESHOLD,
  createMemoryCaptureSpec,
  memoryCaptureSpec,
  type MemoryCaptureMessage,
  type MemoryCaptureState,
} from './decisions/memory-capture.js';
export {
  MEMORY_WORTH_POINT_ID,
  WORTH_USEFUL_AGAIN,
  WORTH_ONE_OFF,
  WORTH_ALREADY_KNOWN,
  createMemoryWorthSpec,
  memoryWorthSpec,
  type MemoryWorthCandidate,
} from './decisions/memory-worth.js';
export {
  MEMORY_MERGE_POINT_ID,
  judgeMemoryMergeRelation,
  memoryMergeSpec,
  type MemoryMergeRelation,
  type JudgeMemoryMergeResult,
} from './decisions/memory-merge.js';
export {
  CONTEXT_FORGET_POINT_ID,
  forgetTombstoneLine,
  createContextForgetSpec,
  contextForgetSpec,
  MIN_CANDIDATE_TOKENS,
  MAX_CANDIDATES_PER_CALL,
  type ForgetCandidate,
} from './decisions/context-forget.js';
export { judgeContextForget, type JudgeContextForgetResult } from './hooks/context-forget.js';
export {
  CONTEXT_COMPACT_POINT_ID,
  segmentCompressibleMessages,
  createContextCompactSpec,
  contextCompactSpec,
  COMPACT_DROP_PROBABILITY,
  type CompactSegment,
} from './decisions/context-compact.js';
export {
  judgeContextCompactPrune,
  type JudgeContextCompactResult,
} from './hooks/context-compact.js';
export {
  TURN_DRIFT_POINT_ID,
  judgeTurnDrift,
  resetTurnDrift,
  clearTurnDrift,
  noteToolCallForDrift,
  turnDriftSpec,
  DRIFT_CHECK_EVERY_TOOL_CALLS,
  DRIFT_PROBABILITY,
  type DriftStep,
} from './decisions/turn-drift.js';
export {
  TURN_COMPLETION_POINT_ID,
  judgeTurnCompletion,
  turnCompletionSpec,
  lastAssistantTextOf,
  NO_VERIFICATION_PROBABILITY,
} from './decisions/turn-completion.js';
export {
  TOOL_RISK_POINT_ID,
  judgeToolRisk,
  toolRiskSpec,
  NOT_ASKED_PROBABILITY,
} from './decisions/tool-risk.js';
export {
  INJECTION_SCREEN_POINT_ID,
  screenToolResultText,
  splitScreenParagraphs,
  applyScreenOutcome,
  applyStaticScreen,
  injectionNoteLine,
  matchesStaticInjectionPattern,
  isExternalContentTool,
  INJECTION_PROBABILITY,
  SCREEN_PARAGRAPH_MAX,
  type ScreenParagraph,
} from './decisions/injection-screen.js';
export {
  CHANNEL_TRIAGE_POINT_ID,
  judgeChannelGroupTriage,
  channelTriageSpec,
  TRIAGE_ADDRESSED_PROBABILITY,
  TRIAGE_NOT_ADDRESSED_PROBABILITY,
  TRIAGE_LATENCY_BUDGET_MS,
  TRIAGE_TEXT_MAX,
  type ChannelTriageState,
  type TriageDecision,
} from './decisions/channel-triage.js';
export {
  NOTIFY_ROUTING_POINT_ID,
  judgeNotifyRoute,
  notifyRoutingSpec,
  NOTIFY_LATER_DELAY_MS,
  NOTIFY_PREVIEW_MAX,
  type NotifyRoute,
  type NotifyRoutingState,
} from './decisions/notify-routing.js';
export {
  triageGroupGateway,
  type GroupGateDecision,
  type GroupGateTriageInput,
} from './hooks/channel-triage.js';
export {
  judgeProactiveNotifyRoute,
  type ProactiveNotifyRouteInput,
} from './hooks/notify-routing.js';
export { maybeTightenShellApproval, type TightenToolRiskInput } from './hooks/safety-tool-risk.js';
export {
  screenExternalToolResult,
  type ScreenExternalToolResultInput,
} from './hooks/safety-injection-screen.js';
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
