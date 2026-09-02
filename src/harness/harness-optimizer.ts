import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  FailureContext,
  ImprovementProposal,
  DiagnosisResult,
  EditableSurface,
  HarnessProposalConfig,
  MechanismFamily,
  ChangeType,
  EditableSurfaceKind,
  ProposalDiff,
  ProposalImpact,
} from './types.js';
import { EditableSurfaceProvider } from './editable-surfaces.js';
import { generateId } from '../shared/ids.js';
import pino from 'pino';

const logger = pino();

const DEFAULT_MEMORY_PATH = 'data/harness-proposal-memory.json';

/**
 * Configuration passed to the LLM describing available editable surfaces.
 */
interface SurfaceDescriptor {
  id: string;
  kind: string;
  label: string;
  currentValue: string;
  mechanismFamily: string;
}

/**
 * Core LLM-based diagnosis and proposal engine for the self-harness system.
 *
 * Analyses tool-call traces to identify root causes of agent failures and
 * generates minimal, targeted improvement proposals for editable surfaces.
 *
 * The LLM caller is injectable via constructor for easy testing with mocks.
 */
export class HarnessOptimizer {
  private config: HarnessProposalConfig;
  private readonly surfaceProvider: EditableSurfaceProvider;
  private llmCaller: (systemPrompt: string, userMessage: string, model?: string) => Promise<string>;
  /** Dedup memory of already-proposed changes (persisted across restarts) so
   *  the same failure pattern does not produce repeat proposals / commits. */
  private readonly remembered = new Set<string>();
  private readonly memoryPath: string;

  constructor(
    config: HarnessProposalConfig,
    surfaceProvider: EditableSurfaceProvider,
    llmCaller: (systemPrompt: string, userMessage: string, model?: string) => Promise<string>,
    memoryPath: string = DEFAULT_MEMORY_PATH,
  ) {
    this.config = config;
    this.surfaceProvider = surfaceProvider;
    this.llmCaller = llmCaller;
    this.memoryPath = memoryPath;
    this.loadMemory();
  }

  /** Restore the dedup memory persisted by a previous process (best-effort:
   *  a missing or corrupt file simply starts with an empty set). */
  private loadMemory(): void {
    let raw: string;
    try {
      raw = readFileSync(this.memoryPath, 'utf-8');
    } catch {
      return; // no memory file yet — first run
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const key of parsed) {
          if (typeof key === 'string') this.remembered.add(key);
        }
      }
      logger.info(
        { restored: this.remembered.size },
        '[HarnessOptimizer] proposal memory restored',
      );
    } catch (err) {
      logger.warn({ err }, '[HarnessOptimizer] failed to parse proposal memory file');
    }
  }

  /** Persist the dedup memory (fire-and-forget; failures are logged only). */
  private async persistMemory(): Promise<void> {
    try {
      await mkdir(dirname(this.memoryPath), { recursive: true });
      await writeFile(
        this.memoryPath,
        JSON.stringify(Array.from(this.remembered), null, 2),
        'utf-8',
      );
    } catch (err) {
      logger.error({ err }, '[HarnessOptimizer] failed to persist proposal memory');
    }
  }

  /** Fingerprint of a generated proposal — used to reject repeat proposals
   *  for the same failure pattern on the same surface. */
  private dedupKey(context: FailureContext, proposal: ImprovementProposal): string {
    const beforeHash = createHash('sha256').update(proposal.diff.before).digest('hex').slice(0, 12);
    return `${context.skillId ?? '_'}:${proposal.type}:${proposal.diff.surface}:${beforeHash}`;
  }

  /**
   * Replace the LLM caller after construction.
   *
   * The factory creates a placeholder that throws; the agent system must
   * inject a real LLM caller before the optimizer is exercised.
   */
  setLlmCaller(
    caller: (systemPrompt: string, userMessage: string, model?: string) => Promise<string>,
  ): void {
    this.llmCaller = caller;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Full optimization pipeline: diagnose failure, then propose a fix.
   *
   * 1. Identifies relevant surfaces from the failure context.
   * 2. Runs LLM-based diagnosis of the root cause.
   * 3. Skips transient failures (e.g. friction) without generating a proposal.
   * 4. Generates a proposal tuned to the diagnosis.
   * 5. Returns the proposal or null if nothing actionable was found.
   */
  async optimize(context: FailureContext): Promise<ImprovementProposal | null> {
    // Step 1: identify relevant editable surfaces
    const surfaces = this.surfaceProvider.identifyRelevantSurfaces(context);

    if (surfaces.length === 0) {
      return null;
    }

    // Step 2: diagnose the failure
    const diagnosis = await this.diagnose(context, surfaces);

    if (diagnosis === null) {
      return null;
    }

    // Step 3: filter out transient failures
    if (this.isTransient(diagnosis)) {
      return null;
    }

    // Step 4: check confidence threshold
    if (diagnosis.confidence < this.config.minConfidence) {
      return null;
    }

    // Step 5: generate a proposal
    const proposal = await this.propose(context, diagnosis, surfaces);

    if (proposal === null) {
      return null;
    }

    // Final confidence gate on the proposal itself
    if (proposal.confidence < this.config.minConfidence) {
      return null;
    }

    // Step 6: dedup memory — a proposal already emitted for this failure
    // pattern / surface is not proposed again.
    const key = this.dedupKey(context, proposal);
    if (this.remembered.has(key)) {
      return null;
    }
    this.remembered.add(key);
    void this.persistMemory();

    return proposal;
  }

  // ---------------------------------------------------------------------------
  // Diagnosis
  // ---------------------------------------------------------------------------

  /**
   * Uses the LLM to analyse the tool-call trace and identify the root cause
   * of a failure.
   */
  private async diagnose(
    context: FailureContext,
    surfaces: EditableSurface[],
  ): Promise<DiagnosisResult | null> {
    const surfaceDescriptors: SurfaceDescriptor[] = surfaces.map((s) => ({
      id: s.id,
      kind: s.kind,
      label: s.label,
      currentValue: s.currentValue,
      mechanismFamily: s.mechanismFamily,
    }));

    const toolCallSummary = context.toolCalls
      .map((tc) => {
        const status = tc.isError ? `ERROR: ${tc.errorMessage ?? 'unknown'}` : 'OK';
        return `  - ${tc.name}(${JSON.stringify(tc.args)}) -> ${status}`;
      })
      .join('\n');

    const systemPrompt = [
      'You are a diagnosis engine for an AI agent harness. Your task is to analyse',
      'a tool-call trace and identify the root cause of a failure.',
      '',
      'Analyse the tool-call trace below and determine the terminal cause of the failure.',
      'Respond with a JSON object only (no markdown fences, no commentary).',
      '',
      'The JSON object must have exactly these fields:',
      '  - "terminal_cause": string — concise description of the root cause',
      '  - "criticality": "root_cause" | "contributor" | "friction" | "unknown"',
      '  - "agent_mechanism": one of the mechanism families listed below',
      '  - "reasoning": string — step-by-step reasoning leading to the diagnosis',
      '  - "recommended_surface": surface id from the available list',
      '  - "confidence": number between 0 and 1',
      '',
      'Valid mechanism families:',
      '  prompt_instruction, subagent, skill_procedure, tool_configuration,',
      '  middleware, runtime_control, permission_interrupt',
      '',
      'Available editable surfaces:',
      JSON.stringify(surfaceDescriptors, null, 2),
    ].join('\n');

    // Historical skill statistics (when available) give the diagnosis LLM
    // context beyond the single failing session. Rendered before the Errors
    // section so per-session errors remain the focus.
    const statsBlock = context.skillStats
      ? [
          'Skill historical stats:',
          `  Activations: ${context.skillStats.totalActivations}`,
          `  Success rate: ${
            context.skillStats.successRate === null
              ? 'unknown'
              : `${(context.skillStats.successRate * 100).toFixed(0)}%`
          }`,
          `  Avg duration: ${
            context.skillStats.avgDurationMs === null
              ? 'unknown'
              : `${context.skillStats.avgDurationMs}ms`
          }`,
          `  Top tools: ${
            context.skillStats.topTools.length > 0
              ? context.skillStats.topTools.map((t) => `${t.name} (${t.count})`).join(', ')
              : 'none'
          }`,
          '',
        ]
      : [];

    const userMessage = [
      'Session:',
      `  Task: ${context.taskMessage}`,
      `  Skill ID: ${context.skillId ?? 'none'}`,
      `  Agent ID: ${context.agentId ?? 'default'}`,
      `  Duration: ${context.durationMs}ms`,
      `  Terminated early: ${context.terminatedEarly}`,
      `  Agent end reason: ${context.agentEndReason}`,
      `  User feedback: ${context.userFeedback ?? 'none'}`,
      '',
      'Tool calls:',
      toolCallSummary,
      '',
      ...statsBlock,
      `Errors (${context.errors.length}):`,
      ...context.errors.map((e) => `  - ${e.toolName}: ${e.message}`),
    ].join('\n');

    let raw: string;
    try {
      raw = await this.callLLM(systemPrompt, userMessage);
    } catch (err) {
      logger.warn(
        { err, sessionId: context.sessionId },
        'HarnessOptimizer: diagnosis LLM call failed',
      );
      return null;
    }

    return this.parseDiagnosis(raw);
  }

  // ---------------------------------------------------------------------------
  // Proposal generation
  // ---------------------------------------------------------------------------

  /**
   * Uses the LLM to generate a minimal edit proposal that fixes the diagnosed
   * issue.
   */
  private async propose(
    context: FailureContext,
    diagnosis: DiagnosisResult,
    surfaces: EditableSurface[],
  ): Promise<ImprovementProposal | null> {
    const targetSurface = surfaces.find((s) => s.id === diagnosis.recommended_surface);
    if (!targetSurface) {
      return null;
    }

    // Filter surfaces by the allowed mechanism families from config
    const allowedMechanisms = this.config.allowedMechanisms;

    // Check whether the target surface's mechanism family is allowed
    if (allowedMechanisms.length > 0 && !allowedMechanisms.includes(diagnosis.agent_mechanism)) {
      return null;
    }

    const systemPrompt = [
      'You are a proposal engine for an AI agent harness. Your task is to generate',
      'a minimal, targeted edit that fixes a diagnosed issue.',
      '',
      'Given the diagnosis and target surface below, propose a minimal edit (3–5 lines)',
      'that addresses the root cause. Prefer surgical changes over broad rewrites.',
      '',
      'Respond with a JSON object only (no markdown fences, no commentary).',
      '',
      'The JSON object must have exactly these fields:',
      '  - "title": string — short title for the change',
      '  - "summary": string — one-sentence summary',
      '  - "before": string — the current value (excerpt) being replaced',
      '  - "after": string — the proposed replacement value',
      '  - "expected_effect": string — what the change should improve',
      '  - "regression_risk": "none" | "low" | "medium" — risk of breaking other behaviour',
      '  - "confidence": number between 0 and 1',
      '  - "mechanism_family": string — the mechanism family being changed',
      '  - "change_type": one of the allowed change types listed below',
      '  - "affected_scope": "single_skill" | "multi_skill" | "global" | "session"',
      '',
      'Allowed change types:',
      '  prompt_text, prompt_structure, trigger_add, trigger_remove, tool_allow_add,',
      '  tool_allow_remove, tool_desc_edit, execution_policy, approval_policy,',
      '  numeric_threshold, spawn_policy_edit, memory_policy_edit',
      '',
      'Constraints:',
      '  - Do NOT propose changes outside these allowed mechanism families:',
      `    ${allowedMechanisms.length > 0 ? allowedMechanisms.join(', ') : 'all'}`,
      '  - Keep the edit minimal — change only what is necessary',
      '  - The "before" value must be a substring found in the current surface value',
      '  - "affected_scope" must be exactly one of the four enum values (use "single_skill" when only one skill is affected)',
    ].join('\n');

    const userMessage = [
      'Diagnosis:',
      `  Terminal cause: ${diagnosis.terminal_cause}`,
      `  Criticality: ${diagnosis.criticality}`,
      `  Recommended surface: ${diagnosis.recommended_surface}`,
      `  Agent mechanism: ${diagnosis.agent_mechanism}`,
      `  Reasoning: ${diagnosis.reasoning}`,
      '',
      'Target surface:',
      `  ID: ${targetSurface.id}`,
      `  Kind: ${targetSurface.kind}`,
      `  Label: ${targetSurface.label}`,
      `  Path: ${targetSurface.path}`,
      `  Mechanism family: ${targetSurface.mechanismFamily}`,
      `  Current value:`,
      targetSurface.currentValue,
    ].join('\n');

    let raw: string;
    try {
      raw = await this.callLLM(systemPrompt, userMessage);
    } catch (err) {
      logger.warn(
        { err, sessionId: context.sessionId },
        'HarnessOptimizer: proposal LLM call failed',
      );
      return null;
    }

    return this.parseProposal(raw, diagnosis, targetSurface);
  }

  // ---------------------------------------------------------------------------
  // Transient detection
  // ---------------------------------------------------------------------------

  /**
   * Returns true when the diagnosis indicates a transient issue (friction)
   * that does not warrant a proposal.
   */
  isTransient(diagnosis: DiagnosisResult): boolean {
    return diagnosis.criticality === 'friction';
  }

  // ---------------------------------------------------------------------------
  // ID generation
  // ---------------------------------------------------------------------------

  /**
   * Generates a unique proposal ID (prefixed; underlying id from shared/ids).
   */
  private generateId(): string {
    return 'prop-' + generateId();
  }

  // ---------------------------------------------------------------------------
  // LLM caller
  // ---------------------------------------------------------------------------

  /**
   * Delegates to the injected LLM caller.
   * In production this would call pi-mono's streamSimple or a configured provider;
   * in tests a mock function is passed via the constructor.
   */
  private async callLLM(systemPrompt: string, userMessage: string): Promise<string> {
    // Resolve the model to use: empty or 'default' → undefined (caller uses system default)
    const configuredModel = this.config.model;
    const model = !configuredModel || configuredModel === 'default' ? undefined : configuredModel;
    return this.llmCaller(systemPrompt, userMessage, model);
  }

  // ---------------------------------------------------------------------------
  // Response parsing
  // ---------------------------------------------------------------------------

  /**
   * Attempts to parse the LLM response into a DiagnosisResult.
   * Returns null if parsing fails or confidence is below 0.6.
   */
  private parseDiagnosis(raw: string): DiagnosisResult | null {
    try {
      // Strip any markdown code fences the LLM might include
      const cleaned = this.stripCodeFences(raw);
      const parsed = JSON.parse(cleaned);

      const diagnosis: DiagnosisResult = {
        terminal_cause: String(parsed.terminal_cause ?? ''),
        criticality: this.validateCriticality(parsed.criticality),
        agent_mechanism: this.validateMechanismFamily(parsed.agent_mechanism),
        reasoning: String(parsed.reasoning ?? ''),
        recommended_surface: String(parsed.recommended_surface ?? ''),
        confidence: Number(parsed.confidence ?? 0),
      };

      if (diagnosis.confidence < this.config.minConfidence) {
        return null;
      }

      return diagnosis;
    } catch {
      return null;
    }
  }

  /**
   * Attempts to parse the LLM response into an ImprovementProposal.
   * Returns null if parsing fails or confidence is below 0.6.
   */
  private parseProposal(
    raw: string,
    diagnosis: DiagnosisResult,
    targetSurface: EditableSurface,
  ): ImprovementProposal | null {
    try {
      // Strip any markdown code fences the LLM might include
      const cleaned = this.stripCodeFences(raw);
      const parsed = JSON.parse(cleaned);

      const confidence = Number(parsed.confidence ?? 0);
      if (confidence < this.config.minConfidence) {
        return null;
      }

      const regressionRisk = this.validateRiskLevel(parsed.regression_risk);
      const affectedScope = this.validateScope(parsed.affected_scope);
      const changeType = this.validateChangeType(parsed.change_type, targetSurface.kind);

      const diff: ProposalDiff = {
        surface: targetSurface.id,
        before: String(parsed.before ?? ''),
        after: String(parsed.after ?? ''),
      };

      const impact: ProposalImpact = {
        scope: affectedScope,
        riskLevel: regressionRisk,
        expectedEffect: String(parsed.expected_effect ?? ''),
      };

      const proposal: ImprovementProposal = {
        id: this.generateId(),
        skillId: null,
        agentId: null,
        type: changeType,
        title: String(parsed.title ?? ''),
        summary: String(parsed.summary ?? ''),
        diff,
        impact,
        expectedEffect: String(parsed.expected_effect ?? ''),
        regressionRisk,
        affectedScope,
        mechanismFamily: diagnosis.agent_mechanism,
        confidence,
        createdAt: Date.now(),
      };

      return proposal;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Strips markdown code-fence markers (```json ... ```) from an LLM response.
   */
  private stripCodeFences(raw: string): string {
    let cleaned = raw.trim();
    // Remove opening ```json or ``` and closing ```
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '');
    cleaned = cleaned.replace(/\n?```\s*$/, '');
    return cleaned.trim();
  }

  /**
   * Validates and normalises the criticality field from an LLM response.
   */
  private validateCriticality(
    value: unknown,
  ): 'root_cause' | 'contributor' | 'friction' | 'unknown' {
    if (value === 'root_cause' || value === 'contributor' || value === 'friction') {
      return value;
    }
    return 'unknown';
  }

  /**
   * Maps a regression risk string to a risk level for the ImpactAssessment.
   *
   * If the LLM provides a detailed regression risk description, we extract
   * the implied level. Otherwise, we default to 'low'.
   */
  private validateRiskLevel(value: unknown): 'none' | 'low' | 'medium' {
    if (typeof value !== 'string') {
      return 'low';
    }
    const lower = value.toLowerCase();
    if (lower.includes('none') || lower.includes('no risk')) {
      return 'none';
    }
    if (lower.includes('medium') || lower.includes('moderate')) {
      return 'medium';
    }
    return 'low';
  }

  /**
   * Validates and normalises the mechanism family field from an LLM response.
   */
  private validateMechanismFamily(value: unknown): MechanismFamily {
    const valid: MechanismFamily[] = [
      'prompt_instruction',
      'subagent',
      'skill_procedure',
      'tool_configuration',
      'middleware',
      'runtime_control',
      'permission_interrupt',
    ];
    if (typeof value === 'string' && (valid as readonly string[]).includes(value)) {
      return value as MechanismFamily;
    }
    return 'prompt_instruction';
  }

  /**
   * Validates a change type from the LLM response against the ChangeType
   * enum. Falls back to a deterministic mapping from the target surface's
   * kind when the LLM value is missing or invalid.
   */
  private validateChangeType(value: unknown, surfaceKind: EditableSurfaceKind): ChangeType {
    const valid: ChangeType[] = [
      'prompt_text',
      'prompt_structure',
      'trigger_add',
      'trigger_remove',
      'tool_allow_add',
      'tool_allow_remove',
      'tool_desc_edit',
      'execution_policy',
      'approval_policy',
      'numeric_threshold',
      'spawn_policy_edit',
      'memory_policy_edit',
    ];
    if (typeof value === 'string' && (valid as readonly string[]).includes(value)) {
      return value as ChangeType;
    }
    return SURFACE_KIND_TO_CHANGE_TYPE[surfaceKind] ?? 'prompt_text';
  }

  /**
   * Normalises the LLM's affected_scope into one of the enum values used by
   * approval rules. Accepts both the canonical enum values and the looser
   * descriptive strings the model may produce.
   */
  private validateScope(
    value: unknown,
  ): 'single_skill' | 'multi_skill' | 'global' | 'session' | 'unknown' {
    if (typeof value !== 'string') return 'unknown';
    const lower = value.toLowerCase();
    if (
      lower === 'single_skill' ||
      lower.includes('single') ||
      lower.includes('仅') ||
      lower.includes('单个')
    ) {
      return 'single_skill';
    }
    if (lower === 'multi_skill' || lower.includes('multi') || lower.includes('多')) {
      return 'multi_skill';
    }
    if (lower === 'global' || lower.includes('全局')) {
      return 'global';
    }
    if (lower === 'session') {
      return 'session';
    }
    return 'unknown';
  }
}

/**
 * Deterministic fallback mapping from editable-surface kind to the change
 * type used for approval-rule matching, applied when the LLM does not
 * supply a valid change_type.
 */
const SURFACE_KIND_TO_CHANGE_TYPE: Partial<Record<EditableSurfaceKind, ChangeType>> = {
  skill_prompt: 'prompt_text',
  skill_triggers: 'trigger_add',
  skill_allowed_tools: 'tool_allow_add',
  skill_memory_policy: 'memory_policy_edit',
  agent_system_prompt: 'prompt_text',
  agent_role_description: 'prompt_text',
  base_system_prompt: 'prompt_text',
  execution_instruction: 'prompt_text',
  failure_recovery_instruction: 'prompt_text',
  verification_instruction: 'prompt_text',
  tool_description: 'tool_desc_edit',
  tool_parameter_description: 'tool_desc_edit',
  tool_defer_strategy: 'execution_policy',
  spawn_policy: 'spawn_policy_edit',
  child_agent_optimizer_rules: 'prompt_structure',
  turn_counter_rules: 'numeric_threshold',
  prompt_layer_priority: 'prompt_structure',
  tool_execution_mode: 'execution_policy',
  max_retry_delay: 'numeric_threshold',
  thinking_budget: 'numeric_threshold',
  shell_approval_mode: 'approval_policy',
  approval_policy_rule: 'approval_policy',
};
