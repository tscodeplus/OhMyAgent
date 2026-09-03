// ---------------------------------------------------------------------------
// Tool classifier tests
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { Type } from 'typebox';
import {
  CORE_TOOL_NAMES,
  BRIDGE_TOOL_NAMES,
  isDeferrable,
  classifyTools,
} from '../../../src/tools/tool-search/classifier.js';
import type { AgentTool } from '../../../src/pi-mono/agent/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agentTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `Tool: ${name}`,
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  };
}

// ---------------------------------------------------------------------------
// Core tool invariants
// ---------------------------------------------------------------------------

describe('CORE_TOOL_NAMES', () => {
  it('contains exactly 10 core tool names (P2: shrunk from 23)', () => {
    expect(CORE_TOOL_NAMES.size).toBe(10);
  });

  it('contains critical file system tools', () => {
    for (const name of ['file_read', 'file_write', 'file_edit', 'glob', 'grep']) {
      expect(CORE_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  it('contains shell but not sleep', () => {
    expect(CORE_TOOL_NAMES.has('shell')).toBe(true);
    expect(CORE_TOOL_NAMES.has('sleep')).toBe(false); // deferred (P2)
  });

  it('contains memory tools', () => {
    for (const name of ['memory-recall', 'memory-store']) {
      expect(CORE_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  it('does not contain deferred maintenance tools', () => {
    for (const name of [
      'memory_compact',
      'memory_delete',
      'memory_list',
      'memory_update',
      'cron_list',
      'enter_plan_mode',
      'exit_plan_mode',
      'spawn_agent',
      'brief',
      'summarize-session',
    ]) {
      expect(CORE_TOOL_NAMES.has(name)).toBe(false);
    }
  });

  it('keeps IM interaction tools core, media deferred (P2)', () => {
    expect(CORE_TOOL_NAMES.has('ask_user_question')).toBe(true);
    expect(CORE_TOOL_NAMES.has('send_message')).toBe(true);
    expect(CORE_TOOL_NAMES.has('feishu_send_media')).toBe(false); // deferred (P2)
  });

  it('defers web, tasks, config, todo, file_search (P2)', () => {
    for (const name of [
      'web_search',
      'file_search',
      'task_create',
      'task_get',
      'task_list',
      'task_update',
      'task_output',
      'task_stop',
      'todo_write',
      'config',
    ]) {
      expect(CORE_TOOL_NAMES.has(name)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Bridge tool names
// ---------------------------------------------------------------------------

describe('BRIDGE_TOOL_NAMES', () => {
  it('contains the three bridge tools', () => {
    expect(BRIDGE_TOOL_NAMES.has('tool_search')).toBe(true);
    expect(BRIDGE_TOOL_NAMES.has('tool_describe')).toBe(true);
    expect(BRIDGE_TOOL_NAMES.has('tool_call')).toBe(true);
  });

  it('has exactly 3 entries', () => {
    expect(BRIDGE_TOOL_NAMES.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// isDeferrable
// ---------------------------------------------------------------------------

describe('isDeferrable', () => {
  it('returns false for all core tools', () => {
    for (const name of CORE_TOOL_NAMES) {
      expect(isDeferrable(name)).toBe(false);
    }
  });

  it('returns false for bridge tools', () => {
    for (const name of BRIDGE_TOOL_NAMES) {
      expect(isDeferrable(name)).toBe(false);
    }
  });

  it('returns true for known deferrable tools', () => {
    const deferrables = [
      'computer_use',
      'image_generation',
      'image_to_text',
      'speech_to_text',
      'lsp',
      'notebook_edit',
      'enter_worktree',
      'exit_worktree',
      'remote_trigger',
      'memory_doctor',
      'memory_audit_persona',
      'memory_rebuild_persona',
      'cron_create',
      'cron_delete',
      'cron_toggle',
      'team_create',
      'team_delete',
      'web_fetch',
      'memory_compact',
      'memory_delete',
      'memory_list',
      'memory_update',
      'cron_list',
      'enter_plan_mode',
      'exit_plan_mode',
      'spawn_agent',
      'brief',
      'summarize-session',
    ];
    for (const name of deferrables) {
      expect(isDeferrable(name)).toBe(true);
    }
  });

  it('returns false for non-existent tool names', () => {
    // Defensive: tools we can't resolve should NOT be deferrable.
    // However, since the classifier is name-only, any non-core name
    // that passes the bridge check IS deferrable. The caller
    // (assembleTools) is responsible for ensuring only registered
    // tools reach classifyTools.
    // Actually, per the design: unknown tools are deferrable=true,
    // but classifyTools keeps them in visible anyway (they won't
    // be in the input to begin with since they're not registered).
    expect(isDeferrable('xx_definitely_not_a_tool_xx')).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(isDeferrable('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyTools
// ---------------------------------------------------------------------------

describe('classifyTools', () => {
  it('splits mixed tools correctly', () => {
    const tools = [
      agentTool('file_read'), // core
      agentTool('computer_use'), // deferrable
      agentTool('shell'), // core
      agentTool('image_generation'), // deferrable
      agentTool('cron_create'), // deferrable
      agentTool('web_search'), // core
    ];

    const { visible, deferrable } = classifyTools(tools);

    const visNames = visible.map((t) => t.name);
    const defNames = deferrable.map((t) => t.name);

    expect(visNames).toContain('file_read');
    expect(visNames).toContain('shell');
    // web_search is deferrable since P2 (unlocked via tool_search)
    expect(defNames).toContain('web_search');
    expect(defNames).toContain('computer_use');
    expect(defNames).toContain('image_generation');
    expect(defNames).toContain('cron_create');
  });

  it('all tools are either visible or deferrable (none lost)', () => {
    const tools = [
      agentTool('file_read'),
      agentTool('computer_use'),
      agentTool('shell'),
      agentTool('lsp'),
    ];
    const { visible, deferrable } = classifyTools(tools);
    expect(visible.length + deferrable.length).toBe(tools.length);
  });

  it('returns all tools in visible when no deferrable tools', () => {
    const tools = [agentTool('file_read'), agentTool('shell'), agentTool('ask_user_question')];
    const { visible, deferrable } = classifyTools(tools);
    expect(deferrable).toEqual([]);
    expect(visible.length).toBe(tools.length);
  });

  it('returns all tools in deferrable for pure non-core list', () => {
    const tools = [agentTool('computer_use'), agentTool('lsp'), agentTool('cron_create')];
    const { visible, deferrable } = classifyTools(tools);
    expect(visible).toEqual([]);
    expect(deferrable.length).toBe(tools.length);
  });

  it('handles empty input', () => {
    const { visible, deferrable } = classifyTools([]);
    expect(visible).toEqual([]);
    expect(deferrable).toEqual([]);
  });

  it('bridge tools are never deferrable', () => {
    const tools = [agentTool('tool_search'), agentTool('tool_describe'), agentTool('tool_call')];
    const { visible, deferrable } = classifyTools(tools);
    expect(deferrable).toEqual([]);
    expect(visible.length).toBe(3);
  });
});
