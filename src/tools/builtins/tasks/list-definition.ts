// ---------------------------------------------------------------------------
// v4 ToolDefinition for the task_list tool
// ---------------------------------------------------------------------------

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import type { ToolExecutionContext } from '../../platform/tool-context.js';
import { textResult, errorResult } from '../../platform/tool-result.js';

export const taskListCapability: ToolCapabilityDescriptor = {
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

const EMPTY_SCHEMA = Type.Object({});

export function createTaskListToolDefinition(): ToolDefinition {
  return {
    name: 'task_list',
    label: 'List Tasks',
    description: 'List all tasks in current session, grouped by status.',
    category: 'task',
    parametersSchema: EMPTY_SCHEMA,
    capability: taskListCapability,
    execute: async (_args: Record<string, never>, ctx: ToolExecutionContext) => {
      const orchestrator = ctx.services.orchestrator;
      if (!orchestrator) return errorResult('Orchestrator not available.');

      const tasks = await orchestrator.listTasks(ctx.sessionId ?? 'default');

      if (tasks.length === 0) {
        return textResult('No tasks found in this session.');
      }

      // Group by status
      const groups: Record<string, typeof tasks> = {};
      for (const task of tasks) {
        const status = task.status;
        if (!groups[status]) groups[status] = [];
        groups[status].push(task);
      }

      const lines: string[] = [];
      const statusOrder = ['pending', 'running', 'completed', 'failed', 'stopped'];

      for (const status of statusOrder) {
        const group = groups[status];
        if (!group || group.length === 0) continue;
        lines.push(`### ${status.charAt(0).toUpperCase() + status.slice(1)} (${group.length})`);
        for (const task of group) {
          lines.push(`- **${task.taskId}**: ${task.title}`);
        }
        lines.push('');
      }

      lines.push(`---\n*Total: ${tasks.length} tasks*`);

      return textResult(lines.join('\n'));
    },
  };
}
