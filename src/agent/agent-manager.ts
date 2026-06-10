import type { ResolvedAgentConfig, AgentConfig } from './config-types.js';
import type { AppConfig, ToolProfileId, ToolRegistry } from '../app/types.js';
import type { AgentPolicyScope } from '../policy/types.js';
import { resolveAllAgents, resolveAgentConfig } from './config-resolver.js';
import { PROFILE_TOOLS } from '../policy/tool-visibility.js';

/**
 * AgentManager resolves agent configuration and applies the shared policy
 * profile tool list from policy/tool-visibility.
 */
export class AgentManager {
  private resolved: Map<string, ResolvedAgentConfig>;
  private global: AppConfig;

  constructor(
    globalConfig: AppConfig,
    agents: AgentConfig[],
    private toolRegistry: ToolRegistry,
  ) {
    this.global = globalConfig;
    this.resolved = resolveAllAgents(globalConfig, agents);
  }

  /** Hot reload: re-resolve all agents with updated config and agent definitions. */
  reload(globalConfig: AppConfig, agents: AgentConfig[]): void {
    this.global = globalConfig;
    this.resolved = resolveAllAgents(globalConfig, agents);
  }

  list(): ResolvedAgentConfig[] {
    return Array.from(this.resolved.values());
  }

  get(id: string): ResolvedAgentConfig | undefined {
    return this.resolved.get(id);
  }

  getDefault(channelType?: string): ResolvedAgentConfig {
    if (channelType) {
      for (const config of this.resolved.values()) {
        if (config.channels.some(ch => ch === channelType || ch.startsWith(channelType + ':'))) {
          return config;
        }
      }
    }
    const fromMap = this.resolved.get('default') || this.resolved.values().next().value;
    if (fromMap) return fromMap;

    // Fallback: zero agents configured (all deleted or config.yaml has no agents
    // section). Build a minimal built-in default with explicit defaults so
    // behavior doesn't depend on global config drifting.
    return resolveAgentConfig(this.global, {
      id: 'default',
      name: 'Default',
      system_prompt: 'You are a helpful AI assistant.',
      tools: { profile: 'advanced' },
      channels: ['feishu', 'telegram', 'wechat', 'qq', 'webui'],
    });
  }

  // Resolve tools for an agent based on its config and optional policy scope
  resolveTools(config: ResolvedAgentConfig, scope?: AgentPolicyScope): any[] {
    const allTools = this.toolRegistry.listAsAgentTools();
    const profile = config.tools.profile;
    let filteredTools = this.filterByProfile(allTools, profile);

    for (const toolName of config.tools.add) {
      const tool = this.toolRegistry.get(toolName);
      if (tool && !filteredTools.find(t => t.name === toolName)) {
        filteredTools.push(tool);
      }
    }

    filteredTools = filteredTools.filter(t => !config.tools.deny.includes(t.name));

    // v4 Phase 5: Filter computer_use based on AgentPolicyScope
    if (scope && !scope.computerUseEnabled) {
      filteredTools = filteredTools.filter(t => t.name !== 'computer_use');
    }

    return filteredTools;
  }

  private filterByProfile(tools: any[], profile: ToolProfileId): any[] {
    const allowed = PROFILE_TOOLS[profile] || PROFILE_TOOLS.standard;
    if (profile === 'full' || allowed[0] === '*') return tools;
    return tools.filter((t: any) => allowed.includes(t.name) || t.name === 'computer_use');
  }
}

export { PROFILE_TOOLS };
