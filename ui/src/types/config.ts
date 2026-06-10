export interface AppConfig {
  logging: { level: string };
  uiLanguage: string;
  showToolCalls: boolean;
  footer: Record<string, boolean>;
  piAi: {
    provider: string;
    model: string;
    reasoningModel?: string;
    apiKey: string;
    baseUrl?: string;
  };
  customProviders: CustomProvider[];
  embedding: {
    model: string;
    apiKey: string;
    baseUrl?: string;
    dimension?: number;
  };
  database: { path: string };
  rateLimit: { maxConcurrent: number; windowMs: number };
  tools: {
    shell?: { timeout?: number; approvalTimeout?: number };
    fileRead?: { maxSize?: number; approvalTimeout?: number };
    approvalTimeout?: number;
  };
  memory: Record<string, unknown>;
  feishu?: Record<string, unknown>;
  telegram?: Record<string, unknown>;
  wechat?: Record<string, unknown>;
  qq?: Record<string, unknown>;
  webSearch: Record<string, unknown>;
  cron: Record<string, unknown>;
  computerUse: Record<string, unknown>;
  visionBridge: Record<string, unknown>;
  multimodal: Record<string, unknown>;
  policy: Record<string, unknown>;
  orchestrator: Record<string, unknown>;
  smartAgentTeam: Record<string, unknown>;
  agents: AgentConfig[];
  remoteTriggers: unknown[];
  extensions: Record<string, boolean>;
}

export interface CustomProvider {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  models: ProviderModel[];
}

export interface ProviderModel {
  id: string;
  name: string;
  api?: string;
  reasoning?: boolean;
  contextWindow?: number;
}

export interface AgentConfig {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  model?: string;
  fallbackModels?: string[];
  profile?: string;
  addTools?: string[];
  denyTools?: string[];
  subAgent?: { enabled: boolean; maxParallel?: number };
  channelBindings?: Record<string, unknown>;
  disabled?: string[];
}
