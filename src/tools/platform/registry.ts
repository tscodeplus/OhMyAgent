// ---------------------------------------------------------------------------
// v4 Tool Platform — registry interface and implementation
// ---------------------------------------------------------------------------

import type { AgentTool } from '../../pi-mono/agent/types.js';
import type { ToolDefinition } from './tool-definition.js';
import type { ToolCategory } from './tool-definition.js';
import type { ToolRegistry } from '../../app/types.js';
import type { AgentPolicyScope } from '../../policy/types.js';

// ---------------------------------------------------------------------------
// AgentToolAdapter interface
// P2-T3 will move this to agent-tool-adapter.js — for now defined here.
// ---------------------------------------------------------------------------

export interface AgentToolAdapter {
  /** Convert a v4 ToolDefinition to a pi-mono AgentTool. */
  toAgentTool(def: ToolDefinition): AgentTool<any>;
}

// ---------------------------------------------------------------------------
// ToolPlatformRegistry
// ---------------------------------------------------------------------------

export interface ToolPlatformRegistry {
  /** Register a v4 ToolDefinition. */
  registerDefinition(def: ToolDefinition): void;

  /** Get a v4 ToolDefinition by name. */
  getDefinition(name: string): ToolDefinition | undefined;

  /** List all registered v4 ToolDefinitions. */
  listDefinitions(): ToolDefinition[];

  /** List definitions filtered by category. */
  getByCategory(category: ToolCategory): ToolDefinition[];

  /** Get the pi-mono compatible AgentTool for a given definition name. */
  getAgentTool(name: string): AgentTool<any> | undefined;

  /** List all tools as pi-mono AgentTools. */
  listAgentTools(): AgentTool<any>[];

  /** Check if a tool definition is registered. */
  has(name: string): boolean;

  /** Unregister a tool. */
  unregister(name: string): void;

  /** List all registered tool names. */
  names(): string[];
}

// ---------------------------------------------------------------------------
// ToolPlatformRegistryImpl
// ---------------------------------------------------------------------------

export class ToolPlatformRegistryImpl implements ToolPlatformRegistry {
  private definitions = new Map<string, ToolDefinition>();
  private legacyRegistry: ToolRegistry;
  private adapter: AgentToolAdapter;

  constructor(legacyRegistry: ToolRegistry, adapter: AgentToolAdapter) {
    this.legacyRegistry = legacyRegistry;
    this.adapter = adapter;
  }

  // -----------------------------------------------------------------------
  // v4 ToolDefinition lifecycle
  // -----------------------------------------------------------------------

  registerDefinition(def: ToolDefinition): void {
    this.definitions.set(def.name, def);
    const agentTool = this.adapter.toAgentTool(def);
    this.legacyRegistry.register(agentTool);
  }

  getDefinition(name: string): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  listDefinitions(): ToolDefinition[] {
    return Array.from(this.definitions.values());
  }

  getByCategory(category: ToolCategory): ToolDefinition[] {
    return this.listDefinitions().filter((d) => d.category === category);
  }

  // -----------------------------------------------------------------------
  // AgentTool compatibility (delegates to old registry)
  // -----------------------------------------------------------------------

  getAgentTool(name: string): AgentTool<any> | undefined {
    return this.legacyRegistry.get(name);
  }

  listAgentTools(): AgentTool<any>[] {
    return this.legacyRegistry.listAsAgentTools();
  }

  has(name: string): boolean {
    return this.definitions.has(name) || this.legacyRegistry.has(name);
  }

  unregister(name: string): void {
    this.definitions.delete(name);
    this.legacyRegistry.unregister(name);
  }

  names(): string[] {
    return [...new Set([...this.definitions.keys(), ...this.legacyRegistry.names()])];
  }

  // -----------------------------------------------------------------------
  // Extended queries
  // -----------------------------------------------------------------------

  /** List all visible tools within a given policy scope. */
  listVisible(_scope: AgentPolicyScope): ToolDefinition[] {
    // Phase 2 simple implementation: return all definitions
    // Phase 5+ can filter by ToolVisibilityPolicy
    return this.listDefinitions();
  }

  /** List all visible tool names within a given policy scope. */
  listVisibleNames(scope: AgentPolicyScope): string[] {
    return this.listVisible(scope).map((d) => d.name);
  }
}
