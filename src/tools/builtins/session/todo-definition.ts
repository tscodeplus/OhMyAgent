// ---------------------------------------------------------------------------
// v4 ToolDefinition for the todo_write tool
// ---------------------------------------------------------------------------

import { Type } from '@sinclair/typebox';
import type { ToolDefinition } from '../../platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../platform/tool-capabilities.js';
import { textResult } from '../../platform/tool-result.js';

export const todoWriteCapability: ToolCapabilityDescriptor = {
  category: 'session',
  readOnly: false,
  readsFiles: false,
  writesFiles: false,
  usesShell: false,
  usesNetwork: false,
  usesComputerUse: false,
  pathAccess: 'none',
  approvalDefault: 'mutating',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TodoItem {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
  description?: string;
}

const TodoItemSchema = Type.Object({
  id: Type.String(),
  subject: Type.String(),
  status: Type.Union([
    Type.Literal('pending'),
    Type.Literal('in_progress'),
    Type.Literal('completed'),
  ]),
  description: Type.Optional(Type.String()),
});

const TodoWriteParams = Type.Object({
  todos: Type.Array(TodoItemSchema),
  merge: Type.Optional(Type.Boolean()),
});

interface TodoWriteArgs {
  todos: TodoItem[];
  merge?: boolean;
}

// ---------------------------------------------------------------------------
// Module-level store: sessionId -> TodoItem[]
// ---------------------------------------------------------------------------

const todoStore = new Map<string, TodoItem[]>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTodoList(items: TodoItem[]): string {
  const groups: Record<string, TodoItem[]> = {
    in_progress: [],
    pending: [],
    completed: [],
  };

  for (const item of items) {
    groups[item.status]?.push(item);
  }

  const lines: string[] = ['## Todo List'];
  for (const [status, label] of [['in_progress', 'In Progress'] as const, ['pending', 'Pending'] as const, ['completed', 'Completed'] as const]) {
    const group = groups[status];
    lines.push(`### ${label} (${group.length})`);
    if (group.length > 0) {
      for (const item of group) {
        const desc = item.description ? ` — ${item.description}` : '';
        lines.push(`- [${item.id}] ${item.subject}${desc}`);
      }
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export function createTodoWriteToolDefinition(): ToolDefinition {
  return {
    name: 'todo_write',
    label: 'Todo Write',
    description: 'Manage a todo list for current session. Merge or replace existing todos.',
    category: 'session',
    parametersSchema: TodoWriteParams,
    capability: todoWriteCapability,
    execute: async (args: TodoWriteArgs, ctx) => {
      const sessionId = ctx.sessionId ?? 'default';
      const { todos, merge } = args;

      if (merge) {
        const existing = todoStore.get(sessionId) ?? [];
        const existingMap = new Map(existing.map((t) => [t.id, t]));
        for (const todo of todos) {
          existingMap.set(todo.id, todo);
        }
        todoStore.set(sessionId, Array.from(existingMap.values()));
      } else {
        todoStore.set(sessionId, [...todos]);
      }

      const stored = todoStore.get(sessionId)!;
      return textResult(formatTodoList(stored));
    },
  };
}
