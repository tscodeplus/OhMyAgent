import type { AgentConfig, ResolvedAgentConfig } from './config-types.js';
import type { AppConfig, ToolProfileId } from '../app/types.js';

const DEFAULT_TOOL_PROFILE: ToolProfileId = 'standard';

function resolveModel(agent: AgentConfig, global: AppConfig): ResolvedAgentConfig['model'] {
  const primary = agent.model?.primary
    || `${global.piAi.provider}/${global.piAi.model}`;

  const fallback = agent.model?.fallback !== undefined
    ? agent.model.fallback
    : global.fallbackModels;

  const reasoning_level = agent.model?.reasoning_level
    || global.defaultReasoningLevel
    || 'off';

  const transport = agent.model?.transport || 'auto';
  const max_retry = agent.model?.max_retry || 3;

  return { primary, fallback, reasoning_level, transport, max_retry };
}

function resolveTools(agent: AgentConfig, global: AppConfig): ResolvedAgentConfig['tools'] {
  const profile = agent.tools?.profile
    || global.tools.toolsProfile
    || DEFAULT_TOOL_PROFILE;

  const add = agent.tools?.add || [];
  const deny = agent.tools?.deny || [];

  return { profile, add, deny };
}

function resolveSpawn(agent: AgentConfig, global: AppConfig): ResolvedAgentConfig['spawn'] {
  // Migration: if the agent has no explicit `spawn` block (not even as an empty
  // object) but the global smart_agent_team is enabled, default spawn to enabled.
  // This avoids breaking existing users who already rely on spawn_agent via the
  // global team-mode toggle.  Agents that define `spawn:` (even without fields)
  // are treated as explicit opt-in/out and won't receive the migration default.
  const hasExplicitSpawnBlock =
    Object.prototype.hasOwnProperty.call(agent, 'spawn') && agent.spawn !== undefined;

  return {
    enabled: agent.spawn?.enabled
      ?? (hasExplicitSpawnBlock ? false : (global.smart_agent_team?.enabled ?? false)),
    max_parallel: agent.spawn?.max_parallel
      ?? global.smart_agent_team?.max_children
      ?? 4,
    allowed_personas: agent.spawn?.allowed_personas || [],
  };
}

function resolveExtensions(agent: AgentConfig): ResolvedAgentConfig['extensions'] {
  return { disable: agent.extensions?.disable || [] };
}

function resolveChannels(agent: AgentConfig): string[] {
  return agent.channels || [];
}

export function resolveAgentConfig(
  global: AppConfig,
  agent: AgentConfig,
): ResolvedAgentConfig {
  const system_prompt = agent.system_prompt || 'You are a helpful AI assistant.';
  const model = resolveModel(agent, global);
  const tools = resolveTools(agent, global);
  const spawn = resolveSpawn(agent, global);
  const extensions = resolveExtensions(agent);
  const channels = resolveChannels(agent);

  return {
    id: agent.id,
    name: agent.name,
    description: agent.description || '',
    system_prompt,
    model,
    tools,
    spawn,
    extensions,
    channels,
    _source: {
      systemPromptFrom: agent.system_prompt ? 'agent' : 'global',
      modelPrimaryFrom: agent.model?.primary ? 'agent' : 'global',
      toolsProfileFrom: agent.tools?.profile ? 'agent' : 'global',
      fallbackFrom: agent.model?.fallback !== undefined ? 'agent' : 'global',
    },
  };
}

export function resolveAllAgents(
  global: AppConfig,
  agents: AgentConfig[],
): Map<string, ResolvedAgentConfig> {
  const resolved = new Map<string, ResolvedAgentConfig>();
  for (const agent of agents) {
    resolved.set(agent.id, resolveAgentConfig(global, agent));
  }
  return resolved;
}
