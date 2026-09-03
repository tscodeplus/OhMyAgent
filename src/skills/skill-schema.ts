// ── Manifest ────────────────────────────────────────────────────────────────

export interface SkillDependencies {
  /** IDs of other skills this skill depends on */
  skills?: string[];
  /** Names of tools that must be available */
  tools?: string[];
  /** Minimum system/engine version required (semver string) */
  minVersion?: string;
}

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
  /** Dependencies this skill requires to function properly */
  dependencies?: SkillDependencies;
  /** IDs of skills this skill conflicts with */
  conflicts?: string[];
}

// ── Tools Config ────────────────────────────────────────────────────────────

export interface ToolsConfig {
  allowedTools: string[];
  deniedTools?: string[];
  /**
   * 'strict' narrows the per-turn tool surface to allowedTools ∪ forced core
   * (denied tools always removed first). Default 'default' keeps additive
   * semantics (allowed grants, never narrows).
   */
  surface?: 'default' | 'strict';
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
