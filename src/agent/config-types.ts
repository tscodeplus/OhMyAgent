// ---------------------------------------------------------------------------
// Agent configuration types for V2 multi-agent system
// ---------------------------------------------------------------------------

import type { ToolProfileId } from '../app/types.js';

export interface AgentConfig {
  id: string;
  name: string;
  description?: string;
  system_prompt?: string;
  model?: {
    primary?: string;
    fallback?: string[];
    reasoning_level?: string;
    transport?: string;
    max_retry?: number;
  };
  tools?: {
    profile?: ToolProfileId;
    add?: string[];
    deny?: string[];
  };
  spawn?: {
    enabled?: boolean;
    max_parallel?: number;
    allowed_personas?: string[];
  };
  extensions?: {
    disable?: string[];
  };
  channels?: string[];
  /** Whether Self-Harness auto-optimization is enabled for this agent. Default true. */
  harness?: {
    enabled: boolean;
  };
}

export interface ResolvedAgentConfig {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  model: {
    primary: string;
    fallback: string[];
    reasoning_level: string;
    transport: string;
    max_retry: number;
  };
  tools: {
    profile: ToolProfileId;
    add: string[];
    deny: string[];
  };
  spawn: {
    enabled: boolean;
    max_parallel: number;
    allowed_personas: string[];
  };
  extensions: {
    disable: string[];
  };
  channels: string[];
  /** Whether Self-Harness auto-optimization is enabled for this agent. Default true. */
  harness?: {
    enabled: boolean;
  };
  _source: {
    systemPromptFrom: 'agent' | 'global';
    modelPrimaryFrom: 'agent' | 'global';
    toolsProfileFrom: 'agent' | 'global';
    fallbackFrom: 'agent' | 'global';
  };
}
