import {
  FailureContext,
  ImprovementProposal,
  DiagnosisResult,
  EditableSurface,
  HarnessProposalConfig,
  MechanismFamily,
  ProposalDiff,
  ProposalImpact,
} from './types.js';
import { EditableSurfaceProvider } from './editable-surfaces.js';

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
  private readonly config: HarnessProposalConfig;
  private readonly surfaceProvider: EditableSurfaceProvider;
  private readonly llmCaller: (systemPrompt: string, userMessage: string) => Promise<string>;

  constructor(
    config: HarnessProposalConfig,
    surfaceProvider: EditableSurfaceProvider,
    llmCaller: (systemPrompt: string, userMessage: string) => Promise<string>,
  ) {
    this.config = config;
    this.surfaceProvider = surfaceProvider;
    this.llmCaller = llmCaller;
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

    const toolCallSummary = context.toolCalls.map((tc) => {
      const status = tc.isError ? `ERROR: ${tc.errorMessage ?? 'unknown'}` : 'OK';
      return `  - ${tc.name}(${JSON.stringify(tc.args)}) -> ${status}`;
    }).join('\n');

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
      `Errors (${context.errors.length}):`,
      ...context.errors.map((e) => `  - ${e.toolName}: ${e.message}`),
    ].join('\n');

    let raw: string;
    try {
      raw = await this.callLLM(systemPrompt, userMessage);
    } catch {
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
      '  - "regression_risk": string — what could break as a side effect',
      '  - "confidence": number between 0 and 1',
      '  - "mechanism_family": string — the mechanism family being changed',
      '  - "affected_scope": string — what scope the change affects (e.g. "session", "skill", "global")',
      '',
      'Constraints:',
      '  - Do NOT propose changes outside these allowed mechanism families:',
      `    ${allowedMechanisms.length > 0 ? allowedMechanisms.join(', ') : 'all'}`,
      '  - Keep the edit minimal — change only what is necessary',
      '  - The "before" value must be a substring found in the current surface value',
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
    } catch {
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
   * Generates a unique, sortable proposal ID.
   */
  private generateId(): string {
    return 'prop-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
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
    return this.llmCaller(systemPrompt, userMessage);
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

      if (diagnosis.confidence < 0.6) {
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
      if (confidence < 0.6) {
        return null;
      }

      const diff: ProposalDiff = {
        surface: targetSurface.id,
        before: String(parsed.before ?? ''),
        after: String(parsed.after ?? ''),
      };

      const impact: ProposalImpact = {
        scope: String(parsed.affected_scope ?? 'unknown'),
        riskLevel: this.validateRiskLevel(parsed.regression_risk),
        expectedEffect: String(parsed.expected_effect ?? ''),
      };

      const proposal: ImprovementProposal = {
        id: this.generateId(),
        skillId: null,
        agentId: null,
        type: 'surface_edit',
        title: String(parsed.title ?? ''),
        summary: String(parsed.summary ?? ''),
        diff,
        impact,
        expectedEffect: String(parsed.expected_effect ?? ''),
        regressionRisk: String(parsed.regression_risk ?? ''),
        affectedScope: String(parsed.affected_scope ?? 'unknown'),
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
}
