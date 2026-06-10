// ---------------------------------------------------------------------------
// v4 ToolDefinition for the task_get tool
// ---------------------------------------------------------------------------

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import type { ToolExecutionContext } from '../../platform/tool-context.js';
import { textResult, errorResult } from '../../platform/tool-result.js';

export const taskGetCapability: ToolCapabilityDescriptor = {
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

const TaskGetParams = Type.Object({
  taskId: Type.String({ description: 'ID of the task to retrieve' }),
});

interface TaskGetArgs {
  taskId: string;
}

export function createTaskGetToolDefinition(): ToolDefinition {
  return {
    name: 'task_get',
    label: 'Get Task',
    description: 'Retrieve details of a specific task by its ID.',
    category: 'task',
    parametersSchema: TaskGetParams,
    capability: taskGetCapability,
    execute: async (args: TaskGetArgs, ctx: ToolExecutionContext) => {
      const orchestrator = ctx.services.orchestrator;
      if (!orchestrator) return errorResult('Orchestrator not available.');

      const task = await orchestrator.getTask(args.taskId);
      if (!task) return errorResult(`Task "${args.taskId}" not found.`);
      if (task.sessionId !== (ctx.sessionId ?? 'default')) {
        return errorResult(`Task "${args.taskId}" not found in this session.`);
      }

      const lines: string[] = [
        `**Task: ${task.title}**`,
        `- **Task ID**: ${task.taskId}`,
        `- **Status**: ${task.status}`,
        `- **Description**: ${task.description}`,
        `- **Owner Agent**: ${task.ownerAgentId}`,
        `- **Created At**: ${new Date(task.createdAt).toISOString()}`,
        `- **Updated At**: ${new Date(task.updatedAt).toISOString()}`,
      ];
      if (task.resultSummary) lines.push(`- **Result Summary**: ${task.resultSummary}`);

      return textResult(lines.join('\n'));
    },
  };
}
