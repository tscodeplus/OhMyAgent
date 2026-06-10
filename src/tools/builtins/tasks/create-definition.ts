// ---------------------------------------------------------------------------
// v4 ToolDefinition for the task_create tool
// ---------------------------------------------------------------------------

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import type { ToolExecutionContext } from '../../platform/tool-context.js';
import { textResult, errorResult } from '../../platform/tool-result.js';

export const taskCreateCapability: ToolCapabilityDescriptor = {
  category: 'task',
  readOnly: false,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'none',
};

const TaskCreateParams = Type.Object({
  title: Type.String({ description: 'Task title' }),
  description: Type.String({ description: 'Task description' }),
  assignToAgentId: Type.Optional(Type.String({ description: 'Agent ID to assign this task to' })),
});

interface TaskCreateArgs {
  title: string;
  description: string;
  assignToAgentId?: string;
}

export function createTaskCreateToolDefinition(): ToolDefinition {
  return {
    name: 'task_create',
    label: 'Create Task',
    description: 'Create a new task in the current session.',
    category: 'task',
    parametersSchema: TaskCreateParams,
    capability: taskCreateCapability,
    execute: async (args: TaskCreateArgs, ctx: ToolExecutionContext) => {
      const orchestrator = ctx.services.orchestrator;
      if (!orchestrator) return errorResult('Orchestrator not available.');

      const task = await orchestrator.createTask({
        ownerAgentId: ctx.agentId ?? 'primary',
        sessionId: ctx.sessionId ?? 'default',
        title: args.title,
        description: args.description,
        assignToAgentId: args.assignToAgentId,
      });

      const lines: string[] = [
        `**Task Created**`,
        `- **Task ID**: ${task.taskId}`,
        `- **Title**: ${task.title}`,
        `- **Status**: ${task.status}`,
        `- **Created At**: ${new Date(task.createdAt).toISOString()}`,
      ];
      if (task.description) lines.push(`- **Description**: ${task.description}`);
      if (task.ownerAgentId) lines.push(`- **Owner Agent**: ${task.ownerAgentId}`);

      return textResult(lines.join('\n'));
    },
  };
}
