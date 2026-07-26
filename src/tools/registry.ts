import type { ToolRegistry } from '../app/types.js';
import type { AgentTool } from '../pi-mono/agent/types.js';

/**
 * In-memory tool registry managing AgentTool instances.
 * Tools are keyed by name; registering a tool with the same name overwrites the previous one.
 *
 * Implements result caching for frequently accessed tool lists via a version counter.
 * The cached list is invalidated whenever a tool is registered or unregistered.
 */
export class ToolRegistryImpl implements ToolRegistry {
  private tools = new Map<string, AgentTool<any>>();
  /** Monotonically increasing version counter, bumped on every register/unregister. */
  private version = 0;
  /** Cached result of listAsAgentTools(). null when the cache is stale. */
  private cachedAgentTools: AgentTool<any>[] | null = null;

  register(tool: AgentTool<any>): void {
    this.tools.set(tool.name, tool);
    this.version++;
    this.cachedAgentTools = null;
  }

  get(name: string): AgentTool<any> | undefined {
    return this.tools.get(name);
  }

  list(): AgentTool<any>[] {
    return Array.from(this.tools.values());
  }

  /**
   * Return all registered tools as AgentTool instances.
   * Results are cached and only recomputed when the registry changes (register/unregister),
   * avoiding unnecessary array allocations on every call.
   */
  listAsAgentTools(): AgentTool<any>[] {
    if (this.cachedAgentTools === null) {
      this.cachedAgentTools = Array.from(this.tools.values());
    }
    return this.cachedAgentTools;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  unregister(name: string): void {
    this.tools.delete(name);
    this.version++;
    this.cachedAgentTools = null;
  }

  names(): string[] {
    return Array.from(this.tools.keys());
  }
}

/**
 * Create a new ToolRegistry instance.
 */
export function createToolRegistry(): ToolRegistry {
  return new ToolRegistryImpl();
}
