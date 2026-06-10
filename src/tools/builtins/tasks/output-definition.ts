// ---------------------------------------------------------------------------
// v4 ToolDefinition for the task_output tool
// ---------------------------------------------------------------------------

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import type { ToolExecutionContext } from '../../platform/tool-context.js';
import { textResult, errorResult } from '../../platform/tool-result.js';

export const taskOutputCapability: ToolCapabilityDescriptor = {
  category: 'task',
  readOnly: true,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'none',
};

const TaskOutputParams = Type.Object({
  taskId: Type.String({ description: 'ID of the task to get output from' }),
});

interface TaskOutputArgs {
  taskId: string;
}

export function createTaskOutputToolDefinition(): ToolDefinition {
  return {
    name: 'task_output',
    label: 'Task Output',
    description: 'Retrieve output of a completed or stopped task.',
    category: 'task',
    parametersSchema: TaskOutputParams,
    capability: taskOutputCapability,
    execute: async (args: TaskOutputArgs, ctx: ToolExecutionContext) => {
      const orchestrator = ctx.services.orchestrator;
      if (!orchestrator) return errorResult('Orchestrator not available.');

      const task = await orchestrator.getTask(args.taskId);
      if (!task) return errorResult(`Task "${args.taskId}" not found.`);
      if (task.sessionId !== (ctx.sessionId ?? 'default')) {
        return errorResult(`Task "${args.taskId}" not found in this session.`);
      }

      // If resultSummary exists, return it directly
      if (task.resultSummary) {
        return textResult([
          `**Task Output: ${task.title}**`,
          `- **Task ID**: ${task.taskId}`,
          `- **Status**: ${task.status}`,
          ``,
          task.resultSummary,
        ].join('\n'));
      }

      // Otherwise collect results from child agents
      const results = await orchestrator.collectResults(task.ownerAgentId);

      if (results.length === 0) {
        return textResult([
          `**Task Output: ${task.title}**`,
          `- **Task ID**: ${task.taskId}`,
          `- **Status**: ${task.status}`,
          ``,
          'No results available yet.',
        ].join('\n'));
      }

      const lines: string[] = [
        `**Task Output: ${task.title}**`,
        `- **Task ID**: ${task.taskId}`,
        `- **Status**: ${task.status}`,
        ``,
      ];

      for (const result of results) {
        lines.push(`### Agent: ${result.agentId} (${result.status})`);
        if (result.summary) lines.push(result.summary);
        if (result.error) lines.push(`**Error**: ${result.error}`);
        lines.push('');
      }

      return textResult(lines.join('\n'));
    },
  };
}
