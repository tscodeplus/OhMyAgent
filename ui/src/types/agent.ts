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
}

export interface CreateAgentPayload {
  id?: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
  channelBindings?: Agent['channelBindings'];
}
