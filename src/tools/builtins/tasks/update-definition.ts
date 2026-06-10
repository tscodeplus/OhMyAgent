// ---------------------------------------------------------------------------
// v4 ToolDefinition for the task_update tool
// ---------------------------------------------------------------------------

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import type { ToolExecutionContext } from '../../platform/tool-context.js';
import { textResult, errorResult } from '../../platform/tool-result.js';

export const taskUpdateCapability: ToolCapabilityDescriptor = {
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

const TaskUpdateParams = Type.Object({
  taskId: Type.String({ description: 'ID of the task to update' }),
  title: Type.Optional(Type.String({ description: 'New task title' })),
  description: Type.Optional(Type.String({ description: 'New task description' })),
  status: Type.Optional(Type.Union([
    Type.Literal('pending'),
    Type.Literal('running'),
    Type.Literal('completed'),
    Type.Literal('failed'),
    Type.Literal('stopped'),
  ], { description: 'New task status' })),
});

interface TaskUpdateArgs {
  taskId: string;
  title?: string;
  description?: string;
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'stopped';
}

export function createTaskUpdateToolDefinition(): ToolDefinition {
  return {
    name: 'task_update',
    label: 'Update Task',
    description: 'Update the title, description, or status of an existing task.',
    category: 'task',
    parametersSchema: TaskUpdateParams,
    capability: taskUpdateCapability,
    execute: async (args: TaskUpdateArgs, ctx: ToolExecutionContext) => {
      const orchestrator = ctx.services.orchestrator;
      if (!orchestrator) return errorResult('Orchestrator not available.');

      const task = await orchestrator.getTask(args.taskId);
      if (!task) return errorResult(`Task "${args.taskId}" not found.`);
      if (task.sessionId !== (ctx.sessionId ?? 'default')) {
        return errorResult(`Task "${args.taskId}" not found in this session.`);
      }

      // Build patch with only provided fields
      const patch: Record<string, string> = {};
      if (args.title !== undefined) patch.title = args.title;
      if (args.description !== undefined) patch.description = args.description;
      if (args.status !== undefined) patch.status = args.status;

      const updated = await orchestrator.updateTask(args.taskId, patch as any);
      if (!updated) return errorResult(`Failed to update task "${args.taskId}".`);

      const lines: string[] = [
        `**Task Updated**`,
        `- **Task ID**: ${updated.taskId}`,
        `- **Title**: ${updated.title}`,
        `- **Status**: ${updated.status}`,
        `- **Updated At**: ${new Date(updated.updatedAt).toISOString()}`,
      ];

      return textResult(lines.join('\n'));
    },
  };
}
