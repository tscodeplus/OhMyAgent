import type { ToolRegistry } from '../app/types.js';
import type { AgentTool } from '../pi-mono/agent/types.js';

/**
 * In-memory tool registry managing AgentTool instances.
 * Tools are keyed by name; registering a tool with the same name overwrites the previous one.
 */
export class ToolRegistryImpl implements ToolRegistry {
  private tools = new Map<string, AgentTool<any>>();

  register(tool: AgentTool<any>): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): AgentTool<any> | undefined {
    return this.tools.get(name);
  }

  list(): AgentTool<any>[] {
    return Array.from(this.tools.values());
  }

  listAsAgentTools(): AgentTool<any>[] {
    return this.list();
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  unregister(name: string): void {
    this.tools.delete(name);
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
