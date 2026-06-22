// ── Prompt Layer Types ───────────────────────────────────────────────────────

export interface PromptLayer {
  /** Unique name for this layer (e.g. 'base', 'agent:researcher', 'skill:code-review') */
  name: string;
  /** The prompt text content */
  content: string;
  /** Lower = earlier in the assembled prompt (lower = more foundational) */
  priority: number;
  /** Cache key for this layer: 'base' | 'agent:${id}' | 'skill:${id}' | 'child' */
  cacheKey: string;
  /** True if this layer changes frequently (skills trigger/detrigger) */
  volatile: boolean;
  /** Optional: block tag for cache_control annotation grouping */
  blockTag?: string;
}

export interface PromptAssemblyOptions {
  agentId?: string;
  isChildAgent?: boolean;
  childTaskDescription?: string;
  /** Max tokens allowed for the system prompt. Default: context * 0.3 */
  maxTokens?: number;
  uiLanguage?: string;
  /** Human-readable language name for LLM output instruction (e.g. "Simplified Chinese") */
  responseLanguage?: string;
  channel?: string;
  /** L1 metadata for all available skills (always included in system prompt) */
  availableSkills?: Array<{
    id: string;
    name: string;
    description: string;
    /** Relative path to the SKILL.md file (e.g. "skills/researcher/SKILL.md") */
    path: string;
  }>;
  /** v7: Agent Team mode — inject orchestrator role layer */
  isTeamMode?: boolean;
  /** v7: Agent Team mode — max parallel child agents */
  teamModeMaxChildren?: number;
  /** Active skill prompt layers (from skill-compiler output, injected into system prompt) */
  activeSkillLayers?: PromptLayer[];
}

export interface PromptAssemblyResult {
  /** The final assembled system prompt string */
  systemPrompt: string;
  /** All layers that contributed, in priority order */
  layers: PromptLayer[];
  /** Estimated token count */
  tokenCount: number;
  /** Budget warnings (if tokenCount exceeded maxTokens) */
  budgetWarnings: string[];
  /** Descriptions of cache breakpoints for provider integration */
  cacheBreakpoints: CacheAnchor[];
}

export interface CacheAnchor {
  /** Position in the prompt: 'system' | 'user' | 'tool' */
  type: 'system';
  /** Index within the system blocks array (for Anthropic) or -1 for whole system */
  blockIndex: number;
  /** Label for logging */
  label: string;
}

export interface PromptManagerDeps {
  /** Current UI language */
  uiLanguage: string;
  /** Context window size for token budget calculation (default: 200000) */
  contextWindow?: number;
}

// ── Child Agent Optimization ─────────────────────────────────────────────────

export interface ChildAgentOptimizeOptions {
  /** The parent agent's assembled prompt */
  parentAssembly: PromptAssemblyResult;
  /** Description of the child's task */
  taskDescription: string;
  /** Optional layer names to keep even if they match strip patterns */
  keepBlocks?: string[];
}
