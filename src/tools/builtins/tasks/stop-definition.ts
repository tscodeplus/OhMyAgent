// ---------------------------------------------------------------------------
// v4 ToolDefinition for the task_stop tool
// ---------------------------------------------------------------------------

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import type { ToolExecutionContext } from '../../platform/tool-context.js';
import { textResult, errorResult } from '../../platform/tool-result.js';

export const taskStopCapability: ToolCapabilityDescriptor = {
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

const TaskStopParams = Type.Object({
  taskId: Type.String({ description: 'ID of the task to stop' }),
});

interface TaskStopArgs {
  taskId: string;
}

export function createTaskStopToolDefinition(): ToolDefinition {
  return {
    name: 'task_stop',
    label: 'Stop Task',
    description: 'Stop a running task and its associated agent. Sets the task status to stopped.',
    category: 'task',
    parametersSchema: TaskStopParams,
    capability: taskStopCapability,
    execute: async (args: TaskStopArgs, ctx: ToolExecutionContext) => {
      const orchestrator = ctx.services.orchestrator;
      if (!orchestrator) return errorResult('Orchestrator not available.');

      const task = await orchestrator.getTask(args.taskId);
      if (!task) return errorResult(`Task "${args.taskId}" not found.`);
      if (task.sessionId !== (ctx.sessionId ?? 'default')) {
        return errorResult(`Task "${args.taskId}" not found in this session.`);
      }

      // Stop the associated agent (F4: orchestrator now handles both status update AND runtime abort)
      await orchestrator.stopAgent(task.ownerAgentId);

      // Verify the agent was actually aborted
      const agentRun = orchestrator.getAgentRun(task.ownerAgentId);
      if (agentRun && agentRun.status !== 'stopped') {
        return errorResult(`Failed to stop agent "${task.ownerAgentId}".`);
      }

      await orchestrator.updateTask(args.taskId, { status: 'stopped' });

      const lines: string[] = [
        `**Task Stopped**`,
        `- **Task ID**: ${task.taskId}`,
        `- **Title**: ${task.title}`,
        `- **Owner Agent**: ${task.ownerAgentId}`,
        `- **Previous Status**: ${task.status}`,
      ];

      return textResult(lines.join('\n'));
    },
  };
}
