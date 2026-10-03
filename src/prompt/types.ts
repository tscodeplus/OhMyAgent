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

/**
 * One MCP server as advertised in the `mcp_servers` system-prompt section.
 *
 * Derived from static `config.yaml` only — never from live connection state,
 * because the system prompt is assembled before any server has connected
 * (MCP_INTEGRATION_DESIGN §12.1).
 */
export interface McpPromptServer {
  /** Server name as written in `config.yaml`, also the tool-name segment. */
  name: string;
  /** How the server's tools are surfaced to the model. */
  exposure: 'direct' | 'deferred' | 'hidden';
  /** Static description from `config.yaml`; may be empty. */
  description: string;
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
  /**
   * One-line snippets for tools available this session (pi-style quick
   * index; full schemas still go through the API). Included as a stable
   * layer after the skills catalog.
   */
  availableTools?: Array<{
    name: string;
    /** Short one-line description of what the tool does. */
    snippet: string;
  }>;
  /**
   * MCP servers to list in the `mcp_servers` section. Omitted or empty → no
   * section at all, keeping the assembled prompt byte-identical to a build
   * without MCP support.
   */
  mcpServers?: McpPromptServer[];
  /** v7: Agent Team mode — inject orchestrator role layer */
  isTeamMode?: boolean;
  /** v7: Agent Team mode — max parallel child agents */
  teamModeMaxChildren?: number;
  /** Active skill prompt layers (from skill-compiler output, injected into system prompt) */
  activeSkillLayers?: PromptLayer[];
  /**
   * Include the skills/tools catalog layers. Defaults to true; set false for
   * providers without prompt caching to save per-turn catalog tokens.
   */
  includeCatalogs?: boolean;
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
