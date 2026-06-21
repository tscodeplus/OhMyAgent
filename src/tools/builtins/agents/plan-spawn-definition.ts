// ---------------------------------------------------------------------------
// v4 ToolDefinition for the plan_and_spawn tool (P4)
//
// Allows the LLM to plan task decomposition AND spawn child agents in one call.
// Use this INSTEAD of separate spawn_agent calls when:
//  - Subtasks have dependencies (A must finish before B starts)
//  - You need structured plan output before execution
//  - You want automatic result aggregation
//
// For single independent subtasks, use spawn_agent directly.
// ---------------------------------------------------------------------------

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import type { ToolExecutionContext } from '../../platform/tool-context.js';
import { textResult, errorResult } from '../../platform/tool-result.js';
import { DAGExecutor, type DAGExecutorDeps } from '../../../orchestrator/dag-executor.js';
import type { PlanAndSpawnInput } from '../../../orchestrator/dag-types.js';

const PlanAndSpawnParams = Type.Object({
  task: Type.String({
    description:
      'Main task description. Used as title for the result summary.',
  }),
  subtasks: Type.Array(
    Type.Object({
      title: Type.String({
        description: 'Short title for this subtask (unique across all subtasks).',
      }),
      description: Type.String({
        description:
          'Detailed, self-contained description. The child agent CANNOT see user messages or conversation history, so include ALL necessary context.',
      }),
      persona: Type.Optional(
        Type.String({
          description:
            'Agent persona ID to use (e.g. "default", "coder", "designer"). Must match an existing agent configuration. Omit to use default.',
        }),
      ),
      dependsOn: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Titles of subtasks that must COMPLETE before this one can start. Leave empty for independent tasks.',
        }),
      ),
    }),
  ),
  strategy: Type.Union(
    [Type.Literal('parallel'), Type.Literal('sequential')],
    {
      description:
        'Execution strategy: "parallel" = independent subtasks run concurrently by topological level; "sequential" = run one at a time in order. Use "parallel" when subtasks are independent.',
    },
  ),
  maxConcurrency: Type.Optional(
    Type.Number({
      description:
        'Override the default max concurrent child agents. Only meaningful with parallel strategy.',
    }),
  ),
});

export const planSpawnToolCapability: ToolCapabilityDescriptor = {
  category: 'agent',
  readOnly: false,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'mutating',
};

export function createPlanAndSpawnToolDefinition(deps: DAGExecutorDeps): ToolDefinition {
  const executor = new DAGExecutor(deps);

  return {
    name: 'plan_and_spawn',
    label: 'Plan & Spawn',
    description: [
      'Plan task decomposition AND spawn child agents in one call.',
      '',
      'Use this INSTEAD of separate spawn_agent calls when:',
      '- Subtasks have dependencies (A must finish before B starts)',
      '- You need structured plan output before execution',
      '- You want automatic result aggregation',
      '',
      'For single independent subtasks, use spawn_agent directly.',
      '',
      'Strategies:',
      '- "parallel": independent subtasks run concurrently by topological level',
      '- "sequential": run one at a time in order, stops on first failure',
    ].join('\n'),
    category: 'agent',
    parametersSchema: PlanAndSpawnParams,
    capability: planSpawnToolCapability,
    execute: async (args, ctx) => {
      try {
        const input = args as unknown as PlanAndSpawnInput;

        // Basic validation before delegating to executor
        if (!input.task || typeof input.task !== 'string') {
          return errorResult('plan_and_spawn: "task" is required and must be a string.');
        }
        if (!Array.isArray(input.subtasks) || input.subtasks.length === 0) {
          return errorResult('plan_and_spawn: "subtasks" must be a non-empty array.');
        }
        if (input.subtasks.length > 20) {
          return errorResult('plan_and_spawn: maximum 20 subtasks allowed.');
        }

        const result = await executor.execute(input);
        return textResult(result.combinedSummary);
      } catch (err: any) {
        return errorResult(`plan_and_spawn failed: ${err.message}`);
      }
    },
  };
}
