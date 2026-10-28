/**
 * Registration guard for MyDocs/KNOWLEDGE_WORKBENCH_PLAN.md §8.1 — the "code
 * written, tests green, the model cannot see the tool" failure mode.
 *
 * A ToolDefinition only reaches the model when all of these agree:
 *   1. its exact `name` is in `PROFILE_TOOLS[profile]` (the default profile is
 *      `standard`; `full` is an empty allow-list = everything)
 *   2. the capability is in the STATIC table of tool-capability-registry —
 *      `registerToolCapability()` is for MCP/dynamic tools and loses to the
 *      static table, so an unlisted built-in falls into the fail-closed default
 *      (`mutating` + `writesFiles`) and a read-only tool would demand approval
 *      on every call
 *   3. the descriptor the definition declares equals the one the static table
 *      resolves, since the approval gate reads the latter
 *
 * The tools registered here are the ones `registerV4ToolDefinitions()` wires;
 * this file is the place to add a row when another one is wired.
 */
import { describe, expect, it } from 'vitest';
import { AgentToolAdapterImpl } from '../../src/tools/platform/agent-tool-adapter.js';
import type { ToolDefinition } from '../../src/tools/platform/tool-definition.js';
import { ToolPlatformRegistryImpl } from '../../src/tools/platform/registry.js';
import { ToolRegistryImpl } from '../../src/tools/registry.js';
import { ToolVisibilityPolicyImpl, PROFILE_TOOLS } from '../../src/policy/tool-visibility.js';
import { getCapabilityForTool } from '../../src/policy/tool-capability-registry.js';
import type { AgentPolicyScope } from '../../src/policy/types.js';
import { createKnowledgeGetToolDefinition } from '../../src/tools/builtins/knowledge/get-definition.js';
import { createKnowledgeSearchToolDefinition } from '../../src/tools/builtins/knowledge/search-definition.js';
import { createKnowledgeWriteToolDefinition } from '../../src/tools/builtins/knowledge/write-definition.js';
import { createSessionSearchToolDefinition } from '../../src/tools/builtins/session/session-search-definition.js';
import type { KnowledgeService } from '../../src/memory/knowledge/service-contract.js';
import type Database from 'better-sqlite3';

/**
 * Construction-time dependencies are never touched: every factory captures its
 * service in a closure and only calls it inside `execute`. That keeps this a
 * pure registration test (no SQLite, no fixtures).
 */
function buildRegisteredDefinitions(): ToolDefinition<any>[] {
  const knowledgeService = {} as KnowledgeService;
  const db = {} as Database.Database;
  return [
    createKnowledgeSearchToolDefinition({ knowledgeService }),
    createKnowledgeGetToolDefinition({ knowledgeService }),
    createKnowledgeWriteToolDefinition({ knowledgeService }),
    createSessionSearchToolDefinition({ db }),
  ];
}

function scopeFor(toolsProfile: AgentPolicyScope['toolsProfile']): AgentPolicyScope {
  return {
    toolsProfile,
    readRoots: [],
    writeRoots: [],
    deniedPatterns: [],
    shellExecMode: 'balanced',
    sessionApprovals: [],
    appApprovals: [],
    readOnly: false,
    computerUseEnabled: false,
    policyMode: 'balanced',
  };
}

describe('tool registration gates (plan §8.1)', () => {
  const definitions = buildRegisteredDefinitions();
  const registry = new ToolPlatformRegistryImpl(
    new ToolRegistryImpl(),
    new AgentToolAdapterImpl({}),
  );
  for (const def of definitions) registry.registerDefinition(def);

  it('every registered tool is visible under the default standard profile', () => {
    const policy = new ToolVisibilityPolicyImpl();
    const invisible = registry
      .names()
      .filter((name) => !policy.isVisible(name, scopeFor('standard')));
    expect(invisible, `invisible under the standard profile: ${invisible.join(', ')}`).toEqual([]);
  });

  it('every registered tool is also in an explicit allow-list (not only the full profile)', () => {
    const listed = new Set([...PROFILE_TOOLS.restricted, ...PROFILE_TOOLS.standard]);
    const missing = registry.names().filter((name) => !listed.has(name));
    expect(missing, `not in restricted/standard allow-lists: ${missing.join(', ')}`).toEqual([]);
  });

  it('each tool declares the same capability the static approval table resolves', () => {
    // `category` is excluded: `capability.category` is read by no approval path
    // — `approvalRiskForTool` and the PolicyCenter gate look at readOnly /
    // approvalDefault / usesComputerUse. Everything the gate reads must match,
    // or the table silently overrides the definition.
    const approvalFields = (capability: Record<string, unknown>) => {
      const { category: _ignored, ...rest } = capability;
      return rest;
    };
    const mismatched = definitions
      .filter((def) => {
        const resolved = approvalFields({ ...getCapabilityForTool(def.name) });
        return JSON.stringify(resolved) !== JSON.stringify(approvalFields({ ...def.capability }));
      })
      .map((def) => def.name);
    expect(
      mismatched,
      `definition and static table disagree (the table wins at approval time): ${mismatched.join(', ')}`,
    ).toEqual([]);
  });

  it('each tool is filed under the category its definition declares', () => {
    // The table and the definition must agree here too — a read-only knowledge
    // tool misfiled as `session` would still pass the approval fields above.
    const misfiled = definitions
      .filter((def) => getCapabilityForTool(def.name).category !== def.capability.category)
      .map((def) => def.name);
    expect(misfiled, `category drift: ${misfiled.join(', ')}`).toEqual([]);
  });

  it('knowledge_read tools are read-only and never prompt for approval', () => {
    for (const name of ['knowledge_search', 'knowledge_get']) {
      expect(getCapabilityForTool(name), name).toEqual({
        category: 'memory',
        readOnly: true,
        readsFiles: false,
        writesFiles: false,
        usesShell: false,
        usesNetwork: false,
        usesComputerUse: false,
        pathAccess: 'none',
        approvalDefault: 'none',
      });
    }
  });

  it('session_search is a session tool, like session_summarize', () => {
    // It reads raw transcripts, not the memory layer's curated tier, so it
    // carries `session_summarize`'s category rather than the knowledge tools'.
    expect(getCapabilityForTool('session_search')).toEqual({
      category: 'session',
      readOnly: true,
      readsFiles: false,
      writesFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'none',
    });
  });

  it('knowledge_write is mutating, like file_write', () => {
    expect(getCapabilityForTool('knowledge_write')).toEqual({
      category: 'memory',
      readOnly: false,
      readsFiles: false,
      writesFiles: false,
      usesShell: false,
      usesNetwork: false,
      usesComputerUse: false,
      pathAccess: 'none',
      approvalDefault: 'mutating',
    });
  });

  it('new tools use a single spelling — no invented kebab aliases', () => {
    const all = [...PROFILE_TOOLS.restricted, ...PROFILE_TOOLS.standard];
    for (const name of ['session_search', 'knowledge_search', 'knowledge_get', 'knowledge_write']) {
      expect(all.filter((entry) => entry.replace(/_/g, '-') === name.replace(/_/g, '-'))).toEqual([
        name,
        name,
      ]);
    }
  });
});
