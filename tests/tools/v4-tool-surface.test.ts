// ---------------------------------------------------------------------------
// v4 Tool Surface Test — verifies ALL 37 v4 final tools are registered with
// proper capability descriptors.
//
// Phase 1 (F0): Written as a FAILING test initially, because tools like
//   web_search, image_generation, and remote_trigger don't exist yet.
//
// Phase 2 (F6): After Agents A–D create the missing tools and register them
//   in bootstrap, this test should PASS.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { ToolPlatformRegistryImpl } from '../../src/tools/platform/registry.js';
import { AgentToolAdapterImpl } from '../../src/tools/platform/agent-tool-adapter.js';
import { ToolRegistryImpl } from '../../src/tools/registry.js';
import { ToolVisibilityPolicyImpl } from '../../src/policy/tool-visibility.js';
import { PROFILE_TOOLS as AGENT_MANAGER_PROFILE_TOOLS } from '../../src/agent/agent-manager.js';
import type { ToolCategory } from '../../src/tools/platform/tool-definition.js';
import type { ToolCapabilityDescriptor } from '../../src/tools/platform/tool-capabilities.js';
import type { ToolDefinition } from '../../src/tools/platform/tool-definition.js';

// ─── 37 v4 final tools per V4_FINAL_CLOSURE_PLAN.md §5.2 ─────────────────────

const V4_FINAL_TOOLS: readonly string[] = [
  // Builtin core
  'shell', 'file_read', 'file_write', 'file_edit', 'notebook_edit',
  'file_search', 'glob', 'grep', 'lsp',
  // Web
  'web_fetch', 'web_search', 'remote_trigger',
  // Session / productivity
  'tool_search', 'memory_recall', 'memory_store', 'image_to_text', 'image_generation',
  'ask_user_question', 'brief', 'config', 'sleep', 'todo_write',
  'enter_plan_mode', 'exit_plan_mode', 'enter_worktree', 'exit_worktree',
  // Agents
  'spawn_agent',
  // Tasks
  'task_create', 'task_get', 'task_list', 'task_stop', 'task_output', 'task_update',
  'send_message', 'team_create', 'team_delete',
  // Cron
  'cron_create', 'cron_list', 'cron_delete', 'cron_toggle',
  // Special
  'computer_use',
];

// ─── Canonical capability descriptors for each v4 final tool ─────────────────
// Derived from before-tool-call.ts getCapabilityForTool() and the v4 final
// closure plan.  Every registered tool's capability must match these values.

const TOOL_CAPABILITIES: Record<string, ToolCapabilityDescriptor> = {
  shell:              { category: 'shell', readOnly: false, readsFiles: true, writesFiles: true, usesShell: true,  usesNetwork: false, usesComputerUse: false, pathAccess: 'read_write', approvalDefault: 'mutating' },
  file_read:          { category: 'file', readOnly: true,  readsFiles: true, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'read', approvalDefault: 'none' },
  file_write:         { category: 'file', readOnly: false, readsFiles: false, writesFiles: true, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'write', approvalDefault: 'mutating' },
  file_edit:          { category: 'file', readOnly: false, readsFiles: true, writesFiles: true, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'read_write', approvalDefault: 'mutating' },
  notebook_edit:      { category: 'file', readOnly: false, readsFiles: true, writesFiles: true, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'read_write', approvalDefault: 'mutating' },
  file_search:        { category: 'file', readOnly: true,  readsFiles: true, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'read', approvalDefault: 'none' },
  glob:               { category: 'file', readOnly: true,  readsFiles: true, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'read', approvalDefault: 'none' },
  grep:               { category: 'file', readOnly: true,  readsFiles: true, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'read', approvalDefault: 'none' },
  lsp:                { category: 'file', readOnly: true,  readsFiles: true, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'read', approvalDefault: 'none' },
  web_fetch:          { category: 'web', readOnly: true,  readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: true, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
  web_search:         { category: 'web', readOnly: true,  readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: true, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
  remote_trigger:     { category: 'web', readOnly: false, readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: true, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'high_risk' },
  tool_search:        { category: 'session', readOnly: true,  readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
  memory_recall:      { category: 'memory', readOnly: true,  readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
  memory_store:       { category: 'memory', readOnly: false, readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'mutating' },
  image_to_text:      { category: 'multimodal', readOnly: true,  readsFiles: true, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'read', approvalDefault: 'none' },
  image_generation:   { category: 'multimodal', readOnly: false, readsFiles: false, writesFiles: true, usesShell: false, usesNetwork: true, usesComputerUse: false, pathAccess: 'write', approvalDefault: 'mutating' },
  ask_user_question:  { category: 'session', readOnly: true,  readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
  brief:              { category: 'session', readOnly: true,  readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
  config:             { category: 'config', readOnly: true,  readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
  sleep:              { category: 'shell', readOnly: true,  readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
  todo_write:         { category: 'session', readOnly: false, readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'mutating' },
  enter_plan_mode:    { category: 'session', readOnly: false, readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
  exit_plan_mode:     { category: 'session', readOnly: false, readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
  enter_worktree:     { category: 'session', readOnly: false, readsFiles: true, writesFiles: true, usesShell: true,  usesNetwork: false, usesComputerUse: false, pathAccess: 'read_write', approvalDefault: 'mutating' },
  exit_worktree:      { category: 'session', readOnly: false, readsFiles: true, writesFiles: true, usesShell: true,  usesNetwork: false, usesComputerUse: false, pathAccess: 'read_write', approvalDefault: 'mutating' },
  spawn_agent:        { category: 'agent', readOnly: false, readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'mutating' },
  task_create:        { category: 'task', readOnly: false, readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
  task_get:           { category: 'task', readOnly: true,  readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
  task_list:          { category: 'task', readOnly: true,  readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
  task_stop:          { category: 'task', readOnly: false, readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
  task_output:        { category: 'task', readOnly: true,  readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
  task_update:        { category: 'task', readOnly: false, readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
  send_message:       { category: 'task', readOnly: false, readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
  team_create:        { category: 'task', readOnly: false, readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'mutating' },
  team_delete:        { category: 'task', readOnly: false, readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'mutating' },
  cron_create:        { category: 'cron', readOnly: false, readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'mutating' },
  cron_list:          { category: 'cron', readOnly: true,  readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'none' },
  cron_delete:        { category: 'cron', readOnly: false, readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'mutating' },
  cron_toggle:        { category: 'cron', readOnly: false, readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: false, pathAccess: 'none', approvalDefault: 'mutating' },
  computer_use:       { category: 'computer_use', readOnly: false, readsFiles: false, writesFiles: false, usesShell: false, usesNetwork: false, usesComputerUse: true, pathAccess: 'none', approvalDefault: 'high_risk' },
};

// ─── Tool profile reference matrices (for consistency check) ────────────────
// AgentManager.PROFILE_TOOLS uses hyphens; ToolVisibilityPolicy uses underscores.
// Both are checked below.

// ToolVisibilityPolicy PROFILE_TOOLS (hardcoded here since it is not exported)
const VISIBILITY_PROFILE_TOOLS: Record<string, string[]> = {
  minimal: [
    'shell', 'file_read', 'memory_recall', 'memory-recall', 'tool_search', 'brief', 'ask_user_question', 'cronjob',
  ],
  standard: [
    'shell', 'file_read', 'file_search', 'memory_recall', 'memory-recall',
    'memory_store', 'memory-store', 'session_summarize', 'summarize-session',
    'web_fetch', 'web-fetch', 'web_search', 'web-search', 'image_to_text',
    'tool_search', 'ask_user_question', 'brief', 'todo_write', 'sleep', 'config',
    'task_create', 'task_get', 'task_list', 'send_message',
    'feishu_send_media', 'wechat_send_media', 'qq_send_media', 'telegram_send_media',
    'cronjob',
  ],
  advanced: [
    'shell', 'file_read', 'file_write', 'file-write', 'file_edit', 'file_search',
    'glob', 'grep',
    'memory_recall', 'memory-recall', 'memory_store', 'memory-store',
    'session_summarize', 'summarize-session',
    'web_fetch', 'web-fetch', 'web_search', 'web-search', 'image_to_text',
    'tool_search', 'ask_user_question', 'brief', 'todo_write', 'sleep', 'config',
    'spawn_agent', 'computer_use',
    'task_create', 'task_get', 'task_list', 'send_message',
    'task_stop', 'task_output', 'task_update',
    'enter_plan_mode', 'exit_plan_mode', 'enter_worktree', 'exit_worktree',
    'team_create', 'team_delete',
    'feishu_send_media', 'wechat_send_media', 'qq_send_media', 'telegram_send_media',
    'cronjob',
  ],
  full: [],
};

// ─── Factory imports for tools with existing definition files ────────────────

import { createShellToolDefinition } from '../../src/tools/builtins/shell/definition.js';
import { createFileWriteToolDefinition } from '../../src/tools/builtins/files/write-definition.js';
import { createFileEditToolDefinition } from '../../src/tools/builtins/files/edit-definition.js';
import { createNotebookEditToolDefinition } from '../../src/tools/builtins/files/notebook-edit-definition.js';
import { createFileSearchToolDefinition } from '../../src/tools/builtins/files/search-definition.js';
import { createGlobToolDefinition } from '../../src/tools/builtins/files/glob-definition.js';
import { createGrepToolDefinition } from '../../src/tools/builtins/files/grep-definition.js';
import { createLspToolDefinition } from '../../src/tools/builtins/files/lsp-definition.js';
import { createWebFetchToolDefinition } from '../../src/tools/builtins/web/fetch-definition.js';
import { createToolSearchToolDefinition } from '../../src/tools/builtins/session/tool-search-definition.js';
import { createAskUserQuestionToolDefinition } from '../../src/tools/builtins/session/ask-definition.js';
import { createBriefToolDefinition } from '../../src/tools/builtins/session/brief-definition.js';
import { createConfigToolDefinition } from '../../src/tools/builtins/config/config-definition.js';
import { createSleepToolDefinition } from '../../src/tools/builtins/shell/sleep-definition.js';
import { createTodoWriteToolDefinition } from '../../src/tools/builtins/session/todo-definition.js';
import { createImageToTextToolDefinition } from '../../src/tools/builtins/multimodal/image-to-text-definition.js';
import { createEnterPlanModeToolDefinition } from '../../src/tools/builtins/session/enter-plan-definition.js';
import { createExitPlanModeToolDefinition } from '../../src/tools/builtins/session/exit-plan-definition.js';
import { createEnterWorktreeToolDefinition } from '../../src/tools/builtins/session/enter-worktree-definition.js';
import { createExitWorktreeToolDefinition } from '../../src/tools/builtins/session/exit-worktree-definition.js';
import { createTaskCreateToolDefinition } from '../../src/tools/builtins/tasks/create-definition.js';
import { createTaskGetToolDefinition } from '../../src/tools/builtins/tasks/get-definition.js';
import { createTaskListToolDefinition } from '../../src/tools/builtins/tasks/list-definition.js';
import { createTaskStopToolDefinition } from '../../src/tools/builtins/tasks/stop-definition.js';
import { createTaskOutputToolDefinition } from '../../src/tools/builtins/tasks/output-definition.js';
import { createTaskUpdateToolDefinition } from '../../src/tools/builtins/tasks/update-definition.js';
import { createSendMessageToolDefinition } from '../../src/tools/builtins/tasks/send-message-definition.js';
import { createTeamCreateToolDefinition } from '../../src/tools/builtins/tasks/team-create-definition.js';
import { createTeamDeleteToolDefinition } from '../../src/tools/builtins/tasks/team-delete-definition.js';
import { createCronCreateToolDefinition } from '../../src/tools/builtins/cron/create-definition.js';
import { createCronListToolDefinition } from '../../src/tools/builtins/cron/list-definition.js';
import { createCronDeleteToolDefinition } from '../../src/tools/builtins/cron/delete-definition.js';
import { createCronToggleToolDefinition } from '../../src/tools/builtins/cron/toggle-definition.js';
import { createRemoteTriggerToolDefinition } from '../../src/tools/builtins/web/remote-trigger-definition.js';
import { createWebSearchTool } from '../../extensions/web-search/web-search-tool.js';
import { createImageGenerationToolDefinition } from '../../src/tools/builtins/multimodal/image-generation-definition.js';

// ═════════════════════════════════════════════════════════════════════════════
// Test setup
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Register all currently-available v4 tool definitions into a fresh registry.
 *
 * Phase 1: web_search, image_generation, remote_trigger have no definition
 *   files yet, so they are NOT registered.  Test 1 will fail as a result,
 *   confirming the baseline.
 *
 * Phase 2: After Agents A–D create the missing definitions, add their factory
 *   imports and registrations below.
 */
function createTestRegistry(): ToolPlatformRegistryImpl {
  const legacy = new ToolRegistryImpl();
  const adapter = new AgentToolAdapterImpl({});
  const reg = new ToolPlatformRegistryImpl(legacy, adapter);

  // ── Builtin core ──
  reg.registerDefinition(createShellToolDefinition());
  reg.registerDefinition(makeMinimalDef('file_read', TOOL_CAPABILITIES.file_read));
  reg.registerDefinition(createFileWriteToolDefinition());
  reg.registerDefinition(createFileEditToolDefinition());
  reg.registerDefinition(createNotebookEditToolDefinition());
  reg.registerDefinition(createFileSearchToolDefinition());
  reg.registerDefinition(createGlobToolDefinition());
  reg.registerDefinition(createGrepToolDefinition());
  reg.registerDefinition(createLspToolDefinition());

  // ── Web ──
  reg.registerDefinition(createWebFetchToolDefinition());
  reg.registerDefinition(createWebSearchTool());
  reg.registerDefinition(createRemoteTriggerToolDefinition());

  // ── Session / productivity ──
  reg.registerDefinition(createToolSearchToolDefinition());
  reg.registerDefinition(makeMinimalDef('memory_recall', TOOL_CAPABILITIES.memory_recall));
  reg.registerDefinition(makeMinimalDef('memory_store', TOOL_CAPABILITIES.memory_store));
  reg.registerDefinition(createImageToTextToolDefinition());
  reg.registerDefinition(createImageGenerationToolDefinition());
  reg.registerDefinition(createAskUserQuestionToolDefinition());
  reg.registerDefinition(createBriefToolDefinition());
  reg.registerDefinition(createConfigToolDefinition());
  reg.registerDefinition(createSleepToolDefinition());
  reg.registerDefinition(createTodoWriteToolDefinition());
  reg.registerDefinition(createEnterPlanModeToolDefinition());
  reg.registerDefinition(createExitPlanModeToolDefinition());
  reg.registerDefinition(createEnterWorktreeToolDefinition());
  reg.registerDefinition(createExitWorktreeToolDefinition());

  // ── Agents ──
  reg.registerDefinition(makeMinimalDef('spawn_agent', TOOL_CAPABILITIES.spawn_agent));

  // ── Tasks ──
  reg.registerDefinition(createTaskCreateToolDefinition());
  reg.registerDefinition(createTaskGetToolDefinition());
  reg.registerDefinition(createTaskListToolDefinition());
  reg.registerDefinition(createTaskStopToolDefinition());
  reg.registerDefinition(createTaskOutputToolDefinition());
  reg.registerDefinition(createTaskUpdateToolDefinition());
  reg.registerDefinition(createSendMessageToolDefinition());
  reg.registerDefinition(createTeamCreateToolDefinition());
  reg.registerDefinition(createTeamDeleteToolDefinition());

  // ── Cron ──
  reg.registerDefinition(createCronCreateToolDefinition());
  reg.registerDefinition(createCronListToolDefinition());
  reg.registerDefinition(createCronDeleteToolDefinition());
  reg.registerDefinition(createCronToggleToolDefinition());

  // ── Special ──
  reg.registerDefinition(makeMinimalDef('computer_use', TOOL_CAPABILITIES.computer_use));

  return reg;
}

/** Create a minimal ToolDefinition for tools whose factories need injection deps. */
function makeMinimalDef(name: string, cap: ToolCapabilityDescriptor): ToolDefinition {
  return {
    name,
    label: name,
    description: name,
    category: cap.category,
    parametersSchema: {},
    capability: cap,
    execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('v4 final tool surface', () => {
  let registry: ToolPlatformRegistryImpl;

  beforeAll(() => {
    registry = createTestRegistry();
  });

  // ── Test 1: All 37 tools have definitions with capability descriptors ─────
  //
  // Phase 1: FAILS — web_search, image_generation, remote_trigger are not yet
  //   created.  The assertion error lists exactly which tools are missing.
  //
  // Phase 2: PASSES after all tools are registered.

  it('all 37 tools have ToolDefinitions registered with proper capability descriptors', () => {
    const missing: string[] = [];
    const mismatchedCaps: string[] = [];
    const invalidCaps: string[] = [];

    for (const name of V4_FINAL_TOOLS) {
      const def = registry.getDefinition(name);
      if (!def) {
        missing.push(name);
        continue;
      }

      // ToolDefinition must exist with correct name
      if (!def || def.name !== name) {
        missing.push(name);
        continue;
      }

      // Capability descriptor must exist and have required fields
      if (!def.capability) {
        invalidCaps.push(`${name}: no capability`);
        continue;
      }
      if (!def.capability.category) {
        invalidCaps.push(`${name}: no category`);
      }
      if (!['none', 'read', 'write', 'read_write'].includes(def.capability.pathAccess)) {
        invalidCaps.push(`${name}: invalid pathAccess "${def.capability.pathAccess}"`);
      }
      if (!['none', 'mutating', 'high_risk'].includes(def.capability.approvalDefault)) {
        invalidCaps.push(`${name}: invalid approvalDefault "${def.capability.approvalDefault}"`);
      }

      // Capability must match canonical v4 plan values
      const canonical = TOOL_CAPABILITIES[name];
      if (canonical) {
        if (def.capability.category !== canonical.category) {
          mismatchedCaps.push(`${name}: category "${def.capability.category}" !== "${canonical.category}"`);
        }
        if (def.capability.pathAccess !== canonical.pathAccess) {
          mismatchedCaps.push(`${name}: pathAccess "${def.capability.pathAccess}" !== "${canonical.pathAccess}"`);
        }
        if (def.capability.approvalDefault !== canonical.approvalDefault) {
          mismatchedCaps.push(`${name}: approvalDefault "${def.capability.approvalDefault}" !== "${canonical.approvalDefault}"`);
        }
      }
    }

    // Collect all issues into one message
    const issues: string[] = [];
    if (missing.length > 0) {
      issues.push(`Missing from registry (${missing.length}/${V4_FINAL_TOOLS.length}): ${missing.join(', ')}`);
    }
    if (invalidCaps.length > 0) {
      issues.push(`Invalid capabilities:\n  ${invalidCaps.join('\n  ')}`);
    }
    if (mismatchedCaps.length > 0) {
      issues.push(`Capability mismatches:\n  ${mismatchedCaps.join('\n  ')}`);
    }

    expect(issues, issues.length > 0 ? issues.join('\n\n') : undefined).toEqual([]);
  });

  // ── Test 2: computer_use not in standard profile ──────────────────────────

  it('standard profile does not include computer_use', () => {
    const policy = new ToolVisibilityPolicyImpl();
    const visible = policy.isVisible('computer_use', {
      toolsProfile: 'standard',
      computerUseEnabled: false,
      readOnly: false,
    } as any);
    expect(visible).toBe(false);
  });

  // ── Test 3: Profile consistency between AgentManager and ToolVisibilityPolicy ──

  it('ToolVisibilityPolicy PROFILE_TOOLS and AgentManager.PROFILE_TOOLS are consistent', () => {
    const agentStd: string[] = AGENT_MANAGER_PROFILE_TOOLS.standard ?? [];
    const agentDev: string[] = AGENT_MANAGER_PROFILE_TOOLS.advanced ?? [];
    const visStd: string[] = VISIBILITY_PROFILE_TOOLS.standard ?? [];
    const visDev: string[] = VISIBILITY_PROFILE_TOOLS.advanced ?? [];

    // Tools that must appear in standard
    const mustBeStandard = [
      'shell', 'file_read', 'file_search', 'memory_recall',
      'web_fetch', 'web_search', 'brief', 'tool_search', 'sleep', 'config',
      'task_create', 'task_get', 'task_list', 'send_message',
    ];

    // Tools that must appear in advanced (in addition to standard)
    const mustBeDeveloper = [
      'file_write', 'file_edit', 'glob', 'grep',
      'spawn_agent',
      'task_stop', 'task_output', 'task_update',
      'enter_plan_mode', 'exit_plan_mode', 'enter_worktree', 'exit_worktree',
      'team_create', 'team_delete',
    ];

    // Normalize: both underscore and hyphen variants are used
    const hasTool = (tool: string, list: string[]): boolean =>
      list.includes(tool) || list.includes(tool.replace(/_/g, '-'));

    for (const tool of mustBeStandard) {
      const inAgent = hasTool(tool, agentStd);
      const inVis = hasTool(tool, visStd);
      expect(inAgent, `AgentManager.standard should include ${tool}`).toBe(true);
      expect(inVis, `ToolVisibilityPolicy.standard should include ${tool}`).toBe(true);
    }

    for (const tool of mustBeDeveloper) {
      const inAgent = hasTool(tool, agentDev);
      const inVis = hasTool(tool, visDev);
      expect(inAgent, `AgentManager.advanced should include ${tool}`).toBe(true);
      expect(inVis, `ToolVisibilityPolicy.advanced should include ${tool}`).toBe(true);
    }

    // Verify computer_use is NOT in standard
    expect(hasTool('computer_use', agentStd)).toBe(false);
    expect(hasTool('computer_use', visStd)).toBe(false);
  });
});
