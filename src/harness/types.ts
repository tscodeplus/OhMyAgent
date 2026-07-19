// ---------------------------------------------------------------------------
// Self-Harness System — Core Type Definitions
// ---------------------------------------------------------------------------
// All types are pure declarations: no runtime code, classes, or functions.
// ---------------------------------------------------------------------------

/**
 * Categorisation of recurring failure patterns observed during agent execution.
 */
export type FailurePattern =
  | 'identical_retry_loop'
  | 'exploration_without_output'
  | 'tool_error_cascade'
  | 'dependency_not_checked'
  | 'user_explicit_dissatisfied'
  | 'timeout_or_abort';

/**
 * A single tool invocation recorded during a session.
 */
export interface ToolCallRecord {
  /** The name of the tool that was called. */
  name: string;
  /** Arguments passed to the tool. */
  args: Record<string, unknown>;
  /** The result returned by the tool (or the error payload). */
  result: unknown;
  /** Whether the tool call ended in an error. */
  isError: boolean;
  /** Human-readable error message, present when isError is true. */
  errorMessage?: string;
  /** Unix-millisecond timestamp of the call. */
  timestamp: number;
}

/**
 * Aggregated context describing a single agent-session failure.
 */
export interface FailureContext {
  /** Unique identifier for the session. */
  sessionId: string;
  /** Identifier of the skill that was active, if any. */
  skillId?: string;
  /** Identifier of the agent that was running, if any. */
  agentId?: string;
  /** The user's original task message. */
  taskMessage: string;
  /** Chronological record of every tool call made in the session. */
  toolCalls: ToolCallRecord[];
  /** Flat list of errors extracted from tool calls, in occurrence order. */
  errors: Array<{ toolName: string; message: string; timestamp: number }>;
  /** Explicit user feedback, if provided. */
  userFeedback?: 'satisfied' | 'dissatisfied' | null;
  /** Total wall-clock duration of the session in milliseconds. */
  durationMs: number;
  /** Whether the session was cut short before natural completion. */
  terminatedEarly: boolean;
  /** The reason the agent stopped, as reported by the runtime. */
  agentEndReason: 'complete' | 'error' | 'aborted';
}

/**
 * A structured signal produced by a failure detector when a pattern is matched.
 */
export interface FailureSignal {
  /** Whether a failure pattern was positively detected. */
  detected: boolean;
  /** Human-readable explanation of the detection. */
  reason: string;
  /** Estimated severity of the failure. */
  severity: 'low' | 'medium' | 'high';
  /** The specific failure pattern that was matched. */
  pattern: FailurePattern;
}

/**
 * The family of mechanism an editable surface belongs to.
 */
export type MechanismFamily =
  | 'prompt_instruction'
  | 'subagent'
  | 'skill_procedure'
  | 'tool_configuration'
  | 'middleware'
  | 'runtime_control'
  | 'permission_interrupt';

/**
 * All possible kinds of editable surface that the harness can modify.
 */
export type EditableSurfaceKind =
  | 'skill_prompt'
  | 'skill_triggers'
  | 'agent_system_prompt'
  | 'agent_role_description'
  | 'base_system_prompt'
  | 'execution_instruction'
  | 'failure_recovery_instruction'
  | 'verification_instruction'
  | 'tool_description'
  | 'tool_parameter_description'
  | 'tool_defer_strategy'
  | 'skill_allowed_tools'
  | 'skill_memory_policy'
  | 'spawn_policy'
  | 'child_agent_optimizer_rules'
  | 'turn_counter_rules'
  | 'prompt_layer_priority'
  | 'tool_execution_mode'
  | 'max_retry_delay'
  | 'thinking_budget'
  | 'shell_approval_mode'
  | 'approval_policy_rule';

/**
 * Describes a single editable surface (a specific config knob or prompt segment)
 * that the harness can read and propose changes to.
 */
export interface EditableSurface {
  /** Globally unique identifier for this surface. */
  id: string;
  /** The kind of surface this represents. */
  kind: EditableSurfaceKind;
  /** Filesystem- or descriptor-style path (e.g. "skills/foo/skill.yaml:prompt"). */
  path: string;
  /** Short human-readable label. */
  label: string;
  /** The current value / content of the surface. */
  currentValue: string;
  /** Which mechanism family this surface belongs to. */
  mechanismFamily: MechanismFamily;
}

/**
 * Result of a validation pass over a proposal or change.
 */
export interface ValidationResult {
  /** Whether the proposed change passed validation. */
  valid: boolean;
  /** Human-readable error messages, empty when valid is true. */
  errors: string[];
}

/**
 * Outcome of diagnosing the root cause behind a failure signal.
 */
export interface DiagnosisResult {
  /** Concise description of the terminal cause of the failure. */
  terminal_cause: string;
  /** How directly this cause contributed to the failure. */
  criticality: 'root_cause' | 'contributor' | 'friction' | 'unknown';
  /** The agent mechanism that should be adjusted. */
  agent_mechanism: MechanismFamily;
  /** Free-text reasoning that led to this diagnosis. */
  reasoning: string;
  /** Identifier of the surface recommended for modification. */
  recommended_surface: string;
  /** Confidence score in the diagnosis, from 0 (none) to 1 (certain). */
  confidence: number;
}

/**
 * A structured diff describing a single proposed change on one surface.
 */
export interface ProposalDiff {
  /** Identifier of the surface being changed. */
  surface: string;
  /** The current value before the change. */
  before: string;
  /** The proposed new value after the change. */
  after: string;
}

/**
 * Estimated impact of applying a proposal.
 */
export interface ProposalImpact {
  /** Scope description (e.g. "session", "skill", "global"). */
  scope: string;
  /** Estimated risk level of the change. */
  riskLevel: 'none' | 'low' | 'medium';
  /** Description of the expected effect on agent behaviour. */
  expectedEffect: string;
}

/**
 * A complete improvement proposal generated by the harness optimizer.
 */
export interface ImprovementProposal {
  /** Unique identifier for the proposal. */
  id: string;
  /** Target skill identifier, or null if not skill-specific. */
  skillId: string | null;
  /** Target agent identifier, or null if not agent-specific. */
  agentId: string | null;
  /** The nature of the change being proposed. */
  type: string;
  /** Short title for the proposal. */
  title: string;
  /** One-sentence summary of the proposal. */
  summary: string;
  /** Optional longer-form detail / rationale. */
  detail?: string;
  /** The concrete before/after diff for the change. */
  diff: ProposalDiff;
  /** Impact assessment. */
  impact: ProposalImpact;
  /** Short description of the expected effect (duplicated for convenience). */
  expectedEffect: string;
  /** Short description of the regression risk if applied. */
  regressionRisk: string;
  /** Scope string describing what the change affects. */
  affectedScope: string;
  /** The mechanism family this proposal targets. */
  mechanismFamily: MechanismFamily;
  /** Confidence score (0–1) that this proposal will help. */
  confidence: number;
  /** Unix-millisecond timestamp of proposal creation. */
  createdAt: number;
}

/**
 * Result of attempting to apply a proposal to the live config or skill file.
 */
export interface ApplyResult {
  /** Whether the change was applied successfully. */
  success: boolean;
  /** Git commit hash of the applied change, if applicable. */
  commitHash?: string;
  /** Error message if the apply failed. */
  error?: string;
}

/**
 * An interactive action the user can take in response to a harness prompt.
 */
export interface InteractionAction {
  /** Stable identifier for the action. */
  id: string;
  /** Button label shown to the user. */
  label: string;
  /** Visual style of the action button. */
  style: 'primary' | 'default' | 'danger';
  /** Optional text-input field attached to this action. */
  inputField?: {
    /** Placeholder text for the input. */
    placeholder: string;
    /** Whether the input supports multiple lines. */
    multiline: boolean;
    /** Optional default value pre-filled in the input. */
    defaultValue?: string;
  };
}

/**
 * A rich prompt object sent to the UI when the harness wants to propose
 * an improvement and optionally collect user interaction.
 */
export interface HarnessImprovementPrompt {
  /** Unique identifier for this prompt. */
  id: string;
  /** Discriminant literal for the prompt type. */
  type: 'harness_improvement';
  /** Brief title displayed as the prompt header. */
  title: string;
  /** Concise summary of the failure that triggered this prompt. */
  failureSummary: string;
  /** Longer narrative detail about the proposed improvement. */
  detail: string;
  /** The before/after diff for the proposed change. */
  diff: { surface: string; before: string; after: string };
  /** Impact summary for the proposed change. */
  impact: { scope: string; riskLevel: string; expectedEffect: string };
  /** Interactive actions the user may take. */
  actions: InteractionAction[];
}

/**
 * Possible outcomes when a user (or timeout) decides on an approval request.
 */
export type ApprovalDecision = 'approve' | 'edit' | 'reject' | 'timeout';

/**
 * How strictly the harness enforces approval for a matching rule.
 */
export type ApprovalAction = 'require_approval' | 'auto_apply' | 'skip';

/**
 * Categories of change that the harness can make to an editable surface.
 */
export type ChangeType =
  | 'prompt_text'
  | 'prompt_structure'
  | 'trigger_add'
  | 'trigger_remove'
  | 'tool_allow_add'
  | 'tool_allow_remove'
  | 'tool_desc_edit'
  | 'execution_policy'
  | 'approval_policy'
  | 'numeric_threshold'
  | 'spawn_policy_edit'
  | 'memory_policy_edit';

/**
 * Auto-rollback configuration for an approval rule.
 */
export interface AutoRollbackConfig {
  /** Minimum satisfaction score (0–1) that must be maintained. */
  satisfactionThreshold: number;
  /** Number of recent sessions to observe for rollback decisions. */
  observationWindow: number;
  /** Error-rate multiplier relative to baseline that triggers rollback. */
  errorRateMultiplier: number;
}

/**
 * A time-of-day window for scheduling rule activation.
 */
export interface TimeRange {
  /** Start time in HH:MM format (24-hour). */
  start: string;
  /** End time in HH:MM format (24-hour). */
  end: string;
}

/**
 * A single approval rule governing when harness changes require human approval.
 */
export interface ApprovalRule {
  /** Unique identifier for the rule. */
  id: string;
  /** Human-readable name for the rule. */
  name: string;
  /** Priority order (higher = evaluated first). */
  priority: number;
  /** Whether this rule is currently active. */
  enabled: boolean;
  /** Optional: filter by skill identifiers. */
  skillIds?: string[];
  /** Optional: filter by skill tags. */
  skillTags?: string[];
  /** Optional: filter by agent identifiers. */
  agentIds?: string[];
  /** Optional: filter by surface identifiers. */
  surfaceIds?: string[];
  /** Optional: filter by mechanism families. */
  mechanismFamilies?: MechanismFamily[];
  /** Optional: filter by change types. */
  changeTypes?: ChangeType[];
  /** Optional: filter by risk levels. */
  riskLevels?: Array<'none' | 'low' | 'medium'>;
  /** Optional: filter by failure patterns. */
  failurePatterns?: FailurePattern[];
  /** Optional: minimum confidence threshold (0–1). */
  minConfidence?: number;
  /** Optional: time-of-day windows for activation. */
  timeRanges?: TimeRange[];
  /** Optional: scope string patterns to match. */
  scopes?: string[];
  /** The action to take when this rule matches. */
  action: ApprovalAction;
  /** Auto-rollback settings (only relevant when action is auto_apply). */
  autoRollback?: AutoRollbackConfig;
}

// ---------------------------------------------------------------------------
// Config interfaces (section 8.1)
// ---------------------------------------------------------------------------

/**
 * Configuration for what triggers the harness to analyse a session.
 */
export interface HarnessTriggerConfig {
  /** Minimum number of identical failed commands to trigger identical_retry_loop. */
  minIdenticalRetries: number;
  /** Minimum consecutive exploration steps without output to trigger. */
  minExplorationSteps: number;
  /** Minimum consecutive tool errors to trigger tool_error_cascade. */
  minConsecutiveErrors: number;
}

/**
 * Rate-limiting configuration to prevent the harness from running too often.
 */
export interface HarnessRateLimitConfig {
  /** Cooldown in milliseconds between successive triggers of the same pattern. */
  cooldownMs: number;
  /** Maximum number of triggers per hour (also used as daily limit). */
  maxAnalyses: number;
  /** Maximum number of auto-applied proposals per day. */
  maxAutoApplyAnalyses: number;
}

/**
 * Channel configuration for which channels receive harness prompts.
 */
export interface HarnessChannelsConfig {
  webui: boolean;
  feishu: boolean;
  telegram: boolean;
  wechat: boolean;
  qq: boolean;
}

/**
 * Proposal generation configuration.
 */
export interface HarnessProposalConfig {
  /** Model to use for proposal generation (provider/model-id format). */
  model: string;
  /** Maximum number of edits per proposal. */
  maxEditsPerProposal: number;
  /** Minimum confidence threshold (0-1) for a proposal to be emitted. */
  minConfidence: number;
  /** Mechanism families the optimizer is allowed to touch. */
  allowedMechanisms: MechanismFamily[];
}

/**
 * Configuration for interactive user-facing prompts from the harness.
 */
export interface HarnessInteractiveConfig {
  /** Whether interactive mode is enabled. */
  enabled: boolean;
}

/**
 * Top-level configuration for the Self-Harness system.
 */
export interface HarnessConfig {
  /** Whether the entire harness system is enabled. */
  enabled: boolean;
  /** Trigger configuration. */
  trigger: HarnessTriggerConfig;
  /** Rate-limiting configuration. */
  rateLimit: HarnessRateLimitConfig;
  /** Channel delivery configuration. */
  channels: HarnessChannelsConfig;
  /** Proposal generation configuration. */
  proposal: HarnessProposalConfig;
  /** Interactive prompt configuration. */
  interactive: HarnessInteractiveConfig;
  /** Ordered list of approval rules. */
  approvalRules: ApprovalRule[];
}

// ---------------------------------------------------------------------------
// Service registry
// ---------------------------------------------------------------------------

/**
 * Container for all harness subsystem service references.
 * Each slot is typed as `unknown` and should be cast at the consumption site.
 */
export interface HarnessServices {
  /** Failure detection service. */
  failureDetector: unknown;
  /** Rate-limiter service. */
  rateLimiter: unknown;
  /** Proposal optimizer service. */
  optimizer: unknown;
  /** Editable-surface registry / provider. */
  surfaceProvider: unknown;
  /** Approval-policy evaluator. */
  approvalPolicy: unknown;
  /** Auto-apply monitor / rollback service. */
  autoApplyMonitor: unknown;
  /** Skill-file editor service. */
  skillEditor: unknown;
}
