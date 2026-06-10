// ── Manifest ────────────────────────────────────────────────────────────────

export interface Manifest {
  id: string;
  name: string;
  description: string;
  version: string;
  triggers: string[];
  priority: number;
  enabled: boolean;
  author?: string;
  tags?: string[];
}

// ── Tools Config ────────────────────────────────────────────────────────────

export interface ToolsConfig {
  allowedTools: string[];
  deniedTools?: string[];
  toolConfigs?: Record<string, unknown>;
}

// ── Memory Policy ───────────────────────────────────────────────────────────

export interface MemoryScope {
  type: 'session' | 'user' | 'global';
  key?: string;
  readPolicy: 'always' | 'on_demand' | 'never';
  writePolicy: 'always' | 'on_demand' | 'never';
}

export interface MemoryPolicy {
  scopes: MemoryScope[];
  captureEnabled?: boolean;
  recallEnabled?: boolean;
}
