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

function resolveSpawn(agent: AgentConfig): ResolvedAgentConfig['spawn'] {
  return {
    enabled: agent.spawn?.enabled ?? false,
    max_parallel: agent.spawn?.max_parallel ?? 3,
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
  const spawn = resolveSpawn(agent);
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
