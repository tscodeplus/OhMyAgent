// ---------------------------------------------------------------------------
// Self-Harness System — Service Factory
// ---------------------------------------------------------------------------
// Factory function that instantiates all harness subsystem services from the
// top-level HarnessConfig and returns them as a single HarnessServices object.
// ---------------------------------------------------------------------------

import type { HarnessConfig } from './types.js';
import { FailureDetector } from './failure-detector.js';
import { HarnessRateLimiter } from './rate-limiter.js';
import { HarnessOptimizer } from './harness-optimizer.js';
import { EditableSurfaceProvider } from './editable-surfaces.js';
import { ApprovalPolicy } from './approval-policy.js';
import { AutoApplyMonitor } from './auto-apply-monitor.js';
import { SkillEditor } from './skill-editor.js';

/**
 * Container for all harness subsystem service references.
 * Provides typed access to each harness subsystem.
 */
export interface HarnessServices {
  failureDetector: FailureDetector;
  rateLimiter: HarnessRateLimiter;
  optimizer: HarnessOptimizer;
  surfaceProvider: EditableSurfaceProvider;
  approvalPolicy: ApprovalPolicy;
  autoApplyMonitor: AutoApplyMonitor;
  skillEditor: SkillEditor;
}

/**
 * Create all harness subsystem service instances from the given config.
 * Returns undefined when the harness is not enabled.
 *
 * The HarnessOptimizer requires an LLM caller callback, which is not
 * available during bootstrap. A placeholder is provided that will throw
 * if invoked before the agent system wires a real caller.
 */
export function createHarnessServices(config: HarnessConfig): HarnessServices | undefined {
  if (!config.enabled) return undefined;

  const surfaceProvider = new EditableSurfaceProvider();

  // Placeholder LLM caller — the agent system must wire a real caller
  // before the optimizer is exercised.
  const optimizer = new HarnessOptimizer(
    {
      model: config.proposal.model,
      maxEditsPerProposal: config.proposal.maxEditsPerProposal,
      minConfidence: (config.proposal as any).minConfidence ?? 0.5,
      allowedMechanisms: (config.proposal as any).allowedMechanisms ?? [
        'prompt_instruction', 'subagent', 'skill_procedure',
        'tool_configuration', 'middleware', 'runtime_control',
      ],
    },
    surfaceProvider,
    async (_systemPrompt: string, _userMessage: string, _model?: string) => {
      throw new Error(
        'HarnessOptimizer LLM caller not wired. The agent system must provide ' +
        'a real LLM invocation via optimizer construction before use.',
      );
    },
  );

  return {
    failureDetector: new FailureDetector(config.trigger),
    rateLimiter: new HarnessRateLimiter(config.rateLimit),
    optimizer,
    surfaceProvider,
    approvalPolicy: new ApprovalPolicy(config.rules ?? []),
    autoApplyMonitor: new AutoApplyMonitor(),
    skillEditor: new SkillEditor(),
  };
}
