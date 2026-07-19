export interface Agent {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
  fallbackModels?: string[];
  reasoningLevel?: string;
  transport?: string;
  maxRetry?: number;
  profile?: string;
  addTools?: string[];
  denyTools?: string[];
  channelBindings?: {
    feishu?: { triggerWords?: string[] };
    telegram?: boolean;
    wechat?: boolean;
    qq?: boolean;
    webui?: boolean;
  };
  subAgent?: {
    enabled: boolean;
    maxParallel?: number;
    allowedPersonas?: string[];
  };
  disabled?: string[];
  /** Whether Self-Harness auto-optimization is enabled for this agent. Default true. */
  harness?: {
    enabled: boolean;
  };
}

export interface CreateAgentPayload {
  id?: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
  channelBindings?: Agent['channelBindings'];
}
